import { appendAudioChunk, finalizeLiveSession, listTeacherVoices, startLiveSession } from './halin-client.js';
import { halinRefresh } from './halin-auth.js';
import { HalinChunkQueue } from './halin-chunk-queue.js';
import { logError, logInfo, logWarn } from './logger.js';

function nowMs() {
  return Date.now();
}

function clampInt(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

const MAX_CHUNK_RETRIES = 5;
const HALIN_PENDING_FINALIZE_KEY = 'halin_pending_finalize';

/** 401 responses often use detail "Invalid access token" — not the word "unauthorized" — so refresh must match those too. */
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

/**
 * Manages a HaLin live_capture session: start -> append PCM chunks -> finalize.
 * STT engine (Whisper vs Soniox) is chosen on the server via HALIN_STT_PROVIDER.
 */
export class HalinClassroomSession {
  constructor({
    getSettings,
    setSettings,
    onStatus,
    onError,
    onMetrics,
    onTranscriptSegments,
    getClientSegmentsForFinalize,
    finalizeLiveAudio,
  }) {
    this.getSettings = getSettings;
    this.setSettings = setSettings || (async () => {});
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.onMetrics = onMetrics || (() => {});
    this.onTranscriptSegments = onTranscriptSegments || (() => {});
    /** @type {(() => object[] | null) | null} Transcript rows for finalize-live when DB chunks are empty */
    this._getClientSegmentsForFinalize = getClientSegmentsForFinalize || null;
    /**
     * Async hook that takes the on-disk session recording, archives it locally, uploads
     * it to the server, and cleans up. Returns true when audio was uploaded successfully
     * (or failed but still exists on disk for retry), false when no audio was captured.
     *
     * @type {((ctx: { baseUrl: string, jobId: string }) => Promise<boolean>) | null}
     */
    this._finalizeLiveAudio = finalizeLiveAudio || null;

    this.enabled = false;
    this.running = false;
    this.jobId = null;
    this._queue = null;
    this._seq = 0;
    this._lastAckedSeq = null;
    this._lastError = null;
    this._tick = null;
    this._retryTick = null;
    /** @type {boolean} Tracks navigator.onLine; set false when app detects offline. */
    this._networkOnline = navigator.onLine !== false;
    this._sessionStartMs = null;
    this._audioBuffer = [];
    this._lastFlushMs = 0;
    /** @type {Promise<void>} Serialize chunk uploads so retry timer cannot overlap flush. */
    this._drainTail = Promise.resolve();

    // Token refresh mutex: avoid concurrent refresh calls overwriting tokens.
    this._refreshing = false;
    this._refreshPromise = null;
  }

  _emitMetrics(extra = {}) {
    try {
      this.onMetrics?.({
        enabled: Boolean(this.enabled),
        running: Boolean(this.running),
        job_id: this.jobId,
        next_chunk_seq: this._seq,
        last_acked_seq: this._lastAckedSeq,
        pending_count: this._queue ? this._queue.pendingCount() : 0,
        last_error: this._lastError,
        ...extra,
      });
    } catch {
      // ignore UI errors
    }
  }

  _getToken() {
    const s = this.getSettings();
    const access = String(s.halin_access_token || '').trim();
    const legacy = String(s.halin_api_token || '').trim();
    return access || legacy;
  }

  async _refreshTokenOnce() {
    if (this._refreshing) return this._refreshPromise;
    this._refreshing = true;
    this._refreshPromise = (async () => {
      const s = this.getSettings();
      const baseUrl = s.halin_base_url;
      const rt = String(s.halin_refresh_token || '').trim();
      if (!rt) return null;
      const r = await halinRefresh({ baseUrl, refreshToken: rt });
      await this.setSettings({
        halin_access_token: r.access_token || '',
        halin_refresh_token: r.refresh_token || '',
      });
      logInfo('halin-classroom', 'token refresh ok', { baseUrl });
      return r;
    })().finally(() => {
      this._refreshing = false;
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  async _refreshIfPossible() {
    return await this._refreshTokenOnce();
  }

  _persistPendingFinalize(payload) {
    try {
      localStorage.setItem(HALIN_PENDING_FINALIZE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent('halin:pending-finalize-changed', { detail: { hasPending: true } }));
    } catch {
      // ignore
    }
  }

  _clearPendingFinalize() {
    try {
      localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent('halin:pending-finalize-changed', { detail: { hasPending: false } }));
    } catch {
      // ignore
    }
  }

  /**
   * @param {boolean} v
   * @param {{ silent?: boolean }} [opts] — silent: no toast (settings sync / quick save)
   */
  setEnabled(v, opts = {}) {
    const next = Boolean(v);
    const silent = Boolean(opts.silent);
    if (this.enabled === next) {
      this._emitMetrics();
      return;
    }
    this.enabled = next;
    if (!silent) {
      this.onStatus?.(this.enabled ? 'Đã bật HaLin Phân Tích' : 'Đã tắt HaLin Phân Tích');
    }
    this._emitMetrics();
  }

  isEnabled() {
    return this.enabled;
  }

  addPcmAudio(pcmBytes) {
    if (!this.running) return;
    if (!pcmBytes || pcmBytes.length === 0) return;
    this._audioBuffer.push(new Uint8Array(pcmBytes));
  }

  _mergeAudioBuffer() {
    if (!this._audioBuffer.length) return new Uint8Array();
    const total = this._audioBuffer.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of this._audioBuffer) {
      out.set(b, off);
      off += b.length;
    }
    this._audioBuffer = [];
    return out;
  }

  async start() {
    if (!this.enabled || this.running) return;
    const s = this.getSettings();
    const baseUrl = s.halin_base_url;
    let token = this._getToken();
    if (!String(token || '').trim()) {
      throw new Error(
        'Chưa có Bearer token. Vào Settings → HaLin: bấm Login (email/mật khẩu) hoặc dán Desktop API token, rồi Save.',
      );
    }
    const chunkSeconds = clampInt(s.halin_chunk_seconds, 2, 10, 5);

    // Auto-pick the most recent teacher voice profile (if any) so enrollment matching works
    // without forcing UI changes in the MVP.
    let teacherVoiceId = null;
    try {
      const tv = await listTeacherVoices({ baseUrl, token, limit: 5 });
      const items = Array.isArray(tv?.items) ? tv.items : (Array.isArray(tv?.data?.items) ? tv.data.items : []);
      if (items && items.length) {
        teacherVoiceId = items[0]?.teacher_voice_id || null;
      }
    } catch {
      teacherVoiceId = null;
    }

    const scheduledStartRaw = String(s.halin_scheduled_start || '').trim();
    let scheduledStart = null;
    if (scheduledStartRaw) {
      const d = new Date(scheduledStartRaw);
      scheduledStart = Number.isNaN(d.getTime()) ? scheduledStartRaw : d.toISOString();
    }
    const totalStudentsRaw = String(s.halin_total_students_enrolled || '').trim();
    const totalStudents = totalStudentsRaw ? clampInt(totalStudentsRaw, 1, 50, null) : null;

    const vocab = String(s.halin_lesson_plan_vocabulary || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const grammar = String(s.halin_lesson_plan_grammar || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const lessonPlan =
      (vocab.length || grammar.length)
        ? { target_vocabulary: vocab, target_grammar: grammar, planned_activities: [] }
        : null;

    const profile = {
      title: s.session_title || null,
      lesson_type: s.halin_lesson_type || null,
      level: s.halin_level || null,
      topic: s.halin_topic || null,
      expected_interaction_mode: s.halin_expected_interaction_mode || null,
      language_hint: null,
      external_ref: 'desktop-classroom',
      callback_url: null,
      teacher_voice_id: teacherVoiceId,
      scheduled_start: scheduledStart,
      scheduled_end: null,
      total_students_enrolled: totalStudents,
      lesson_plan: lessonPlan,
    };

    let r;
    try {
      r = await startLiveSession({ baseUrl, token, profile });
    } catch (e) {
      const msg = String(e?.message || e);
      if (shouldRetryAuthAfterErrorMessage(msg)) {
        await this._refreshIfPossible();
        r = await startLiveSession({ baseUrl, token: this._getToken(), profile });
      } else {
        logError('halin-classroom', 'startLiveSession failed', e);
        throw e;
      }
    }
    this.jobId = r.job_id;
    this._drainTail = Promise.resolve();
    this._queue = new HalinChunkQueue(this.jobId);
    this._seq = 0;
    this._audioBuffer = [];
    this._sessionStartMs = nowMs();
    this._lastFlushMs = nowMs();
    this.running = true;
    this.onStatus?.(`HaLin session started: ${this.jobId}`);
    this._lastError = null;
    this._lastAckedSeq = null;
    this._emitMetrics({ event: 'started' });

    this._tick = window.setInterval(() => {
      this.flush(false).catch((e) => this.onError?.(e));
    }, chunkSeconds * 1000);

    this._retryTick = window.setInterval(() => {
      this._drainOnce().catch(() => {});
    }, 1500);
  }

  /**
   * @deprecated No longer used; STT is server-side. Kept to avoid breaking callers.
   */
  addFinalText(_text, _speaker, _language, _confidence) {
    // intentionally empty
  }

  async flush(force) {
    if (!this.running || !this._queue) return;
    const now = nowMs();
    if (!force && this._audioBuffer.length === 0) return;

    const chunkStartSeconds = this._sessionStartMs ? (this._lastFlushMs - this._sessionStartMs) / 1000 : 0;
    const audio = this._mergeAudioBuffer();
    if (audio.length === 0) return;

    const payload = {
      chunk_seq: this._seq,
      audio,
      chunk_start_seconds: chunkStartSeconds,
    };
    this._queue.enqueue(payload);
    this._seq += 1;
    this._lastFlushMs = now;
    this.onStatus?.(`Buffered audio chunk #${payload.chunk_seq} (${this._queue.pendingCount()} pending)`);
    this._emitMetrics({ event: 'buffered', buffered_seq: payload.chunk_seq });

    await this._drainOnce();
  }

  async stopAndFinalize() {
    if (!this.running) return;
    const finalizedJobId = this.jobId;
    try {
      await this.flush(true);
    } catch (e) {
      this.onError?.(e);
    }

    if (this._tick) window.clearInterval(this._tick);
    if (this._retryTick) window.clearInterval(this._retryTick);
    this._tick = null;
    this._retryTick = null;

    const s = this.getSettings();
    const baseUrl = s.halin_base_url;
    const token = this._getToken();
    const durationSeconds = this._sessionStartMs ? (nowMs() - this._sessionStartMs) / 1000 : null;

    const deadline = nowMs() + 8_000;
    while (this._queue && this._queue.pendingCount() > 0 && nowMs() < deadline) {
      try {
        await this._drainOnce();
      } catch {
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    const clientSegments =
      typeof this._getClientSegmentsForFinalize === 'function'
        ? this._getClientSegmentsForFinalize()
        : null;

    // Full-session audio: hand off to the app-supplied hook which finalizes the on-disk
    // WAV (Rust), archives a local copy for QA, uploads to /live-audio, and deletes
    // the temp file. The hook handles token refresh internally.
    let hasWav = false;
    if (typeof this._finalizeLiveAudio === 'function' && this.jobId) {
      try {
        hasWav = await this._finalizeLiveAudio({ baseUrl, jobId: this.jobId });
      } catch (e) {
        this.onError?.(e);
      }
    }

    // If user started then stopped immediately, there may be no audio + no transcript.
    // In that case, don't persist a pending-finalize entry that will nag forever.
    const hasClientSegments = Array.isArray(clientSegments) && clientSegments.length > 0;
    if (!hasClientSegments && !hasWav) {
      this._clearPendingFinalize();
      this.running = false;
      this._emitMetrics({ event: 'finalized_empty' });
      this.onStatus?.('Buổi học quá ngắn nên không có dữ liệu để gửi lên HaLin.');
      return { job_id: finalizedJobId };
    }

    this._persistPendingFinalize({
      jobId: finalizedJobId,
      baseUrl,
      durationSeconds,
      clientSegments,
      savedAt: nowMs(),
    });

    try {
      await finalizeLiveSession({
        baseUrl,
        token,
        jobId: finalizedJobId,
        durationSeconds,
        languageDetected: null,
        clientSegments,
      });
      this.onStatus?.('Finalize OK; backend queued scoring job');
      this.running = false;
      this._emitMetrics({ event: 'finalized' });
      this._clearPendingFinalize();
      return { job_id: finalizedJobId };
    } catch (e) {
      const msg = String(e?.message || e);
      if (shouldRetryAuthAfterErrorMessage(msg)) {
        await this._refreshIfPossible();
        await finalizeLiveSession({
          baseUrl,
          token: this._getToken(),
          jobId: finalizedJobId,
          durationSeconds,
          languageDetected: null,
          clientSegments,
        });
        this.onStatus?.('Finalize OK; backend queued scoring job');
        this.running = false;
        this._emitMetrics({ event: 'finalized' });
        this._clearPendingFinalize();
        return { job_id: finalizedJobId };
      }
      this.onError?.(e);
      this.running = false;
      this._lastError = String(e?.message || e);
      this._emitMetrics({ event: 'finalize_failed' });
      throw e;
    }
  }

  async recoverFallback() {
    let raw = '';
    try {
      raw = localStorage.getItem(HALIN_PENDING_FINALIZE_KEY) || '';
    } catch {
      raw = '';
    }
    if (!raw) {
      throw new Error('Không có phiên HaLin cần khôi phục.');
    }

    let pending = null;
    try {
      pending = JSON.parse(raw);
    } catch {
      try {
        localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
      } catch {
        // ignore
      }
      throw new Error('Dữ liệu khôi phục HaLin bị lỗi — đã xoá bộ đệm.');
    }

    const jobId = pending?.jobId != null ? String(pending.jobId).trim() : '';
    const baseUrl = pending?.baseUrl != null ? String(pending.baseUrl).trim() : '';
    if (!jobId || !baseUrl) {
      try {
        localStorage.removeItem(HALIN_PENDING_FINALIZE_KEY);
      } catch {
        // ignore
      }
      throw new Error('Thiếu jobId/baseUrl để khôi phục — đã xoá bộ đệm.');
    }

    const durationSeconds = pending?.durationSeconds ?? null;
    let clientSegments = Array.isArray(pending?.clientSegments) ? pending.clientSegments : null;
    if (!clientSegments || clientSegments.length === 0) {
      clientSegments =
        typeof this._getClientSegmentsForFinalize === 'function'
          ? this._getClientSegmentsForFinalize()
          : null;
    }
    if (!clientSegments || clientSegments.length === 0) {
      this._clearPendingFinalize();
      throw new Error('Buổi học quá ngắn nên không có dữ liệu để gửi lên HaLin — đã xoá bộ đệm khôi phục.');
    }

    const token0 = this._getToken();
    if (!String(token0 || '').trim()) {
      throw new Error('Chưa có Bearer token để khôi phục. Vào Settings → HaLin để đăng nhập hoặc dán token.');
    }

    try {
      await finalizeLiveSession({
        baseUrl,
        token: token0,
        jobId,
        durationSeconds,
        languageDetected: null,
        clientSegments,
      });
      this.onStatus?.('Đã gửi lại dữ liệu buổi học lên HaLin.');
      this._clearPendingFinalize();
      return { job_id: jobId };
    } catch (e) {
      const msg = String(e?.message || e);
      if (shouldRetryAuthAfterErrorMessage(msg)) {
        await this._refreshIfPossible();
        await finalizeLiveSession({
          baseUrl,
          token: this._getToken(),
          jobId,
          durationSeconds,
          languageDetected: null,
          clientSegments,
        });
        this.onStatus?.('Đã gửi lại dữ liệu buổi học lên HaLin.');
        this._clearPendingFinalize();
        return { job_id: jobId };
      }
      throw e;
    }
  }

  /**
   * Gọi từ app.js khi window 'online' event fire.
   * Đặt lại flag và drain ngay lập tức thay vì đợi _retryTick 1.5s tiếp.
   */
  notifyOnline() {
    this._networkOnline = true;
    if (this.jobId && this._queue) {
      this._drainOnce().catch(() => {});
    }
  }

  async _drainOnce() {
    this._drainTail = this._drainTail.then(() => this._drainOnceCore());
    return this._drainTail;
  }

  async _drainOnceCore() {
    // NOTE: In some desktop webviews, navigator.onLine can be unreliable.
    // App-level network monitor will update this._networkOnline.
    if (this._networkOnline === false) return;
    if (!this._queue || !this.jobId) return;
    const next = this._queue.nextPending();
    if (!next) return;
    if ((next.attempts || 0) >= MAX_CHUNK_RETRIES) {
      // Drop chunk to unblock finalize / session progress.
      this._queue.markAcked(next.chunk_seq);
      this._lastAckedSeq = next.chunk_seq;
      this._lastError = `Chunk #${next.chunk_seq} failed after ${MAX_CHUNK_RETRIES} attempts, dropped`;
      this._emitMetrics({
        event: 'chunk_dropped',
        dropped_seq: next.chunk_seq,
        attempts: next.attempts || 0,
      });
      logWarn('halin-classroom', 'chunk dropped', { chunk_seq: next.chunk_seq, attempts: next.attempts || 0 });
      this.onError?.(new Error(`Chunk #${next.chunk_seq} bị mất do lỗi mạng liên tục (đã bỏ qua để không kẹt phiên)`));
      return;
    }
    const s = this.getSettings();
    const baseUrl = s.halin_base_url;
    const token = this._getToken();
    const payload = this._queue.decodeAudioPayload(next.payload);
    try {
      const chunkResult = await appendAudioChunk({
        baseUrl,
        token,
        jobId: this.jobId,
        chunkSeq: next.chunk_seq,
        chunkStartSeconds: payload.chunk_start_seconds,
        pcmS16leBytes: payload.audio,
        sampleRate: 16000,
        numChannels: 1,
      });
      const segs = chunkResult?.segments;
      if (Array.isArray(segs) && segs.length) {
        try {
          this.onTranscriptSegments(segs);
        } catch (e) {
          this.onError?.(e);
        }
      }
      this._queue.markAcked(next.chunk_seq);
      this._lastAckedSeq = next.chunk_seq;
      this._lastError = null;
      this._emitMetrics({ event: 'sent', sent_seq: next.chunk_seq });
      this.onStatus?.(`Sent chunk #${next.chunk_seq} (${this._queue.pendingCount()} pending)`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (shouldRetryAuthAfterErrorMessage(msg)) {
        await this._refreshIfPossible();
        const chunkResult2 = await appendAudioChunk({
          baseUrl,
          token: this._getToken(),
          jobId: this.jobId,
          chunkSeq: next.chunk_seq,
          chunkStartSeconds: payload.chunk_start_seconds,
          pcmS16leBytes: payload.audio,
          sampleRate: 16000,
          numChannels: 1,
        });
        const segs2 = chunkResult2?.segments;
        if (Array.isArray(segs2) && segs2.length) {
          try {
            this.onTranscriptSegments(segs2);
          } catch (e2) {
            this.onError?.(e2);
          }
        }
        this._queue.markAcked(next.chunk_seq);
        this._lastAckedSeq = next.chunk_seq;
        this._lastError = null;
        this._emitMetrics({ event: 'sent', sent_seq: next.chunk_seq, refreshed: true });
        this.onStatus?.(`Sent chunk #${next.chunk_seq} (${this._queue.pendingCount()} pending)`);
        return;
      }
      this._queue.markFailed(next.chunk_seq, e);
      this._lastError = String(e?.message || e);
      this._emitMetrics({ event: 'send_failed', failed_seq: next.chunk_seq });
      logError('halin-classroom', `chunk send failed seq=${next.chunk_seq}`, e);
      throw e;
    }
  }
}
