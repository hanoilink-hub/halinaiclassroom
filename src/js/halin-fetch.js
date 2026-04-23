/**
 * Use Tauri native HTTP when embedded in the desktop app so calls to http://localhost
 * are not blocked by the WebView mixed-content policy (https page → http API).
 */

function timeoutError(url, timeoutMs) {
  return new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
}

function uint8ToBase64(u8) {
  const arr = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < arr.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function flattenHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  return { ...headers };
}

/**
 * fetch-compatible enough for halin-auth / halin-client (ok, status, text()).
 */
export async function halinFetch(url, init = {}, timeoutMs = 30000) {
  const tauri = typeof window !== 'undefined' && window.__TAURI__;
  if (!tauri?.core?.invoke) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw timeoutError(url, timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  const method = (init.method || 'GET').toUpperCase();
  const headers = flattenHeaders(init.headers);

  let body = null;
  let bodyBase64 = null;
  const raw = init.body;
  if (raw != null) {
    if (typeof raw === 'string') {
      body = raw;
    } else if (raw instanceof ArrayBuffer) {
      bodyBase64 = uint8ToBase64(new Uint8Array(raw));
    } else if (raw instanceof Uint8Array) {
      bodyBase64 = uint8ToBase64(raw);
    } else if (typeof raw === 'object' && raw.buffer instanceof ArrayBuffer) {
      bodyBase64 = uint8ToBase64(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    } else {
      body = String(raw);
    }
  }

  const invokePromise = tauri.core.invoke('halin_http_fetch', {
    method,
    url,
    headers,
    body,
    bodyBase64,
  });
  const out = await Promise.race([
    invokePromise,
    new Promise((_, reject) => {
      const t = setTimeout(() => {
        clearTimeout(t);
        reject(timeoutError(url, timeoutMs));
      }, timeoutMs);
    }),
  ]);
  try {
    const status = out?.status ?? 0;
    const text = out?.body ?? '';
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  } catch (e) {
    const msg =
      typeof e === 'string'
        ? e
        : e?.message || e?.error || (e != null ? String(e) : '');
    throw new Error(msg || 'halin_http_fetch failed');
  }
}
