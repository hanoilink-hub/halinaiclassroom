//! Persistent on-disk WAV recorder for a HaLin classroom session.
//!
//! Audio (PCM s16le 16 kHz mono) is appended to a temp WAV file as it arrives from the
//! capture pipeline, so a 7-hour session never accumulates ~800 MB in the JS heap.
//! The WAV header is written with placeholder sizes and patched at finalize.

use base64::Engine;
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;

pub struct RecordingTarget {
    pub writer: BufWriter<File>,
    pub path: PathBuf,
    pub pcm_bytes: u64,
    pub job_id: Option<String>,
}

/// Shared state. The audio forwarder thread also holds a clone of this Arc so it can
/// write PCM frames to the active file without going through an IPC roundtrip.
#[derive(Clone, Default)]
pub struct SessionRecordingState(pub Arc<Mutex<Option<RecordingTarget>>>);

impl SessionRecordingState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }

    /// Cheap clone of the inner Arc — used to give the audio forwarder thread a handle.
    pub fn handle(&self) -> Arc<Mutex<Option<RecordingTarget>>> {
        self.0.clone()
    }
}

fn session_recording_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("session_recording");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create session_recording dir: {}", e))?;
    Ok(dir)
}

fn live_recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("live_recordings");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create live_recordings dir: {}", e))?;
    Ok(dir)
}

fn sanitize_job_id(job_id: Option<&str>) -> String {
    let raw = job_id.unwrap_or("").trim();
    let s: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if s.is_empty() {
        format!("session-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"))
    } else {
        s
    }
}

fn write_wav_header_placeholder<W: Write>(w: &mut W) -> std::io::Result<()> {
    let byte_rate = SAMPLE_RATE * CHANNELS as u32 * (BITS_PER_SAMPLE / 8) as u32;
    let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
    w.write_all(b"RIFF")?;
    w.write_all(&0u32.to_le_bytes())?; // patched at finalize
    w.write_all(b"WAVE")?;
    w.write_all(b"fmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?; // PCM
    w.write_all(&CHANNELS.to_le_bytes())?;
    w.write_all(&SAMPLE_RATE.to_le_bytes())?;
    w.write_all(&byte_rate.to_le_bytes())?;
    w.write_all(&block_align.to_le_bytes())?;
    w.write_all(&BITS_PER_SAMPLE.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&0u32.to_le_bytes())?; // patched at finalize
    Ok(())
}

fn patch_wav_header(path: &PathBuf, pcm_bytes: u64) -> std::io::Result<()> {
    // u32 max ~4 GB. PCM s16le 16 kHz mono = 32 kB/s, so ~37 hours fit in u32. Fine.
    let mut f = OpenOptions::new().write(true).read(true).open(path)?;
    let file_size_minus_8 = (36u64 + pcm_bytes).min(u32::MAX as u64) as u32;
    f.seek(SeekFrom::Start(4))?;
    f.write_all(&file_size_minus_8.to_le_bytes())?;
    f.seek(SeekFrom::Start(40))?;
    f.write_all(&(pcm_bytes.min(u32::MAX as u64) as u32).to_le_bytes())?;
    f.flush()?;
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingResult {
    pub path: String,
    pub job_id: Option<String>,
}

#[tauri::command]
pub fn start_session_recording(
    app: AppHandle,
    state: State<'_, SessionRecordingState>,
    job_id: Option<String>,
) -> Result<StartRecordingResult, String> {
    let dir = session_recording_dir(&app)?;
    let stem = sanitize_job_id(job_id.as_deref());
    let path = dir.join(format!("{}.wav", stem));

    // Replace any leftover recording.
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(prev) = guard.take() {
        // Best-effort flush & delete previous unfinalized recording.
        drop(prev.writer);
        let _ = std::fs::remove_file(&prev.path);
    }

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("Failed to open recording file {}: {}", path.display(), e))?;
    let mut writer = BufWriter::with_capacity(64 * 1024, file);
    write_wav_header_placeholder(&mut writer)
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;

    *guard = Some(RecordingTarget {
        writer,
        path: path.clone(),
        pcm_bytes: 0,
        job_id: job_id.clone(),
    });

    Ok(StartRecordingResult {
        path: path.to_string_lossy().to_string(),
        job_id,
    })
}

/// Append a PCM frame to the active recording. Returns Ok even when no recording is
/// active — capture starts before the recording target is configured in some flows.
pub fn append_pcm_frame(state: &Arc<Mutex<Option<RecordingTarget>>>, pcm: &[u8]) {
    if pcm.is_empty() {
        return;
    }
    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(target) = guard.as_mut() else { return };
    if let Err(e) = target.writer.write_all(pcm) {
        eprintln!(
            "[SessionRecording] write failed (PCM dropped, len={}): {}",
            pcm.len(),
            e
        );
        return;
    }
    target.pcm_bytes += pcm.len() as u64;
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeRecordingResult {
    pub path: String,
    pub pcm_bytes: u64,
    pub duration_seconds: f64,
    pub job_id: Option<String>,
}

#[tauri::command]
pub fn finalize_session_recording(
    state: State<'_, SessionRecordingState>,
) -> Result<FinalizeRecordingResult, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let Some(mut target) = guard.take() else {
        return Err("No active session recording".to_string());
    };
    target
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush WAV: {}", e))?;
    // Drop writer to release the file handle before reopening for header patch.
    let path = target.path.clone();
    let pcm_bytes = target.pcm_bytes;
    let job_id = target.job_id.clone();
    drop(target.writer);
    patch_wav_header(&path, pcm_bytes)
        .map_err(|e| format!("Failed to patch WAV header: {}", e))?;

    let bytes_per_second = (SAMPLE_RATE as f64) * (CHANNELS as f64) * (BITS_PER_SAMPLE as f64 / 8.0);
    let duration_seconds = if bytes_per_second > 0.0 {
        pcm_bytes as f64 / bytes_per_second
    } else {
        0.0
    };

    Ok(FinalizeRecordingResult {
        path: path.to_string_lossy().to_string(),
        pcm_bytes,
        duration_seconds,
        job_id,
    })
}

/// Drop the in-progress recording without producing a valid WAV. Called when the session
/// is aborted with no useful audio (e.g. teacher pressed Start then Stop immediately).
#[tauri::command]
pub fn discard_session_recording(
    state: State<'_, SessionRecordingState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(target) = guard.take() {
        drop(target.writer);
        let _ = std::fs::remove_file(&target.path);
    }
    Ok(())
}

