type Resolver<T> = (value: T | { __done: true }) => void;

export class InputQueue<T> {
  private buffer: T[] = [];
  private waiting: Resolver<T> | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(value);
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ __done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<T | { __done: true }>((resolve) => {
        this.waiting = resolve;
      });
      if (typeof next === "object" && next !== null && "__done" in next) return;
      yield next;
    }
  }
}
