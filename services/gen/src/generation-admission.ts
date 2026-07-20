import { LatestGenerationJobAuthority } from "./job-authority.js";

interface CapacityLease {
  release(): void;
}

class HardGenerationCapacity {
  private active = 0;
  private readonly waiting: Array<{
    signal: AbortSignal;
    resolve(lease: CapacityLease): void;
    reject(reason: unknown): void;
  }> = [];

  constructor(private readonly maximum: number) {}

  get activeCount(): number {
    return this.active;
  }

  tryAcquire(): CapacityLease | undefined {
    if (this.active >= this.maximum) return undefined;
    this.active += 1;
    return this.lease();
  }

  acquire(signal: AbortSignal): Promise<CapacityLease> {
    signal.throwIfAborted();
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const waiting = { signal, resolve, reject };
      const abort = (): void => {
        const index = this.waiting.indexOf(waiting);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push({
        ...waiting,
        resolve(lease) {
          signal.removeEventListener("abort", abort);
          resolve(lease);
        },
      });
    });
  }

  private lease(): CapacityLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        while (this.waiting.length > 0) {
          const next = this.waiting.shift()!;
          if (next.signal.aborted) continue;
          this.active += 1;
          next.resolve(this.lease());
          break;
        }
      },
    };
  }
}

class GenerationRateLimiter {
  private readonly history = new Map<string, number[]>();
  private lastPruneAt = 0;

  constructor(private readonly maximum: number, private readonly windowMs: number) {}

  consume(key: string, now: number): boolean {
    if (now - this.lastPruneAt >= this.windowMs) {
      for (const [candidate, times] of this.history) {
        const recent = times.filter((time) => now - time < this.windowMs);
        if (recent.length === 0) this.history.delete(candidate);
        else this.history.set(candidate, recent);
      }
      this.lastPruneAt = now;
    }
    const recent = (this.history.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.maximum) {
      this.history.set(key, recent);
      return false;
    }
    recent.push(now);
    this.history.set(key, recent);
    return true;
  }
}

export interface GenerationAdmissionLease {
  controller: AbortController;
  replacedOlderJob: boolean;
  activate(): Promise<void>;
  release(): void;
}

export type GenerationAdmissionResult =
  | { accepted: false; reason: "busy" | "rate_limited" }
  | { accepted: true; lease: GenerationAdmissionLease };

export class GenerationAdmissionController {
  private readonly capacity: HardGenerationCapacity;
  private readonly limiter: GenerationRateLimiter;
  private readonly jobs = new LatestGenerationJobAuthority();

  constructor(maximumConcurrent: number, maximumPerWindow: number, windowMs: number) {
    this.capacity = new HardGenerationCapacity(maximumConcurrent);
    this.limiter = new GenerationRateLimiter(maximumPerWindow, windowMs);
  }

  get activeCount(): number {
    return this.capacity.activeCount;
  }

  begin(sessionKey: string, now = Date.now()): GenerationAdmissionResult {
    if (!this.limiter.consume(sessionKey, now)) return { accepted: false, reason: "rate_limited" };
    const replacing = this.jobs.has(sessionKey);
    const initialCapacity = replacing ? undefined : this.capacity.tryAcquire();
    if (!replacing && !initialCapacity) return { accepted: false, reason: "busy" };

    const job = this.jobs.begin(sessionKey);
    let capacity = initialCapacity;
    let activation: Promise<void> | undefined;
    let released = false;
    const activate = async (): Promise<void> => {
      await job.predecessorDone;
      job.controller.signal.throwIfAborted();
      capacity ??= await this.capacity.acquire(job.controller.signal);
    };
    return {
      accepted: true,
      lease: {
        controller: job.controller,
        replacedOlderJob: job.replacedOlderJob,
        activate() {
          return activation ??= activate();
        },
        release() {
          if (released) return;
          released = true;
          capacity?.release();
          job.release();
        },
      },
    };
  }
}
