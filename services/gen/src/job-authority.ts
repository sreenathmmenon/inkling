export interface GenerationJobLease {
  controller: AbortController;
  replacedOlderJob: boolean;
  predecessorDone: Promise<void>;
  isLatest(): boolean;
  release(): void;
}

/**
 * Process-local newest-request authority. Production can replace the storage
 * adapter with a durable equivalent without changing pipeline semantics.
 */
export class LatestGenerationJobAuthority {
  private readonly active = new Map<string, {
    controller: AbortController;
    done: Promise<void>;
    resolveDone(): void;
  }>();

  has(sessionKey: string): boolean {
    return this.active.has(sessionKey);
  }

  begin(sessionKey: string): GenerationJobLease {
    const older = this.active.get(sessionKey);
    older?.controller.abort(new Error("superseded_by_newer_generation"));
    const controller = new AbortController();
    let resolveDone = (): void => undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const current = { controller, done, resolveDone };
    this.active.set(sessionKey, current);
    let released = false;
    return {
      controller,
      replacedOlderJob: older !== undefined,
      predecessorDone: older?.done ?? Promise.resolve(),
      isLatest: () => this.active.get(sessionKey) === current,
      release: () => {
        if (released) return;
        released = true;
        resolveDone();
        if (this.active.get(sessionKey) === current) this.active.delete(sessionKey);
      },
    };
  }
}
