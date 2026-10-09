import type { PaseoAgentTimelineEvent, PaseoAgentTimelineSubscription, PaseoApi } from './paseo-types.ts';

type Watch = { handle?: PaseoAgentTimelineSubscription; ready: Promise<void> };
type Callbacks = {
  event(event: PaseoAgentTimelineEvent): void;
  gap(id: string): void;
  restored(id: string): Promise<void>;
  error(id: string, error: unknown): void;
};

/** A rejected restore invalidates the SDK handle even when its initial ready resolved. */
export class TimelineSubscriptions {
  private watches = new Map<string, Watch>();
  private retries = new Map<string, { count: number; exhausted?: boolean; timer?: ReturnType<typeof setTimeout> }>();
  private pending = new Set<Promise<unknown>>();
  private stopped = false;

  private paseo: PaseoApi;
  private callbacks: Callbacks;
  private delays: readonly number[];
  constructor(paseo: PaseoApi, callbacks: Callbacks, delays: readonly number[] = [1000, 3000, 10000]) {
    this.paseo = paseo; this.callbacks = callbacks; this.delays = delays;
  }

  get size(): number { return this.watches.size; }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
  }

  private release(id: string, watch: Watch): void {
    if (watch.handle) this.track(watch.handle.release().catch((error) => this.callbacks.error(id, error)));
  }

  watch(id: string, retryAfterExhaustion = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.watches.get(id);
    if (existing) return existing.ready;
    const previousRetry = this.retries.get(id);
    if (previousRetry?.timer) return Promise.resolve();
    if (previousRetry?.exhausted) {
      if (!retryAfterExhaustion) return Promise.resolve();
      previousRetry.count = 0;
      previousRetry.exhausted = false;
    }
    const watch: Watch = { ready: Promise.resolve() };
    this.watches.set(id, watch);
    const current = () => !this.stopped && this.watches.get(id) === watch;
    const fail = (error: unknown) => {
      if (!current()) return;
      this.watches.delete(id);
      this.release(id, watch);
      this.callbacks.gap(id);
      this.callbacks.error(id, error);
      const retry = this.retries.get(id) ?? { count: 0 };
      this.retries.set(id, retry);
      if (retry.count < this.delays.length) {
        retry.timer = setTimeout(() => {
          retry.timer = undefined;
          void this.watch(id).catch(() => {});
        }, this.delays[retry.count++]);
      } else retry.exhausted = true;
    };
    try {
      watch.handle = this.paseo.agents.ref(id).timeline.subscribe((event) => {
        if (!current()) return;
        if (event.event.type === 'error') { fail(new Error(event.event.error)); return; }
        if (event.event.type === 'subscription_restored') {
          this.callbacks.gap(id);
          this.track(this.callbacks.restored(id).catch(fail));
          return;
        }
        this.callbacks.event(event);
      });
      // A synchronous error callback can fire before subscribe returns its handle.
      if (!current()) this.release(id, watch);
      watch.ready = watch.handle.ready.then(async () => {
        if (!current()) return;
        if (this.retries.has(id)) await this.callbacks.restored(id);
        if (current()) this.retries.delete(id);
      });
    } catch (error) { watch.ready = Promise.reject(error); }
    void watch.ready.catch(fail);
    return watch.ready;
  }

  unwatch(id: string): void {
    clearTimeout(this.retries.get(id)?.timer);
    this.retries.delete(id);
    const watch = this.watches.get(id);
    this.watches.delete(id);
    if (watch) this.release(id, watch);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    for (const retry of this.retries.values()) clearTimeout(retry.timer);
    this.retries.clear();
    for (const id of this.watches.keys()) this.unwatch(id);
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
