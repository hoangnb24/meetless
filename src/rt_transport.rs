use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TryRecvError, TrySendError, bounded};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[derive(Debug, Default)]
struct TransportStats {
    capacity: u64,
    ready_depth_high_water: AtomicU64,
    slot_miss_drops: AtomicU64,
    fill_failures: AtomicU64,
    queue_full_drops: AtomicU64,
    recycle_failures: AtomicU64,
    enqueued: AtomicU64,
    dequeued: AtomicU64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TransportStatsSnapshot {
    pub capacity: u64,
    pub ready_depth_high_water: u64,
    pub slot_miss_drops: u64,
    pub fill_failures: u64,
    pub queue_full_drops: u64,
    pub recycle_failures: u64,
    pub enqueued: u64,
    pub dequeued: u64,
    pub in_flight: u64,
}

impl TransportStats {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity as u64,
            ..Self::default()
        }
    }

    fn update_ready_depth_high_water(&self, depth: usize) {
        let depth = depth as u64;
        let mut current = self.ready_depth_high_water.load(Ordering::Relaxed);
        while depth > current {
            match self.ready_depth_high_water.compare_exchange_weak(
                current,
                depth,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }
    }

    fn snapshot(&self) -> TransportStatsSnapshot {
        let enqueued = self.enqueued.load(Ordering::Relaxed);
        let dequeued = self.dequeued.load(Ordering::Relaxed);
        TransportStatsSnapshot {
            capacity: self.capacity,
            ready_depth_high_water: self.ready_depth_high_water.load(Ordering::Relaxed),
            slot_miss_drops: self.slot_miss_drops.load(Ordering::Relaxed),
            fill_failures: self.fill_failures.load(Ordering::Relaxed),
            queue_full_drops: self.queue_full_drops.load(Ordering::Relaxed),
            recycle_failures: self.recycle_failures.load(Ordering::Relaxed),
            enqueued,
            dequeued,
            in_flight: enqueued.saturating_sub(dequeued),
        }
    }
}

#[derive(Clone)]
pub struct PreallocatedProducer<T> {
    free_rx: Receiver<T>,
    free_tx: Sender<T>,
    ready_tx: Sender<T>,
    stats: Arc<TransportStats>,
}

pub struct PreallocatedConsumer<T> {
    ready_rx: Receiver<T>,
    free_tx: Sender<T>,
    stats: Arc<TransportStats>,
}

pub fn preallocated_spsc<T>(slots: Vec<T>) -> (PreallocatedProducer<T>, PreallocatedConsumer<T>) {
    assert!(
        !slots.is_empty(),
        "preallocated_spsc requires at least one slot"
    );

    let capacity = slots.len();
    let (free_tx, free_rx) = bounded::<T>(capacity);
    let (ready_tx, ready_rx) = bounded::<T>(capacity);

    for slot in slots {
        free_tx
            .send(slot)
            .expect("failed to seed preallocated free-slot queue");
    }

    let stats = Arc::new(TransportStats::with_capacity(capacity));
    (
        PreallocatedProducer {
            free_rx,
            free_tx: free_tx.clone(),
            ready_tx,
            stats: Arc::clone(&stats),
        },
        PreallocatedConsumer {
            ready_rx,
            free_tx,
            stats,
        },
    )
}

impl<T> PreallocatedProducer<T> {
    pub fn try_push_with<F>(&self, fill: F)
    where
        F: FnOnce(&mut T) -> bool,
    {
        match self.free_rx.try_recv() {
            Ok(mut slot) => {
                if !fill(&mut slot) {
                    self.stats.fill_failures.fetch_add(1, Ordering::Relaxed);
                    if self.free_tx.try_send(slot).is_err() {
                        self.stats.recycle_failures.fetch_add(1, Ordering::Relaxed);
                    }
                    return;
                }

                match self.ready_tx.try_send(slot) {
                    Ok(()) => {
                        self.stats.enqueued.fetch_add(1, Ordering::Relaxed);
                        self.stats
                            .update_ready_depth_high_water(self.ready_tx.len());
                    }
                    Err(TrySendError::Full(slot)) => {
                        self.stats.queue_full_drops.fetch_add(1, Ordering::Relaxed);
                        if self.free_tx.try_send(slot).is_err() {
                            self.stats.recycle_failures.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        self.stats.queue_full_drops.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => {
                self.stats.slot_miss_drops.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn stats_snapshot(&self) -> TransportStatsSnapshot {
        self.stats.snapshot()
    }
}

impl<T> PreallocatedConsumer<T> {
    pub fn recv_timeout(&self, timeout: Duration) -> Result<T, RecvTimeoutError> {
        let slot = self.ready_rx.recv_timeout(timeout)?;
        self.stats.dequeued.fetch_add(1, Ordering::Relaxed);
        Ok(slot)
    }

    pub fn recycle(&self, slot: T) {
        if self.free_tx.try_send(slot).is_err() {
            self.stats.recycle_failures.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn stats_snapshot(&self) -> TransportStatsSnapshot {
        self.stats.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::{TransportStatsSnapshot, preallocated_spsc};
    use std::time::Duration;

    #[test]
    fn recycles_slots_across_producer_consumer() {
        let slots = vec![0usize; 8];
        let (producer, consumer) = preallocated_spsc(slots);

        for value in 1..=256usize {
            producer.try_push_with(|slot| {
                *slot = value;
                true
            });

            let slot = consumer
                .recv_timeout(Duration::from_millis(50))
                .expect("expected queued slot");
            assert_eq!(slot, value);
            consumer.recycle(slot);
        }

        let TransportStatsSnapshot {
            capacity,
            ready_depth_high_water,
            slot_miss_drops,
            fill_failures,
            recycle_failures,
            enqueued,
            dequeued,
            ..
        } = consumer.stats_snapshot();

        assert_eq!(capacity, 8);
        assert!(ready_depth_high_water <= capacity);
        assert_eq!(slot_miss_drops, 0);
        assert_eq!(fill_failures, 0);
        assert_eq!(recycle_failures, 0);
        assert_eq!(enqueued, 256);
        assert_eq!(dequeued, 256);
    }

    #[test]
    fn accounts_for_backpressure_drops() {
        let slots = vec![0usize; 2];
        let (producer, consumer) = preallocated_spsc(slots);

        for value in 1..=128usize {
            producer.try_push_with(|slot| {
                *slot = value;
                true
            });
        }

        let stats = producer.stats_snapshot();
        assert_eq!(stats.capacity, 2);
        assert!(stats.ready_depth_high_water <= stats.capacity);
        assert!(stats.slot_miss_drops > 0);
        assert_eq!(stats.fill_failures, 0);

        for _ in 0..stats.enqueued {
            let slot = consumer
                .recv_timeout(Duration::from_millis(50))
                .expect("expected queued slot after producer run");
            consumer.recycle(slot);
        }
    }
}
