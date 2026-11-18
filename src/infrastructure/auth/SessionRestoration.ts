/** Share startup work, but never remember a failed vault read as a completed restore. */
export class SessionRestoration {
  private pending?: Promise<void>;

  run(restore: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    if (!this.pending) {
      const pending: Promise<void> = Promise.resolve().then(() => restore(() => this.pending === pending));
      this.pending = pending;
      void pending.catch(() => { if (this.pending === pending) this.pending = undefined; });
    }
    return this.pending;
  }

  complete(): void { this.pending = Promise.resolve(); }
}
