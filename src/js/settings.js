/**
 * Settings Manager — handles loading/saving settings via Tauri IPC
 */

import { DEFAULT_HALIN_API_BASE_URL } from './config.js';

const { invoke } = window.__TAURI__.core;

// Default settings shape
const DEFAULT_SETTINGS = {
  source_language: 'auto',
  target_language: 'vi',
  audio_source: 'system',
  overlay_opacity: 0.85,
  font_size: 16,
  max_lines: 5,
  show_original: true,
  translation_mode: 'soniox',
  custom_context: null,
  elevenlabs_api_key: '',
  tts_enabled: false,
  tts_provider: 'edge',
  tts_voice_id: '21m00Tcm4TlvDq8ikWAM',
  tts_speed: 1.2,
  edge_tts_voice: 'vi-VN-HoaiMyNeural',
  edge_tts_speed: 50,
  tts_auto_read: true,
  // HaLin Classroom capture
  halin_enabled: false,
  halin_remember_password: false,
  halin_base_url: DEFAULT_HALIN_API_BASE_URL,
  halin_dashboard_url: 'https://noibo.hanoilink.edu.vn/dashboard',
  halin_api_token: '',
  halin_email: '',
  halin_access_token: '',
  halin_refresh_token: '',
  halin_chunk_seconds: 5,
  halin_lesson_type: 'conversation',
  halin_level: 'N5',
  halin_topic: '',
  halin_expected_interaction_mode: 'qa',
  // Lesson plan + schedule (optional)
  halin_scheduled_start: '', // datetime-local string (e.g. "2026-04-20T18:30") or ''
  halin_total_students_enrolled: '', // number-as-string or ''
  halin_lesson_plan_vocabulary: '', // comma-separated
  halin_lesson_plan_grammar: '', // comma-separated
};

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._listeners = [];
    this._saveTimer = null;
    this._pendingPatch = null;
    this._pendingResolvers = [];
  }

  /**
   * Load settings from Rust backend
   */
  async load() {
    try {
      const settings = await invoke('get_settings');
      const merged = { ...DEFAULT_SETTINGS, ...settings };
      // Security: never keep plaintext password in settings (legacy cleanup).
      if (merged && typeof merged === 'object' && 'halin_password' in merged) {
        try {
          delete merged.halin_password;
        } catch {
          // ignore
        }
      }
      this.settings = merged;
    } catch (err) {
      console.error('Failed to load settings:', err);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this._notify();
    return this.settings;
  }

  /**
   * Save settings to Rust backend
   */
  async save(newSettings) {
    try {
      const merged = { ...this.settings, ...newSettings };
      await invoke('save_settings', { newSettings: merged });
      this.settings = merged;
      this._notify();
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      throw err;
    }
  }

  /**
   * Debounced save: batch frequent small updates into one disk write.
   * Resolves once the underlying save has completed.
   */
  saveDebounced(patch, delayMs = 500) {
    const nextPatch = (patch && typeof patch === 'object') ? patch : {};
    this._pendingPatch = { ...(this._pendingPatch || {}), ...nextPatch };

    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    const p = new Promise((resolve, reject) => {
      this._pendingResolvers.push({ resolve, reject });
    });

    this._saveTimer = setTimeout(async () => {
      const payload = this._pendingPatch || {};
      const waiters = this._pendingResolvers.splice(0, this._pendingResolvers.length);
      this._pendingPatch = null;
      this._saveTimer = null;
      try {
        await this.save(payload);
        for (const w of waiters) w.resolve(true);
      } catch (e) {
        for (const w of waiters) w.reject(e);
      }
    }, delayMs);

    return p;
  }

  /**
   * Get current settings (cached)
   */
  get() {
    return { ...this.settings };
  }

  /**
   * Subscribe to settings changes
   */
  onChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notify() {
    const settings = this.get();
    this._listeners.forEach(cb => cb(settings));
  }
}

// Singleton
export const settingsManager = new SettingsManager();
