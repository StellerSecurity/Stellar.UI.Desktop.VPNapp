use std::{fs, path::PathBuf};
use stellar_core::{domain::{AppError, Session, Settings}, ports::PreferencesRepository};

pub struct FilePreferences { directory: PathBuf }
impl FilePreferences { pub fn new(directory: PathBuf) -> Self { Self { directory } } }
fn storage_error(_: std::io::Error) -> AppError { AppError::new("preferences_io", "Could not save or load desktop preferences") }
fn language_for_locale(locale: &str) -> &'static str {
    let base = locale.trim().split(['-', '_', '@', '.']).next().unwrap_or("").to_ascii_lowercase();
    match base.as_str() {
        "da" => "Dansk", "de" => "Deutsch", "tr" => "Türkçe", "es" => "Español", "sv" => "Svenska",
        "nb" | "nn" | "no" => "Norsk (bokmål)", "fr" => "Français", "it" => "Italiano",
        "nl" => "Nederlands", "pl" => "Polski", "pt" => "Português (Brasil)", _ => "English",
    }
}
fn system_language() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        // Read only the current user's public locale. No shell, process or dependency.
        use std::ffi::{c_char, c_void};
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            fn CFLocaleCopyCurrent() -> *const c_void;
            fn CFLocaleGetIdentifier(locale: *const c_void) -> *const c_void;
            fn CFStringGetCString(string: *const c_void, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
            fn CFRelease(value: *const c_void);
        }
        let mut buffer = [0u8; 128];
        let copied = unsafe {
            let locale = CFLocaleCopyCurrent();
            if locale.is_null() { return "English"; }
            let identifier = CFLocaleGetIdentifier(locale);
            let copied = !identifier.is_null() && CFStringGetCString(identifier, buffer.as_mut_ptr().cast(), buffer.len() as isize, 0x08000100) != 0;
            CFRelease(locale); copied
        };
        if copied {
            let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
            return language_for_locale(std::str::from_utf8(&buffer[..end]).unwrap_or("en"));
        }
    }
    "English"
}
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
        settings.language = system_language().into();
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
    #[test] fn locale_defaults_use_supported_languages_with_a_safe_fallback() {
        for (locale, expected) in [("da_DK", "Dansk"), ("de-DE", "Deutsch"), ("nb_NO", "Norsk (bokmål)"), ("nn-NO", "Norsk (bokmål)"), ("pt_PT", "Português (Brasil)"), ("fr_CA.UTF-8", "Français"), ("ja_JP", "English"), ("", "English")] {
            assert_eq!(language_for_locale(locale), expected);
        }
    }
    #[test] fn fresh_preferences_default_on_but_explicit_off_and_last_location_survive_restart() {
        let directory = std::env::temp_dir().join(format!("stellar-preferences-test-{}", std::process::id()));
        let store = FilePreferences::new(directory.clone());
        assert!(store.load().unwrap().0.auto_connect);
        store.save(&Settings { auto_connect: false, language: "Deutsch".into(), ..Default::default() }, &Session::default()).unwrap();
        store.save_selected_server("ch-1").unwrap();
        let restored = FilePreferences::new(directory.clone());
        assert!(!restored.load().unwrap().0.auto_connect);
        assert_eq!(restored.load().unwrap().0.language, "Deutsch");
        assert_eq!(restored.load_selected_server().unwrap().as_deref(), Some("ch-1"));
        assert!(store.save_selected_server("../bad").is_err());
        for name in ["selected-location.txt", "preview-preferences.txt"] { fs::remove_file(directory.join(name)).unwrap(); }
        fs::remove_dir(directory).unwrap();
    }
}
