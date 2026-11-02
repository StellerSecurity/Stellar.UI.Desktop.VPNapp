export const ACCOUNT_REFRESH_INTERVAL = 4 * 60 * 60 * 1000;
export const CONNECTED_ACCOUNT_REFRESH_INTERVAL = 30 * 60 * 1000;
export class AccountRefresh {
  private last = -Infinity;
  mark(now: number) { this.last = now; }
  request(now: number, periodic = false, interval = ACCOUNT_REFRESH_INTERVAL): boolean {
    const elapsed = now - this.last;
    // A page-open, focus and wake event can describe the same user action.
    if (elapsed >= 0 && elapsed < (periodic ? interval : 2000)) return false;
    this.last = now;
    return true;
  }
}
