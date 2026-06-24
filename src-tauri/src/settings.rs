use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Default HaLin API base URL.
/// - debug build (`npm run tauri dev`): points to local backend
/// - release build (`npm run tauri build` / GitHub Actions): points to production
#[cfg(debug_assertions)]
const DEFAULT_HALIN_BASE_URL: &str = "http://localhost:8000";

#[cfg(not(debug_assertions))]
const DEFAULT_HALIN_BASE_URL: &str = "https://noibo.hanoilink.edu.vn";

/// Default HaLin Dashboard URL (the frontend web app).
#[cfg(debug_assertions)]
const DEFAULT_HALIN_DASHBOARD_URL: &str = "http://localhost:5173";

#[cfg(not(debug_assertions))]
const DEFAULT_HALIN_DASHBOARD_URL: &str = "https://noibo.hanoilink.edu.vn/dashboard";

/// Translation term: source → target mapping for Soniox
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

/// Custom context for Soniox — provides domain-specific hints
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    pub domain: Option<String>,
    pub translation_terms: Vec<TranslationTerm>,
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Overlay opacity: 0.0 - 1.0
    pub overlay_opacity: f64,
    /// Font size in px
    pub font_size: u32,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Whether to show original text alongside translation
    pub show_original: bool,
    /// Translation mode: "soniox" (cloud API) or "local" (MLX models)
    pub translation_mode: String,
    /// Optional custom context for better transcription
    pub custom_context: Option<CustomContext>,
    /// ElevenLabs API key for TTS narration
    pub elevenlabs_api_key: String,
    /// Whether TTS narration is enabled
    pub tts_enabled: bool,
    /// TTS provider: "edge" | "elevenlabs" | "google"
    pub tts_provider: String,
    /// ElevenLabs voice ID
    pub tts_voice_id: String,
    /// TTS speed multiplier (Web Speech)
    pub tts_speed: f64,
    /// Edge TTS voice name
    pub edge_tts_voice: String,
    /// Edge TTS speed percentage
    pub edge_tts_speed: i32,
    /// Auto-read new translations aloud
    pub tts_auto_read: bool,
    /// Google Cloud TTS API key
    pub google_tts_api_key: String,
    /// Google TTS voice name
    pub google_tts_voice: String,
    /// Google TTS speaking rate
    pub google_tts_speed: f64,
    /// Whether HaLin mode is enabled (backend STT)
    pub halin_enabled: bool,
    /// Remember HaLin password locally (opt-in)
    pub halin_remember_password: bool,
    /// HaLin backend base URL (e.g. http://127.0.0.1:8000)
    pub halin_base_url: String,
    /// HaLin dashboard web URL (e.g. http://localhost:5173)
    pub halin_dashboard_url: String,
    /// HaLin desktop API token (Authorization: Bearer ...)
    pub halin_api_token: String,
    /// HaLin user email (JWT login)
    pub halin_email: String,
    /// HaLin user password (JWT login) — MVP only (stored locally)
    pub halin_password: String,
    /// HaLin JWT access token
    pub halin_access_token: String,
    /// HaLin JWT refresh token
    pub halin_refresh_token: String,
    /// Classroom chunk size in seconds (2–5 typical)
    pub halin_chunk_seconds: u32,
    /// Default session profile presets for classroom mode
    pub halin_lesson_type: String,
    pub halin_level: String,
    pub halin_topic: String,
    pub halin_expected_interaction_mode: String,
    /// Phase 7C — when the desktop fetches today-sessions and the teacher picks
    /// one, this id is sent to the server which then auto-fills topic /
    /// objectives / duration from the ClassLessonPlan.
    #[serde(default)]
    pub halin_class_lesson_plan_id: String,
    /// Phase 7C — optional per-session goal appended to the lesson plan's objective.
    #[serde(default)]
    pub halin_bonus_objective: String,
    #[serde(default)]
    pub halin_objective: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            source_language: "auto".to_string(),
            target_language: "vi".to_string(),
            audio_source: "system".to_string(),
            overlay_opacity: 0.85,
            font_size: 16,
            max_lines: 5,
            show_original: true,
            translation_mode: "soniox".to_string(),
            custom_context: None,
            elevenlabs_api_key: String::new(),
            tts_enabled: false,
            tts_provider: "edge".to_string(),
            tts_voice_id: "21m00Tcm4TlvDq8ikWAM".to_string(),
            tts_speed: 1.2,
            edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            edge_tts_speed: 50,
            tts_auto_read: true,
            google_tts_api_key: String::new(),
            google_tts_voice: "vi-VN-Chirp3-HD-Aoede".to_string(),
            google_tts_speed: 1.0,
            halin_enabled: false,
            halin_remember_password: false,
            halin_base_url: DEFAULT_HALIN_BASE_URL.to_string(),
            halin_dashboard_url: DEFAULT_HALIN_DASHBOARD_URL.to_string(),
            halin_api_token: String::new(),
            halin_email: String::new(),
            halin_password: String::new(),
            halin_access_token: String::new(),
            halin_refresh_token: String::new(),
            halin_chunk_seconds: 5,
            halin_lesson_type: "conversation".to_string(),
            halin_level: "N5".to_string(),
            halin_topic: "".to_string(),
            halin_expected_interaction_mode: "qa".to_string(),
            halin_class_lesson_plan_id: String::new(),
            halin_bonus_objective: String::new(),
            halin_objective: String::new(),
        }
    }
}

/// Get the settings file path
/// ~/Library/Application Support/com.personal.translator/settings.json
fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.translator");
    path.push("settings.json");
    path
}

impl Settings {
    /// Load settings from disk, or return defaults
    pub fn load() -> Self {
        let path = settings_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    /// Save settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json =
            serde_json::to_string_pretty(self).map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

        Ok(())
    }
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);
