//! Native, monotonic scheduling: no webview timer and no catch-up burst after sleep.
use std::time::{Duration, Instant};
pub const ROTATION_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
#[derive(Default)]
pub struct RotationSchedule { deadline: Option<Instant> }
impl RotationSchedule {
    pub fn reset(&mut self, enabled: bool, connected: bool, now: Instant) {
        self.deadline = (enabled && connected).then(|| now + ROTATION_INTERVAL);
    }
    pub fn due(&self, now: Instant) -> bool { self.deadline.is_some_and(|deadline| now >= deadline) }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rotation_uses_seven_days_not_thirty_minutes() {
        assert_eq!(ROTATION_INTERVAL.as_secs(), 604_800);
        let now = Instant::now(); let mut timer = RotationSchedule::default();
        timer.reset(true, true, now);
        assert!(!timer.due(now + Duration::from_secs(30 * 60)));
        assert!(!timer.due(now + Duration::from_secs(604_799)));
        assert!(timer.due(now + Duration::from_secs(604_800)));
    }
    #[test] fn disabled_and_disconnected_never_rotate() {
        let now = Instant::now(); let mut timer = RotationSchedule::default();
        for (enabled, connected) in [(false, false), (false, true), (true, false)] {
            timer.reset(enabled, connected, now); assert!(!timer.due(now + ROTATION_INTERVAL * 10));
        }
    }
    #[test] fn exact_deadline_and_sleep_wake_only_produce_one_attempt() {
        let now = Instant::now(); let mut timer = RotationSchedule::default();
        timer.reset(true, true, now);
        assert!(!timer.due(now + ROTATION_INTERVAL - Duration::from_millis(1)));
        assert!(timer.due(now + ROTATION_INTERVAL));
        let wake = now + ROTATION_INTERVAL * 10;
        assert!(timer.due(wake)); timer.reset(true, true, wake);
        assert!(!timer.due(wake)); assert!(!timer.due(wake + Duration::from_secs(1)));
    }
    #[test] fn manual_switch_restarts_the_full_interval() {
        let now = Instant::now(); let mut timer = RotationSchedule::default();
        timer.reset(true, true, now); timer.reset(true, true, now + Duration::from_secs(60));
        assert!(!timer.due(now + ROTATION_INTERVAL));
        assert!(timer.due(now + ROTATION_INTERVAL + Duration::from_secs(60)));
    }
}
