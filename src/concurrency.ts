export function concurrencyLimit(value = 1): number {
  if (!Number.isInteger(value) || value < 1 || value > 3)
    throw new Error("Concurrency must be an integer from 1 to 3.");
  return value;
}
/** Wait for every worker before propagating failure, so callers can safely release directory locks. */
export async function forEachConcurrent<T>(
  items: T[],
  limit: number,
  action: (item: T, index: number) => Promise<void>,
): Promise<void> {
  concurrencyLimit(limit);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await action(items[index]!, index);
      }
    },
  );
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
/** Bounded reusable resources. A lease covers the entire action; failed resources are discarded. */
export class ResourcePool<T> {
  private idle: T[] = [];
  private available: number;
  private waiters: (() => void)[] = [];
  constructor(
    private readonly create: () => Promise<T>,
    private readonly discard: (resource: T) => Promise<void>,
    limit: number,
  ) {
    this.available = concurrencyLimit(limit);
  }
  async use<R>(action: (resource: T) => Promise<R>): Promise<R> {
    if (this.available > 0) this.available--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let resource: T | undefined;
    let reusable = false;
    try {
      resource = this.idle.pop() ?? (await this.create());
      const result = await action(resource);
      reusable = true;
      return result;
    } finally {
      if (resource !== undefined) {
        if (reusable) this.idle.push(resource);
        else await this.discard(resource).catch(() => {});
      }
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    }
  }
  async close(): Promise<void> {
    const resources = this.idle.splice(0);
    await Promise.all(resources.map((resource) => this.discard(resource)));
  }
}
/** Independent async work lane. Waiting for another lane never consumes one of these slots. */
export class TaskQueue {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Queue limit must be a positive integer.");
  }
  get running(): number {
    return this.active;
  }
  get waiting(): number {
    return this.waiters.length;
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await action();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
/** Promise-tail mutex. Rejections do not poison later jobs. */
export function serialQueue(): <T>(action: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(action: () => Promise<T>): Promise<T> => {
    const job = tail.then(action);
    tail = job.catch(() => {});
    return job;
  };
}
