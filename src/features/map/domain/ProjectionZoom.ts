/** One trackpad/pinch gesture must not become a second zoom after projection handoff. */
export class ProjectionZoom {
  private lastGesture = -Infinity;
  private handoff = false;
  readonly overviewZoom = 1.05;

  begin(now: number) { this.handoff = true; this.lastGesture = now; }
  consume(now: number, transitioning: boolean) {
    if (!this.handoff) return false;
    if (transitioning || now - this.lastGesture < 180) {
      this.lastGesture = now;
      return true;
    }
    this.handoff = false;
    return false;
  }
}
