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

/// Forwards audio from a receiver to a Tauri IPC channel
pub struct AudioForwarder {
    /// Handle to signal stop
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl AudioForwarder {
    fn stop(&self) {
        self.stop_flag.store(true, std::sync::atomic::Ordering::SeqCst);
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

            match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(data) => {
                    buffer.extend_from_slice(&data);
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

    // Store the forwarder so we can stop it later
    let forwarder = AudioForwarder { stop_flag };
    let mut active = state.active_receiver.lock().map_err(|e| e.to_string())?;
    *active = Some(forwarder);

    Ok(())
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
