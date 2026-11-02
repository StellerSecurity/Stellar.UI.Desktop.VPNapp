//! Stellar policy inspired by state-driven VPN UX; no OS calls or third-party code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateNotice { Downloading(String), Ready(String), Installing(String), Completed(String), Failed }
#[derive(Default)]
pub struct UpdateNotificationPolicy { last: Option<UpdateNotice> }
impl UpdateNotificationPolicy {
    pub fn message(&mut self, notice: UpdateNotice, enabled: bool) -> Option<String> {
        if !enabled || self.last.as_ref() == Some(&notice) { return None; }
        let version = match &notice { UpdateNotice::Downloading(v) | UpdateNotice::Ready(v) | UpdateNotice::Installing(v) | UpdateNotice::Completed(v) => Some(v), UpdateNotice::Failed => None };
        if version.is_some_and(|v| v.is_empty() || v.len() > 32 || !v.bytes().all(|b| b.is_ascii_digit() || b == b'.')) { return None; }
        let message = match &notice {
            UpdateNotice::Downloading(v) => format!("Downloading Stellar VPN {v}. Your VPN connection is unchanged."),
            UpdateNotice::Ready(v) => format!("Stellar VPN {v} is verified and ready to install."),
            UpdateNotice::Installing(v) => format!("Installing Stellar VPN {v}. The app will restart."),
            UpdateNotice::Completed(v) => format!("Stellar VPN was updated to {v}."),
            UpdateNotice::Failed => "The update could not be completed. Open Stellar VPN for details.".into(),
        };
        self.last = Some(notice); Some(message)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    Connecting(String), Switching(String), Connected(String), LocationChanged(String), Disconnecting,
    Disconnected, Failed, DisconnectFailed, TimedOut, Lost, Blocked,
}
impl Notice {
    pub fn delayed(&self) -> bool { matches!(self, Self::Connecting(_) | Self::Switching(_)) }
    pub fn message(&self) -> String {
        self.message_for_location(None)
    }
    pub fn server_id(&self) -> Option<&str> {
        match self { Self::Connecting(id) | Self::Switching(id) | Self::Connected(id) | Self::LocationChanged(id) => Some(id), _ => None }
    }
    pub fn message_for_location(&self, name: Option<&str>) -> String {
        let location = name.unwrap_or("the selected location");
        match self {
            Self::Connecting(_) => format!("Connecting to {location}…"),
            Self::Switching(_) => format!("Switching location to {location}…"),
            Self::Connected(_) => format!("Connected to {location}."),
            Self::LocationChanged(_) => format!("Location changed to {location}."),
            Self::Disconnecting => "Disconnecting…".into(),
            Self::Disconnected => "VPN disconnected.".into(),
            Self::Failed => "Couldn’t connect. Open Stellar VPN to try again.".into(),
            Self::DisconnectFailed => "Couldn’t disconnect. Open Stellar VPN to check your connection.".into(),
            Self::TimedOut => "Connection timed out after 30 seconds. Open Stellar VPN to try again.".into(),
            Self::Lost => "VPN connection lost. Your traffic is no longer protected by Stellar VPN.".into(),
            Self::Blocked => "VPN connection lost. Internet access is blocked by the kill switch.".into(),
        }
    }
}
#[derive(Default)]
pub struct NotificationPolicy { pub current: Option<Notice>, revision: u64 }
impl NotificationPolicy {
    pub fn transition(&mut self, next: Notice) -> Option<u64> {
        if self.current.as_ref() == Some(&next) { return None; }
        self.current = Some(next); self.revision = self.revision.wrapping_add(1); Some(self.revision)
    }
    pub fn deliver(&self, revision: u64, visible: bool, enabled: bool) -> Option<&Notice> {
        if revision != self.revision || visible || !enabled { return None; }
        self.current.as_ref().filter(|event| !matches!(event, Notice::Disconnecting))
    }
    pub fn busy(&self) -> bool { matches!(self.current, Some(Notice::Connecting(_) | Notice::Switching(_) | Notice::Disconnecting)) }
    pub fn unexpected_disconnect(&self) -> bool {
        matches!(self.current, None | Some(Notice::Connected(_) | Notice::LocationChanged(_) | Notice::DisconnectFailed))
    }
    pub fn connection_announced(&self, id: &str) -> bool {
        matches!(&self.current, Some(Notice::Connected(current) | Notice::LocationChanged(current)) if current == id)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn update_notifications_are_separate_deduplicated_and_respect_the_preference() {
        let mut updates = UpdateNotificationPolicy::default();
        assert!(updates.message(UpdateNotice::Downloading("1.2.3".into()), false).is_none());
        let downloading = updates.message(UpdateNotice::Downloading("1.2.3".into()), true).unwrap();
        assert!(!downloading.contains("verified"));
        assert!(updates.message(UpdateNotice::Downloading("1.2.3".into()), true).is_none());
        assert!(updates.message(UpdateNotice::Ready("1.2.3".into()), true).unwrap().contains("verified"));
        assert!(updates.message(UpdateNotice::Installing("1.2.3".into()), true).unwrap().contains("restart"));
        assert!(updates.message(UpdateNotice::Completed("1.2.3".into()), true).unwrap().contains("updated to 1.2.3"));
        assert!(updates.message(UpdateNotice::Failed, true).unwrap().contains("could not be completed"));
        assert!(updates.message(UpdateNotice::Ready("<script>".into()), true).is_none());
    }
    #[test] fn blocking_notice_is_distinct_from_an_unprotected_loss() {
        assert!(Notice::Blocked.message().contains("blocked by the kill switch"));
        assert!(!Notice::Lost.message().contains("blocked"));
    }
    #[test] fn notifications_use_location_names_without_changing_server_identity() {
        let notice = Notice::LocationChanged("ch-1".into());
        assert_eq!(notice.server_id(), Some("ch-1"));
        assert_eq!(notice.message_for_location(Some("Switzerland – Zurich")), "Location changed to Switzerland – Zurich.");
        for event in [Notice::Connecting("ch-1".into()), Notice::Switching("ch-1".into()), Notice::Connected("ch-1".into()), notice] {
            assert!(event.message_for_location(Some("Switzerland – Zurich")).contains("Switzerland – Zurich"));
            assert!(!event.message().contains("ch-1"));
        }
    }
    #[test] fn location_change_is_announced_once_and_later_loss_is_still_reportable() {
        let mut policy = NotificationPolicy::default();
        policy.transition(Notice::Connected("de-1".into()));
        policy.transition(Notice::Switching("ch-1".into()));
        let revision = policy.transition(Notice::LocationChanged("ch-1".into())).unwrap();
        assert!(policy.connection_announced("ch-1"));
        assert!(!policy.connection_announced("de-1"));
        assert!(policy.deliver(revision, false, true).unwrap().message().contains("Location changed"));
        assert!(policy.deliver(revision, true, true).is_none());
        assert!(policy.transition(Notice::LocationChanged("ch-1".into())).is_none());
        assert!(policy.unexpected_disconnect());
    }
    #[test] fn suppresses_duplicates_visible_windows_and_disabled_preferences() {
        let mut policy = NotificationPolicy::default();
        let version = policy.transition(Notice::Connected("de-1".into())).unwrap();
        assert!(policy.transition(Notice::Connected("de-1".into())).is_none());
        assert!(policy.deliver(version, true, true).is_none());
        assert!(policy.deliver(version, false, false).is_none());
        assert!(policy.deliver(version, false, true).is_some());
    }
    #[test] fn newer_states_cancel_pending_connecting_and_allow_a_real_reconnect() {
        let mut policy = NotificationPolicy::default();
        let pending = policy.transition(Notice::Connecting("de-1".into())).unwrap();
        assert!(policy.busy());
        let connected = policy.transition(Notice::Connected("de-1".into())).unwrap();
        assert!(!policy.busy()); assert!(policy.deliver(pending, false, true).is_none());
        assert!(policy.deliver(connected, false, true).is_some());
        policy.transition(Notice::Disconnected);
        assert!(policy.transition(Notice::Connected("de-1".into())).is_some());
    }
    #[test] fn timeout_replaces_connecting_without_claiming_traffic_blocking() {
        let mut policy = NotificationPolicy::default();
        let pending = policy.transition(Notice::Connecting("de-1".into())).unwrap();
        let failed = policy.transition(Notice::TimedOut).unwrap();
        assert!(policy.deliver(pending, false, true).is_none());
        assert!(policy.deliver(failed, false, true).unwrap().message().contains("30 seconds"));
        assert!(!Notice::Lost.message().contains("blocked"));
    }
    #[test] fn deliberate_disconnect_and_failed_switch_are_not_reported_as_tunnel_loss() {
        let mut policy = NotificationPolicy::default();
        assert!(policy.unexpected_disconnect());
        policy.transition(Notice::Connected("de-1".into()));
        assert!(policy.unexpected_disconnect());
        for event in [Notice::Disconnecting, Notice::Disconnected, Notice::Switching("ch-1".into()), Notice::Failed, Notice::TimedOut, Notice::Lost] {
            policy.transition(event);
            assert!(!policy.unexpected_disconnect());
        }
    }
    #[test] fn disconnect_failure_is_deliverable_and_does_not_hide_later_tunnel_loss() {
        let mut policy = NotificationPolicy::default();
        let pending = policy.transition(Notice::Disconnecting).unwrap();
        assert!(policy.deliver(pending, false, true).is_none());
        let failure = policy.transition(Notice::DisconnectFailed).unwrap();
        assert!(!policy.busy());
        assert!(policy.unexpected_disconnect());
        assert!(policy.deliver(failure, false, true).is_some());
        assert!(policy.deliver(failure, false, false).is_none());
    }
}
