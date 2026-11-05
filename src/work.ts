/** Own admitted operations through cancellation and awaited teardown. */
export class Work {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /** Combine caller cancellation with this instance's lifetime. */
  signal(caller?: AbortSignal): AbortSignal {
    this.controller.signal.throwIfAborted()
    return caller === undefined ? this.controller.signal : AbortSignal.any([caller, this.controller.signal])
  }

  /** Retain an operation until its own cleanup has completed. */
  run<T>(operation: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    const signal = this.signal(caller)
    const promise = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal) })
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }

  /** Stop admission, abort consumers, then await their settlement. */
  async close(): Promise<void> {
    this.controller.abort(new Error('ChatGPT plan plugin stopped'))
    await Promise.allSettled([...this.pending])
  }
}