/// Copy the finalized recording into `live_recordings/<jobId>.wav` for offline QA.
/// Must be called AFTER `finalize_session_recording` since the active recording is
/// already closed by then. Async so a multi-hundred-MB copy doesn't block the Tauri
/// command thread pool.
#[tauri::command]
pub async fn archive_session_recording(
    app: AppHandle,
    source_path: String,
    job_id: Option<String>,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !tokio::fs::try_exists(&src).await.unwrap_or(false) {
        return Err(format!("Source WAV not found: {}", source_path));
    }
    let dir = live_recordings_dir(&app)?;
    let stem = sanitize_job_id(job_id.as_deref());
    let dst = dir.join(format!("{}.wav", stem));
    tokio::fs::copy(&src, &dst)
        .await
        .map_err(|e| format!("Archive copy failed: {}", e))?;
    Ok(dst.to_string_lossy().to_string())
}

/// Delete the finalized recording file. Called after a successful upload so the temp
/// file doesn't accumulate across sessions. Async to keep parity with the rest of the
/// session-recording IO so it never blocks the runtime.
#[tauri::command]
pub async fn delete_session_recording_file(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Ok(());
    }
    let p = PathBuf::from(&path);
    match tokio::fs::remove_file(&p).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete {}: {}", path, e)),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub status: u16,
    pub body: String,
}

/// Default chunk size for resumable upload. Must stay below the server's
/// ``max_live_audio_chunk_bytes`` setting (16 MB by default).
const UPLOAD_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
/// Per-chunk retry budget on transient errors (network drop, 5xx, timeout).
const UPLOAD_MAX_RETRIES: u32 = 5;
/// Base for exponential backoff between retries (ms).
const UPLOAD_RETRY_BASE_MS: u64 = 750;

fn normalize_bearer(token: &str) -> String {
    let t = token.trim();
    if t.is_empty() {
        return String::new();
    }
    if t.to_lowercase().starts_with("bearer ") {
        t.to_string()
    } else {
        format!("Bearer {}", t)
    }
}

async fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        // Generous per-chunk timeout — a single 8 MB chunk over 1 Mbit ≈ 65s.
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))
}

