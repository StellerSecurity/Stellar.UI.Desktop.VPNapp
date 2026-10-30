use std::{fs, path::PathBuf};
use stellar_core::{domain::{AppError, Session, Settings}, ports::PreferencesRepository};

pub struct FilePreferences { directory: PathBuf }
impl FilePreferences { pub fn new(directory: PathBuf) -> Self { Self { directory } } }
fn storage_error(_: std::io::Error) -> AppError { AppError::new("preferences_io", "Could not save or load desktop preferences") }
impl PreferencesRepository for FilePreferences {
    fn load_selected_server(&self) -> Result<Option<String>, AppError> {
        match fs::read_to_string(self.directory.join("selected-location.txt")) {
            Ok(id) if id.len() <= 64 && !id.is_empty() && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') => Ok(Some(id)),
            Ok(_) => Ok(None),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(storage_error(error)),
        }
    }
    fn save_selected_server(&self, id: &str) -> Result<(), AppError> {
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') { return Err(AppError::new("invalid_server", "Invalid location")); }
        fs::create_dir_all(&self.directory).map_err(storage_error)?;
        let temporary = self.directory.join("selected-location.pending");
        fs::write(&temporary, id).map_err(storage_error)?;
        fs::rename(temporary, self.directory.join("selected-location.txt")).map_err(storage_error)
    }
    fn load(&self) -> Result<(Settings, Session), AppError> {
        let mut settings = Settings::default();
        let mut session = Session::default();
        let data = match fs::read_to_string(self.directory.join("preview-preferences.txt")) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((settings, session)),
            Err(error) => return Err(storage_error(error)),
        };
        for line in data.lines().take(20) {
            if let Some((key, value)) = line.split_once('=') {
                let flag = value == "true";
                match key {
                    "autoConnect" => settings.auto_connect = flag,
                    "killSwitch" => settings.kill_switch = flag,
                    "autoRotate" => settings.auto_rotate = flag,
                    "notifications" => settings.notifications = flag,
                    "menuBar" => settings.menu_bar = flag,
                    "language" => settings.language = value.to_string(),
                    // Never restore authentication from a non-secret preference file.
                    "onboardingComplete" => session.onboarding_complete = flag,
                    _ => {},
                }
            }
        }
        Ok((settings, session))
    }
    fn save(&self, settings: &Settings, session: &Session) -> Result<(), AppError> {
        settings.validate()?;
        fs::create_dir_all(&self.directory).map_err(storage_error)?;
        let data = format!("autoConnect={}\nkillSwitch={}\nautoRotate={}\nnotifications={}\nmenuBar={}\nlanguage={}\nauthenticated={}\nonboardingComplete={}\n",
            settings.auto_connect, settings.kill_switch, settings.auto_rotate, settings.notifications,
            settings.menu_bar, settings.language, false, session.onboarding_complete);
        let temporary = self.directory.join("preview-preferences.pending");
        fs::write(&temporary, data).map_err(storage_error)?;
        fs::rename(temporary, self.directory.join("preview-preferences.txt")).map_err(storage_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn fresh_preferences_default_on_but_explicit_off_and_last_location_survive_restart() {
        let directory = std::env::temp_dir().join(format!("stellar-preferences-test-{}", std::process::id()));
        let store = FilePreferences::new(directory.clone());
        assert!(store.load().unwrap().0.auto_connect);
        store.save(&Settings { auto_connect: false, ..Default::default() }, &Session::default()).unwrap();
        store.save_selected_server("ch-1").unwrap();
        let restored = FilePreferences::new(directory.clone());
        assert!(!restored.load().unwrap().0.auto_connect);
        assert_eq!(restored.load_selected_server().unwrap().as_deref(), Some("ch-1"));
        assert!(store.save_selected_server("../bad").is_err());
        for name in ["selected-location.txt", "preview-preferences.txt"] { fs::remove_file(directory.join(name)).unwrap(); }
        fs::remove_dir(directory).unwrap();
    }
}
