/**
 * App — main application controller
 * Wires together: settings, UI, HaLin backend STT, and audio capture
 */

import { DEFAULT_HALIN_API_BASE_URL } from './config.js';
import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { halinRefresh } from './halin-auth.js';
import { elevenLabsTTS } from './elevenlabs-tts.js';
import { googleTTS } from './google-tts.js';
import { edgeTTSRust } from './edge-tts.js';
import { audioPlayer } from './audio-player.js';
import { updater } from './updater.js';
import { HalinClassroomSession } from './halin-classroom.js';
import { halinLogin, halinLogout, halinMe } from './halin-auth.js';
import { exportLogs } from './logger.js';
import { finalizeLiveSession, getJobStatus } from './halin-client.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const HALIN_PENDING_FINALIZE_KEY = 'halin_pending_finalize';

/** Match finalize/chunk 401 wording from HaLin API (see halin-classroom.js). */
function shouldRetryAuthAfterErrorMessage(msg) {
    const m = String(msg || '').toLowerCase();
    return (
        m.includes('unauthorized') ||
        m.includes('missing bearer') ||
        m.includes('invalid access token') ||
        m.includes('access token expired') ||
        /\b401\b/.test(m)
    );
}

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false; // Guard against re-entry
        this.currentSource = 'system'; // 'system' | 'microphone' | 'both'
        this.translationMode = 'soniox'; // 'soniox' | 'local'
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow();
        this.localPipelineChannel = null;
        this.localPipelineReady = false;
        this.recordingStartTime = null;
        this.lastSessionDurationLabel = null; // set in _snapshotSessionDurationLabel() on stop
        this.sessionStartTime = null;  // Session start timestamp (new Date())
        this.sessionSourceLang = 'auto';
        this.sessionTargetLang = 'vi';
        this.sessionMode = 'one_way';
        this.ttsEnabled = false;  // TTS runtime toggle
        this.isPinned = false;    // Always-on-top (toggle with toolbar pin; default: normal stacking)
        this.isCompact = false;   // Compact mode (hide control bar)
        this._sessionTimerInterval = null;
        this._lastConfidence = null;
        this.halinSession = new HalinClassroomSession({
            getSettings: () => settingsManager.get(),
            setSettings: async (patch) => {
                const current = settingsManager.get();
                await settingsManager.save({ ...current, ...patch });
            },
            getClientSegmentsForFinalize: () => {
                try {
                    return this.transcriptUI?.getHalinFinalizeSegments?.() ?? null;
                } catch {
                    return null;
                }
            },
            getLiveWavBytesForFinalize: () => {
                try {
                    return this._buildLiveWavBytesForFinalize?.() ?? null;
                } catch {
                    return null;
                }
            },
            onLiveWavAfterCapture: async (wavBytes, { jobId }) => {
                try {
                    const b64 = this._uint8ArrayToBase64(wavBytes);
                    const path = await invoke('save_live_wav', {
                        wavBase64: b64,
                        jobId: jobId != null ? String(jobId) : null,
                    });
                    const name = String(path || '').split(/[/\\]/).pop() || path;
                    this._showToast(`Đã lưu WAV kiểm tra: ${name}`, 'success');
                } catch (e) {
                    console.warn('[HaLin] save live wav local:', e);
                    this._showToast(`Không lưu được WAV cục bộ: ${String(e?.message || e)}`, 'error');
                }
            },
            onTranscriptSegments: (segments) => {
                if (!Array.isArray(segments) || !this.transcriptUI) return;
                for (const seg of segments) {
                    const t = String(seg?.text || '').trim();
                    if (!t) continue;
                    const speaker = seg.speaker != null ? seg.speaker : null;
                    const lang = seg.language != null ? String(seg.language) : null;
                    this.transcriptUI.addSttFinalSegment(t, speaker, lang);
                }
            },
            onStatus: (msg) => {
                const m = String(msg || '');
                if (/^(Buffered audio chunk|Sent chunk #)/.test(m)) {
                    this._updateHalinBackendStatus();
                    return;
                }
                this._showToast(m, 'success');
                this._updateHalinBackendStatus();
            },
            onError: (e) => {
                this._showToast(String(e?.message || e), 'error');
                this._updateHalinBackendStatus({ last_error: String(e?.message || e) });
            },
            onMetrics: (m) => this._updateHalinBackendStatus(m),
        });
        this._refreshing = false;
        this._refreshPromise = null;
    }

    async _refreshTokenOnce(baseUrl, refreshToken) {
        if (this._refreshing) return this._refreshPromise;
        this._refreshing = true;
        this._refreshPromise = (async () => {
            const rt = String(refreshToken || '').trim();
            if (!rt) return null;
            const r = await halinRefresh({ baseUrl, refreshToken: rt });
            await settingsManager.save({
                ...settingsManager.get(),
                halin_access_token: r.access_token || '',
                halin_refresh_token: r.refresh_token || '',
            });
            return r;
        })().finally(() => {
            this._refreshing = false;
            this._refreshPromise = null;
        });
        return this._refreshPromise;
    }

    /** Encode binary for Tauri IPC (avoids stack overflow on large buffers). */
    _uint8ArrayToBase64(u8) {
        const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || []);
        const CHUNK = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        return btoa(binary);
    }

    _buildWavFromPcmS16le(pcmBytes, sampleRate = 16000, numChannels = 1) {
        const pcm = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes || []);
        const bytesPerSample = 2;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = pcm.length;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        const writeStr = (off, s) => {
            for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
        };
        writeStr(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true); // PCM fmt chunk size
        view.setUint16(20, 1, true); // PCM format
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true); // bits per sample
        writeStr(36, 'data');
        view.setUint32(40, dataSize, true);
        new Uint8Array(buffer, 44).set(pcm);
        return new Uint8Array(buffer);
    }

    _mergeUint8Chunks(chunks) {
        const arr = Array.isArray(chunks) ? chunks : [];
        const total = arr.reduce((s, b) => s + (b?.length || 0), 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const b of arr) {
            if (!b || !b.length) continue;
            out.set(b, off);
            off += b.length;
        }
        return out;
    }

    _updateHalinBackendStatus(metrics) {
        const enabled = this.halinSession?.isEnabled?.() ? true : false;
        const running = this.halinSession?.running ? true : false;
        const jobId = metrics?.job_id ?? this.halinSession?.jobId ?? null;
        const pending = typeof metrics?.pending_count === 'number'
            ? metrics.pending_count
            : (this.halinSession?._queue?.pendingCount?.() ?? 0);
        const lastAcked = metrics?.last_acked_seq ?? this.halinSession?._lastAckedSeq ?? null;
        const lastErr = metrics?.last_error ?? this.halinSession?._lastError ?? null;

        const st = document.getElementById('halin-backend-stt-status');
        if (st) {
            if (!enabled) st.textContent = 'HaLin: tắt';
            else if (enabled && !running) st.textContent = 'HaLin: bật (chờ)';
            else st.textContent = 'HaLin: bật (đang chạy)';
        }
        const jid = document.getElementById('halin-job-id');
        if (jid) jid.textContent = jobId || '—';
        const q = document.getElementById('halin-queue-status');
        if (q) q.textContent = `chờ=${pending}, xác nhận=${(lastAcked ?? '—')}`;
        const le = document.getElementById('halin-last-error');
        if (le) le.textContent = lastErr ? String(lastErr).slice(0, 180) : '—';
    }

    /** Khi tắt HaLin Phân Tích: luôn được bắt đầu. Khi bật: cần chủ đề đã lưu trong cài đặt. */
    _sessionSetupAllowsStart() {
        if (!this.halinSession?.isEnabled?.()) return true;
        return String(settingsManager.get().halin_topic || '').trim().length > 0;
    }

    _initSessionSetupCard() {
        const card = document.getElementById('session-setup-card');
        const btnSave = document.getElementById('btn-ssc-save');
        const status = document.getElementById('ssc-status');
        if (!card || !btnSave) return;

        const ltEl = document.getElementById('ssc-lesson-type');
        const lvEl = document.getElementById('ssc-level');
        const tpEl = document.getElementById('ssc-topic');
        const schedEl = document.getElementById('ssc-scheduled-start');
        const totalEl = document.getElementById('ssc-total-students');
        const lpVocabEl = document.getElementById('ssc-lesson-plan-vocab');
        const lpGrammarEl = document.getElementById('ssc-lesson-plan-grammar');

        const syncHint = () => {
            const hint = document.getElementById('ssc-topic-hint');
            if (!hint) return;
            hint.textContent = this.halinSession?.isEnabled?.() ? '(bắt buộc khi HaLin bật)' : '';
        };

        const populate = (s) => {
            const ss = s || settingsManager.get();
            if (ltEl) this._ensureSelectOption(ltEl, ss.halin_lesson_type || 'mixed');
            if (lvEl) this._ensureSelectOption(lvEl, ss.halin_level || 'N4');
            if (tpEl && document.activeElement !== tpEl) tpEl.value = ss.halin_topic || '';
            const em = ss.halin_expected_interaction_mode || 'qa';
            const r = document.querySelector(`input[name="ssc-expected-mode"][value="${em}"]`);
            if (r) r.checked = true;
            if (schedEl && document.activeElement !== schedEl) schedEl.value = String(ss.halin_scheduled_start || '');
            if (totalEl && document.activeElement !== totalEl) totalEl.value = String(ss.halin_total_students_enrolled || '');
            if (lpVocabEl && document.activeElement !== lpVocabEl) lpVocabEl.value = String(ss.halin_lesson_plan_vocabulary || '');
            if (lpGrammarEl && document.activeElement !== lpGrammarEl) lpGrammarEl.value = String(ss.halin_lesson_plan_grammar || '');
            syncHint();
            if (status) {
                status.textContent = this._sessionSetupAllowsStart() ? '✓ Sẵn sàng bắt đầu' : '';
                status.className = this._sessionSetupAllowsStart() ? 'ssc-status ready' : 'ssc-status';
            }
        };

        this._syncSessionSetupCard = populate;
        populate(settingsManager.get());

        btnSave.addEventListener('click', async () => {
            const lesson = ltEl?.value || 'mixed';
            const level = lvEl?.value || 'N4';
            const topic = tpEl?.value.trim() || '';
            const halinOn = this.halinSession?.isEnabled?.() ? true : false;
            const expectedMode =
                document.querySelector('input[name="ssc-expected-mode"]:checked')?.value || 'qa';
            const scheduledStart = schedEl?.value || '';
            const totalStudents = totalEl?.value || '';
            const lpVocab = lpVocabEl?.value || '';
            const lpGrammar = lpGrammarEl?.value || '';

            if (halinOn && !topic) {
                if (status) {
                    status.textContent = '⚠️ Nhập chủ đề để bật HaLin Phân Tích';
                    status.className = 'ssc-status';
                }
                tpEl?.focus();
                return;
            }

            try {
                await settingsManager.save({
                    ...settingsManager.get(),
                    halin_lesson_type: lesson,
                    halin_level: level,
                    halin_topic: topic,
                    halin_expected_interaction_mode: expectedMode,
                    halin_scheduled_start: scheduledStart,
                    halin_total_students_enrolled: totalStudents,
                    halin_lesson_plan_vocabulary: lpVocab,
                    halin_lesson_plan_grammar: lpGrammar,
                });
            } catch (e) {
                if (status) {
                    status.textContent = 'Lưu thất bại: ' + String(e?.message || e);
                    status.className = 'ssc-status';
                }
                return;
            }

            if (status) {
                status.textContent = '✓ Sẵn sàng bắt đầu';
                status.className = 'ssc-status ready';
            }
            this._updateStartButton();
            this._showToast('Đã lưu thiết lập buổi học', 'success');
        });
    }

    async _applyHalinEnabledToggle(next) {
        const on = Boolean(next);
        this.halinSession.setEnabled(on);
        const btn = document.getElementById('btn-halin');
        if (btn) {
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        const chk = document.getElementById('check-halin-enabled');
        if (chk) chk.checked = on;
        const s = settingsManager.get();
        try {
            await settingsManager.save({ ...s, halin_enabled: on });
        } catch {
            /* ignore */
        }
        this._updateModeUI(this.translationMode);
        this._updateHalinBackendStatus();
        this._updateStartButton();
    }

    async init() {
        // Load settings
        await settingsManager.load();

        // HaLin: recover finalize if app crashed / network dropped mid-finalize
        void this._maybeRetryPendingHalinFinalize().catch(() => {});
        this._syncRecoverButtonVisibility();
        window.addEventListener('halin:pending-finalize-changed', () => this._syncRecoverButtonVisibility());

        // Init transcript UI
        const transcriptContainer = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(transcriptContainer);

        // Check platform — hide Local MLX on non-Apple-Silicon
        await this._checkPlatformSupport();

        // Apply saved settings to UI
        this._applySettings(settingsManager.get());
        this._refreshSessionChrome(settingsManager.get());
        this._updateHalinBackendStatus();

        // Bind event listeners
        this._bindEvents();
        this._initSessionSetupCard();
        this._initSettingsScrollIndicator();
        this._initNetworkMonitor();

        // Bind keyboard shortcuts
        this._bindKeyboardShortcuts();

        // Subscribe to settings changes
        settingsManager.onChange((settings) => {
            this._applySettings(settings);
            this._refreshSessionChrome(settings);
            this._syncSessionSetupCard?.(settings);
            this._updateSettingsConnectionCard();
            this._syncRecoverButtonVisibility();
        });

        // Init audio player for TTS
        audioPlayer.init();

        // Wire TTS audio callbacks for providers that use audioPlayer
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onAudioChunk = (base64Audio, isFinal) => {
                audioPlayer.enqueue(base64Audio);
            };
        }
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onError = (error) => {
                console.error('[TTS]', error);
                this._showToast(error, 'error');
            };
        }

        // Window position restore disabled — causes issues on Retina displays
        // await this._restoreWindowPosition();

        // Check for updates (non-blocking)
        this._initAboutTab();
        this._checkForUpdates();

        this._applyAuthShell();

        // Keep OS always-on-top in sync with default (see tauri.conf + isPinned)
        try {
            const pinBtn = document.getElementById('btn-pin');
            if (pinBtn) pinBtn.classList.toggle('active', this.isPinned);
            await this.appWindow.setAlwaysOnTop(this.isPinned);
        } catch (e) {
            console.warn('setAlwaysOnTop:', e);
        }

        console.log('🌐 HaLin AI Platform initialized');
    }

    _isAppAuthenticated() {
        const s = settingsManager.get();
        const access = String(s.halin_access_token || '').trim();
        const legacy = String(s.halin_api_token || '').trim();
        return Boolean(access || legacy);
    }

    _populateLoginForm() {
        const s = settingsManager.get();
        const base = document.getElementById('input-login-base-url');
        const email = document.getElementById('input-login-email');
        const pw = document.getElementById('input-login-password');
        const remember = document.getElementById('check-login-remember');
        const tok = document.getElementById('input-login-api-token');
        if (base) base.value = s.halin_base_url || DEFAULT_HALIN_API_BASE_URL;
        if (email) email.value = s.halin_email || '';
        if (remember) remember.checked = Boolean(s.halin_remember_password);
        if (pw) {
            pw.value = s.halin_remember_password ? (s.halin_saved_password || '') : '';
            // Trigger input event để nút toggle eye hiện khi có giá trị được điền sẵn
            if (pw.value) pw.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (tok) tok.value = s.halin_api_token || '';
    }

    _setLoginStatus(text, variant) {
        const el = document.getElementById('login-auth-status');
        if (!el) return;
        el.textContent = text || '';
        el.classList.remove('login-status-error', 'login-status-ok');
        if (variant === 'error') el.classList.add('login-status-error');
        if (variant === 'ok') el.classList.add('login-status-ok');
    }

    _setLoginSubmitLoading(isLoading) {
        const btn = document.getElementById('btn-login-submit');
        const textEl = btn?.querySelector('.login-btn-text');
        if (!btn || !textEl) return;
        btn.disabled = isLoading;
        btn.classList.toggle('is-loading', isLoading);
        textEl.textContent = isLoading ? 'Đang đăng nhập…' : 'Đăng nhập';
    }

    /** Thông báo gần gũi cho giáo viên — ẩn chi tiết kỹ thuật đăng nhập */
    _friendlyLoginError(err) {
        let raw = '';
        if (err != null) {
            if (typeof err === 'string') raw = err;
            else raw = String(err.message || err.error || err);
        }
        raw = raw.trim();
        const lower = raw.toLowerCase();
        if (
            lower.includes('invalid email or password')
            || lower.includes('invalid credentials')
            || /401|403/.test(raw)
            || lower.includes('unauthorized')
            || lower.includes('wrong password')
            || lower.includes('authentication failed')
        ) {
            return 'Sai email hoặc mật khẩu';
        }
        if (
            lower.includes('failed to fetch')
            || lower.includes('networkerror')
            || lower.includes('load failed')
            || lower.includes('connection refused')
            || lower.includes('error sending request')
            || lower.includes('tcp connect error')
            || lower.includes('no connection could be made')
        ) {
            return 'Không kết nối được máy chủ API. Bật Advanced và kiểm tra URL, hoặc kiểm tra mạng.';
        }
        if (raw && raw.length < 160) return raw;
        return 'Đăng nhập thất bại. Thử lại sau.';
    }

    _applyAuthShell() {
        this._populateLoginForm();
        if (this._isAppAuthenticated()) {
            this._showView('overlay');
        } else {
            this._showView('login');
        }
    }

    async _submitLoginEmail() {
        const s = settingsManager.get();
        const baseUrl = document.getElementById('input-login-base-url')?.value.trim()
            || s.halin_base_url
            || DEFAULT_HALIN_API_BASE_URL;
        const email = document.getElementById('input-login-email')?.value.trim() || '';
        const password = document.getElementById('input-login-password')?.value || '';
        const rememberEmail = document.getElementById('check-login-remember')?.checked || false;
        if (!email || !password) {
            this._setLoginStatus('Nhập email và mật khẩu.', 'error');
            return;
        }
        this._setLoginStatus('', null);
        this._setLoginSubmitLoading(true);
        try {
            const r = await halinLogin({ baseUrl, email, password });
            const accessToken = r?.access_token ?? r?.accessToken;
            const refreshToken = r?.refresh_token ?? r?.refreshToken;
            if (!accessToken) {
                throw new Error('Phản hồi máy chủ thiếu access_token.');
            }
            await settingsManager.save({
                ...s,
                halin_base_url: baseUrl,
                halin_email: rememberEmail ? email : '',
                halin_saved_password: rememberEmail ? password : '',
                halin_remember_password: rememberEmail,
                halin_access_token: accessToken,
                halin_refresh_token: refreshToken || '',
                halin_api_token: '',
            });
            try {
                await halinMe({ baseUrl, accessToken });
                this._showToast('Đã đăng nhập HaLin', 'success');
            } catch {
                this._showToast(
                    'Đã lưu phiên đăng nhập. Không xác minh được tài khoản — kiểm tra API hoặc mạng.',
                    'warning',
                );
            }
            this._setLoginStatus('', null);
            this._updateHalinBackendStatus();
            this._showView('overlay');
        } catch (e) {
            const msg = this._friendlyLoginError(e);
            this._setLoginStatus(msg, 'error');
            this._showToast(msg, 'error');
        } finally {
            this._setLoginSubmitLoading(false);
        }
    }

    async _submitLoginToken() {
        const s = settingsManager.get();
        const baseUrl = document.getElementById('input-login-base-url')?.value.trim()
            || s.halin_base_url
            || DEFAULT_HALIN_API_BASE_URL;
        let token = document.getElementById('input-login-api-token')?.value.trim() || '';
        if (!token) {
            this._setLoginStatus('Nhập Desktop API token.', 'error');
            return;
        }
        if (/^bearer\s+/i.test(token)) {
            token = token.replace(/^bearer\s+/i, '').trim();
        }
        const btnTok = document.getElementById('btn-login-token-only');
        this._setLoginStatus('', null);
        if (btnTok) btnTok.disabled = true;
        try {
            await settingsManager.save({
                ...s,
                halin_base_url: baseUrl,
                halin_api_token: token,
                halin_access_token: '',
                halin_refresh_token: '',
            });
            this._showToast('Đã dùng Desktop API token', 'success');
            this._updateHalinBackendStatus();
            this._showView('overlay');
        } catch (e) {
            const msg = String(e?.message || e) || 'Không lưu được. Thử lại.';
            this._setLoginStatus(msg, 'error');
            this._showToast(msg, 'error');
        } finally {
            if (btnTok) btnTok.disabled = false;
        }
    }

    async _logout() {
        // Ensure no background capture/timers keep running after logout.
        try {
            if (this.isRunning) {
                await this.stop();
            } else {
                this._stopSessionTimer();
            }
        } catch (e) {
            console.warn('[App] logout cleanup:', e);
        }

        const s = settingsManager.get();
        const rt = String(s.halin_refresh_token || '').trim();
        const baseUrl = s.halin_base_url || DEFAULT_HALIN_API_BASE_URL;
        if (rt) {
            try {
                await halinLogout({ baseUrl, refreshToken: rt });
            } catch {
                /* still clear local session */
            }
        }
        try {
            await settingsManager.save({
                ...s,
                halin_access_token: '',
                halin_refresh_token: '',
                halin_api_token: '',
            });
        } catch (e) {
            this._showToast(String(e?.message || e), 'error');
            return;
        }
        this._setLoginStatus('', null);
        this._showToast('Đã đăng xuất', 'info');
        this._applyAuthShell();
    }

    async _checkPlatformSupport() {
        try {
            // Check if we're on macOS Apple Silicon
            const arch = await invoke('get_platform_info');
            const info = JSON.parse(arch);
            this.isAppleSilicon = (info.os === 'macos' && info.arch === 'aarch64');
        } catch {
            // Fallback: check via navigator
            this.isAppleSilicon = navigator.platform === 'MacIntel' &&
                navigator.userAgent.includes('Mac OS X');
        }

        if (!this.isAppleSilicon) {
            const settings = settingsManager.get();
            if (settings.translation_mode === 'local') {
                settings.translation_mode = 'soniox';
                settingsManager.save(settings);
            }
        }
    }

    // ─── Event Binding ──────────────────────────────────────

    _bindEvents() {
        // Login view
        document.getElementById('btn-login-minimize')?.addEventListener('click', async () => {
            await this._saveWindowPosition();
            await this.appWindow.minimize();
        });
        document.getElementById('btn-login-close')?.addEventListener('click', async () => {
            await this._saveWindowPosition();
            await this.stop();
            await this.appWindow.close();
        });
        document.getElementById('form-login-email')?.addEventListener('submit', (e) => {
            e.preventDefault();
            void this._submitLoginEmail().catch((err) => {
                const msg = this._friendlyLoginError(err);
                this._setLoginStatus(msg, 'error');
                this._showToast(msg, 'error');
            });
        });
        document.getElementById('btn-login-token-only')?.addEventListener('click', () => {
            this._submitLoginToken();
        });
        document.getElementById('btn-toggle-login-api-token')?.addEventListener('click', () => {
            const input = document.getElementById('input-login-api-token');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Password visibility toggle — LGN-1
        (() => {
            const pwInput  = document.getElementById('input-login-password');
            const pwToggle = document.getElementById('btn-toggle-login-password');
            if (!pwInput || !pwToggle) return;

            const eyeOpen   = pwToggle.querySelector('.pw-eye--open');
            const eyeClosed = pwToggle.querySelector('.pw-eye--closed');

            const syncVisibility = () => {
                if (pwInput.value.length > 0) {
                    pwToggle.removeAttribute('hidden');
                } else {
                    pwToggle.setAttribute('hidden', '');
                    // Reset về password khi xoá hết
                    pwInput.type = 'password';
                    if (eyeOpen)   eyeOpen.style.display   = '';
                    if (eyeClosed) eyeClosed.style.display = 'none';
                    pwToggle.setAttribute('aria-label', 'Hiện mật khẩu');
                }
            };

            pwInput.addEventListener('input', syncVisibility);

            pwToggle.addEventListener('click', () => {
                const showing = pwInput.type === 'text';
                pwInput.type = showing ? 'password' : 'text';
                if (eyeOpen)   eyeOpen.style.display   = showing ? ''     : 'none';
                if (eyeClosed) eyeClosed.style.display = showing ? 'none' : '';
                pwToggle.setAttribute('aria-label', showing ? 'Hiện mật khẩu' : 'Ẩn mật khẩu');
                pwInput.focus();
            });
        })();

        document.getElementById('btn-sidebar-logout')?.addEventListener('click', () => {
            this._logout();
        });

        document.getElementById('btn-nav-live')?.addEventListener('click', () => {
            this._setSidebarNav('live');
            this._showView('overlay');
            document.getElementById('transcript-container')?.scrollTo({ top: 0, behavior: 'smooth' });
        });
        document.getElementById('btn-nav-transcript')?.addEventListener('click', () => {
            this._setSidebarNav('transcript');
            this._showView('sessions');
        });
        document.getElementById('btn-nav-settings')?.addEventListener('click', () => {
            this._showView('settings');
        });

        // Back from settings
        document.getElementById('btn-back').addEventListener('click', () => {
            this._clearSettingsDirty();
            this._showView('overlay');
            this._setSidebarNav('live');
        });

        // Back from sessions
        document.getElementById('btn-sessions-back').addEventListener('click', () => {
            this._showView('overlay');
        });

        // Back from session viewer to session list
        document.getElementById('btn-session-back-to-list').addEventListener('click', () => {
            document.getElementById('sessions-list-panel').style.display = '';
            document.getElementById('session-viewer').style.display = 'none';
        });

        // Copy session content
        document.getElementById('btn-session-copy').addEventListener('click', async () => {
            const content = document.getElementById('session-viewer-content')?.textContent || '';
            if (content) {
                await navigator.clipboard.writeText(content);
                this._showToast('Đã sao chép vào bộ nhớ', 'success');
            }
        });

        const bindWindowClose = async () => {
            await this._saveWindowPosition();
            await this.stop();
            await this.appWindow.close();
        };
        document.getElementById('btn-close')?.addEventListener('click', bindWindowClose);
        document.getElementById('btn-settings-close')?.addEventListener('click', bindWindowClose);

        const bindWindowMinimize = async () => {
            await this._saveWindowPosition();
            await this.appWindow.minimize();
        };
        document.getElementById('btn-minimize')?.addEventListener('click', bindWindowMinimize);
        document.getElementById('btn-settings-minimize')?.addEventListener('click', bindWindowMinimize);

        const bindWindowMaximize = async () => {
            await this.appWindow.toggleMaximize();
        };
        document.getElementById('btn-maximize')?.addEventListener('click', bindWindowMaximize);
        document.getElementById('btn-settings-maximize')?.addEventListener('click', bindWindowMaximize);

        this._bindAudioSourceDropdown();

        this._bindTopbarOverflow();
        this._bindHalinSessionFormUI();

        // Pin/Unpin button
        document.getElementById('btn-pin').addEventListener('click', () => {
            this._togglePin();
        });

        // View mode toggle (dual panel)
        document.getElementById('btn-view-mode').addEventListener('click', () => {
            this._toggleViewMode();
        });

        // Font size quick controls
        document.getElementById('btn-font-up').addEventListener('click', () => this._adjustFontSize(4));
        document.getElementById('btn-font-down').addEventListener('click', () => this._adjustFontSize(-4));

        // Color dot controls
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                const color = dot.dataset.color;
                this.transcriptUI.configure({ fontColor: color });
            });
        });
        const initialColorDot = document.querySelector('.color-dot.active');
        if (initialColorDot?.dataset?.color) {
            this.transcriptUI.configure({ fontColor: initialColorDot.dataset.color });
        }

        // Start/Stop button
        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.isStarting) return; // Prevent re-entry
            if (!this.isRunning && !this._sessionSetupAllowsStart()) {
                this._showToast('Nhập chủ đề trong Thiết lập buổi học và bấm Lưu thiết lập, hoặc tắt HaLin Phân Tích.', 'error');
                return;
            }
            try {
                if (this.isRunning) {
                    await this.stop();
                } else {
                    this.isStarting = true;
                    await this.start();
                }
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                this._showToast(`Lỗi: ${err}`, 'error');
                this.isRunning = false;
                this._updateStartButton();
                this._updateStatus('error');
                this.transcriptUI.clear();
                this.transcriptUI.showPlaceholder();
            } finally {
                this.isStarting = false;
            }
        });

        document.getElementById('btn-result-dismiss')?.addEventListener('click', () => {
            this._hideSessionResultCard();
        });

        document.getElementById('btn-result-new-session')?.addEventListener('click', () => {
            this._hideSessionResultCard();
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.recordingStartTime = null;
            this.lastSessionDurationLabel = null;
            document.getElementById('session-setup-card')?.classList.remove('hidden');
            const statusEl = document.getElementById('ssc-status');
            if (statusEl) {
                statusEl.textContent = '';
                statusEl.className = 'ssc-status';
            }
        });

        document.getElementById('btn-result-dashboard')?.addEventListener('click', (e) => {
            e.preventDefault();
            const jobId = document.getElementById('session-result-card')?.dataset?.jobId || '';
            const s = settingsManager.get();
            const base = String(s.halin_base_url || DEFAULT_HALIN_API_BASE_URL).replace(/\/+$/, '');
            const url = `${base}/dashboard/#/training/job-detail?id=${encodeURIComponent(String(jobId))}`;
            try {
                window.__TAURI__?.opener?.openUrl?.(url);
            } catch {
                // ignore
            }
        });

        // Clear button — clears display only (auto-save happens on stop)
        document.getElementById('btn-clear').addEventListener('click', async () => {
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.recordingStartTime = null;
            this.lastSessionDurationLabel = null;
            document.getElementById('session-setup-card')?.classList.remove('hidden');
            const statusEl = document.getElementById('ssc-status');
            if (statusEl) {
                statusEl.textContent = '';
                statusEl.className = 'ssc-status';
            }
        });

        // Copy transcript button
        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                this._showToast('Đã sao chép vào bộ nhớ', 'success');
            } else {
                this._showToast('Không có nội dung để sao chép', 'info');
            }
        });

        // Open saved transcripts folder (kept for Finder access)
        document.getElementById('btn-open-transcripts').addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                this._showToast('Không mở được thư mục: ' + err, 'error');
            }
        });

        document.getElementById('btn-export-debug-log')?.addEventListener('click', async () => {
            try {
                const text = exportLogs();
                await navigator.clipboard.writeText(text);
                this._showToast('Đã copy Debug Log vào clipboard', 'success');
            } catch (e) {
                this._showToast(`Không export được log: ${String(e?.message || e)}`, 'error');
            }
        });

        // Settings form elements
        this._bindSettingsForm();

        // Kéo cửa sổ chỉ từ thanh header Cài đặt (không dùng data-tauri-drag-region — tránh double-click Windows thu/phóng cửa khi không có nút phóng to trên màn này).
        document.getElementById('settings-drag')?.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const interactive = e.target.closest('button, input, select, label, a, textarea');
            if (interactive) return;
            e.preventDefault();
            this.appWindow.startDragging();
        });

        // Translation type toggle (one-way / two-way)
        document.getElementById('select-translation-type')?.addEventListener('change', (e) => {
            this._updateTranslationTypeUI(e.target.value);
        });

        // Soniox link
        document.getElementById('link-soniox').addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://console.soniox.com/signup/');
        });

        // ElevenLabs link
        document.getElementById('link-elevenlabs')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://elevenlabs.io/app/sign-up');
        });

        // Save settings — both top and bottom buttons
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            this._saveSettingsFromForm();
        });
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => {
            this._saveSettingsFromForm();
        });

        // Slider live updates
        document.getElementById('range-opacity').addEventListener('input', (e) => {
            document.getElementById('opacity-value').textContent = `${e.target.value}%`;
            settingsManager.saveDebounced({ overlay_opacity: parseInt(e.target.value) / 100 }).catch(() => {});
        });

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = `${e.target.value}px`;
            settingsManager.saveDebounced({ font_size: parseInt(e.target.value) }).catch(() => {});
        });

        document.getElementById('range-max-lines').addEventListener('input', (e) => {
            document.getElementById('max-lines-value').textContent = e.target.value;
            settingsManager.saveDebounced({ max_lines: parseInt(e.target.value) }).catch(() => {});
        });

        document.getElementById('range-endpoint-delay')?.addEventListener('input', (e) => {
            document.getElementById('endpoint-delay-value').textContent = `${(e.target.value / 1000).toFixed(1)}s`;
            settingsManager.saveDebounced({ endpoint_delay: parseInt(e.target.value) }).catch(() => {});
        });

        // (session info moved to main screen setup card)
        document.getElementById('input-context-terms')?.addEventListener('input', () => {
            settingsManager.saveDebounced(this._collectCustomContextPatch()).catch(() => {});
        });
        document.getElementById('input-context-text')?.addEventListener('input', () => {
            settingsManager.saveDebounced(this._collectCustomContextPatch()).catch(() => {});
        });
        document.getElementById('context-general-list')?.addEventListener('input', () => {
            settingsManager.saveDebounced(this._collectCustomContextPatch()).catch(() => {});
        });
        document.getElementById('translation-terms-list')?.addEventListener('input', () => {
            settingsManager.saveDebounced(this._collectCustomContextPatch()).catch(() => {});
        });

        // Toggle ElevenLabs API key visibility
        document.getElementById('btn-toggle-elevenlabs-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-elevenlabs-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-tts-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-halin-token')?.addEventListener('click', () => {
            const input = document.getElementById('input-halin-api-token');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Settings tab switching
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab)?.classList.add('active');
            });
        });

        // TTS enable/disable toggle in settings — show/hide detail
        document.getElementById('check-tts-enabled')?.addEventListener('change', (e) => {
            const detail = document.getElementById('tts-settings-detail');
            if (detail) detail.style.display = e.target.checked ? '' : 'none';
        });

        // TTS provider toggle — show/hide relevant settings panels
        document.getElementById('select-tts-provider')?.addEventListener('change', (e) => {
            this._updateTTSProviderUI(e.target.value);
        });

        // TTS speed slider — show value
        document.getElementById('range-tts-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tts-speed-value');
            if (label) label.textContent = e.target.value + 'x';
        });

        // Edge TTS speed slider
        document.getElementById('range-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        document.getElementById('range-google-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Add translation term row
        document.getElementById('btn-add-term')?.addEventListener('click', () => {
            this._addTermRow('', '');
        });

        // Add general context row
        document.getElementById('btn-add-general')?.addEventListener('click', () => {
            this._addGeneralRow('', '');
        });

        // TTS toggle button in overlay
        document.getElementById('btn-tts').addEventListener('click', () => {
            this._toggleTTS();
        });

        // HaLin classroom toggle
        document.getElementById('btn-halin')?.addEventListener('click', async () => {
            const next = !this.halinSession.isEnabled();
            await this._applyHalinEnabledToggle(next);
        });

        document.getElementById('btn-halin-recover')?.addEventListener('click', async () => {
            try {
                await this.halinSession.recoverFallback();
                this._showToast('Đã gửi lại dữ liệu buổi học lên HaLin.', 'success');
                this._syncRecoverButtonVisibility();
            } catch (err) {
                const msg = String(err?.message || err);
                if (/No transcript segments found|chunk_rows=0/i.test(msg)) {
                    this._showToast(
                        'Không gửi lại được dữ liệu buổi học: không còn dữ liệu transcript để khôi phục (buổi học có thể đã bị mất do mất mạng/app tắt đột ngột).',
                        'error',
                    );
                } else {
                    this._showToast(`Gửi lại dữ liệu buổi học thất bại: ${msg}`, 'error');
                }
                this._syncRecoverButtonVisibility();
            }
        });

    }

    _bindSettingsForm() {
        const root = document.querySelector('#settings-view .settings-body');
        if (!root) return;
        const mark = () => this._setSettingsDirty(true);
        root.addEventListener('input', mark);
        root.addEventListener('change', mark);
        root.addEventListener('click', (e) => {
            const el = e.target instanceof Element ? e.target : e.target.parentElement;
            if (!el?.closest) return;
            if (el.closest('.settings-tab, #btn-save-settings, #btn-save-settings-top')) return;
            if (el.closest('.saas-segment')) mark();
            if (el.closest('#btn-add-general, #btn-add-term, .btn-remove-general, .btn-remove-term')) mark();
        });
    }

    _setSettingsDirty(dirty) {
        const on = Boolean(dirty);
        document.getElementById('btn-save-settings')?.classList.toggle('dirty', on);
        document.getElementById('btn-save-settings-top')?.classList.toggle('dirty', on);
        const lbl = document.getElementById('btn-save-settings-label');
        if (lbl) lbl.textContent = on ? 'Lưu *' : 'Lưu và đóng';
        const top = document.getElementById('btn-save-settings-top');
        if (top) top.title = on ? 'Lưu * — có thay đổi chưa lưu đầy đủ' : 'Lưu và đóng';
    }

    _clearSettingsDirty() {
        this._setSettingsDirty(false);
    }

    // ─── Keyboard Shortcuts ─────────────────────────────────

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            const onLogin = document.getElementById('login-view')?.classList.contains('active');
            if (onLogin) {
                if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                    e.preventDefault();
                    this._saveWindowPosition();
                    this.appWindow.minimize();
                }
                return;
            }

            // Ignore when typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Cmd/Ctrl + Enter: Start/Stop
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.isStarting) return;
                if (!this.isRunning && !this._sessionSetupAllowsStart()) {
                    this._showToast('Nhập chủ đề trong Thiết lập buổi học và bấm Lưu thiết lập, hoặc tắt HaLin Phân Tích.', 'error');
                    return;
                }
                (async () => {
                    try {
                        if (this.isRunning) {
                            await this.stop();
                        } else {
                            this.isStarting = true;
                            await this.start();
                        }
                    } catch (err) {
                        console.error('[App] Keyboard start/stop error:', err);
                        this._showToast(`Lỗi: ${err}`, 'error');
                        this.isRunning = false;
                        this._updateStartButton();
                        this._updateStatus('error');
                    } finally {
                        this.isStarting = false;
                    }
                })();
            }

            // Escape: close audio menu / overlay / settings
            if (e.key === 'Escape') {
                const audioMenu = document.getElementById('audio-source-dropdown');
                if (audioMenu && !audioMenu.hidden) {
                    e.preventDefault();
                    this._closeAudioSourceDropdown();
                    return;
                }
                e.preventDefault();
                if (document.getElementById('login-view')?.classList.contains('active')) {
                    return;
                }
                const settingsVisible = document.getElementById('settings-view').classList.contains('active');
                if (settingsVisible) {
                    this._clearSettingsDirty();
                    this._showView('overlay');
                }
            }

            // Cmd/Ctrl + ,: Open settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            // Cmd/Ctrl + 1: Switch to System Audio
            if ((e.metaKey || e.ctrlKey) && e.key === '1') {
                e.preventDefault();
                this._setSource('system');
            }

            // Cmd/Ctrl + 2: Switch to Microphone
            if ((e.metaKey || e.ctrlKey) && e.key === '2') {
                e.preventDefault();
                this._setSource('microphone');
            }

            // Cmd/Ctrl + 3: Switch to Both
            if ((e.metaKey || e.ctrlKey) && e.key === '3') {
                e.preventDefault();
                this._setSource('both');
            }

            // Cmd/Ctrl + T: Toggle TTS
            if ((e.metaKey || e.ctrlKey) && e.key === 't') {
                e.preventDefault();
                this._toggleTTS();
            }

            // Cmd/Ctrl + M: Minimize
            if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                e.preventDefault();
                this._saveWindowPosition();
                this.appWindow.minimize();
            }

            // Cmd/Ctrl + P: Toggle Pin
            if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
                e.preventDefault();
                this._togglePin();
            }

        });
    }

    // ─── Views ──────────────────────────────────────────────

    _syncSettingsScrollIndicator() {
        const body = document.querySelector('#settings-view .settings-body');
        const tabs = document.querySelector('#settings-view .settings-tabs');
        if (!body || !tabs) return;
        const { scrollTop, scrollHeight, clientHeight } = body;
        const overflow = scrollHeight > clientHeight + 2;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 12;
        tabs.classList.toggle('settings-tabs--scrolled', scrollTop > 6);
        body.classList.toggle('settings-body--more', overflow && !atBottom);
    }

    _initSettingsScrollIndicator() {
        const body = document.querySelector('#settings-view .settings-body');
        if (!body) return;
        const sync = () => this._syncSettingsScrollIndicator();
        body.addEventListener('scroll', sync, { passive: true });
        window.addEventListener('resize', sync);
        try {
            const ro = new ResizeObserver(() => sync());
            ro.observe(body);
        } catch {
            // ignore
        }
        document.querySelectorAll('#settings-view .settings-tab').forEach((t) => {
            t.addEventListener('click', () => requestAnimationFrame(sync));
        });
        requestAnimationFrame(sync);
    }

    _initNetworkMonitor() {
        const dock = document.getElementById('app-footer-dock');
        const badge = document.getElementById('dock-net-status');

        const setOffline = () => {
            dock?.classList.add('net-offline');
            if (badge) badge.removeAttribute('hidden');
            try {
                if (this.halinSession) this.halinSession._networkOnline = false;
            } catch {
                // ignore
            }
            if (this.isRunning) {
                this._showToast('Mất kết nối mạng — dữ liệu âm thanh đang được giữ lại', 'error');
            }
        };

        const setOnline = () => {
            dock?.classList.remove('net-offline');
            if (badge) badge.setAttribute('hidden', '');
            try {
                if (this.halinSession) this.halinSession._networkOnline = true;
            } catch {
                // ignore
            }
            if (this.isRunning) {
                this._showToast('Đã kết nối lại — tiếp tục đồng bộ HaLin', 'success');
                this.halinSession?.notifyOnline?.();
            }
        };

        // Desktop webviews can mis-report connectivity to specific backends.
        // This badge is strictly for "machine lost Internet".
        window.addEventListener('offline', setOffline);
        window.addEventListener('online', setOnline);

        if (navigator.onLine === false) setOffline();
        else setOnline();
    }

    _syncRecoverButtonVisibility() {
        const rec = document.getElementById('btn-halin-recover');
        if (!rec) return;
        let hasPending = false;
        let rawLen = 0;
        try {
            const raw = localStorage.getItem(HALIN_PENDING_FINALIZE_KEY) || '';
            rawLen = String(raw || '').length;
            hasPending = Boolean(String(raw || '').trim());
        } catch {
            hasPending = false;
        }
        rec.hidden = !hasPending;
    }

    _showView(view) {
        if (view !== 'login' && !this._isAppAuthenticated()) {
            view = 'login';
        }

        document.getElementById('login-view')?.classList.toggle('active', view === 'login');
        document.getElementById('overlay-view').classList.toggle('active', view === 'overlay');
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');
        document.getElementById('sessions-view').classList.toggle('active', view === 'sessions');

        if (view === 'login') {
            this._populateLoginForm();
            requestAnimationFrame(() => {
                document.getElementById('input-login-email')?.focus();
            });
        }
        if (view === 'settings') {
            this._populateSettingsForm();
            this._setSidebarNav('settings');
            this._updateSettingsConnectionCard();
            requestAnimationFrame(() => this._syncSettingsScrollIndicator());
        }
        if (view === 'sessions') {
            this._showSessions();
        }
    }

    _setSidebarNav(which) {
        const map = { live: 'btn-nav-live', transcript: 'btn-nav-transcript', settings: 'btn-nav-settings' };
        const activeId = map[which];
        if (!activeId) return;
        document.querySelectorAll('.sidebar-nav-item').forEach((b) => {
            b.classList.toggle('active', b.id === activeId);
        });
    }

    // ─── Settings Form ─────────────────────────────────────

    _populateSettingsForm() {
        const s = settingsManager.get();

        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';
        this._updateModeUI(s.translation_mode || 'soniox');

        // Translation type (one-way / two-way)
        const translationType = s.translation_type || 'one_way';
        document.getElementById('select-translation-type').value = translationType;
        this._updateTranslationTypeUI(translationType);

        // Two-way language selects
        document.getElementById('select-lang-a').value = s.language_a || 'ja';
        document.getElementById('select-lang-b').value = s.language_b || 'vi';

        // Strict language detection
        document.getElementById('check-strict-lang').checked = s.language_hints_strict || false;

        // Endpoint delay
        const endpointDelay = s.endpoint_delay || 3000;
        const delaySlider = document.getElementById('range-endpoint-delay');
        if (delaySlider) delaySlider.value = endpointDelay;
        const delayValue = document.getElementById('endpoint-delay-value');
        if (delayValue) delayValue.textContent = `${(endpointDelay / 1000).toFixed(1)}s`;

        // Audio source radio — prefer live dock selection so "Cả hai" on dock isn't overwritten by stale saved value
        const radioValue = this.currentSource || s.audio_source || 'system';
        const audioSourceRadio = document.querySelector(`input[name="audio-source"][value="${radioValue}"]`);
        if (audioSourceRadio) audioSourceRadio.checked = true;

        // Display
        const opacityPercent = Math.round((s.overlay_opacity || 0.85) * 100);
        document.getElementById('range-opacity').value = opacityPercent;
        document.getElementById('opacity-value').textContent = `${opacityPercent}%`;

        document.getElementById('range-font-size').value = s.font_size || 16;
        document.getElementById('font-size-value').textContent = `${s.font_size || 16}px`;

        document.getElementById('range-max-lines').value = s.max_lines || 5;
        document.getElementById('max-lines-value').textContent = s.max_lines || 5;

        document.getElementById('check-show-original').checked = s.show_original !== false;

        // Custom context (rich format)
        const ctx = s.custom_context;
        // General context rows
        const generalList = document.getElementById('context-general-list');
        if (generalList) {
            generalList.innerHTML = '';
            const generalPairs = ctx?.general || [];
            generalPairs.forEach(g => this._addGeneralRow(g.key, g.value));
        }
        // Transcription terms
        const termsInput = document.getElementById('input-context-terms');
        if (termsInput) {
            termsInput.value = (ctx?.terms || []).join('\n');
        }
        // Background text
        const textInput = document.getElementById('input-context-text');
        if (textInput) {
            textInput.value = ctx?.text || '';
        }
        // Load translation terms as rows
        const termsList = document.getElementById('translation-terms-list');
        if (termsList) {
            termsList.innerHTML = '';
            const terms = ctx?.translation_terms || [];
            terms.forEach(t => this._addTermRow(t.source, t.target));
        }

        // TTS settings
        document.getElementById('input-elevenlabs-key').value = s.elevenlabs_api_key || '';
        document.getElementById('select-tts-voice').value = s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
        // Edge TTS settings
        const edgeVoiceSelect = document.getElementById('select-edge-voice');
        if (edgeVoiceSelect) edgeVoiceSelect.value = s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const edgeSpeedSlider = document.getElementById('range-edge-speed');
        const edgeSpeedLabel = document.getElementById('edge-speed-value');
        const edgeSpeed = s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20;
        if (edgeSpeedSlider) edgeSpeedSlider.value = edgeSpeed;
        if (edgeSpeedLabel) edgeSpeedLabel.textContent = (edgeSpeed >= 0 ? '+' : '') + edgeSpeed + '%';

        // Google TTS settings
        const googleKeyInput = document.getElementById('input-google-tts-key');
        if (googleKeyInput) googleKeyInput.value = s.google_tts_api_key || '';
        const googleVoiceSelect = document.getElementById('select-google-voice');
        if (googleVoiceSelect) googleVoiceSelect.value = s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        const googleSpeedSlider = document.getElementById('range-google-speed');
        const googleSpeedLabel = document.getElementById('google-speed-value');
        const googleSpeed = s.google_tts_speed || 1.0;
        if (googleSpeedSlider) googleSpeedSlider.value = googleSpeed;
        if (googleSpeedLabel) googleSpeedLabel.textContent = googleSpeed + 'x';

        // TTS provider
        const providerSelect = document.getElementById('select-tts-provider');
        if (providerSelect) {
            providerSelect.value = s.tts_provider || 'edge';
            this._updateTTSProviderUI(providerSelect.value);
        }

        // HaLin classroom
        const halinBase = document.getElementById('input-halin-base-url');
        if (halinBase) halinBase.value = s.halin_base_url || DEFAULT_HALIN_API_BASE_URL;
        const halinTok = document.getElementById('input-halin-api-token');
        if (halinTok) halinTok.value = s.halin_api_token || '';
        const btnHalinBadge = document.getElementById('btn-halin');
        if (btnHalinBadge) {
            const halinOn = Boolean(s.halin_enabled);
            btnHalinBadge.classList.toggle('active', halinOn);
            btnHalinBadge.setAttribute('aria-pressed', halinOn ? 'true' : 'false');
        }
        const halinChunk = document.getElementById('input-halin-chunk-seconds');
        if (halinChunk) halinChunk.value = String(this._clampInt(s.halin_chunk_seconds, 2, 10, 5));
        this._updateSettingsConnectionCard();

        this._clearSettingsDirty();
    }

    /**
     * Trạng thái kết nối HaLin (thẻ ở tab Chung)
     */
    _updateSettingsConnectionCard() {
        const dot = document.getElementById('settings-connection-dot');
        const title = document.getElementById('settings-connection-title');
        const sub = document.getElementById('settings-connection-sub');
        if (!dot || !title || !sub) return;

        dot.classList.remove(
            'settings-connection-dot--ok',
            'settings-connection-dot--warn',
            'settings-connection-dot--muted',
        );

        const s = settingsManager.get();
        const base = String(s.halin_base_url || '').trim();
        const jwt = String(s.halin_access_token || '').trim();
        const apiTok = String(s.halin_api_token || '').trim();

        if (!base) {
            dot.classList.add('settings-connection-dot--muted');
            title.textContent = 'HaLin AI';
            sub.textContent = 'Chưa cấu hình máy chủ — thêm URL trong tab Chung.';
            return;
        }
        if (jwt || apiTok) {
            dot.classList.add('settings-connection-dot--ok');
            title.textContent = 'Đã kết nối HaLin AI';
            sub.textContent = jwt
                ? 'Đăng nhập JWT — sẵn sàng đồng bộ buổi học.'
                : 'Desktop API token đã lưu — sẵn sàng gọi backend.';
            return;
        }
        dot.classList.add('settings-connection-dot--warn');
        title.textContent = 'Chưa xác thực';
        sub.textContent = 'Đã có máy chủ — đăng nhập từ màn hình chính hoặc dán Desktop API token (Thêm → Nâng cao / Debug).';
    }

    /** Build `custom_context` from Session tab form (same shape as `_saveSettingsFromForm`). */
    _collectCustomContextPatch() {
        const generalPairs = [];
        document.querySelectorAll('#context-general-list .general-row').forEach((row) => {
            const key = row.querySelector('.general-key')?.value.trim();
            const value = row.querySelector('.general-value')?.value.trim();
            if (key && value) generalPairs.push({ key, value });
        });
        const termsRaw = document.getElementById('input-context-terms')?.value.trim() || '';
        const terms = termsRaw ? termsRaw.split('\n').map((t) => t.trim()).filter((t) => t) : [];
        const contextText = document.getElementById('input-context-text')?.value.trim() || '';
        const translationTerms = [];
        document.querySelectorAll('#translation-terms-list .term-row').forEach((row) => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) translationTerms.push({ source, target });
        });
        if (generalPairs.length > 0 || terms.length > 0 || contextText || translationTerms.length > 0) {
            return {
                custom_context: {
                    general: generalPairs,
                    terms,
                    text: contextText || null,
                    translation_terms: translationTerms,
                },
            };
        }
        return {};
    }

    async _saveSettingsFromForm() {
        // (session info moved to main screen setup card)

        const current = settingsManager.get();
        const settings = {
            ...current,
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            translation_mode: current.translation_mode || 'soniox',
            translation_type: document.getElementById('select-translation-type')?.value || 'one_way',
            language_a: document.getElementById('select-lang-a')?.value || 'ja',
            language_b: document.getElementById('select-lang-b')?.value || 'vi',
            language_hints_strict: document.getElementById('check-strict-lang')?.checked || false,
            endpoint_delay: parseInt(document.getElementById('range-endpoint-delay')?.value || 3000),
            audio_source:
                document.querySelector('input[name="audio-source"]:checked')?.value || this.currentSource || 'system',
            overlay_opacity: parseInt(document.getElementById('range-opacity').value) / 100,
            font_size: parseInt(document.getElementById('range-font-size').value),
            max_lines: parseInt(document.getElementById('range-max-lines').value),
            show_original: document.getElementById('check-show-original').checked,
        };

        Object.assign(settings, this._collectCustomContextPatch());

        // TTS settings
        settings.tts_provider = document.getElementById('select-tts-provider')?.value || 'edge';
        settings.elevenlabs_api_key = document.getElementById('input-elevenlabs-key').value.trim();
        settings.tts_voice_id = document.getElementById('select-tts-voice').value;
        settings.edge_tts_voice = document.getElementById('select-edge-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.edge_tts_speed = parseInt(document.getElementById('range-edge-speed')?.value || 20);
        settings.tts_speed = parseFloat(document.getElementById('range-tts-speed')?.value || 1.2);
        settings.google_tts_api_key = document.getElementById('input-google-tts-key')?.value.trim() || '';
        settings.google_tts_voice = document.getElementById('select-google-voice')?.value || 'vi-VN-Chirp3-HD-Aoede';
        settings.google_tts_speed = parseFloat(document.getElementById('range-google-speed')?.value || 1.0);
        settings.tts_enabled = false;

        // HaLin classroom (halin_enabled / halin_email: unchanged — topbar toggle & màn hình đăng nhập)
        settings.halin_base_url = document.getElementById('input-halin-base-url')?.value.trim() || DEFAULT_HALIN_API_BASE_URL;
        settings.halin_api_token = document.getElementById('input-halin-api-token')?.value.trim() || '';
        settings.halin_remember_password = false;
        // access/refresh tokens are managed by Login button; preserved via spread current
        settings.halin_chunk_seconds = this._clampInt(
            document.getElementById('input-halin-chunk-seconds')?.value || 5,
            2,
            10,
            5,
        );
        // (session info moved to main screen setup card)

        try {
            await settingsManager.save(settings);
            this._clearSettingsDirty();
            this._showToast('Đã lưu cài đặt', 'success');
            this._showView('overlay');
            this._setSidebarNav('live');
        } catch (err) {
            this._showToast(`Lưu thất bại: ${err}`, 'error');
        }
    }

    // ─── Apply Settings ────────────────────────────────────

    _applySettings(settings) {
        // Update overlay opacity
        const overlayView = document.getElementById('overlay-view');
        overlayView.style.opacity = settings.overlay_opacity || 0.85;

        // Update transcript UI
        if (this.transcriptUI) {
            this.transcriptUI.configure({
                maxLines: settings.max_lines || 5,
                showOriginal: settings.show_original !== false,
                fontSize: settings.font_size || 16,
            });
        }

        // Update current source button states
        this.currentSource = settings.audio_source || 'system';
        this._updateSourceButtons();

        // TTS is always OFF on app start — user must toggle on each session
        this.ttsEnabled = false;
        this._updateTTSButton();

        // Apply persisted HaLin toggle (so relaunch keeps behavior)
        const halinOn = Boolean(settings.halin_enabled);
        this.halinSession.setEnabled(halinOn, { silent: true });
        const btnHalin = document.getElementById('btn-halin');
        if (btnHalin) {
            btnHalin.classList.toggle('active', halinOn);
            btnHalin.setAttribute('aria-pressed', halinOn ? 'true' : 'false');
        }
        this._updateModeUI(settings.translation_mode || 'soniox');
        this._updateHalinBackendStatus();
        this._updateStartButton();
    }

    _refreshSessionChrome(settings) {
        const s = settings || settingsManager.get();
        const topic = String(s.halin_topic || '').trim();
        const lesson = String(s.halin_lesson_type || 'conversation').trim();
        const level = String(s.halin_level || 'N5').trim();
        const title = topic || `Buổi ${lesson}`;
        const meta = `${level} · ${lesson}`;
        const email = String(s.halin_email || '').trim();
        const userName = email ? email.split('@')[0] : 'Giáo viên';

        const lessonDockLabels = {
            conversation: 'Hội thoại',
            grammar: 'Ngữ pháp',
            kanji: 'Kanji',
            listening: 'Nghe hiểu',
            reading: 'Đọc hiểu',
            mixed: 'Hỗn hợp',
        };

        const hs = document.getElementById('header-session-name');
        if (hs) hs.textContent = title;
        const hu = document.getElementById('header-user-name');
        if (hu) hu.textContent = userName;
        const pi = document.getElementById('header-profile-initial');
        if (pi) pi.textContent = (userName[0] || 'G').toUpperCase();

        const dockLt = document.getElementById('dock-lesson-type');
        if (dockLt) dockLt.textContent = lessonDockLabels[lesson] || lesson;
        const dockLv = document.getElementById('dock-level');
        if (dockLv) dockLv.textContent = level;
    }

    _startSessionTimer() {
        this._stopSessionTimer();
        const tick = () => {
            const el = document.getElementById('session-timer');
            if (!el || !this.sessionStartTime) return;
            const ms = Date.now() - this.sessionStartTime.getTime();
            el.textContent = this._formatSessionClock(ms);
        };
        tick();
        this._sessionTimerInterval = setInterval(tick, 1000);
    }

    _stopSessionTimer() {
        if (this._sessionTimerInterval) {
            clearInterval(this._sessionTimerInterval);
            this._sessionTimerInterval = null;
        }
        const el = document.getElementById('session-timer');
        if (el) el.textContent = '00:00:00';
    }

    _formatSessionClock(ms) {
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
    }

    _clampInt(n, lo, hi, fallback) {
        const v = Number(n);
        if (!Number.isFinite(v)) return fallback;
        return Math.max(lo, Math.min(hi, Math.floor(v)));
    }

    // ─── TTS Control ──────────────────────────────────────

    _toggleTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';

        // Block TTS in two-way mode to prevent audio feedback loop
        const translationType = document.getElementById('select-translation-type')?.value;
        if (translationType === 'two_way') {
            this._showToast('Chế độ hai chiều đã tắt TTS để tránh vòng lặp âm thanh', 'error');
            return;
        }

        // Check API key for premium providers
        if (provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('Thêm khóa ElevenLabs trong Cài đặt → Đọc (TTS)', 'error');
            this._showView('settings');
            return;
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            this._showToast('Thêm khóa Google TTS trong Cài đặt → Đọc (TTS)', 'error');
            this._showView('settings');
            return;
        }

        this.ttsEnabled = !this.ttsEnabled;
        this._updateTTSButton();

        const tts = this._getActiveTTS();

        if (this.ttsEnabled) {
            this._configureTTS(tts, settings);
            if (this.isRunning) {
                tts.connect();
                audioPlayer.resume();
            }
            const label = { edge: 'Edge TTS (Free)', google: 'Google Chirp 3 HD', elevenlabs: 'ElevenLabs' }[provider] || provider;
            this._showToast(`Đọc TTS bật 🔊 (${label})`, 'success');
        } else {
            tts.disconnect();
            audioPlayer.stop();
            this._showToast('Đọc TTS tắt 🔇', 'success');
        }
    }

    _getActiveTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';
        if (provider === 'elevenlabs') return elevenLabsTTS;
        if (provider === 'google') return googleTTS;
        return edgeTTSRust;
    }

    _configureTTS(tts, settings) {
        const provider = settings.tts_provider || 'edge';
        if (provider === 'elevenlabs') {
            tts.configure({
                apiKey: settings.elevenlabs_api_key,
                voiceId: settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            });
        } else if (provider === 'google') {
            const voice = settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            const langCode = voice.replace(/-Chirp3.*/, '');
            tts.configure({
                apiKey: settings.google_tts_api_key,
                voice: voice,
                languageCode: langCode,
                speakingRate: settings.google_tts_speed || 1.0,
            });
        } else {
            tts.configure({
                voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20,
            });
        }
    }

    _addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'term-row';
        row.innerHTML = `<input type="text" class="term-source" value="${source}" placeholder="Nguồn" />` +
            `<input type="text" class="term-target" value="${target}" placeholder="Đích" />` +
            `<button type="button" class="btn-remove-term" title="Xóa">×</button>`;
        row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _addGeneralRow(key = '', value = '') {
        const list = document.getElementById('context-general-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'general-row';
        row.innerHTML = `<input type="text" class="general-key" value="${this._escAttr(key)}" placeholder="Khóa (vd. môn học)" />` +
            `<input type="text" class="general-value" value="${this._escAttr(value)}" placeholder="Giá trị (vd. Toán)" />` +
            `<button type="button" class="btn-remove-general" title="Xóa">×</button>`;
        row.querySelector('.btn-remove-general').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _escAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    _updateTTSProviderUI(provider) {
        const ed = document.getElementById('tts-edge-settings');
        const go = document.getElementById('tts-google-settings');
        const el = document.getElementById('tts-elevenlabs-settings');
        if (ed) ed.style.display = provider === 'edge' ? '' : 'none';
        if (go) go.style.display = provider === 'google' ? '' : 'none';
        if (el) el.style.display = provider === 'elevenlabs' ? '' : 'none';
        // Update hint text
        const hint = document.getElementById('tts-provider-hint');
        if (hint) {
            const hints = {
                edge: 'Miễn phí, giọng tự nhiên — không cần API key',
                google: 'Chất lượng gần người — cần Google Cloud API key (1 triệu ký tự/tháng miễn phí)',
                elevenlabs: 'Chất lượng cao cấp — cần khóa API ElevenLabs',
            };
            hint.textContent = hints[provider] || '';
        }
    }

    _updateTranslationTypeUI(type) {
        const oneway = document.getElementById('section-oneway-langs');
        const twoway = document.getElementById('section-twoway-langs');
        const hintTwoway = document.getElementById('hint-twoway');
        const strictLang = document.getElementById('section-strict-lang');

        if (type === 'two_way') {
            if (oneway) oneway.style.display = 'none';
            if (twoway) twoway.style.display = 'flex';
            if (hintTwoway) hintTwoway.style.display = 'block';
            // Hide strict lang in two-way mode (both languages are specified)
            if (strictLang) strictLang.style.display = 'none';
            // Force-disable TTS in two-way mode to prevent audio feedback loop
            if (this.ttsEnabled) {
                this.ttsEnabled = false;
                this._getActiveTTS().disconnect();
                audioPlayer.stop();
            }
            this._updateTTSButton();
        } else {
            if (oneway) oneway.style.display = 'flex';
            if (twoway) twoway.style.display = 'none';
            if (hintTwoway) hintTwoway.style.display = 'none';
            if (strictLang) strictLang.style.display = 'flex';
            this._updateTTSButton();
        }
    }

    _updateTTSButton() {
        const btn = document.getElementById('btn-tts');
        const iconOff = document.getElementById('icon-tts-off');
        const iconOn = document.getElementById('icon-tts-on');
        const isTwoWay = document.getElementById('select-translation-type')?.value === 'two_way';

        if (btn) {
            btn.classList.toggle('active', this.ttsEnabled);
            btn.classList.toggle('disabled', isTwoWay);
            btn.title = isTwoWay ? 'TTS tắt ở chế độ hai chiều' : 'Bật/tắt đọc TTS (Ctrl+T)';
        }
        if (iconOff) iconOff.style.display = this.ttsEnabled ? 'none' : 'block';
        if (iconOn) iconOn.style.display = this.ttsEnabled ? 'block' : 'none';
    }

    _speakIfEnabled(text) {
        if (this.ttsEnabled && text?.trim()) {
            this._getActiveTTS().speak(text);
        }
    }

    // ─── Source Control ────────────────────────────────────

    _setSource(source) {
        if (this.isRunning) {
            this._showToast('Dừng ghi (Bắt đầu/Dừng) rồi mới đổi nguồn âm thanh.', 'info');
            return;
        }
        const labels = { system: 'Âm thanh hệ thống', microphone: 'Mic', both: 'Hệ thống + Mic' };
        const label = labels[source] || source;
        this.currentSource = source;
        this._updateSourceButtons();
        this._showToast(`Nguồn âm thanh: ${label}`, 'success');
    }

    _updateSourceButtons() {
        const locked = Boolean(this.isRunning);
        const audioHdr = document.getElementById('btn-audio-source-current');
        if (audioHdr) {
            audioHdr.disabled = locked;
            audioHdr.setAttribute('aria-disabled', locked ? 'true' : 'false');
            if (!audioHdr.dataset.titleDefault) audioHdr.dataset.titleDefault = audioHdr.title || '';
            audioHdr.title = locked
                ? 'Không đổi nguồn khi đang ghi — bấm Dừng trước'
                : (audioHdr.dataset.titleDefault || audioHdr.title);
            audioHdr.setAttribute('data-current', this.currentSource);
        }

        const shortLabels = { system: 'Hệ thống', microphone: 'Mic', both: 'Cả hai' };
        const audioLabel = document.getElementById('audio-source-label');
        if (audioLabel) {
            audioLabel.textContent = shortLabels[this.currentSource] || this.currentSource;
        }

        document.querySelectorAll('#audio-source-dropdown .audio-source-option').forEach((opt) => {
            const src = opt.getAttribute('data-source');
            opt.classList.toggle('active', src === this.currentSource);
        });

        const dockAudio = document.getElementById('dock-audio-label');
        if (dockAudio) {
            const dockNames = {
                system: 'Âm thanh hệ thống',
                microphone: 'Microphone',
                both: 'Hệ thống + Mic',
            };
            dockAudio.textContent = dockNames[this.currentSource] || this.currentSource;
        }
    }

    _closeAudioSourceDropdown() {
        const menu = document.getElementById('audio-source-dropdown');
        const btn = document.getElementById('btn-audio-source-current');
        if (menu) menu.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    _bindAudioSourceDropdown() {
        const wrap = document.getElementById('audio-source-select');
        const btn = document.getElementById('btn-audio-source-current');
        const menu = document.getElementById('audio-source-dropdown');
        if (!wrap || !btn || !menu) return;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = menu.hidden;
            menu.hidden = !open;
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        menu.querySelectorAll('.audio-source-option').forEach((opt) => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                const src = opt.getAttribute('data-source');
                if (src) this._setSource(src);
                this._closeAudioSourceDropdown();
            });
        });

        document.addEventListener('click', (e) => {
            if (!menu.hidden && !wrap.contains(e.target)) {
                this._closeAudioSourceDropdown();
            }
        });
    }

    _bindTopbarOverflow() {
        const btn = document.getElementById('btn-topbar-overflow');
        const menu = document.getElementById('topbar-overflow-menu');
        if (!btn || !menu) return;

        const close = () => {
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = menu.hidden;
            menu.hidden = !open;
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        menu.querySelectorAll('[data-mirror]').forEach((item) => {
            item.addEventListener('click', () => {
                const id = item.getAttribute('data-mirror');
                const target = id && document.getElementById(id);
                target?.click();
                close();
            });
        });

        document.addEventListener('click', (e) => {
            if (menu.hidden) return;
            if (e.target === btn || btn.contains(e.target)) return;
            if (menu.contains(e.target)) return;
            close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });
    }

    _ensureSelectOption(selectEl, value) {
        if (!selectEl || value == null || value === '') return;
        const v = String(value);
        const has = Array.from(selectEl.options).some((o) => o.value === v);
        if (!has) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            selectEl.appendChild(opt);
        }
        selectEl.value = v;
    }

    _bindHalinSessionFormUI() {
        // (session info moved to main screen setup card)
    }

    _updateModeUI(mode) {
        const isSoniox = mode === 'soniox';

        const sectionApiKey = document.getElementById('section-api-key');
        if (sectionApiKey) sectionApiKey.style.display = isSoniox ? '' : 'none';
    }

    // ─── Start/Stop ────────────────────────────────────────

    async start() {
        if (!this._isAppAuthenticated()) {
            this._showToast('Vui lòng đăng nhập hoặc dùng Desktop API token.', 'error');
            this._showView('login');
            return;
        }

        if (!this._sessionSetupAllowsStart()) {
            this._showToast('Nhập chủ đề trong Thiết lập buổi học và bấm Lưu thiết lập, hoặc tắt HaLin Phân Tích.', 'error');
            return;
        }

        const settings = settingsManager.get();
        this.translationMode = settings.translation_mode || 'soniox';
        console.log('[App] start() called, translation_mode:', this.translationMode);

        // Check ElevenLabs key only if TTS is enabled AND provider is elevenlabs
        if (this.ttsEnabled && settings.tts_provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('TTS bật nhưng thiếu khóa ElevenLabs. Thêm khóa hoặc tắt TTS.', 'error');
            this._showView('settings');
            return;
        }

        this.isRunning = true;
        this._updateStartButton();
        document.getElementById('session-setup-card')?.classList.add('hidden');
        if (!this.recordingStartTime) {
            this.recordingStartTime = Date.now();
            this.lastSessionDurationLabel = null;
        }

        // Record session metadata for auto-save
        if (!this.sessionStartTime) {
            this.sessionStartTime = new Date();
            const translationType = settings.translation_type || 'one_way';
            this.sessionMode = translationType;
            if (translationType === 'two_way') {
                this.sessionSourceLang = settings.language_a || 'ja';
                this.sessionTargetLang = settings.language_b || 'vi';
            } else {
                this.sessionSourceLang = settings.source_language || 'auto';
                this.sessionTargetLang = settings.target_language || 'vi';
            }
        }
        this._startSessionTimer();

        // Clear transcript only if nothing is showing
        if (!this.transcriptUI.hasContent()) {
            this.transcriptUI.showListening();
        } else {
            this.transcriptUI.clearProvisional();
        }

        // Start HaLin live_capture session (optional)
        if (this.halinSession.isEnabled()) {
            try {
                // Full-session WAV recording for post-processing diarization.
                this._liveFullPcmChunks = [];
                this._buildLiveWavBytesForFinalize = () => {
                    const pcm = this._mergeUint8Chunks(this._liveFullPcmChunks || []);
                    if (!pcm.length) return null;
                    return this._buildWavFromPcmS16le(pcm, 16000, 1);
                };
                await this.halinSession.start();
                const recHide = document.getElementById('btn-halin-recover');
                if (recHide) recHide.hidden = true;
            } catch (err) {
                const msg = String(err?.message || err);
                this._showToast(`Không khởi động được HaLin: ${msg}`, 'error');
                if (/token|bearer|unauthorized|login/i.test(msg)) {
                    this._showToast('Phiên đăng nhập hết hạn hoặc thiếu quyền. Đăng nhập lại.', 'error');
                    this._showView('login');
                }
            }
        }

        if (this.translationMode === 'local') {
            await this._startLocalMode(settings);
        } else {
            await this._startSonioxMode(settings);
        }

        // Start TTS if enabled
        if (this.ttsEnabled) {
            const tts = this._getActiveTTS();
            this._configureTTS(tts, settings);
            tts.connect();
            audioPlayer.resume();
        }
    }

    _getHalinToken() {
        const s = settingsManager.get();
        const access = String(s.halin_access_token || '').trim();
        const legacy = String(s.halin_api_token || '').trim();
        return access || legacy;
    }

    async _startSonioxMode(settings) {
        // HaLin classroom: PCM → server (Whisper or Soniox per HALIN_STT_PROVIDER).
        if (this.halinSession.isEnabled()) {
            this._updateStatus('connecting');
            try {
                let audioChunkCount = 0;
                const channel = new window.__TAURI__.core.Channel();
                channel.onmessage = (pcmData) => {
                    audioChunkCount++;
                    const bytes = new Uint8Array(pcmData);
                    this.halinSession.addPcmAudio(bytes);
                    if (this._liveFullPcmChunks) this._liveFullPcmChunks.push(bytes);
                    if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                        console.log(`[Audio] Batch #${audioChunkCount}, size:`, bytes.length || 0);
                    }
                };
                console.log('[App] Starting audio capture (HaLin backend STT), source:', this.currentSource);
                await invoke('start_capture', { source: this.currentSource, channel });
                this._updateStatus('connected');
                return;
            } catch (err) {
                console.error('Failed to start audio capture:', err);
                this._showToast(`Lỗi âm thanh: ${err}`, 'error');
                await this.stop();
                return;
            }
        }
        this._showToast('Chế độ này cần bật HaLin (để tạo job và xử lý STT). Vào Settings → bật HaLin.', 'error');
        this.isRunning = false;
        this._updateStartButton();
        this._updateStatus('error');
    }

    async _startLocalMode(settings) {
        console.log('[App] Starting Local mode (MLX models)...');
        this._updateStatus('connecting');

        // Step 0: Check audio permission FIRST (before loading models)
        try {
            await invoke('start_capture', {
                source: this.currentSource,
                channel: new window.__TAURI__.core.Channel(), // dummy channel for permission check
            });
            await invoke('stop_capture');
        } catch (err) {
            console.error('[App] Audio permission check failed:', err);
            this._showToast(`Cần quyền truy cập mic/âm thanh: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            return;
        }

        // Step 1: Check if MLX setup is complete
        try {
            const checkResult = await invoke('check_mlx_setup');
            const status = JSON.parse(checkResult);
            if (!status.ready) {
                this._showToast('Đang cài mô hình MLX (một lần, ~5GB)…', 'success');
                this.transcriptUI.showStatusMessage('Đang tải mô hình MLX (cài đặt một lần)…');
                await this._runMlxSetup();
            }
        } catch (err) {
            console.warn('[App] MLX check failed (proceeding anyway):', err);
        }

        console.log('[App] MLX check passed, starting pipeline...');

        // Step 1: Start pipeline FIRST (independent of audio)
        try {
            this._showToast('Đang khởi động pipeline cục bộ…', 'success');

            this.localPipelineChannel = new window.__TAURI__.core.Channel();
            this.localPipelineReady = false;

            this.localPipelineChannel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    console.warn('[Local] JSON parse failed:', typeof msg, msg);
                    return;
                }
                try {
                    this._handleLocalPipelineResult(data);
                } catch (e) {
                    console.error('[Local] Handler error for type:', data?.type, e);
                }
            };

            const sourceLangMap = {
                'auto': 'auto', 'ja': 'Japanese', 'en': 'English',
                'zh': 'Chinese', 'ko': 'Korean', 'vi': 'Vietnamese',
            };
            const sourceLang = sourceLangMap[settings.source_language] || 'Japanese';

            await invoke('start_local_pipeline', {
                sourceLang: sourceLang,
                targetLang: settings.target_language || 'vi',
                channel: this.localPipelineChannel,
            });
            console.log('[App] Local pipeline spawned');
        } catch (err) {
            console.error('Failed to start pipeline:', err);
            this._showToast(`Lỗi pipeline: ${err}`, 'error');
            await this.stop();
            return;
        }

        // Step 2: Start audio capture
        try {
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;

            audioChannel.onmessage = async (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Local] Audio batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                try {
                    await invoke('send_audio_to_pipeline', { data: Array.from(new Uint8Array(pcmData)) });
                } catch (e) {
                    // Pipeline may not be ready yet
                }
            };

            await invoke('start_capture', {
                source: this.currentSource,
                channel: audioChannel,
            });
            console.log('[App] Audio capture started');
        } catch (err) {
            console.error('Audio capture failed (pipeline still running):', err);
            this._showToast(`Âm thanh: ${err}. Pipeline vẫn đang tải…`, 'error');
        }
    }

    _handleLocalPipelineResult(data) {
        switch (data.type) {
            case 'ready':
                this.localPipelineReady = true;
                this._updateStatus('connected');
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.showListening();
                this._showToast('Mô hình cục bộ đã sẵn sàng!', 'success');
                break;
            case 'result':
                // Chase effect: show original first (gray), then translation (white)
                if (data.original) {
                    this.transcriptUI.addOriginal(data.original);
                }
                // Small delay for visual "chase" effect
                setTimeout(() => {
                if (data.translated) {
                    this.transcriptUI.addTranslation(data.translated);
                    this._speakIfEnabled(data.translated);
                }
                }, 80);
                break;
            case 'status':
                const msg = data.message || 'Loading...';
                // Status bar: show compact message (strip [pipeline] prefix)
                const statusText = document.getElementById('status-text');
                if (statusText) {
                    const compact = msg.replace(/^\[pipeline\]\s*/, '');
                    statusText.textContent = compact;
                }
                // Transcript area: only show loading/starting messages, not debug logs
                if (!msg.startsWith('[pipeline]')) {
                    this.transcriptUI.showStatusMessage(msg);
                }
                break;
            case 'done':
                this._updateStatus('disconnected');
                break;
        }
    }

    async _runMlxSetup() {
        const modal = document.getElementById('setup-modal');
        const progressFill = document.getElementById('setup-progress-fill');
        const progressPct = document.getElementById('setup-progress-pct');
        const statusText = document.getElementById('setup-status-text');
        const cancelBtn = document.getElementById('btn-cancel-setup');

        // Step mapping: step name → total progress weight
        const stepWeights = { check: 5, venv: 10, packages: 35, models: 50 };
        let totalProgress = 0;

        const updateStep = (stepName, icon, isActive) => {
            const stepEl = document.getElementById(`step-${stepName}`);
            if (!stepEl) return;
            stepEl.querySelector('.step-icon').textContent = icon;
            stepEl.classList.toggle('active', isActive);
            stepEl.classList.toggle('done', icon === '✅');
        };

        const updateProgress = (pct) => {
            totalProgress = Math.min(100, pct);
            progressFill.style.width = totalProgress + '%';
            progressPct.textContent = Math.round(totalProgress) + '%';
        };

        // Show modal
        modal.style.display = 'flex';
        const releaseFocusTrap = this._trapFocus(modal);

        return new Promise((resolve, reject) => {
            const channel = new window.__TAURI__.core.Channel();

            // Cancel handler
            const onCancel = () => {
                releaseFocusTrap();
                modal.style.display = 'none';
                reject(new Error('Đã hủy cài đặt'));
            };
            cancelBtn.addEventListener('click', onCancel, { once: true });

            channel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    return;
                }

                switch (data.type) {
                    case 'progress':
                        statusText.textContent = data.message || 'Đang xử lý…';

                        // Update step indicators
                        if (data.step) {
                            // Mark previous steps as done
                            const steps = ['check', 'venv', 'packages', 'models'];
                            const currentIdx = steps.indexOf(data.step);
                            steps.forEach((s, i) => {
                                if (i < currentIdx) updateStep(s, '✅', false);
                                else if (i === currentIdx) updateStep(s, '🔄', true);
                            });

                            if (data.done) {
                                updateStep(data.step, '✅', false);
                            }

                            // Calculate overall progress
                            let pct = 0;
                            steps.forEach((s, i) => {
                                if (i < currentIdx) pct += stepWeights[s];
                                else if (i === currentIdx) {
                                    pct += (data.progress || 0) / 100 * stepWeights[s];
                                }
                            });
                            updateProgress(pct);
                        }
                        break;

                    case 'complete':
                        updateProgress(100);
                        statusText.textContent = '✅ ' + (data.message || 'Cài đặt xong!');
                        ['check', 'venv', 'packages', 'models'].forEach(s => updateStep(s, '✅', false));

                        // Close modal after brief delay
                        setTimeout(() => {
                            releaseFocusTrap();
                            modal.style.display = 'none';
                            resolve();
                        }, 1000);
                        break;

                    case 'error':
                        statusText.textContent = '❌ ' + (data.message || 'Cài đặt thất bại');
                        cancelBtn.textContent = 'Đóng';
                        cancelBtn.removeEventListener('click', onCancel);
                        cancelBtn.addEventListener('click', () => {
                            releaseFocusTrap();
                            modal.style.display = 'none';
                            reject(new Error(data.message));
                        }, { once: true });
                        break;

                    case 'log':
                        console.log('[MLX Setup]', data.message);
                        break;
                }
            };

            invoke('run_mlx_setup', { channel })
                .catch(err => {
                    releaseFocusTrap();
                    statusText.textContent = '❌ ' + err;
                    modal.style.display = 'none';
                    reject(err);
                });
        });
    }

    async stop() {
        this.isRunning = false;
        this._updateStartButton();
        this.sessionStartTime = null;
        this._stopSessionTimer();
        this._snapshotSessionDurationLabel();

        // Stop audio capture
        try {
            await invoke('stop_capture');
        } catch (err) {
            console.error('Failed to stop audio capture:', err);
        }

        if (this.translationMode === 'local') {
            // Stop local pipeline
            try {
                await invoke('stop_local_pipeline');
            } catch (err) {
                console.error('Failed to stop local pipeline:', err);
            }
            this.localPipelineReady = false;
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
        } else {
            this._updateStatus('disconnected');
        }

        // Keep transcript visible — don't clear
        this.transcriptUI.clearProvisional();

        // Stop TTS
        elevenLabsTTS.disconnect();
        edgeTTSRust.disconnect();

        audioPlayer.stop();

        // Finalize HaLin session after capture stops
        if (this.halinSession.isEnabled()) {
            try {
                const r = await this.halinSession.stopAndFinalize();
                // Release large buffers after finalize (WAV upload may be big).
                this._liveFullPcmChunks = [];
                this._buildLiveWavBytesForFinalize = null;
                const rec = document.getElementById('btn-halin-recover');
                if (rec) rec.hidden = true;
                const jobId = r?.job_id || this.halinSession?.jobId || null;
                if (jobId) {
                    this._pollHalinJobCompleted(jobId).catch(() => {});
                }
            } catch (err) {
                this._showToast('Không kết thúc được phiên HaLin — có thể dùng Khôi phục từ bộ đệm.', 'error');
                const rec = document.getElementById('btn-halin-recover');
                if (rec) rec.hidden = false;
            }
        }

        // Auto-save on stop — use full sessionLog (not trimmed display buffer)
        if (this.transcriptUI.hasSessionContent()) {
            await this._saveTranscriptFile();
            this.transcriptUI.clearSession();
        }
    }

    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');
        const label = document.getElementById('btn-start-label');

        btn.classList.toggle('recording', this.isRunning);
        iconPlay.style.display = this.isRunning ? 'none' : 'block';
        iconStop.style.display = this.isRunning ? 'block' : 'none';
        if (label) label.textContent = this.isRunning ? 'Dừng' : 'Bắt đầu';
        if (!this.isRunning) {
            const allow = this._sessionSetupAllowsStart();
            btn.disabled = !allow;
            btn.title = allow
                ? 'Bắt đầu / Dừng (Space)'
                : 'Nhập chủ đề buổi học và bấm Lưu thiết lập trên sidebar (hoặc tắt HaLin Phân Tích để bắt đầu ngay)';
        } else {
            btn.disabled = false;
            btn.title = 'Dừng ghi nhận';
        }
        document.getElementById('app-footer-dock')?.classList.toggle('recording', this.isRunning);
        this._updateSourceButtons();
    }

    // ─── Transcript Persistence ───────────────────────────────

    _formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}m ${sec}s`;
    }

    _snapshotSessionDurationLabel() {
        if (!this.recordingStartTime) {
            this.lastSessionDurationLabel = null;
            return;
        }
        const durationMs = Date.now() - this.recordingStartTime;
        this.lastSessionDurationLabel = this._formatDuration(durationMs);
    }

    async _saveTranscriptFile() {
        const duration =
            this.lastSessionDurationLabel ??
            (this.recordingStartTime
                ? this._formatDuration(Date.now() - this.recordingStartTime)
                : '0m 0s');

        // Use session metadata captured at start()
        const sourceLang = this.sessionSourceLang || document.getElementById('select-source-lang')?.value || 'auto';
        const targetLang = this.sessionTargetLang || document.getElementById('select-target-lang')?.value || 'vi';
        const mode = this.sessionMode || 'one_way';

        const content = this.transcriptUI.getFullSessionText({
            model:
                this.translationMode === 'soniox'
                    ? 'HaLin backend STT (Whisper or Soniox)'
                    : 'Local MLX Whisper',
            sourceLang,
            targetLang,
            duration,
            mode,
            audioSource: this.currentSource,
        });

        if (!content) return;

        try {
            const path = await invoke('save_transcript', { content });
            const filename = path.split('/').pop();
            this._showToast(`Đã lưu: ${filename}`, 'success');
        } catch (err) {
            console.error('Failed to save transcript:', err);
            this._showToast('Không lưu được transcript', 'error');
        }
    }

    // ─── Status ────────────────────────────────────────────

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');
        const pill = document.getElementById('header-status-pill');

        dot.className = 'status-dot';
        if (pill) {
            pill.classList.remove('status-pill--live', 'status-pill--idle');
        }

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = 'Đang kết nối…';
                if (pill) pill.classList.add('status-pill--idle');
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = 'Đang nghe';
                if (pill) pill.classList.add('status-pill--live');
                break;
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = 'Sẵn sàng';
                if (pill) pill.classList.add('status-pill--idle');
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Lỗi';
                if (pill) pill.classList.add('status-pill--idle');
                break;
        }
    }

    // ─── Window Position ───────────────────────────────────

    async _saveWindowPosition() {
        try {
            const factor = await this.appWindow.scaleFactor();
            const pos = await this.appWindow.outerPosition();
            const size = await this.appWindow.innerSize();
            // Save logical coordinates (physical / scaleFactor)
            localStorage.setItem('window_state', JSON.stringify({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                width: Math.round(size.width / factor),
                height: Math.round(size.height / factor),
            }));
        } catch (err) {
            console.error('Failed to save window position:', err);
        }
    }

    async _restoreWindowPosition() {
        try {
            const saved = localStorage.getItem('window_state');
            if (!saved) return;

            const state = JSON.parse(saved);
            const { LogicalPosition, LogicalSize } = window.__TAURI__.window;

            // Validate — don't restore if position seems off-screen
            if (state.x < -100 || state.y < -100 || state.x > 5000 || state.y > 3000) {
                console.warn('Saved window position looks off-screen, skipping restore');
                localStorage.removeItem('window_state');
                return;
            }

            if (state.width && state.height && state.width >= 300 && state.height >= 100) {
                await this.appWindow.setSize(new LogicalSize(state.width, state.height));
            }
            if (state.x !== undefined && state.y !== undefined) {
                await this.appWindow.setPosition(new LogicalPosition(state.x, state.y));
            }
        } catch (err) {
            console.error('Failed to restore window position:', err);
            localStorage.removeItem('window_state');
        }
    }

    // ─── Pin / Unpin (Always on Top) ────────────────────

    async _togglePin() {
        this.isPinned = !this.isPinned;
        await this.appWindow.setAlwaysOnTop(this.isPinned);
        const btn = document.getElementById('btn-pin');
        if (btn) btn.classList.toggle('active', this.isPinned);
        this._showToast(this.isPinned ? 'Đã ghim cửa sổ (luôn trên cùng)' : 'Đã bỏ ghim — cửa sổ có thể nằm sau app khác', 'success');
    }

    // ─── Compact Mode ───────────────────────────────

    _toggleCompact() {
        this.isCompact = !this.isCompact;
        const dragRegion = document.getElementById('drag-region');
        const overlay = document.getElementById('overlay-view');

        if (this.isCompact) {
            dragRegion.classList.add('compact-hidden');
            overlay.classList.add('compact-mode');
        } else {
            dragRegion.classList.remove('compact-hidden');
            overlay.classList.remove('compact-mode');
        }
    }

    _toggleViewMode() {
        const isDual = this.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.transcriptUI.configure({ viewMode: newMode });
        const btn = document.getElementById('btn-view-mode');
        if (btn) btn.classList.toggle('active', newMode === 'dual');
    }

    _adjustFontSize(delta) {
        const current = this.transcriptUI.fontSize || 16;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.transcriptUI.configure({ fontSize: newSize });

        // Update display
        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;

        // Sync with settings slider
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
    }

    // ─── Toast ─────────────────────────────────────────────

    // ─── Session History ───────────────────────────────────

    async _showSessions() {
        const listEl = document.getElementById('sessions-list');
        const listPanel = document.getElementById('sessions-list-panel');
        const viewer = document.getElementById('session-viewer');

        if (listPanel) listPanel.style.display = '';
        if (viewer) viewer.style.display = 'none';
        if (!listEl) return;

        listEl.replaceChildren();
        const loadingEl = document.createElement('div');
        loadingEl.className = 'sessions-loading';
        loadingEl.textContent = 'Loading...';
        listEl.appendChild(loadingEl);

        try {
            const sessions = await invoke('list_transcripts');
            listEl.replaceChildren();
            if (sessions.length === 0) {
                const emptyEl = document.createElement('div');
                emptyEl.className = 'sessions-empty';
                emptyEl.textContent = 'Chưa có phiên nào được lưu.';
                listEl.appendChild(emptyEl);
                return;
            }

            for (const s of sessions) {
                const meta = this._parseSessionMeta(s);
                const filename = s.filename != null ? String(s.filename) : '';

                const item = document.createElement('div');
                item.className = 'session-item';
                item.dataset.filename = filename;

                const dateEl = document.createElement('div');
                dateEl.className = 'session-item-date';
                dateEl.textContent = meta.date;

                const metaEl = document.createElement('div');
                metaEl.className = 'session-item-meta';

                const timeEl = document.createElement('span');
                timeEl.className = 'session-item-time';
                timeEl.textContent = meta.time;
                metaEl.appendChild(timeEl);

                if (meta.duration) {
                    const durEl = document.createElement('span');
                    durEl.className = 'session-item-duration';
                    durEl.textContent = meta.duration;
                    metaEl.appendChild(durEl);
                }
                if (meta.langPair) {
                    const langEl = document.createElement('span');
                    langEl.className = 'session-item-langs';
                    langEl.textContent = meta.langPair;
                    metaEl.appendChild(langEl);
                }

                const sizeEl = document.createElement('div');
                sizeEl.className = 'session-item-size';
                sizeEl.textContent = this._formatBytes(s.size_bytes);

                item.appendChild(dateEl);
                item.appendChild(metaEl);
                item.appendChild(sizeEl);
                item.addEventListener('click', () => {
                    this._openSession(filename);
                });
                listEl.appendChild(item);
            }
        } catch (err) {
            listEl.replaceChildren();
            const errEl = document.createElement('div');
            errEl.className = 'sessions-empty';
            errEl.textContent = `Lỗi: ${String(err?.message || err)}`;
            listEl.appendChild(errEl);
        }
    }

    async _openSession(filename) {
        const listPanel = document.getElementById('sessions-list-panel');
        const viewer = document.getElementById('session-viewer');
        const title = document.getElementById('session-viewer-title');
        const content = document.getElementById('session-viewer-content');

        if (listPanel) listPanel.style.display = 'none';
        if (viewer) viewer.style.display = '';
        if (title) title.textContent = filename.replace('.md', '').replace('_', ' ');
        if (content) content.textContent = 'Đang tải…';

        try {
            const text = await invoke('read_transcript', { filename });
            if (content) content.textContent = text;
        } catch (err) {
            if (content) content.textContent = `Không tải được phiên: ${err}`;
        }
    }

    _parseSessionMeta(session) {
        // created_at format: "2026-03-27 10:21:05"
        const parts = (session.created_at || '').split(' ');
        const date = parts[0] || '';
        const time = parts[1] ? parts[1].slice(0, 5) : '';
        return { date, time, duration: '', langPair: '' };
    }

    _formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    async _checkForUpdates() {
        updater.onUpdateFound = (version, notes) => {
            this._onUpdateAvailable(version, notes);
        };
        updater.onError = (err) => {
            const statusText = document.getElementById('update-status-text');
            if (statusText) statusText.textContent = `⚠️ Check failed: ${err.message || err}`;
        };
        updater.onCheckComplete = (hasUpdate) => {
            const checkBtn = document.getElementById('btn-check-update');
            if (checkBtn) checkBtn.classList.remove('spinning');
            if (!hasUpdate && !this._pendingUpdateVersion) {
                const statusText = document.getElementById('update-status-text');
                if (statusText) statusText.textContent = '✅ App is up to date';
            }
        };
        // Delay check slightly so app finishes loading first
        setTimeout(() => {
            const statusText = document.getElementById('update-status-text');
            const checkBtn = document.getElementById('btn-check-update');
            if (statusText) statusText.textContent = 'Đang kiểm tra cập nhật…';
            if (checkBtn) checkBtn.classList.add('spinning');
            updater.checkForUpdates();
        }, 3000);
    }

    _triggerUpdateCheck() {
        const statusText = document.getElementById('update-status-text');
        const checkBtn = document.getElementById('btn-check-update');
        if (statusText) statusText.textContent = 'Đang kiểm tra cập nhật…';
        if (checkBtn) checkBtn.classList.add('spinning');
        updater.checkForUpdates();
    }

    _onUpdateAvailable(version, notes) {
        this._pendingUpdateVersion = version;

        // 1. Show badge on sidebar Cài đặt
        const badge = document.getElementById('settings-badge');
        if (badge) badge.style.display = '';

        // 2. Update About tab status
        const statusEl = document.getElementById('update-status');
        const statusText = document.getElementById('update-status-text');
        const actions = document.getElementById('update-actions');
        if (statusEl) statusEl.classList.add('has-update');
        if (statusText) statusText.textContent = `🆕 Có bản cập nhật v${version}`;
        if (actions) actions.style.display = '';

        // 3. Show subtle hint on main screen
        const existing = document.querySelector('.update-hint');
        if (existing) existing.remove();
        const hint = document.createElement('div');
        hint.className = 'update-hint';
        hint.textContent = `Có bản v${version} — mở Cài đặt → tab Thêm`;
        hint.addEventListener('click', () => {
            this._showView('settings');
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-tab-content').forEach(t => t.classList.remove('active'));
            const extraTab = document.querySelector('[data-tab="tab-extra"]');
            const extraContent = document.getElementById('tab-extra');
            if (extraTab) extraTab.classList.add('active');
            if (extraContent) extraContent.classList.add('active');
            hint.remove();
        });
        document.body.appendChild(hint);

        // Auto-hide hint after 8 seconds
        setTimeout(() => { if (hint.parentNode) hint.remove(); }, 8000);
    }

    _initAboutTab() {
        // Check for Updates button
        document.getElementById('btn-check-update')?.addEventListener('click', () => {
            this._triggerUpdateCheck();
        });

        // Download & Install button
        document.getElementById('btn-do-update')?.addEventListener('click', async () => {
            const btnText = document.getElementById('update-btn-text');
            const btn = document.getElementById('btn-do-update');
            const progressDiv = document.getElementById('update-progress');
            const progressFill = document.getElementById('update-progress-fill');
            const progressPct = document.getElementById('update-progress-pct');

            if (btn) btn.disabled = true;
            if (btnText) btnText.textContent = 'Đang tải…';
            if (progressDiv) progressDiv.style.display = '';

            try {
                await updater.downloadAndInstall((downloaded, total) => {
                    if (total > 0) {
                        const pct = Math.round((downloaded / total) * 100);
                        if (progressFill) progressFill.style.width = `${pct}%`;
                        if (progressPct) progressPct.textContent = `${pct}%`;
                        if (btnText) btnText.textContent = `Đang tải ${pct}%…`;
                    }
                });
                // Install succeeded! Try to restart
                if (btnText) btnText.textContent = 'Đang khởi động lại…';
                try {
                    const relaunch = window.__TAURI__?.process?.relaunch;
                    if (relaunch) {
                        await relaunch();
                    } else {
                        const invoke = window.__TAURI__?.core?.invoke;
                        if (invoke) await invoke('plugin:process|restart');
                    }
                } catch (restartErr) {
                    // Restart failed (e.g. process plugin not available) but update IS installed
                    console.warn('[Update] Restart failed, update is installed:', restartErr);
                    if (btnText) btnText.textContent = '✅ Updated! Restart app';
                    const statusText = document.getElementById('update-status-text');
                    if (statusText) statusText.textContent = '✅ Đã cài cập nhật — đóng và mở lại app';
                    if (btn) btn.disabled = true;
                }
            } catch (err) {
                const errMsg = err?.message || String(err);
                if (btnText) btnText.textContent = 'Thất bại — thử lại';
                const statusText = document.getElementById('update-status-text');
                if (statusText) statusText.textContent = `⚠️ Install error: ${errMsg}`;
                if (btn) btn.disabled = false;
                console.error('[Update]', err);
            }
        });
    }

    _dismissToast(toast) {
        if (!toast?.parentNode) return;
        const tid = toast.dataset.timerId;
        if (tid) clearTimeout(Number(tid));
        delete toast.dataset.timerId;
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }

    _showToast(message, type = 'success') {
        const MAX_TOASTS = 3;
        let stack = document.getElementById('toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'toast-stack';
            stack.className = 'toast-stack';
            stack.setAttribute('aria-live', 'polite');
            stack.setAttribute('aria-relevant', 'additions text');
            document.body.appendChild(stack);
        }

        const existing = stack.querySelectorAll(':scope > .toast');
        if (existing.length >= MAX_TOASTS) {
            existing[0].remove();
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.setAttribute('role', 'status');

        const msg = document.createElement('span');
        msg.className = 'toast-msg';
        msg.textContent = message;

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'toast-dismiss';
        dismiss.setAttribute('aria-label', 'Đóng');
        dismiss.textContent = '✕';
        dismiss.addEventListener('click', () => this._dismissToast(toast));

        toast.appendChild(msg);
        toast.appendChild(dismiss);
        stack.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));

        const duration = type === 'error' ? 6000 : 3500;
        const timer = setTimeout(() => this._dismissToast(toast), duration);
        toast.dataset.timerId = String(timer);
    }

    _hideSessionResultCard() {
        const card = document.getElementById('session-result-card');
        if (!card) return;
        card.classList.add('hidden');
        card.setAttribute('aria-hidden', 'true');
    }

    /**
     * Kết quả buổi học (HaLin job completed) — card trong transcript; fallback toast nếu thiếu DOM.
     * @param {{ totalScore?: number|null, issuesCount?: number|null, jobId?: string|null, durationLabel?: string|null }} _
     */
    _showSessionResultToast({ totalScore, issuesCount, jobId, durationLabel }) {
        const card = document.getElementById('session-result-card');
        const ring = document.getElementById('ring-fill');
        const scoreVal = document.getElementById('result-score-value');
        const issuesEl = document.getElementById('result-issues-count');
        const durEl = document.getElementById('result-duration');
        const timeEl = document.getElementById('result-card-time');

        if (!card || !ring || !scoreVal) {
            const root = document.getElementById('session-result-toast');
            const body = document.getElementById('session-result-body');
            const link = document.getElementById('session-result-link');
            if (!root || !body || !link) {
                this._showToast(
                    `Kết quả: ${totalScore != null ? `${totalScore}/100` : '—'} · Issues: ${issuesCount != null ? issuesCount : '—'}`,
                    'success',
                );
                return;
            }
            body.textContent = `Điểm tổng: ${totalScore != null ? `${totalScore}/100` : '—'} · Issues: ${issuesCount != null ? issuesCount : '—'}`;
            link.onclick = (e) => {
                e.preventDefault();
                const s = settingsManager.get();
                const base = String(s.halin_base_url || DEFAULT_HALIN_API_BASE_URL).replace(/\/+$/, '');
                const url = `${base}/dashboard/#/training/job-detail?id=${encodeURIComponent(String(jobId || ''))}`;
                try {
                    window.__TAURI__?.opener?.openUrl?.(url);
                } catch {
                    // ignore
                }
            };
            root.classList.remove('hidden');
            root.classList.add('show', 'success');
            setTimeout(() => {
                root.classList.remove('show');
                setTimeout(() => root.classList.add('hidden'), 300);
            }, 8000);
            return;
        }

        const circumference = 213.6;
        if (totalScore != null && totalScore !== '' && !Number.isNaN(Number(totalScore))) {
            const s = Math.max(0, Math.min(100, Number(totalScore)));
            scoreVal.textContent = String(Math.round(s));
            ring.style.strokeDashoffset = String(circumference * (1 - s / 100));
        } else {
            scoreVal.textContent = '—';
            ring.style.strokeDashoffset = String(circumference);
        }

        if (issuesEl) issuesEl.textContent = issuesCount != null ? String(issuesCount) : '—';
        if (durEl) durEl.textContent = durationLabel != null && String(durationLabel).trim() !== '' ? String(durationLabel) : '—';
        if (timeEl) timeEl.textContent = new Date().toLocaleString('vi-VN');

        card.dataset.jobId = jobId != null ? String(jobId) : '';
        card.classList.remove('hidden');
        card.setAttribute('aria-hidden', 'false');
    }

    /**
     * Giữ phím Tab trong modal; gỡ listener và khôi phục focus khi gọi hàm trả về.
     * @param {HTMLElement | null} modal
     * @returns {() => void}
     */
    _trapFocus(modal) {
        if (!modal) return () => {};
        const previous = document.activeElement;
        const selector =
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const getFocusable = () =>
            Array.from(modal.querySelectorAll(selector)).filter((el) => {
                if (el.getAttribute('aria-hidden') === 'true') return false;
                const st = window.getComputedStyle(el);
                if (st.display === 'none' || st.visibility === 'hidden') return false;
                return true;
            });

        const handler = (e) => {
            if (e.key !== 'Tab') return;
            const list = getFocusable();
            if (list.length === 0) return;
            const first = list[0];
            const last = list[list.length - 1];
            const active = document.activeElement;
            const inside = modal.contains(active);
            if (e.shiftKey) {
                if (!inside || active === first) {
                    e.preventDefault();
                    last.focus();
                }
            } else if (!inside || active === last) {
                e.preventDefault();
                first.focus();
            }
        };

        modal.addEventListener('keydown', handler);
        requestAnimationFrame(() => {
            const list = getFocusable();
            if (list[0]) {
                list[0].focus();
            } else {
                try {
                    modal.focus();
                } catch {
                    // ignore
                }
            }
        });

        return () => {
            modal.removeEventListener('keydown', handler);
            if (previous && typeof previous.focus === 'function') {
                try {
                    previous.focus();
                } catch {
                    // ignore
                }
            }
        };
    }

    /**
     * HaLin JWT login: collect password in-app (masked). Password is never written to settings disk.
     * @param {{ email?: string }} _
     * @returns {Promise<string|null>} trimmed password; empty string if user submitted blank; null if cancelled
     */
    _showHalinLoginPasswordModal({ email } = {}) {
        const overlay = document.getElementById('halin-login-password-modal');
        const pwInput = document.getElementById('input-halin-login-password-modal');
        const hint = document.getElementById('halin-login-password-email-hint');
        const btnOk = document.getElementById('btn-halin-login-password-ok');
        const btnCancel = document.getElementById('btn-halin-login-password-cancel');
        const safeEmail = String(email || '').trim();
        if (!overlay || !pwInput || !btnOk || !btnCancel) {
            const p = window.prompt('Mật khẩu HaLin (fallback — không lưu đĩa):');
            if (p === null) return Promise.resolve(null);
            return Promise.resolve(String(p).trim());
        }
        return new Promise((resolve) => {
            if (hint) {
                hint.textContent = safeEmail
                    ? `Tài khoản: ${safeEmail}\nMật khẩu không được lưu vào Settings hoặc đĩa.`
                    : 'Mật khẩu không được lưu vào Settings hoặc đĩa.';
            }
            pwInput.value = '';

            let releaseFocusTrap = () => {};

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                pwInput.value = '';
                releaseFocusTrap();
                overlay.style.display = 'none';
                btnOk.removeEventListener('click', onOk);
                btnCancel.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onOverlayClick);
                document.removeEventListener('keydown', onKey);
                pwInput.removeEventListener('keydown', onPwKey);
                resolve(value);
            };

            const onOk = () => finish((pwInput.value || '').trim());
            const onCancel = () => finish(null);
            const onOverlayClick = (e) => {
                if (e.target === overlay) finish(null);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') finish(null);
            };
            const onPwKey = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    onOk();
                }
            };

            btnOk.addEventListener('click', onOk);
            btnCancel.addEventListener('click', onCancel);
            overlay.addEventListener('click', onOverlayClick);
            document.addEventListener('keydown', onKey);
            pwInput.addEventListener('keydown', onPwKey);
            overlay.style.display = 'flex';
            releaseFocusTrap = this._trapFocus(overlay);
        });
    }

    /**
     * Ask user (in-app modal) whether to retry finalize for a pending job. Falls back to `confirm` if DOM missing.
     * @returns {Promise<boolean>}
     */
    _showPendingFinalizeDialog({ jobId }) {
        const overlay = document.getElementById('halin-pending-finalize-modal');
        const body = document.getElementById('halin-pending-finalize-body');
        const btnOk = document.getElementById('btn-halin-pending-confirm');
        const btnCancel = document.getElementById('btn-halin-pending-cancel');
        const safeJob = String(jobId || '—');
        if (!overlay || !body || !btnOk || !btnCancel) {
            return Promise.resolve(
                window.confirm(
                    'Phát hiện buổi học có thể chưa gửi dữ liệu lên HaLin (mất mạng / app tắt đột ngột).\n\n' +
                        `Job: ${safeJob}\n` +
                        'Bạn có muốn gửi lại dữ liệu buổi học lên HaLin ngay bây giờ không?',
                ),
            );
        }
        return new Promise((resolve) => {
            body.replaceChildren();
            const p1 = document.createElement('p');
            p1.className = 'modal-desc';
            p1.textContent =
                'Có thể buổi học chưa gửi dữ liệu lên HaLin (mất mạng hoặc app tắt đột ngột). Bạn có muốn gửi lại dữ liệu buổi học lên HaLin ngay bây giờ?';
            const p2 = document.createElement('p');
            p2.className = 'modal-desc';
            p2.style.marginBottom = '0';
            p2.textContent = `Job: ${safeJob}`;
            body.appendChild(p1);
            body.appendChild(p2);

            let releaseFocusTrap = () => {};

            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                releaseFocusTrap();
                overlay.style.display = 'none';
                btnOk.removeEventListener('click', onOk);
                btnCancel.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onOverlayClick);
                document.removeEventListener('keydown', onKey);
                resolve(ok);
            };
            const onOk = () => finish(true);
            const onCancel = () => finish(false);
            const onOverlayClick = (e) => {
                if (e.target === overlay) finish(false);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') finish(false);
            };

            btnOk.addEventListener('click', onOk);
            btnCancel.addEventListener('click', onCancel);
            overlay.addEventListener('click', onOverlayClick);
            document.addEventListener('keydown', onKey);
            overlay.style.display = 'flex';
            releaseFocusTrap = this._trapFocus(overlay);
        });
    }

    /**
     * If a previous run crashed or lost network after chunks were sent but before finalize ACK,
     * `halin-classroom` leaves a payload in localStorage (WebView clears sessionStorage on window close).
     * On next launch, offer to resend finalize.
     */
    async _maybeRetryPendingHalinFinalize() {
        let raw = '';
        try {
            raw = localStorage.getItem(HALIN_PENDING_FINALIZE_KEY) || '';
        } catch {
            return;
        }
        if (!raw) {
            try {
                const legacy = sessionStorage.getItem(HALIN_PENDING_FINALIZE_KEY);
                if (legacy) {
                    localStorage.setItem(HALIN_PENDING_FINALIZE_KEY, legacy);
                    sessionStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
                    raw = legacy;
                }
            } catch {
                // ignore
            }
        }
        if (!raw) return;

        let pending = null;
        try {
            pending = JSON.parse(raw);
        } catch {
            try {
                localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
            } catch {
                // ignore
            }
            return;
        }

        const jobId = pending?.jobId != null ? String(pending.jobId).trim() : '';
        const baseUrl = pending?.baseUrl != null ? String(pending.baseUrl).trim() : '';
        if (!jobId || !baseUrl) {
            try {
                localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
            } catch {
                // ignore
            }
            return;
        }

        const savedAt = Number(pending?.savedAt);
        const maxAgeMs = 48 * 60 * 60 * 1000;
        if (Number.isFinite(savedAt) && Date.now() - savedAt > maxAgeMs) {
            try {
                localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
            } catch {
                // ignore
            }
            this._showToast('Bỏ qua buổi học chưa gửi dữ liệu lên HaLin (quá 48h).', 'info');
            return;
        }

        const token0 = this._getHalinToken();
        if (!token0) {
            // User not signed in yet — keep pending for a later session when token exists.
            return;
        }

        // If user chose "Để sau" recently, don't nag again in this session.
        const dismissedAt = Number(pending?.dismissedAt);
        const dismissCooldownMs = 30 * 60 * 1000;
        if (Number.isFinite(dismissedAt) && Date.now() - dismissedAt < dismissCooldownMs) {
            return;
        }

        // If there is nothing to resend (no segments in cache and none in UI), clear the stale pending entry.
        const cachedSegments = Array.isArray(pending?.clientSegments) ? pending.clientSegments : null;
        let uiSegments = null;
        if (!cachedSegments || cachedSegments.length === 0) {
            try {
                uiSegments = this.transcriptUI?.getHalinFinalizeSegments?.() ?? null;
            } catch {
                uiSegments = null;
            }
        }
        if ((!cachedSegments || cachedSegments.length === 0) && (!uiSegments || uiSegments.length === 0)) {
            try {
                localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
            } catch {
                // ignore
            }
            this._showToast('Đã xoá thông báo khôi phục vì buổi học quá ngắn nên không có dữ liệu.', 'info');
            this._syncRecoverButtonVisibility();
            return;
        }

        const ok = await this._showPendingFinalizeDialog({ jobId });
        if (!ok) {
            try {
                localStorage.setItem(
                    HALIN_PENDING_FINALIZE_KEY,
                    JSON.stringify({ ...pending, dismissedAt: Date.now() }),
                );
            } catch {
                // ignore
            }
            return;
        }

        const durationSeconds = pending?.durationSeconds ?? null;
        let clientSegments = Array.isArray(pending?.clientSegments) ? pending.clientSegments : null;
        if (!clientSegments || clientSegments.length === 0) {
            try {
                clientSegments = this.transcriptUI?.getHalinFinalizeSegments?.() ?? null;
            } catch {
                clientSegments = null;
            }
        }

        const s = settingsManager.get();
        const rt = String(s.halin_refresh_token || '').trim();

        const tryFinalize = async (token) =>
            finalizeLiveSession({
                baseUrl,
                token,
                jobId,
                durationSeconds,
                languageDetected: null,
                clientSegments,
            });

        try {
            try {
                await tryFinalize(token0);
            } catch (e) {
                const msg = String(e?.message || e);
                if (shouldRetryAuthAfterErrorMessage(msg)) {
                    if (!rt) throw e;
                    await this._refreshTokenOnce(baseUrl, rt);
                    await tryFinalize(this._getHalinToken());
                } else {
                    throw e;
                }
            }

            try {
                localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
            } catch {
                // ignore
            }

            this._showToast('Đã gửi lại dữ liệu buổi học lên HaLin.', 'success');
            this._syncRecoverButtonVisibility();
            this._pollHalinJobCompleted(jobId).catch(() => {});
        } catch (e) {
            // If job already progressed, try to surface score instead of nagging forever.
            try {
                const data = await getJobStatus({ baseUrl, token: this._getHalinToken(), jobId });
                const status = data?.status || data?.job_status || data?.state || null;
                if (String(status || '').toLowerCase() === 'completed') {
                    try {
                        localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
                    } catch {
                        // ignore
                    }
                    const totalScore = data?.score?.total_score ?? data?.score?.totalScore ?? null;
                    const issuesCount = Array.isArray(data?.analysis?.issues)
                        ? data.analysis.issues.length
                        : (Array.isArray(data?.analysis?.issue_list) ? data.analysis.issue_list.length : null);
                    this._showSessionResultToast({
                        totalScore,
                        issuesCount,
                        jobId,
                        durationLabel: this.lastSessionDurationLabel,
                    });
                    return;
                }
            } catch {
                // ignore
            }

            const msg = String(e?.message || e);
            if (/No transcript segments found|chunk_rows=0/i.test(msg)) {
                this._showToast(
                    'Không gửi lại được dữ liệu buổi học: không còn dữ liệu transcript để khôi phục (buổi học có thể đã bị mất do mất mạng/app tắt đột ngột).',
                    'error',
                );
            } else {
                this._showToast(`Gửi lại dữ liệu buổi học thất bại: ${msg}`, 'error');
            }
            this._syncRecoverButtonVisibility();
        }
    }

    async _pollHalinJobCompleted(jobId) {
        const s = settingsManager.get();
        const baseUrl = s.halin_base_url || DEFAULT_HALIN_API_BASE_URL;
        for (let i = 0; i < 10; i++) {
            try {
                const data = await getJobStatus({ baseUrl, token: this._getHalinToken(), jobId });
                const status = data?.status || data?.job_status || data?.state || null;
                if (String(status || '').toLowerCase() === 'completed') {
                    const totalScore = data?.score?.total_score ?? data?.score?.totalScore ?? null;
                    const issuesCount = Array.isArray(data?.analysis?.issues)
                        ? data.analysis.issues.length
                        : (Array.isArray(data?.analysis?.issue_list) ? data.analysis.issue_list.length : null);
                    this._showSessionResultToast({
                        totalScore,
                        issuesCount,
                        jobId,
                        durationLabel: this.lastSessionDurationLabel,
                    });
                    return;
                }
            } catch (e) {
                // ignore transient errors
            }
            await new Promise((r) => setTimeout(r, 10_000));
        }
        this._showToast('Đã gửi dữ liệu buổi học lên HaLin. Kết quả sẽ cập nhật trên Dashboard sau vài phút.', 'info');
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