/// Strip the JSON envelope from a status response so callers can read `received`.
#[derive(serde::Deserialize)]
struct StatusEnvelope {
    success: Option<bool>,
    data: Option<StatusData>,
    error: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct StatusData {
    received: Option<u64>,
    complete: Option<bool>,
    #[serde(rename = "live_audio_uri")]
    live_audio_uri: Option<String>,
}

async fn get_upload_status(
    client: &reqwest::Client,
    base: &str,
    job: &str,
    auth: &str,
) -> Result<(u64, bool), String> {
    let url = format!("{}/api/v1/training/jobs/{}/live-audio/status", base, job);
    let mut rb = client.get(&url);
    if !auth.is_empty() {
        rb = rb.header("Authorization", auth);
    }
    let resp = rb.send().await.map_err(|e| format!("status request failed: {}", e))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 404 {
        // No partial yet — start at 0.
        return Ok((0, false));
    }
    if !(200..300).contains(&status) {
        return Err(format!(
            "status HTTP {}: {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }
    let env: StatusEnvelope = serde_json::from_str(&body).map_err(|e| {
        format!(
            "status parse failed: {} (body: {})",
            e,
            body.chars().take(200).collect::<String>()
        )
    })?;
    if env.success == Some(false) {
        return Err(format!("status error: {:?}", env.error));
    }
    let d = env.data.unwrap_or(StatusData {
        received: Some(0),
        complete: Some(false),
        live_audio_uri: None,
    });
    Ok((
        d.received.unwrap_or(0),
        d.complete.unwrap_or(false) || d.live_audio_uri.is_some(),
    ))
}

async fn put_chunk(
    client: &reqwest::Client,
    base: &str,
    job: &str,
    auth: &str,
    start: u64,
    end_inclusive: u64,
    total: u64,
    bytes: Vec<u8>,
) -> Result<UploadResult, String> {
    let url = format!("{}/api/v1/training/jobs/{}/live-audio", base, job);
    let mut rb = client
        .put(&url)
        .header("Content-Type", "audio/wav")
        .header(
            "Content-Range",
            format!("bytes {}-{}/{}", start, end_inclusive, total),
        )
        .body(bytes);
    if !auth.is_empty() {
        rb = rb.header("Authorization", auth);
    }
    let resp = rb.send().await.map_err(|e| format!("chunk request failed: {}", e))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Ok(UploadResult { status, body })
}

/// Upload the on-disk WAV to HaLin using the resumable PUT /live-audio endpoint.
///
/// The file is read **8 MB at a time** from disk and PUT directly — the Rust process
/// never holds the full 7-hour WAV in memory. On transient failures (network drop,
/// 5xx, 408, 429) the same chunk is retried with exponential backoff. On a 409 offset
/// mismatch the client re-queries the server's current ``received`` and resumes from
/// there (handles the case where the server received a chunk but the response was
/// lost on the wire).
#[tauri::command]
pub async fn upload_session_recording_to_halin(
    base_url: String,
    token: String,
    job_id: String,
    source_path: String,
) -> Result<UploadResult, String> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("base_url is required".to_string());
    }
    let job = job_id.trim().to_string();
    if job.is_empty() {
        return Err("job_id is required".to_string());
    }
    let path = PathBuf::from(&source_path);
    if !path.is_file() {
        return Err(format!("WAV not found: {}", source_path));
    }
    let total = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to stat WAV: {}", e))?
        .len();
    if total == 0 {
        return Err("WAV is empty".to_string());
    }

    let auth = normalize_bearer(&token);
    let client = http_client().await?;

    // Resume offset: server may already have some bytes from a prior attempt.
    let (mut offset, mut already_complete) = match get_upload_status(&client, &base, &job, &auth).await {
        Ok(s) => s,
        Err(e) => {
            // Status check is best-effort; failure simply means we start from 0.
            eprintln!("[upload] status check failed, starting from 0: {}", e);
            (0u64, false)
        }
    };
    if offset > total {
        // Server has more than we do — partial was for a different file. Reset.
        eprintln!(
            "[upload] server has {} bytes but local file is {} — discarding partial",
            offset, total
        );
        let _ = discard_remote_partial(&client, &base, &job, &auth).await;
        offset = 0;
        already_complete = false;
    }
    if already_complete {
        return Ok(UploadResult {
            status: 200,
            body: "{\"complete\":true}".to_string(),
        });
    }

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Failed to open WAV: {}", e))?;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if offset > 0 {
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("Failed to seek WAV: {}", e))?;
    }

