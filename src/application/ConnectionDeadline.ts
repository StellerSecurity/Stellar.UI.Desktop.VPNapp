/** One budget shared by configuration loading and the native tunnel attempt. */
export class ConnectionDeadline {
  private readonly started: number;
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; this.started = now(); }
  remaining(): number {
    const milliseconds = Math.floor(30_000 - (this.now() - this.started));
    if (milliseconds <= 0) throw new Error('Connection timed out after 30 seconds. Please try again.');
    return Math.min(30_000, milliseconds);
  }
}
