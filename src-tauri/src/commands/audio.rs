use crate::audio::microphone::MicCapture;
use crate::audio::SystemAudioCapture;
use crate::commands::session_recording::{append_pcm_frame, SessionRecordingState};
use serde::Serialize;
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{ipc::Channel, State};

/// State for tracking active audio captures
pub struct AudioState {
    pub system_audio: Mutex<SystemAudioCapture>,
    pub microphone: Mutex<MicCapture>,
    pub active_receiver: Mutex<Option<AudioForwarder>>,
}

/// Forwards audio from a receiver to a Tauri IPC channel.
///
/// ``pause_flag`` lets the forwarder be paused without tearing down the capture
/// pipeline — the mic/system streams keep running but PCM frames are dropped
/// instead of forwarded to the channel and the session recording file. This is
/// used by Phase 7C pause/resume so a 7-hour session can include lunch breaks
/// without the teacher having to stop+restart the whole pipeline.
pub struct AudioForwarder {
    /// Handle to signal stop
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pause_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl AudioForwarder {
    fn stop(&self) {
        self.stop_flag.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn set_paused(&self, paused: bool) {
        self.pause_flag
            .store(paused, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_paused(&self) -> bool {
        self.pause_flag.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn append_pcm_s16le_to_i16(buf: &mut Vec<i16>, bytes: &[u8]) {
    for chunk in bytes.chunks_exact(2) {
        buf.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }
}

/// Mix mic + system as **time-aligned** PCM (both are 16 kHz mono s16le).
/// The previous implementation concatenated chunks from two threads, which corrupts
/// the waveform (slow-motion / crackle when played as one stream).
fn spawn_mic_system_mixer(
    mic_rx: mpsc::Receiver<Vec<u8>>,
    sys_rx: mpsc::Receiver<Vec<u8>>,
) -> mpsc::Receiver<Vec<u8>> {
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();

    std::thread::spawn(move || {
        let mut mic_q: Vec<i16> = Vec::new();
        let mut sys_q: Vec<i16> = Vec::new();
        let mut mic_done = false;
        let mut sys_done = false;

        const MIN_MIX: usize = 160; // 10 ms @ 16 kHz — keeps latency low
        const MAX_OUT: usize = 16_000; // up to 1 s per chunk

        loop {
            while !mic_done {
                match mic_rx.try_recv() {
                    Ok(d) => append_pcm_s16le_to_i16(&mut mic_q, &d),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        mic_done = true;
                        break;
                    }
                }
            }
            while !sys_done {
                match sys_rx.try_recv() {
                    Ok(d) => append_pcm_s16le_to_i16(&mut sys_q, &d),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        sys_done = true;
                        break;
                    }
                }
            }

            let take = mic_q.len().min(sys_q.len());
            let flush_pair = mic_done && sys_done && take > 0;
            if take >= MIN_MIX || flush_pair {
                let n = take.min(MAX_OUT);
                let mut out = Vec::with_capacity(n * 2);
                for i in 0..n {
                    let m = mic_q[i] as i32;
                    let s = sys_q[i] as i32;
                    let mixed = ((m + s) / 2) as i16;
                    out.extend_from_slice(&mixed.to_le_bytes());
                }
                mic_q.drain(0..n);
                sys_q.drain(0..n);
                if out_tx.send(out).is_err() {
                    return;
                }
                continue;
            }

            if mic_done || sys_done {
                // One side ended: pass through the other (mono) so we don't drop tail audio.
                if mic_done && !mic_q.is_empty() {
                    let n = mic_q.len().min(MAX_OUT);
                    let mut out = Vec::with_capacity(n * 2);
                    for i in 0..n {
                        out.extend_from_slice(&mic_q[i].to_le_bytes());
                    }
                    mic_q.drain(0..n);
                    if out_tx.send(out).is_err() {
                        return;
                    }
                    continue;
                }
                if sys_done && !sys_q.is_empty() {
                    let n = sys_q.len().min(MAX_OUT);
                    let mut out = Vec::with_capacity(n * 2);
                    for i in 0..n {
                        out.extend_from_slice(&sys_q[i].to_le_bytes());
                    }
                    sys_q.drain(0..n);
                    if out_tx.send(out).is_err() {
                        return;
                    }
                    continue;
                }
                if mic_done && sys_done {
                    break;
                }
            }

            // Wait for more samples on the shorter (or either) queue.
            if mic_q.len() <= sys_q.len() && !mic_done {
                match mic_rx.recv_timeout(Duration::from_millis(30)) {
                    Ok(d) => append_pcm_s16le_to_i16(&mut mic_q, &d),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => mic_done = true,
                }
            } else if !sys_done {
                match sys_rx.recv_timeout(Duration::from_millis(30)) {
                    Ok(d) => append_pcm_s16le_to_i16(&mut sys_q, &d),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => sys_done = true,
                }
            } else {
                match mic_rx.recv_timeout(Duration::from_millis(30)) {
                    Ok(d) => append_pcm_s16le_to_i16(&mut mic_q, &d),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => mic_done = true,
                }
            }
        }
    });

    out_rx
}

#[derive(Serialize, Clone)]
pub struct PermissionStatus {
    pub screen_recording: String,
    pub microphone: String,
}

/// Start audio capture and forward data to the frontend via IPC channel.
///
/// Also forwards PCM into the on-disk session recording when one is active
/// (see [`crate::commands::session_recording::start_session_recording`]), so the
/// full-session WAV never has to be accumulated in the JS heap.
#[tauri::command]
pub fn start_capture(
    source: String,
    channel: Channel<Vec<u8>>,
    state: State<'_, AudioState>,
    recording: State<'_, SessionRecordingState>,
) -> Result<(), String> {
    // Stop any existing capture first
    stop_capture_inner(&state);
    let recording_handle = recording.handle();

    let receiver: mpsc::Receiver<Vec<u8>> = match source.as_str() {
        "system" => {
            let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
            sys.start()?
        }
        "microphone" => {
            let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
            mic.start()?
        }
        "both" => {
            // Start both sources and **time-align mix** (do not concatenate interleaved chunks).
            let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
            let sys_rx = sys.start()?;
            let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
            let mic_rx = mic.start()?;

            spawn_mic_system_mixer(mic_rx, sys_rx)
        }
        _ => return Err(format!("Unknown source: {}", source)),
    };

    // Spawn a thread to forward audio data from receiver to IPC channel
    let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();
    let pause_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pause_flag_clone = pause_flag.clone();

    std::thread::spawn(move || {
        let mut buffer: Vec<u8> = Vec::with_capacity(32000); // ~1 sec at 16kHz s16le
        let batch_interval = std::time::Duration::from_millis(200);
        let mut last_flush = std::time::Instant::now();

        loop {
            if stop_flag_clone.load(std::sync::atomic::Ordering::SeqCst) {
                // Flush remaining buffer before exit
                if !buffer.is_empty() {
                    append_pcm_frame(&recording_handle, &buffer);
                    let _ = channel.send(buffer.clone());
                }
                break;
            }

            // Phase 7C pause: keep draining the mic/system receivers so they don't
            // overflow during a long break (lunch can be 60+ min), but DROP the
            // bytes instead of forwarding them to the channel or writing to the
            // session WAV file. When the user hits Resume the buffer is reset so
            // pre-pause audio doesn't bleed into the post-pause stream.
            let is_paused = pause_flag_clone.load(std::sync::atomic::Ordering::SeqCst);

            match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(data) => {
                    if !is_paused {
                        buffer.extend_from_slice(&data);
                    }
                    // else: silently drop the frame
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !buffer.is_empty() {
                        append_pcm_frame(&recording_handle, &buffer);
                        let _ = channel.send(buffer.clone());
                    }
                    break;
                }
            }

            // While paused: clear any leftover buffer so a chunk straddling the
            // pause boundary doesn't leak. Also skip the periodic flush.
            if is_paused {
                if !buffer.is_empty() {
                    buffer.clear();
                }
                last_flush = std::time::Instant::now();
                continue;
            }

            // Flush buffer every 200ms — write to disk first so a channel.send failure
            // (webview tab closed unexpectedly) does not silently drop the recording.
            if last_flush.elapsed() >= batch_interval && !buffer.is_empty() {
                append_pcm_frame(&recording_handle, &buffer);
                if let Err(_e) = channel.send(buffer.clone()) {
                    break; // Channel closed
                }
                buffer.clear();
                last_flush = std::time::Instant::now();
            }
        }
    });

    // Store the forwarder so we can stop / pause / resume it later.
    let forwarder = AudioForwarder { stop_flag, pause_flag };
    let mut active = state.active_receiver.lock().map_err(|e| e.to_string())?;
    *active = Some(forwarder);

    Ok(())
}

/// Pause the live audio forwarder. PCM frames are dropped (not written to the
/// WAV file or forwarded to the JS channel) until ``resume_capture`` is called.
/// The mic / system audio streams keep running underneath so resuming is instant.
/// No-op if no capture is active or if already paused.
#[tauri::command]
pub fn pause_capture(state: State<'_, AudioState>) -> Result<bool, String> {
    let active = state.active_receiver.lock().map_err(|e| e.to_string())?;
    if let Some(forwarder) = active.as_ref() {
        let was_paused = forwarder.is_paused();
        forwarder.set_paused(true);
        Ok(!was_paused)
    } else {
        Ok(false)
    }
}

/// Resume a paused capture. No-op if no capture is active or if not paused.
#[tauri::command]
pub fn resume_capture(state: State<'_, AudioState>) -> Result<bool, String> {
    let active = state.active_receiver.lock().map_err(|e| e.to_string())?;
    if let Some(forwarder) = active.as_ref() {
        let was_paused = forwarder.is_paused();
        forwarder.set_paused(false);
        Ok(was_paused)
    } else {
        Ok(false)
    }
}

/// Query current pause state of the active capture. Returns Ok(false) if no
/// capture is active.
#[tauri::command]
pub fn is_capture_paused(state: State<'_, AudioState>) -> Result<bool, String> {
    let active = state.active_receiver.lock().map_err(|e| e.to_string())?;
    Ok(active.as_ref().map(|f| f.is_paused()).unwrap_or(false))
}

/// Stop audio capture
#[tauri::command]
pub fn stop_capture(state: State<'_, AudioState>) -> Result<(), String> {
    stop_capture_inner(&state);
    Ok(())
}

fn stop_capture_inner(state: &AudioState) {
    // Stop the forwarder
    if let Ok(mut active) = state.active_receiver.lock() {
        if let Some(forwarder) = active.take() {
            forwarder.stop();
        }
    }

    // Stop system audio
    if let Ok(sys) = state.system_audio.lock() {
        sys.stop();
    }

    // Stop microphone
    if let Ok(mut mic) = state.microphone.lock() {
        mic.stop();
    }
}

/// Check audio capture permissions
#[tauri::command]
pub fn check_permissions() -> PermissionStatus {
    // Note: Actual permission checking on macOS requires Objective-C interop
    // For now, we return "unknown" and permissions will be prompted on first use
    PermissionStatus {
        screen_recording: "unknown".to_string(),
        microphone: "unknown".to_string(),
    }
}