    let mut last_response = UploadResult {
        status: 200,
        body: "{}".to_string(),
    };
    // Reused chunk buffer — allocated once, refilled each iteration.
    let mut buf: Vec<u8> = Vec::with_capacity(UPLOAD_CHUNK_BYTES as usize);
    while offset < total {
        let end_exclusive = (offset + UPLOAD_CHUNK_BYTES).min(total);
        let chunk_len = (end_exclusive - offset) as usize;
        buf.resize(chunk_len, 0);
        file.read_exact(&mut buf[..])
            .await
            .map_err(|e| format!("Failed to read WAV chunk: {}", e))?;

        let mut attempt: u32 = 0;
        // True when the inner loop exits via a 409 resync that changed `offset`. In that
        // case the outer loop must NOT advance `offset` by `chunk_len` — it must restart
        // from the freshly-set server offset. The original code did `offset = end.max(offset)`
        // which silently skipped bytes when the server's offset was smaller than the chunk
        // we'd just tried to send (data loss on resync).
        let mut resynced = false;
        loop {
            let resp =
                put_chunk(&client, &base, &job, &auth, offset, end_exclusive - 1, total, buf.clone())
                    .await;
            match resp {
                Ok(r) if (200..300).contains(&r.status) => {
                    last_response = r;
                    break;
                }
                Ok(r) if r.status == 409 => {
                    // Offset mismatch — resync from server and retry from the real offset.
                    eprintln!("[upload] 409 offset mismatch — resyncing");
                    match get_upload_status(&client, &base, &job, &auth).await {
                        Ok((srv_offset, complete)) => {
                            if complete {
                                return Ok(UploadResult {
                                    status: 200,
                                    body: "{\"complete\":true,\"resynced\":true}".to_string(),
                                });
                            }
                            if srv_offset != offset {
                                offset = srv_offset;
                                file.seek(std::io::SeekFrom::Start(offset))
                                    .await
                                    .map_err(|e| format!("Failed to seek WAV: {}", e))?;
                                resynced = true;
                                break;
                            }
                        }
                        Err(e) => {
                            eprintln!("[upload] resync failed: {}", e);
                        }
                    }
                    // If we couldn't resync or offset is unchanged, fall through to retry/backoff.
                    if attempt >= UPLOAD_MAX_RETRIES {
                        return Ok(r);
                    }
                    attempt += 1;
                    let delay = UPLOAD_RETRY_BASE_MS * (1u64 << attempt.min(5));
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
                Ok(r) if r.status == 401 || r.status == 403 => {
                    // Caller (JS) handles refresh + retry by re-invoking the command with a fresh token.
                    return Ok(r);
                }
                Ok(r)
                    if r.status == 408
                        || r.status == 429
                        || (r.status >= 500 && r.status < 600) =>
                {
                    if attempt >= UPLOAD_MAX_RETRIES {
                        return Ok(r);
                    }
                    attempt += 1;
                    let delay = UPLOAD_RETRY_BASE_MS * (1u64 << attempt.min(5));
                    eprintln!(
                        "[upload] transient HTTP {} on chunk {}-{}, retry {} after {}ms",
                        r.status,
                        offset,
                        end_exclusive - 1,
                        attempt,
                        delay
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
                Ok(r) => {
                    // Non-retriable error: hand the response back to JS.
                    return Ok(r);
                }
                Err(e) => {
                    if attempt >= UPLOAD_MAX_RETRIES {
                        return Err(e);
                    }
                    attempt += 1;
                    let delay = UPLOAD_RETRY_BASE_MS * (1u64 << attempt.min(5));
                    eprintln!(
                        "[upload] network error on chunk {}-{}, retry {} after {}ms: {}",
                        offset,
                        end_exclusive - 1,
                        attempt,
                        delay,
                        e
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }

        // After a successful PUT we move forward by exactly chunk_len; after a resync the
        // outer loop re-reads from the new offset and we MUST NOT skip past it.
        if !resynced {
            offset = end_exclusive;
        }
    }

    Ok(last_response)
}

async fn discard_remote_partial(
    client: &reqwest::Client,
    base: &str,
    job: &str,
    auth: &str,
) -> Result<(), String> {
    let url = format!("{}/api/v1/training/jobs/{}/live-audio", base, job);
    let mut rb = client.delete(&url);
    if !auth.is_empty() {
        rb = rb.header("Authorization", auth);
    }
    let resp = rb.send().await.map_err(|e| format!("delete partial failed: {}", e))?;
    let _ = resp.text().await;
    Ok(())
}

/// Encode the recording file to base64. Kept only for legacy callers that still expect
/// to receive WAV bytes (e.g. local debug viewers). Avoid for large recordings.
#[tauri::command]
pub async fn read_session_recording_base64(source_path: String) -> Result<String, String> {
    let bytes = tokio::fs::read(&source_path)
        .await
        .map_err(|e| format!("Failed to read WAV: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
