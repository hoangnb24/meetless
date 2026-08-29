export type MeetingWorkKind = "active_capture" | "finalization" | "transcription" | "ask";

export interface MeetingLifecycleLease {
  release(): void;
}

interface MeetingLifecycleState {
  deleting: boolean;
  work: Map<MeetingWorkKind, number>;
}

export class MeetingLifecycleCoordinator {
  private readonly states = new Map<string, MeetingLifecycleState>();

  tryAcquireWork(meetingId: string, kind: MeetingWorkKind): MeetingLifecycleLease | null {
    const state = this.state(meetingId);
    if (state.deleting) return null;
    state.work.set(kind, (state.work.get(kind) ?? 0) + 1);
    return this.lease(meetingId, () => {
      const current = this.states.get(meetingId);
      if (!current) return;
      const count = current.work.get(kind) ?? 0;
      if (count <= 1) current.work.delete(kind);
      else current.work.set(kind, count - 1);
      this.prune(meetingId, current);
    });
  }

  tryAcquireDeletion(meetingId: string):
    | { acquired: true; lease: MeetingLifecycleLease }
    | { acquired: false; active: MeetingWorkKind[] } {
    const state = this.state(meetingId);
    if (state.deleting || state.work.size > 0) {
      return { acquired: false, active: [...state.work.keys()] };
    }
    state.deleting = true;
    return {
      acquired: true,
      lease: this.lease(meetingId, () => {
        const current = this.states.get(meetingId);
        if (!current) return;
        current.deleting = false;
        this.prune(meetingId, current);
      }),
    };
  }

  private state(meetingId: string): MeetingLifecycleState {
    let state = this.states.get(meetingId);
    if (!state) {
      state = { deleting: false, work: new Map() };
      this.states.set(meetingId, state);
    }
    return state;
  }

  private lease(meetingId: string, release: () => void): MeetingLifecycleLease {
    let released = false;
    return { release: () => { if (!released) { released = true; release(); } } };
  }

  private prune(meetingId: string, state: MeetingLifecycleState): void {
    if (!state.deleting && state.work.size === 0) this.states.delete(meetingId);
  }
}
