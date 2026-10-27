use std::{fs, path::PathBuf};
use stellar_core::{domain::{AppError, Session, Settings}, ports::PreferencesRepository};

pub struct FilePreferences { directory: PathBuf }
impl FilePreferences { pub fn new(directory: PathBuf) -> Self { Self { directory } } }
fn storage_error(_: std::io::Error) -> AppError { AppError::new("preferences_io", "Could not save or load desktop preferences") }
impl PreferencesRepository for FilePreferences {
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
