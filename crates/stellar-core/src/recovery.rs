//! Preserve connection intent across an unexpected tunnel loss, not a user
//! disconnect. Native timers work even when a hidden webview is suspended.
use std::time::{Duration, Instant};
#[derive(Default)]
pub struct Recovery { target: Option<String>, deadline: Option<Instant>, attempts: u32 }
pub struct RecoveryAttempt { pub server_id: String, pub first: bool }
impl Recovery {
    pub fn cancel(&mut self) { *self = Self::default(); }
    pub fn established(&mut self, id: &str) { self.target = Some(id.into()); self.deadline = None; self.attempts = 0; }
    pub fn lost(&mut self, now: Instant) {
        if self.target.is_some() && self.deadline.is_none() { self.deadline = Some(now + Duration::from_secs(2)); }
    }
    pub fn owns(&self, id: &str) -> bool { self.target.as_deref() == Some(id) && self.deadline.is_some() }
    pub fn take_due(&mut self, now: Instant) -> Option<RecoveryAttempt> {
        if !self.deadline.is_some_and(|deadline| now >= deadline) { return None; }
        let server_id = self.target.clone()?;
        self.attempts = self.attempts.saturating_add(1);
        self.deadline = Some(now + Duration::from_secs(30));
        Some(RecoveryAttempt { server_id, first: self.attempts == 1 })
    }
    pub fn failed(&mut self, now: Instant) {
        let seconds = match self.attempts { 0 | 1 => 5, 2 => 10, 3 => 20, _ => 30 };
        if self.target.is_some() { self.deadline = Some(now + Duration::from_secs(seconds)); }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn loss_after_sleep_retries_without_a_webview_or_a_catch_up_burst() {
        let now = Instant::now(); let mut recovery = Recovery::default();
        recovery.established("dk-1"); assert!(recovery.take_due(now).is_none());
        recovery.lost(now); assert!(recovery.take_due(now + Duration::from_secs(1)).is_none());
        let wake = now + Duration::from_secs(3600);
        let first = recovery.take_due(wake).unwrap(); assert!(first.first); assert_eq!(first.server_id, "dk-1");
        assert!(recovery.take_due(wake).is_none());
        recovery.failed(wake);
        assert!(recovery.take_due(wake + Duration::from_secs(4)).is_none());
        assert!(!recovery.take_due(wake + Duration::from_secs(5)).unwrap().first);
    }
    #[test] fn explicit_disconnect_cancels_recovery_and_never_establishes_a_new_intent() {
        let now = Instant::now(); let mut recovery = Recovery::default();
        recovery.lost(now); assert!(recovery.take_due(now + Duration::from_secs(99)).is_none());
        recovery.established("dk-1"); recovery.lost(now); recovery.cancel();
        assert!(recovery.take_due(now + Duration::from_secs(99)).is_none());
        assert!(!recovery.owns("dk-1"));
    }
}
