/**
 * In-memory queue for pending audio chunks before upload to HaLin API.
 *
 * We intentionally do NOT persist raw PCM/base64 in localStorage: browser quota is
 * ~5MB; a few seconds of 16kHz s16le audio as base64 exceeds it and throws
 * (setItem quota), which broke switching audio source mid-session (stop→start
 * could stack large queues).
 */

function keyFor(jobId) {
  return `halin_chunk_queue:${jobId}`;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class HalinChunkQueue {
  constructor(jobId) {
    this.jobId = jobId;
    this.items = [];
    this._dropLegacyStorageEntry();
  }

  /** Remove leftover key from older builds that wrote huge JSON into localStorage. */
  _dropLegacyStorageEntry() {
    try {
      localStorage.removeItem(keyFor(this.jobId));
    } catch {
      /* ignore */
    }
  }

  enqueue(payload) {
    const p = { ...payload };
    if (p.audio instanceof Uint8Array) {
      p.audio_b64 = bytesToBase64(p.audio);
      delete p.audio;
    }
    const item = {
      chunk_seq: p.chunk_seq,
      payload: p,
      acked: false,
      attempts: 0,
      last_error: null,
      updated_at: Date.now(),
    };
    const idx = this.items.findIndex((x) => x && x.chunk_seq === item.chunk_seq);
    if (idx >= 0) {
      this.items[idx] = item;
    } else {
      this.items.push(item);
      this.items.sort((a, b) => (a.chunk_seq || 0) - (b.chunk_seq || 0));
    }
  }

  markAcked(chunkSeq) {
    const it = this.items.find((x) => x && x.chunk_seq === chunkSeq);
    if (it) {
      it.acked = true;
      it.updated_at = Date.now();
      this._pruneAcked();
    }
  }

  /** Drop fully acked entries from memory to cap RAM during long sessions. */
  _pruneAcked() {
    while (this.items.length > 0 && this.items[0]?.acked === true) {
      this.items.shift();
    }
  }

  markFailed(chunkSeq, err) {
    const it = this.items.find((x) => x && x.chunk_seq === chunkSeq);
    if (it) {
      it.attempts = (it.attempts || 0) + 1;
      it.last_error = String(err || '');
      it.updated_at = Date.now();
    }
  }

  nextPending() {
    return this.items.find((x) => x && x.acked !== true) || null;
  }

  pendingCount() {
    return this.items.filter((x) => x && x.acked !== true).length;
  }

  allSegmentsMerged() {
    const segs = [];
    for (const it of this.items) {
      const p = it?.payload;
      const arr = p?.segments;
      if (Array.isArray(arr)) segs.push(...arr);
    }
    return segs;
  }

  decodeAudioPayload(payload) {
    const p = payload || {};
    if (p.audio_b64 && !p.audio) {
      return { ...p, audio: base64ToBytes(p.audio_b64) };
    }
    return p;
  }

  clear() {
    this.items = [];
    this._dropLegacyStorageEntry();
  }
}
