import { codedError } from "./errors.mjs";

export class AsyncMutex {
  constructor(name, { timeoutMs = 30_000 } = {}) {
    this.name = name;
    this.timeoutMs = timeoutMs;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.owner = null;
  }

  async run(callback, { owner = null, timeoutMs = this.timeoutMs } = {}) {
    const previous = this.tail;
    let release;
    this.pending += 1;
    this.tail = new Promise((resolve) => { release = resolve; });
    let timer;
    let acquired = false;
    try {
      await Promise.race([
        previous,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(codedError(
            "LOCK_TIMEOUT",
            `Oracle Firefox timed out waiting for the ${this.name} lock. No browser action was attempted.`,
            { safeToRetry: true, details: { lock: this.name, pending: this.pending } },
          )), Math.max(1, timeoutMs));
          timer.unref?.();
        }),
      ]);
      acquired = true;
      this.owner = owner;
      return await callback();
    } finally {
      clearTimeout(timer);
      this.pending = Math.max(0, this.pending - 1);
      if (acquired) {
        this.owner = null;
        release();
      } else {
        // A cancelled waiter still owns its place in the promise chain. It may
        // pass that place on only after the preceding holder really releases.
        previous.then(release, release);
      }
    }
  }

  status() {
    return { name: this.name, pending: this.pending, owner: this.owner };
  }
}
