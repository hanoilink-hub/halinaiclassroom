/**
 * HaLin auth (desktop app): login/refresh/me/logout via JSON endpoints.
 */

import { DEFAULT_HALIN_API_BASE_URL, validateBaseUrl } from './config.js';
import { halinFetch } from './halin-fetch.js';
import { logError, logInfo } from './logger.js';

function normalizeBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  const out = b || DEFAULT_HALIN_API_BASE_URL;
  validateBaseUrl(out);
  return out;
}

function bearerHeader(accessToken) {
  const t = String(accessToken || '').trim();
  if (!t) return {};
  return { Authorization: t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}` };
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
  const payload = json?.data ?? json;
  return payload;
}

export async function halinLogin({ baseUrl, email, password }) {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const res = await halinFetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }, 15000);
    const out = await parseEnvelope(res);
    logInfo('halin-auth', 'login ok', { baseUrl: base });
    return out;
  } catch (e) {
    logError('halin-auth', 'login failed', e);
    throw e;
  }
}

export async function halinRefresh({ baseUrl, refreshToken }) {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const res = await halinFetch(`${base}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, 15000);
    const out = await parseEnvelope(res);
    logInfo('halin-auth', 'refresh ok', { baseUrl: base });
    return out;
  } catch (e) {
    logError('halin-auth', 'refresh failed', e);
    throw e;
  }
}

export async function halinMe({ baseUrl, accessToken }) {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const res = await halinFetch(`${base}/api/v1/auth/me`, {
      method: 'GET',
      headers: { ...bearerHeader(accessToken) },
    }, 15000);
    const out = await parseEnvelope(res);
    return out;
  } catch (e) {
    logError('halin-auth', 'me failed', e);
    throw e;
  }
}

export async function halinLogout({ baseUrl, refreshToken }) {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const res = await halinFetch(`${base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, 15000);
    const out = await parseEnvelope(res);
    logInfo('halin-auth', 'logout ok', { baseUrl: base });
    return out;
  } catch (e) {
    logError('halin-auth', 'logout failed', e);
    throw e;
  }
}

