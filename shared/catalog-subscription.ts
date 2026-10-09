// Shared code cannot import host client or server SDK types. This is the
// structural part of the SDK OwnedSubscription that the catalog uses.
export type OwnedSubscription<P> = {
  subscribe(observer: { snapshot(page: P): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
};

type Page = { pageInfo: { nextCursor?: string | null } };
export type CatalogSubscription = {
  ready: Promise<void>;
  ensure(): void;
  release(): Promise<void>;
};

/** Owns one host-assigned subscription and reconciles every paginated snapshot. */
export function subscribeCatalog<T, P extends Page, U>(options: {
  open(): Promise<P & { subscription: OwnedSubscription<P> }>;
  next(cursor: string): Promise<P>;
  entries(page: P): readonly T[];
  id(item: T): string;
  update(message: unknown): { id: string; item: T | null; value: U } | null;
  onSnapshot(items: T[], restored: boolean): void;
  onUpdate(update: U): void;
  onError(error: unknown): void;
  retryDelays?: readonly number[];
}): CatalogSubscription {
  let stopped = false;
  let opening = false;
  let generation = 0;
  let epoch = 0;
  let established = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscription: OwnedSubscription<P> | null = null;
  let changes: Map<string, T | null> | null = null;
  const work = new Set<Promise<unknown>>();
  const delays = options.retryDelays ?? [1000, 3000, 10000];
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Consumers can attach their initial await after registering this observer.
  void ready.catch(() => {});
  function track(promise: Promise<unknown>): void {
    work.add(promise);
    void promise.finally(() => work.delete(promise)).catch(() => {});
  }
  function releaseHandle(handle: OwnedSubscription<P>): void {
    track(handle.release().catch(options.onError));
  }
  function fail(error: unknown, ownGeneration: number): void {
    if (stopped || generation !== ownGeneration) return;
    generation++;
    epoch++;
    changes = null;
    opening = false;
    if (subscription) releaseHandle(subscription);
    subscription = null;
    options.onError(error);
    if (!established) rejectReady(error);
    if (attempts < delays.length) timer = setTimeout(() => { timer = undefined; start(); }, delays[attempts++]);
  }
  async function snapshot(first: P, ownGeneration: number): Promise<void> {
    const ownEpoch = ++epoch;
    const pendingChanges = new Map<string, T | null>();
    changes = pendingChanges;
    const items = new Map<string, T>();
    const seen = new Set<string>();
    let page = first;
    do {
      for (const item of options.entries(page)) items.set(options.id(item), item);
      const cursor = page.pageInfo.nextCursor;
      if (!cursor) break;
      if (seen.has(cursor)) throw new Error('Repeated catalog pagination cursor');
      seen.add(cursor);
      page = await options.next(cursor);
      if (stopped || generation !== ownGeneration || epoch !== ownEpoch) return;
    } while (true);
    if (stopped || generation !== ownGeneration || epoch !== ownEpoch) return;
    for (const [id, item] of pendingChanges) {
      if (item) items.set(id, item); else items.delete(id);
    }
    changes = null;
    options.onSnapshot([...items.values()], established);
    established = true;
    attempts = 0;
    resolveReady();
  }
  function start(): void {
    if (stopped || opening || subscription || timer) return;
    opening = true;
    const ownGeneration = ++generation;
    const task = options.open().then((page) => {
      if (stopped || ownGeneration !== generation) { releaseHandle(page.subscription); return; }
      opening = false;
      subscription = page.subscription;
      subscription.subscribe({
        snapshot: (page) => {
          if (stopped || generation !== ownGeneration) return;
          const ownEpoch = epoch + 1;
          track(snapshot(page, ownGeneration).catch((error) => {
            if (epoch === ownEpoch) fail(error, ownGeneration);
          }));
        },
        update: (message) => {
          if (stopped || generation !== ownGeneration) return;
          const update = options.update(message);
          if (!update) return;
          changes?.set(update.id, update.item);
          options.onUpdate(update.value);
        },
        error: (error) => fail(error, ownGeneration),
      });
    }).catch((error) => fail(error, ownGeneration));
    track(task);
  }
  start();
  return {
    ready,
    ensure: start,
    async release() {
      if (!stopped) {
        stopped = true;
        generation++;
        clearTimeout(timer);
        rejectReady(new Error('Catalog subscription released'));
        if (subscription) releaseHandle(subscription);
        subscription = null;
      }
      // Opening may resolve after cleanup and return another owned handle.
      while (work.size) await Promise.allSettled([...work]);
    },
  };
}
