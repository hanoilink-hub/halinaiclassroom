/**
 * HaLin client (desktop app) — minimal wrapper around fetch.
 */

import { DEFAULT_HALIN_API_BASE_URL } from './config.js';
import { halinFetch } from './halin-fetch.js';

function normalizeBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  return b || DEFAULT_HALIN_API_BASE_URL;
}

function authHeaders(token) {
  const t = String(token || '').trim();
  return t ? { Authorization: t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}` } : {};
}

function messageFromErrorJson(json, status) {
  if (!json || typeof json !== 'object') return `HTTP ${status}`;
  const env = json.error?.message;
  if (env) return String(env);
  const d = json.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map((x) => (x && (x.msg || x.message)) || JSON.stringify(x)).join('; ');
  }
  return `HTTP ${status}`;
}

async function parseEnvelope(res) {
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`HTTP ${res.status} — invalid JSON`);
  }
  if (!res.ok) {
    throw new Error(messageFromErrorJson(json, res.status));
  }
  if (json?.success === false) {
    throw new Error(json?.error?.message || 'Request failed');
  }
  return json?.data ?? json;
}

export async function startLiveSession({ baseUrl, token, profile }) {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}/api/v1/training/jobs/live-session`;
  try {
    const res = await halinFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(profile || {}),
    }, 15000);
    return await parseEnvelope(res);
  } catch (e) {
    const origin = (typeof window !== 'undefined' && window.location) ? window.location.origin : 'unknown';
    throw new Error(`Failed to fetch (origin=${origin}) ${url}: ${e?.message || e}`);
  }
}

export async function listTeacherVoices({ baseUrl, token, limit = 5 }) {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}/api/v1/training/teacher-voices?limit=${encodeURIComponent(String(limit))}`;
  const res = await halinFetch(url, {
    method: 'GET',
    headers: { ...authHeaders(token) },
  }, 15000);
  return await parseEnvelope(res);
}

/**
 * Phase 7C — sessions the logged-in teacher is scheduled to teach today (or in
 * the next ``daysAhead`` days). Powers the Desktop "pick a session" UI.
 * Returns ``{ items: [{ id, class_id, class_code, class_name, session_no,
 * planned_date, topic, objectives, duration_minutes, ... }, ...] }``.
 */
export async function listTodaySessions({ baseUrl, token, daysAhead = 0, onDate = null }) {
  const base = normalizeBaseUrl(baseUrl);
  const params = new URLSearchParams();
  params.set('days_ahead', String(daysAhead));
  if (onDate) params.set('on_date', String(onDate));
  const url = `${base}/api/v1/training/today-sessions?${params.toString()}`;
  const res = await halinFetch(url, {
    method: 'GET',
    headers: { ...authHeaders(token) },
  }, 15000);
  return await parseEnvelope(res);
}

/** Open a break on a live capture job (teacher pressed Pause). */
export async function pauseLiveSession({ baseUrl, token, jobId }) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await halinFetch(`${base}/api/v1/training/jobs/${jobId}/breaks/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ type: 'manual' }),
  }, 15000);
  return await parseEnvelope(res);
}

/** Close the currently-open break (teacher pressed Resume). */
export async function resumeLiveSession({ baseUrl, token, jobId }) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await halinFetch(`${base}/api/v1/training/jobs/${jobId}/breaks/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: '{}',
  }, 15000);
  return await parseEnvelope(res);
}

export async function postSttChunk({
  baseUrl,
  token,
  chunkSeq,
  chunkStartSeconds,
  pcmS16leBytes,
  sampleRate = 16000,
  numChannels = 1,
  languageHints = null,
  translationTarget = null,
}) {
  const base = normalizeBaseUrl(baseUrl);
  let url =
    `${base}/api/v1/stt/chunk` +
    `?chunk_seq=${encodeURIComponent(String(chunkSeq))}` +
    `&chunk_start_seconds=${encodeURIComponent(String(chunkStartSeconds))}` +
    `&sample_rate=${encodeURIComponent(String(sampleRate))}` +
    `&num_channels=${encodeURIComponent(String(numChannels))}`;
  if (languageHints) {
    url += `&language_hints=${encodeURIComponent(String(languageHints))}`;
  }
  if (translationTarget) {
    url += `&translation_target=${encodeURIComponent(String(translationTarget))}`;
  }
  const res = await halinFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...authHeaders(token) },
    body: pcmS16leBytes,
  }, 20000);
  return await parseEnvelope(res);
}

export async function appendTranscriptChunk({ baseUrl, token, jobId, chunkSeq, segments, durationSeconds }) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await halinFetch(`${base}/api/v1/training/jobs/${jobId}/transcript-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      chunk_seq: chunkSeq,
      segments,
      duration_seconds: durationSeconds ?? null,
    }),
  }, 30000);
  return await parseEnvelope(res);
}

export async function appendAudioChunk({ baseUrl, token, jobId, chunkSeq, chunkStartSeconds, pcmS16leBytes, sampleRate = 16000, numChannels = 1 }) {
  const base = normalizeBaseUrl(baseUrl);
  const url =
    `${base}/api/v1/training/jobs/${jobId}/audio-chunks` +
    `?chunk_seq=${encodeURIComponent(String(chunkSeq))}` +
    `&chunk_start_seconds=${encodeURIComponent(String(chunkStartSeconds))}` +
    `&sample_rate=${encodeURIComponent(String(sampleRate))}` +
    `&num_channels=${encodeURIComponent(String(numChannels))}`;
  // Each chunk runs server-side STT (Soniox realtime via a fresh WebSocket,
  // or Whisper on CPU). Whisper on a 4-vCPU box can take 15–25 s per 5-s
  // chunk; Soniox real-time ~3–5 s typical but can stall when the API or
  // network has a hiccup. The old 20 s budget gave almost no headroom, so
  // teachers saw frequent timeouts that were really transient slowness, not
  // hard failures. Use 60 s — long enough to absorb worst-case Whisper but
  // still short enough that a truly hung request fails before the next chunk
  // queues up.
  const res = await halinFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...authHeaders(token) },
    body: pcmS16leBytes,
  }, 60000);
  return await parseEnvelope(res);
}

// uploadLiveAudioWav was removed in Phase 1 of the long-session refactor.
// The WAV is now produced as an on-disk file by `commands::session_recording`
// (Rust) and uploaded by `upload_session_recording_to_halin`, so the JS heap
// no longer needs to hold ~800 MB of audio for a multi-hour session.

export async function finalizeLiveSession({
  baseUrl,
  token,
  jobId,
  durationSeconds,
  languageDetected,
  clientSegments,
}) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await halinFetch(`${base}/api/v1/training/jobs/${jobId}/finalize-live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      duration_seconds: durationSeconds ?? null,
      language_detected: languageDetected ?? null,
      client_segments: Array.isArray(clientSegments) && clientSegments.length ? clientSegments : null,
    }),
  }, 60000);
  return await parseEnvelope(res);
}

export async function recoverFromTranscript({ baseUrl, token, body }) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await halinFetch(`${base}/api/v1/training/jobs/from-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(body),
  }, 60000);
  return await parseEnvelope(res);
}

export async function getJobStatus({ baseUrl, token, jobId }) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await halinFetch(`${base}/api/v1/training/jobs/${encodeURIComponent(String(jobId))}`, {
    method: 'GET',
    headers: { ...authHeaders(token) },
  }, 15000);
  return await parseEnvelope(res);
}

