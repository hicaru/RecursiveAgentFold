import { EventEmitter } from 'node:events';

export const RATE_LIMIT_MESSAGE_RE =
  /(?:\b429\b|rate.?limit|too many requests|\b1302\b|overloaded|temporarily unavailable|速率限制|请求频率|限流)/i;

const RATE_LIMIT_CODES: Readonly<Record<string, true>> = Object.freeze({
  '429': true,
  '1302': true,
  RATE_LIMIT: true,
  RATE_LIMITED: true,
  RATE_LIMIT_EXCEEDED: true,
  RATE_LIMIT_EXHAUSTED: true,
});

export function isRateLimitError(
  code: string | number | undefined,
  status: number | undefined,
  message: string,
): boolean {
  if (status === 429) return true;
  if (code !== undefined && RATE_LIMIT_CODES[String(code).toUpperCase()] === true) return true;
  return RATE_LIMIT_MESSAGE_RE.test(message);
}

/** Parse an HTTP Retry-After header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const secs = Number(trimmed);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export interface RateLimitCoordinatorOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly staggerMs?: number;
  readonly maxSoloRetries?: number;
  readonly maxTotalRetries?: number;
}

export interface RateLimitLease {
  readonly isSolo: () => boolean;
  readonly release: () => void;
}

interface QueuedWaiter {
  readonly priority: number;
  readonly resolve: (lease: RateLimitLease) => void;
  readonly reject: (err: unknown) => void;
  readonly cleanup: () => void;
}

export class RateLimitCoordinator extends EventEmitter {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly staggerMs: number;
  readonly maxSoloRetries: number;
  readonly maxTotalRetries: number;

  private _activeWorkers = 0;
  private _inFlight = 0;
  private _allowedConcurrency = Number.POSITIVE_INFINITY;
  private _rateLimitUntil = 0;
  private _streak = 0;
  private _nextWakeAt = 0;
  private _drainTimer: NodeJS.Timeout | undefined;
  private _drainTargetAt = 0;
  private readonly waitQueue: QueuedWaiter[] = [];

  constructor(options: RateLimitCoordinatorOptions = {}) {
    super();
    this.baseDelayMs = options.baseDelayMs ?? 5_000;
    this.maxDelayMs = options.maxDelayMs ?? 300_000;
    this.staggerMs = options.staggerMs ?? 350;
    this.maxSoloRetries = options.maxSoloRetries ?? 8;
    this.maxTotalRetries = options.maxTotalRetries ?? Math.max(this.maxSoloRetries * 3, 24);
  }

  get activeWorkers(): number {
    return this._activeWorkers;
  }

  get inFlight(): number {
    return this._inFlight;
  }

  get allowedConcurrency(): number {
    return this._allowedConcurrency;
  }

  get rateLimitUntil(): number {
    return this._rateLimitUntil;
  }

  get streak(): number {
    return this._streak;
  }

  get queueSize(): number {
    return this.waitQueue.length;
  }

  enterWorker(): () => void {
    this._activeWorkers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._activeWorkers = Math.max(0, this._activeWorkers - 1);
    };
  }

  isSolo(): boolean {
    return this._activeWorkers <= 1 && this._inFlight <= 1 && this.waitQueue.length === 0;
  }

  shouldTerminateSolo(soloStreak: number): boolean {
    return this.isSolo() && soloStreak >= this.maxSoloRetries;
  }

  shouldTerminateTotal(totalRetries: number): boolean {
    return totalRetries >= this.maxTotalRetries;
  }

  createSoloExhaustedError(soloStreak: number, lastErrorMessage: string): Error & { code: string } {
    const err = new Error(
      `RATE_LIMIT_EXHAUSTED: Provider rate limit persisted after ${soloStreak} solo retries with no parallel contention (${lastErrorMessage})`,
    ) as Error & { code: string };
    err.code = 'RATE_LIMIT_EXHAUSTED';
    return err;
  }

  createExhaustedError(totalRetries: number, lastErrorMessage: string): Error & { code: string } {
    const err = new Error(
      `RATE_LIMIT_EXHAUSTED: Provider rate limit persisted after ${totalRetries} retries (${lastErrorMessage})`,
    ) as Error & { code: string };
    err.code = 'RATE_LIMIT_EXHAUSTED';
    return err;
  }

  noteRateLimit(retryAfterMs?: number): { readonly waitMs: number; readonly streak: number } {
    this._streak += 1;
    this._allowedConcurrency = 1;
    const exponent = Math.min(this._streak - 1, 6);
    const backoff = Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
    const baseWait = retryAfterMs !== undefined && retryAfterMs > 0 ? Math.max(backoff, retryAfterMs) : backoff;
    const jitter = Math.floor(Math.random() * Math.min(250, Math.max(1, this.baseDelayMs)));
    const waitMs = Math.min(baseWait + jitter, this.maxDelayMs);
    const now = Date.now();
    this._rateLimitUntil = Math.max(this._rateLimitUntil, now + waitMs);
    this._nextWakeAt = Math.max(this._nextWakeAt, this._rateLimitUntil);
    this.emit('rate:limited', {
      waitMs: this._rateLimitUntil - now,
      streak: this._streak,
      rateLimitUntil: this._rateLimitUntil,
      activeWorkers: this._activeWorkers,
      inFlight: this._inFlight,
      queued: this.waitQueue.length,
    });
    this.scheduleDrain();
    return { waitMs: this._rateLimitUntil - now, streak: this._streak };
  }

  noteSuccess(): void {
    const now = Date.now();
    if (now >= this._rateLimitUntil) {
      const wasLimited = this._streak > 0 || this._rateLimitUntil > 0;
      this._streak = 0;
      this._rateLimitUntil = 0;
      if (Number.isFinite(this._allowedConcurrency)) {
        this._allowedConcurrency += 1;
        if (this._allowedConcurrency >= 16 && this.waitQueue.length === 0) {
          this._allowedConcurrency = Number.POSITIVE_INFINITY;
        }
      }
      if (wasLimited) {
        this.emit('rate:resumed', {
          allowedConcurrency: this._allowedConcurrency,
          activeWorkers: this._activeWorkers,
          queued: this.waitQueue.length,
        });
      }
    }
    this.scheduleDrain();
  }

  reset(): void {
    this._streak = 0;
    this._rateLimitUntil = 0;
    this._nextWakeAt = 0;
    this._allowedConcurrency = Number.POSITIVE_INFINITY;
    clearTimeout(this._drainTimer);
    this._drainTimer = undefined;
    this._drainTargetAt = 0;
    this.scheduleDrain();
  }

  acquire(signal?: AbortSignal, priority = 1): Promise<RateLimitLease> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    }
    const now = Date.now();
    if (
      this.waitQueue.length === 0 &&
      now >= this._rateLimitUntil &&
      now >= this._nextWakeAt &&
      this._inFlight < this._allowedConcurrency
    ) {
      return Promise.resolve(this.createLease(now));
    }

    return new Promise<RateLimitLease>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waitQueue.indexOf(waiter);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: QueuedWaiter = { priority, resolve, reject, cleanup };
      signal?.addEventListener('abort', onAbort, { once: true });
      let insertIdx = this.waitQueue.length;
      for (let i = 0; i < this.waitQueue.length; i++) {
        const existing = this.waitQueue[i];
        if (existing && priority < existing.priority) {
          insertIdx = i;
          break;
        }
      }
      this.waitQueue.splice(insertIdx, 0, waiter);
      this.scheduleDrain();
    });
  }

  private createLease(now: number): RateLimitLease {
    this._inFlight += 1;
    if (this._rateLimitUntil > 0 || Number.isFinite(this._allowedConcurrency) || this.waitQueue.length > 0) {
      this._nextWakeAt = Math.max(this._nextWakeAt, now) + this.staggerMs;
    }
    let released = false;
    return {
      isSolo: () => this.isSolo(),
      release: () => {
        if (released) return;
        released = true;
        this._inFlight = Math.max(0, this._inFlight - 1);
        this.scheduleDrain();
      },
    };
  }

  private scheduleDrain(): void {
    while (this.waitQueue.length > 0 && this._inFlight < this._allowedConcurrency) {
      const now = Date.now();
      const targetAt = Math.max(this._rateLimitUntil, this._nextWakeAt);
      const waitMs = targetAt - now;
      if (waitMs > 0) {
        if (this._drainTimer === undefined || targetAt < this._drainTargetAt) {
          clearTimeout(this._drainTimer);
          this._drainTargetAt = targetAt;
          this._drainTimer = setTimeout(() => {
            this._drainTimer = undefined;
            this._drainTargetAt = 0;
            this.scheduleDrain();
          }, waitMs);
        }
        return;
      }
      const next = this.waitQueue.shift();
      if (!next) break;
      next.cleanup();
      next.resolve(this.createLease(now));
    }
    if (this.waitQueue.length === 0) {
      clearTimeout(this._drainTimer);
      this._drainTimer = undefined;
      this._drainTargetAt = 0;
    }
  }
}

export const defaultRateLimitGate = new RateLimitCoordinator();

/** Per-provider coordinator registry so rate limits on one provider never throttle others. */
export class RateLimitRegistry {
  private readonly gates = new Map<string, RateLimitCoordinator>();

  constructor(private readonly options: RateLimitCoordinatorOptions = {}) {}

  get(providerKey: string): RateLimitCoordinator {
    const key = providerKey.trim().toLowerCase() || 'default';
    let gate = this.gates.get(key);
    if (!gate) {
      gate = new RateLimitCoordinator(this.options);
      this.gates.set(key, gate);
    }
    return gate;
  }

  resetAll(): void {
    for (const gate of this.gates.values()) gate.reset();
  }
}

export const defaultRateLimitRegistry = new RateLimitRegistry();
