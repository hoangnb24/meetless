use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveAsrJobClass {
    Partial,
    Final,
    Reconcile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TempAudioPolicy {
    DeleteAlways,
    RetainOnFailure,
    RetainAlways,
}

#[derive(Debug, Clone)]
pub struct LiveAsrPoolConfig {
    pub worker_count: usize,
    pub queue_capacity: usize,
    pub retries: usize,
    pub temp_audio_policy: TempAudioPolicy,
}

impl Default for LiveAsrPoolConfig {
    fn default() -> Self {
        Self {
            worker_count: 2,
            queue_capacity: 8,
            retries: 0,
            temp_audio_policy: TempAudioPolicy::RetainOnFailure,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LiveAsrJob {
    pub job_id: usize,
    pub class: LiveAsrJobClass,
    pub role: &'static str,
    pub label: String,
    pub segment_id: String,
    pub audio_path: PathBuf,
    pub is_temp_audio: bool,
}

#[derive(Debug, Clone)]
pub struct LiveAsrJobResult {
    pub job: LiveAsrJob,
    pub transcript_text: Option<String>,
    pub error: Option<String>,
    pub retry_attempts: usize,
    pub temp_audio_retained: bool,
    pub temp_audio_deleted: bool,
}

impl LiveAsrJobResult {
    pub fn success(&self) -> bool {
        self.error.is_none()
    }
}

#[derive(Debug, Clone, Default)]
pub struct LiveAsrPoolTelemetry {
    pub prewarm_ok: bool,
    pub submitted: usize,
    pub enqueued: usize,
    pub dropped_queue_full: usize,
    pub processed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub retry_attempts: usize,
    pub temp_audio_retained: usize,
    pub temp_audio_deleted: usize,
}

pub trait LiveAsrExecutor: Send + Sync + 'static {
    fn prewarm(&self) -> Result<(), String>;
    fn transcribe(&self, audio_path: &Path) -> Result<String, String>;
}

#[derive(Default)]
struct ServiceQueueState {
    final_jobs: VecDeque<LiveAsrJob>,
    reconcile_jobs: VecDeque<LiveAsrJob>,
    partial_jobs: VecDeque<LiveAsrJob>,
    closed: bool,
}

enum QueueEnqueueOutcome {
    Enqueued,
    EnqueuedWithEviction(LiveAsrJob),
    DroppedIncoming(LiveAsrJob, &'static str),
    Closed(LiveAsrJob),
}

impl ServiceQueueState {
    fn total_len(&self) -> usize {
        self.final_jobs.len() + self.reconcile_jobs.len() + self.partial_jobs.len()
    }

    fn pop_next(&mut self) -> Option<LiveAsrJob> {
        self.final_jobs
            .pop_front()
            .or_else(|| self.reconcile_jobs.pop_front())
            .or_else(|| self.partial_jobs.pop_front())
    }

    fn enqueue_with_policy(&mut self, job: LiveAsrJob, capacity: usize) -> QueueEnqueueOutcome {
        if self.closed {
            return QueueEnqueueOutcome::Closed(job);
        }

        let capacity = capacity.max(1);
        if self.total_len() < capacity {
            self.push_job(job);
            return QueueEnqueueOutcome::Enqueued;
        }

        match job.class {
            LiveAsrJobClass::Final => {
                let evicted = self
                    .partial_jobs
                    .pop_front()
                    .or_else(|| self.reconcile_jobs.pop_front());
                if let Some(evicted) = evicted {
                    self.final_jobs.push_back(job);
                    QueueEnqueueOutcome::EnqueuedWithEviction(evicted)
                } else {
                    QueueEnqueueOutcome::DroppedIncoming(
                        job,
                        "asr queue full; dropped final submission (no background jobs to evict)",
                    )
                }
            }
            LiveAsrJobClass::Reconcile => {
                if let Some(evicted) = self.partial_jobs.pop_front() {
                    self.reconcile_jobs.push_back(job);
                    QueueEnqueueOutcome::EnqueuedWithEviction(evicted)
                } else {
                    QueueEnqueueOutcome::DroppedIncoming(
                        job,
                        "asr queue full; dropped reconcile submission",
                    )
                }
            }
            LiveAsrJobClass::Partial => QueueEnqueueOutcome::DroppedIncoming(
                job,
                "asr queue full; dropped partial submission",
            ),
        }
    }

    fn push_job(&mut self, job: LiveAsrJob) {
        match job.class {
            LiveAsrJobClass::Final => self.final_jobs.push_back(job),
            LiveAsrJobClass::Reconcile => self.reconcile_jobs.push_back(job),
            LiveAsrJobClass::Partial => self.partial_jobs.push_back(job),
        }
    }
}

pub struct LiveAsrService {
    executor: Arc<dyn LiveAsrExecutor>,
    queue_capacity: usize,
    temp_audio_policy: TempAudioPolicy,
    telemetry: LiveAsrPoolTelemetry,
    prewarm_result: Option<Result<(), String>>,
    queue_state: Arc<(Mutex<ServiceQueueState>, Condvar)>,
    result_rx: Receiver<LiveAsrJobResult>,
    immediate_results: VecDeque<LiveAsrJobResult>,
    worker_handles: Vec<thread::JoinHandle<()>>,
}

impl LiveAsrService {
    pub fn start(executor: Arc<dyn LiveAsrExecutor>, config: LiveAsrPoolConfig) -> Self {
        let worker_count = config.worker_count.max(1);
        let queue_capacity = config.queue_capacity.max(1);

        let (result_tx, result_rx) = mpsc::channel::<LiveAsrJobResult>();
        let queue_state = Arc::new((Mutex::new(ServiceQueueState::default()), Condvar::new()));

        let mut worker_handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let queue = Arc::clone(&queue_state);
            let tx = result_tx.clone();
            let exec = Arc::clone(&executor);
            let policy = config.temp_audio_policy;
            let retries = config.retries;
            worker_handles.push(thread::spawn(move || {
                loop {
                    let maybe_job = LiveAsrService::pop_next_job(&queue);
                    let Some(job) = maybe_job else {
                        break;
                    };

                    let mut attempts = 0usize;
                    let (transcript, error) = loop {
                        match exec.transcribe(&job.audio_path) {
                            Ok(text) => break (Some(text), None),
                            Err(err) => {
                                if attempts >= retries {
                                    break (None, Some(err));
                                }
                                attempts += 1;
                            }
                        }
                    };

                    let success = error.is_none();
                    let (retained, deleted) = finalize_temp_audio_path(
                        &job.audio_path,
                        job.is_temp_audio,
                        success,
                        policy,
                    );
                    let _ = tx.send(LiveAsrJobResult {
                        job,
                        transcript_text: transcript,
                        error,
                        retry_attempts: attempts,
                        temp_audio_retained: retained,
                        temp_audio_deleted: deleted,
                    });
                }
            }));
        }
        drop(result_tx);

        Self {
            executor,
            queue_capacity,
            temp_audio_policy: config.temp_audio_policy,
            telemetry: LiveAsrPoolTelemetry::default(),
            prewarm_result: None,
            queue_state,
            result_rx,
            immediate_results: VecDeque::new(),
            worker_handles,
        }
    }

    pub fn prewarm_once(&mut self) -> Result<(), String> {
        if let Some(result) = &self.prewarm_result {
            return result.clone();
        }
        let result = self.executor.prewarm();
        self.telemetry.prewarm_ok = result.is_ok();
        self.prewarm_result = Some(result.clone());
        result
    }

    pub fn submit(&mut self, job: LiveAsrJob) -> Result<(), String> {
        self.telemetry.submitted += 1;

        if let Err(err) = self.prewarm_once() {
            self.push_immediate_result(build_failed_submission_result(
                job,
                format!("asr prewarm failed: {err}"),
                self.temp_audio_policy,
            ));
            return Err(format!("asr prewarm failed: {err}"));
        }

        let incoming_class = job.class;
        let queue_state = Arc::clone(&self.queue_state);
        let enqueue_outcome = {
            let (lock, notify) = &*queue_state;
            let mut queue = match lock.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    self.push_immediate_result(build_failed_submission_result(
                        job,
                        "asr queue lock poisoned".to_string(),
                        self.temp_audio_policy,
                    ));
                    return Err("asr queue lock poisoned".to_string());
                }
            };
            let outcome = queue.enqueue_with_policy(job, self.queue_capacity);
            if matches!(
                outcome,
                QueueEnqueueOutcome::Enqueued | QueueEnqueueOutcome::EnqueuedWithEviction(_)
            ) {
                notify.notify_one();
            }
            outcome
        };

        match enqueue_outcome {
            QueueEnqueueOutcome::Enqueued => {
                self.telemetry.enqueued += 1;
                Ok(())
            }
            QueueEnqueueOutcome::EnqueuedWithEviction(evicted) => {
                self.telemetry.enqueued += 1;
                self.telemetry.dropped_queue_full += 1;
                let evicted_class = evicted.class;
                self.push_immediate_result(build_failed_submission_result(
                    evicted,
                    format!(
                        "asr queue pressure; evicted {} job in favor of {}",
                        class_name(evicted_class),
                        class_name(incoming_class)
                    ),
                    self.temp_audio_policy,
                ));
                Ok(())
            }
            QueueEnqueueOutcome::DroppedIncoming(job, reason) => {
                self.telemetry.dropped_queue_full += 1;
                self.push_immediate_result(build_failed_submission_result(
                    job,
                    reason.to_string(),
                    self.temp_audio_policy,
                ));
                Err(reason.to_string())
            }
            QueueEnqueueOutcome::Closed(job) => {
                self.push_immediate_result(build_failed_submission_result(
                    job,
                    "asr service closed".to_string(),
                    self.temp_audio_policy,
                ));
                Err("asr service closed".to_string())
            }
        }
    }

    pub fn try_recv_result(&mut self) -> Option<LiveAsrJobResult> {
        if let Some(result) = self.immediate_results.pop_front() {
            return Some(result);
        }
        match self.result_rx.try_recv() {
            Ok(result) => {
                self.record_worker_result(&result);
                Some(result)
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => None,
        }
    }

    pub fn recv_result_timeout(&mut self, timeout: Duration) -> Option<LiveAsrJobResult> {
        if let Some(result) = self.immediate_results.pop_front() {
            return Some(result);
        }
        match self.result_rx.recv_timeout(timeout) {
            Ok(result) => {
                self.record_worker_result(&result);
                Some(result)
            }
            Err(_) => None,
        }
    }

    pub fn recv_result(&mut self) -> Option<LiveAsrJobResult> {
        if let Some(result) = self.immediate_results.pop_front() {
            return Some(result);
        }
        self.result_rx.recv().ok().map(|result| {
            self.record_worker_result(&result);
            result
        })
    }

    pub fn close(&mut self) {
        let (lock, notify) = &*self.queue_state;
        if let Ok(mut queue) = lock.lock() {
            queue.closed = true;
            notify.notify_all();
        }
    }

    pub fn join(&mut self) {
        self.close();
        for handle in self.worker_handles.drain(..) {
            let _ = handle.join();
        }
    }

    pub fn telemetry(&self) -> LiveAsrPoolTelemetry {
        self.telemetry.clone()
    }

    fn record_worker_result(&mut self, result: &LiveAsrJobResult) {
        self.telemetry.processed += 1;
        self.telemetry.retry_attempts += result.retry_attempts;
        self.record_result(result);
    }

    fn push_immediate_result(&mut self, result: LiveAsrJobResult) {
        self.record_result(&result);
        self.immediate_results.push_back(result);
    }

    fn record_result(&mut self, result: &LiveAsrJobResult) {
        if result.success() {
            self.telemetry.succeeded += 1;
        } else {
            self.telemetry.failed += 1;
        }
        if result.temp_audio_retained {
            self.telemetry.temp_audio_retained += 1;
        }
        if result.temp_audio_deleted {
            self.telemetry.temp_audio_deleted += 1;
        }
    }

    pub fn queue_capacity(&self) -> usize {
        self.queue_capacity
    }

    fn pop_next_job(queue_state: &Arc<(Mutex<ServiceQueueState>, Condvar)>) -> Option<LiveAsrJob> {
        let (lock, notify) = &**queue_state;
        let mut queue = lock.lock().ok()?;
        loop {
            if let Some(job) = queue.pop_next() {
                return Some(job);
            }
            if queue.closed {
                return None;
            }
            queue = notify.wait(queue).ok()?;
        }
    }
}

fn class_name(class: LiveAsrJobClass) -> &'static str {
    match class {
        LiveAsrJobClass::Partial => "partial",
        LiveAsrJobClass::Final => "final",
        LiveAsrJobClass::Reconcile => "reconcile",
    }
}

fn build_failed_submission_result(
    job: LiveAsrJob,
    error: String,
    policy: TempAudioPolicy,
) -> LiveAsrJobResult {
    let (retained, deleted) =
        finalize_temp_audio_path(&job.audio_path, job.is_temp_audio, false, policy);
    LiveAsrJobResult {
        job,
        transcript_text: None,
        error: Some(error),
        retry_attempts: 0,
        temp_audio_retained: retained,
        temp_audio_deleted: deleted,
    }
}

pub fn run_live_asr_pool(
    executor: Arc<dyn LiveAsrExecutor>,
    jobs: Vec<LiveAsrJob>,
    config: LiveAsrPoolConfig,
) -> (Vec<LiveAsrJobResult>, LiveAsrPoolTelemetry) {
    let expected_results = jobs.len();
    let mut service = LiveAsrService::start(executor, config);
    for job in jobs {
        let _ = service.submit(job);
    }
    service.close();

    let mut results = Vec::with_capacity(expected_results);
    while results.len() < expected_results {
        match service.recv_result() {
            Some(result) => results.push(result),
            None => break,
        }
    }
    service.join();

    let telemetry = service.telemetry();
    results.sort_by_key(|result| result.job.job_id);
    (results, telemetry)
}

fn finalize_temp_audio_path(
    path: &Path,
    is_temp_audio: bool,
    success: bool,
    policy: TempAudioPolicy,
) -> (bool, bool) {
    if !is_temp_audio {
        return (false, false);
    }

    let retain = match policy {
        TempAudioPolicy::DeleteAlways => false,
        TempAudioPolicy::RetainOnFailure => !success,
        TempAudioPolicy::RetainAlways => true,
    };
    if retain {
        return (true, false);
    }

    match fs::remove_file(path) {
        Ok(()) => (false, true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => (false, false),
        Err(_) => (true, false),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        LiveAsrExecutor, LiveAsrJob, LiveAsrJobClass, LiveAsrPoolConfig, LiveAsrService,
        QueueEnqueueOutcome, ServiceQueueState, TempAudioPolicy, run_live_asr_pool,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    struct MockExecutor {
        prewarm_ok: bool,
        fail_text: bool,
        sleep_ms: u64,
        attempts: AtomicUsize,
    }

    impl LiveAsrExecutor for MockExecutor {
        fn prewarm(&self) -> Result<(), String> {
            self.attempts.fetch_add(1, Ordering::Relaxed);
            if self.prewarm_ok {
                Ok(())
            } else {
                Err("mock prewarm failure".to_string())
            }
        }

        fn transcribe(&self, audio_path: &Path) -> Result<String, String> {
            self.attempts.fetch_add(1, Ordering::Relaxed);
            if self.sleep_ms > 0 {
                thread::sleep(Duration::from_millis(self.sleep_ms));
            }
            if self.fail_text {
                Err(format!("failed: {}", audio_path.display()))
            } else {
                Ok(format!("ok:{}", audio_path.display()))
            }
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("recordit-live-asr-pool-tests");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join(name);
        let _ = fs::write(&path, b"tmp");
        path
    }

    fn job(id: usize, class: LiveAsrJobClass) -> LiveAsrJob {
        LiveAsrJob {
            job_id: id,
            class,
            role: "mic",
            label: "mic".to_string(),
            segment_id: format!("seg-{id}"),
            audio_path: temp_file(&format!("q-{id}.wav")),
            is_temp_audio: true,
        }
    }

    #[test]
    fn queue_policy_final_eviction_prefers_background_partial_then_reconcile() {
        let mut queue = ServiceQueueState::default();
        assert!(matches!(
            queue.enqueue_with_policy(job(1, LiveAsrJobClass::Partial), 2),
            QueueEnqueueOutcome::Enqueued
        ));
        assert!(matches!(
            queue.enqueue_with_policy(job(2, LiveAsrJobClass::Reconcile), 2),
            QueueEnqueueOutcome::Enqueued
        ));

        match queue.enqueue_with_policy(job(3, LiveAsrJobClass::Final), 2) {
            QueueEnqueueOutcome::EnqueuedWithEviction(evicted) => {
                assert_eq!(evicted.job_id, 1);
                assert_eq!(evicted.class, LiveAsrJobClass::Partial);
            }
            _ => panic!("expected eviction outcome"),
        }

        assert_eq!(queue.total_len(), 2);
        let first = queue.pop_next().expect("expected final-first scheduling");
        let second = queue.pop_next().expect("expected remaining reconcile");
        assert_eq!(first.class, LiveAsrJobClass::Final);
        assert_eq!(second.class, LiveAsrJobClass::Reconcile);
    }

    #[test]
    fn queue_policy_reconcile_evicts_partial_and_never_final() {
        let mut queue = ServiceQueueState::default();
        assert!(matches!(
            queue.enqueue_with_policy(job(10, LiveAsrJobClass::Final), 2),
            QueueEnqueueOutcome::Enqueued
        ));
        assert!(matches!(
            queue.enqueue_with_policy(job(11, LiveAsrJobClass::Partial), 2),
            QueueEnqueueOutcome::Enqueued
        ));

        match queue.enqueue_with_policy(job(12, LiveAsrJobClass::Reconcile), 2) {
            QueueEnqueueOutcome::EnqueuedWithEviction(evicted) => {
                assert_eq!(evicted.job_id, 11);
                assert_eq!(evicted.class, LiveAsrJobClass::Partial);
            }
            _ => panic!("expected reconcile to evict partial"),
        }

        match queue.enqueue_with_policy(job(13, LiveAsrJobClass::Reconcile), 2) {
            QueueEnqueueOutcome::DroppedIncoming(dropped, reason) => {
                assert_eq!(dropped.job_id, 13);
                assert!(reason.contains("dropped reconcile"));
            }
            _ => panic!("expected reconcile drop when no partial is available"),
        }
    }

    #[test]
    fn queue_policy_final_drops_only_when_no_background_jobs_exist() {
        let mut queue = ServiceQueueState::default();
        assert!(matches!(
            queue.enqueue_with_policy(job(20, LiveAsrJobClass::Final), 1),
            QueueEnqueueOutcome::Enqueued
        ));

        match queue.enqueue_with_policy(job(21, LiveAsrJobClass::Final), 1) {
            QueueEnqueueOutcome::DroppedIncoming(dropped, reason) => {
                assert_eq!(dropped.job_id, 21);
                assert_eq!(dropped.class, LiveAsrJobClass::Final);
                assert!(reason.contains("dropped final submission"));
            }
            _ => panic!("expected final drop when only final jobs are queued"),
        }

        let queued = queue
            .pop_next()
            .expect("original final should remain queued");
        assert_eq!(queued.job_id, 20);
        assert_eq!(queued.class, LiveAsrJobClass::Final);
    }

    #[test]
    fn queue_stays_non_blocking_and_drops_on_full_capacity() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: true,
            fail_text: false,
            sleep_ms: 30,
            attempts: AtomicUsize::new(0),
        });
        let jobs = (0..6)
            .map(|idx| LiveAsrJob {
                job_id: idx,
                class: LiveAsrJobClass::Final,
                role: "mic",
                label: "mic".to_string(),
                segment_id: format!("s-{idx}"),
                audio_path: temp_file(&format!("queue-{idx}.wav")),
                is_temp_audio: true,
            })
            .collect::<Vec<_>>();

        let (results, telemetry) = run_live_asr_pool(
            executor,
            jobs,
            LiveAsrPoolConfig {
                worker_count: 1,
                queue_capacity: 1,
                retries: 0,
                temp_audio_policy: TempAudioPolicy::RetainOnFailure,
            },
        );

        assert_eq!(telemetry.submitted, 6);
        assert!(telemetry.dropped_queue_full > 0);
        assert_eq!(results.len(), 6);
    }

    #[test]
    fn service_final_submission_evicts_background_job_under_pressure() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: true,
            fail_text: false,
            sleep_ms: 5,
            attempts: AtomicUsize::new(0),
        });
        let mut service = LiveAsrService::start(
            executor,
            LiveAsrPoolConfig {
                worker_count: 1,
                queue_capacity: 1,
                retries: 0,
                temp_audio_policy: TempAudioPolicy::RetainOnFailure,
            },
        );

        {
            let (lock, _) = &*service.queue_state;
            let mut queue = lock.lock().expect("queue lock should not be poisoned");
            queue.push_job(job(100, LiveAsrJobClass::Partial));
        }

        let final_job = job(101, LiveAsrJobClass::Final);
        assert!(
            service.submit(final_job.clone()).is_ok(),
            "final submission should evict background work instead of dropping"
        );

        let evicted = service
            .try_recv_result()
            .expect("evicted background job should be reported immediately");
        assert_eq!(evicted.job.job_id, 100);
        assert_eq!(evicted.job.class, LiveAsrJobClass::Partial);
        assert!(!evicted.success());
        assert!(
            evicted
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("evicted partial job in favor of final")
        );

        service.close();
        let mut final_result = None;
        for _ in 0..20 {
            let Some(result) = service.recv_result_timeout(Duration::from_millis(100)) else {
                continue;
            };
            if result.job.job_id == final_job.job_id {
                final_result = Some(result);
                break;
            }
        }
        service.join();

        let final_result = final_result.expect("expected final result after eviction path");
        assert!(final_result.success());
        assert_eq!(final_result.job.class, LiveAsrJobClass::Final);

        let telemetry = service.telemetry();
        assert_eq!(telemetry.submitted, 1);
        assert_eq!(telemetry.enqueued, 1);
        assert_eq!(telemetry.dropped_queue_full, 1);
        assert_eq!(telemetry.failed, 1);
        assert_eq!(telemetry.succeeded, 1);
    }

    #[test]
    fn delete_always_policy_removes_temp_audio_on_success() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: true,
            fail_text: false,
            sleep_ms: 0,
            attempts: AtomicUsize::new(0),
        });
        let tmp = temp_file("delete-success.wav");
        let (results, telemetry) = run_live_asr_pool(
            executor,
            vec![LiveAsrJob {
                job_id: 1,
                class: LiveAsrJobClass::Final,
                role: "mic",
                label: "mic".to_string(),
                segment_id: "s1".to_string(),
                audio_path: tmp.clone(),
                is_temp_audio: true,
            }],
            LiveAsrPoolConfig {
                worker_count: 1,
                queue_capacity: 2,
                retries: 0,
                temp_audio_policy: TempAudioPolicy::DeleteAlways,
            },
        );

        assert_eq!(telemetry.temp_audio_deleted, 1);
        assert!(results[0].success());
        assert!(!tmp.exists());
    }

    #[test]
    fn retain_on_failure_keeps_temp_audio_for_debugging() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: true,
            fail_text: true,
            sleep_ms: 0,
            attempts: AtomicUsize::new(0),
        });
        let tmp = temp_file("retain-failure.wav");
        let (results, telemetry) = run_live_asr_pool(
            executor,
            vec![LiveAsrJob {
                job_id: 1,
                class: LiveAsrJobClass::Final,
                role: "mic",
                label: "mic".to_string(),
                segment_id: "s1".to_string(),
                audio_path: tmp.clone(),
                is_temp_audio: true,
            }],
            LiveAsrPoolConfig {
                worker_count: 1,
                queue_capacity: 2,
                retries: 0,
                temp_audio_policy: TempAudioPolicy::RetainOnFailure,
            },
        );

        assert_eq!(telemetry.failed, 1);
        assert_eq!(telemetry.temp_audio_retained, 1);
        assert!(!results[0].success());
        assert!(tmp.exists());
        let _ = fs::remove_file(tmp);
    }

    #[test]
    fn prewarm_failure_short_circuits_jobs() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: false,
            fail_text: false,
            sleep_ms: 0,
            attempts: AtomicUsize::new(0),
        });
        let tmp = temp_file("prewarm-failure.wav");
        let (results, telemetry) = run_live_asr_pool(
            executor,
            vec![LiveAsrJob {
                job_id: 1,
                class: LiveAsrJobClass::Final,
                role: "mic",
                label: "mic".to_string(),
                segment_id: "s1".to_string(),
                audio_path: tmp.clone(),
                is_temp_audio: true,
            }],
            LiveAsrPoolConfig::default(),
        );

        assert!(!telemetry.prewarm_ok);
        assert_eq!(telemetry.failed, 1);
        assert_eq!(telemetry.temp_audio_retained, 1);
        assert_eq!(telemetry.temp_audio_deleted, 0);
        assert!(
            results[0]
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("prewarm failed")
        );
        assert!(tmp.exists());
        let _ = fs::remove_file(tmp);
    }

    #[test]
    fn service_prewarm_once_is_idempotent() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: true,
            fail_text: false,
            sleep_ms: 0,
            attempts: AtomicUsize::new(0),
        });
        let mut service = LiveAsrService::start(executor.clone(), LiveAsrPoolConfig::default());
        assert!(service.prewarm_once().is_ok());
        assert!(service.prewarm_once().is_ok());
        service.close();
        service.join();
        assert_eq!(executor.attempts.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn service_submit_and_collect_results_non_blocking() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: true,
            fail_text: false,
            sleep_ms: 10,
            attempts: AtomicUsize::new(0),
        });
        let mut service = LiveAsrService::start(
            executor,
            LiveAsrPoolConfig {
                worker_count: 1,
                queue_capacity: 1,
                retries: 0,
                temp_audio_policy: TempAudioPolicy::RetainOnFailure,
            },
        );

        let jobs = (0..5)
            .map(|idx| LiveAsrJob {
                job_id: idx,
                class: LiveAsrJobClass::Final,
                role: "mic",
                label: "mic".to_string(),
                segment_id: format!("seg-{idx}"),
                audio_path: temp_file(&format!("service-submit-{idx}.wav")),
                is_temp_audio: true,
            })
            .collect::<Vec<_>>();

        for job in jobs {
            let _ = service.submit(job);
        }
        service.close();

        let mut results = Vec::new();
        while results.len() < 5 {
            if let Some(result) = service.recv_result_timeout(Duration::from_millis(250)) {
                results.push(result);
            }
        }

        service.join();
        let telemetry = service.telemetry();
        assert_eq!(results.len(), 5);
        assert_eq!(telemetry.submitted, 5);
        assert_eq!(telemetry.succeeded + telemetry.failed, 5);
        assert!(telemetry.dropped_queue_full > 0);
    }

    #[test]
    fn service_submit_after_close_returns_error_and_result() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: true,
            fail_text: false,
            sleep_ms: 0,
            attempts: AtomicUsize::new(0),
        });
        let mut service = LiveAsrService::start(executor, LiveAsrPoolConfig::default());
        service.close();
        let tmp = temp_file("service-closed.wav");
        let err = service
            .submit(LiveAsrJob {
                job_id: 42,
                class: LiveAsrJobClass::Final,
                role: "mic",
                label: "mic".to_string(),
                segment_id: "seg-42".to_string(),
                audio_path: tmp.clone(),
                is_temp_audio: true,
            })
            .err()
            .unwrap_or_default();
        assert!(err.contains("closed"));

        let result = service.recv_result_timeout(Duration::from_millis(100));
        assert!(result.is_some());
        assert!(
            result
                .as_ref()
                .and_then(|r| r.error.as_ref())
                .map(|msg| msg.contains("closed"))
                .unwrap_or(false)
        );
        let telemetry = service.telemetry();
        assert_eq!(telemetry.failed, 1);
        assert_eq!(telemetry.temp_audio_retained, 1);
        assert_eq!(telemetry.temp_audio_deleted, 0);
        assert!(tmp.exists());
        let _ = fs::remove_file(tmp);
        service.join();
    }

    #[test]
    fn service_submit_after_close_delete_always_removes_temp_audio() {
        let executor = Arc::new(MockExecutor {
            prewarm_ok: true,
            fail_text: false,
            sleep_ms: 0,
            attempts: AtomicUsize::new(0),
        });
        let mut service = LiveAsrService::start(
            executor,
            LiveAsrPoolConfig {
                worker_count: 1,
                queue_capacity: 1,
                retries: 0,
                temp_audio_policy: TempAudioPolicy::DeleteAlways,
            },
        );
        service.close();
        let tmp = temp_file("service-closed-delete-always.wav");
        let err = service
            .submit(LiveAsrJob {
                job_id: 77,
                class: LiveAsrJobClass::Final,
                role: "mic",
                label: "mic".to_string(),
                segment_id: "seg-77".to_string(),
                audio_path: tmp.clone(),
                is_temp_audio: true,
            })
            .err()
            .unwrap_or_default();
        assert!(err.contains("closed"));

        let result = service
            .recv_result_timeout(Duration::from_millis(100))
            .expect("expected immediate failure result");
        assert!(!result.success());
        assert!(result.temp_audio_deleted);
        assert!(!tmp.exists());

        let telemetry = service.telemetry();
        assert_eq!(telemetry.failed, 1);
        assert_eq!(telemetry.temp_audio_deleted, 1);
        assert_eq!(telemetry.temp_audio_retained, 0);
        service.join();
    }
}
