export interface GenerationJobLease {
  controller: AbortController;
  replacedOlderJob: boolean;
  isLatest(): boolean;
  release(): void;
}

/**
 * Process-local newest-request authority. Production can replace the storage
 * adapter with a durable equivalent without changing pipeline semantics.
 */
export class LatestGenerationJobAuthority {
  private readonly active = new Map<string, AbortController>();

  has(sessionKey: string): boolean {
    return this.active.has(sessionKey);
  }

  begin(sessionKey: string): GenerationJobLease {
    const older = this.active.get(sessionKey);
    older?.abort(new Error("superseded_by_newer_generation"));
    const controller = new AbortController();
    this.active.set(sessionKey, controller);
    return {
      controller,
      replacedOlderJob: older !== undefined,
      isLatest: () => this.active.get(sessionKey) === controller,
      release: () => {
        if (this.active.get(sessionKey) === controller) this.active.delete(sessionKey);
      },
    };
  }
}

