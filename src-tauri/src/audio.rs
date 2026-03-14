use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

use crate::debug_log::{resolve_log_file_path, DebugLogState};

/// We store the stream handle as a raw pointer because cpal::Stream is not Send.
/// This is safe because we only create/drop it from the main thread context
/// and the audio callback is managed by cpal internally.
struct StreamHandle(*mut ());

unsafe impl Send for StreamHandle {}
unsafe impl Sync for StreamHandle {}

impl StreamHandle {
    fn new(stream: cpal::Stream) -> Self {
        let boxed = Box::new(stream);
        StreamHandle(Box::into_raw(boxed) as *mut ())
    }

    /// Drop the inner stream. Must only be called once.
    unsafe fn drop_inner(&mut self) {
        if !self.0.is_null() {
            let _ = unsafe { Box::from_raw(self.0 as *mut cpal::Stream) };
            self.0 = std::ptr::null_mut();
        }
    }
}

/// Shared state for audio recording
pub struct AudioState {
    pub is_recording: AtomicBool,
    pub is_monitoring: AtomicBool,
    stream: Mutex<Option<StreamHandle>>,
    monitor_stream: Mutex<Option<StreamHandle>>,
    monitor_capture: Mutex<Option<MonitorCapture>>,
    debug_capture: Arc<Mutex<Option<DebugAudioCapture>>>,
    pcm_emit_buffer: Arc<Mutex<Vec<u8>>>,
}

unsafe impl Send for AudioState {}
unsafe impl Sync for AudioState {}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            is_recording: AtomicBool::new(false),
            is_monitoring: AtomicBool::new(false),
            stream: Mutex::new(None),
            monitor_stream: Mutex::new(None),
            monitor_capture: Mutex::new(None),
            debug_capture: Arc::new(Mutex::new(None)),
            pcm_emit_buffer: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

struct MonitorCapture {
    sample_rate: u32,
    samples: Arc<Mutex<Vec<i16>>>,
}

struct DebugAudioCapture {
    file: File,
    data_bytes: u32,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    path: PathBuf,
}

const EMIT_PCM_CHUNK_BYTES: usize = 640;
const MAX_DEBUG_AUDIO_RECORDINGS: usize = 10;

#[derive(Clone, Serialize)]
struct AudioChunkPayload {
    /// Base64-encoded PCM 16-bit LE audio data
    data: String,
    /// RMS energy level (0.0 - 1.0) for silence detection
    rms: f32,
}

#[derive(Clone, Serialize)]
struct RecordingStatusPayload {
    recording: bool,
}

#[derive(Clone, Serialize)]
struct MicLevelPayload {
    rms: f32,
}

#[derive(Clone, Serialize)]
struct MicMonitoringStatusPayload {
    monitoring: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDeviceInfo {
    id: String,
    name: String,
    is_default: bool,
}

#[tauri::command]
pub fn list_input_devices() -> Result<Vec<InputDeviceInfo>, String> {
    let host = cpal::default_host();

    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let mut devices = Vec::new();
    let input_devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {}", e))?;

    for device in input_devices {
        let name = device
            .name()
            .unwrap_or_else(|_| "Unknown input device".to_string());
        let is_default = default_name
            .as_ref()
            .is_some_and(|default| *default == name);
        devices.push(InputDeviceInfo {
            id: name.clone(),
            name,
            is_default,
        });
    }

    devices.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(devices)
}

#[tauri::command]
pub fn start_mic_monitoring(
    app: AppHandle,
    device_id: Option<String>,
    input_gain: Option<f32>,
) -> Result<(), String> {
    let state = app.state::<AudioState>();

    if state.is_recording.load(Ordering::SeqCst) {
        return Err("Cannot start mic test while recording".to_string());
    }
    if state.is_monitoring.load(Ordering::SeqCst) {
        return Ok(());
    }

    let host = cpal::default_host();
    let device = pick_input_device(&host, device_id)?;

    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    let source_channels = default_config.channels() as usize;
    let source_sample_rate = default_config.sample_rate().0;
    let gain = input_gain.unwrap_or(1.0).clamp(0.25, 3.0);
    let config = cpal::StreamConfig {
        channels: default_config.channels(),
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    let app_handle = app.clone();
    let is_monitoring = Arc::new(AtomicBool::new(true));
    let is_monitoring_clone = is_monitoring.clone();
    let last_emit = Arc::new(Mutex::new(std::time::Instant::now()));
    let monitor_samples = Arc::new(Mutex::new(Vec::<i16>::new()));
    let max_monitor_samples = source_sample_rate as usize * 20;

    let stream = match default_config.sample_format() {
        cpal::SampleFormat::F32 => {
            let last_emit_clone = last_emit.clone();
            let samples_clone = monitor_samples.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !is_monitoring_clone.load(Ordering::SeqCst) {
                        return;
                    }
                    let gained: Vec<f32> =
                        data.iter().map(|s| (*s * gain).clamp(-1.0, 1.0)).collect();
                    collect_monitor_samples(
                        &gained,
                        source_channels,
                        max_monitor_samples,
                        &samples_clone,
                    );
                    emit_mic_level(&gained, source_channels, &last_emit_clone, &app_handle);
                },
                |err| eprintln!("Mic monitor stream error: {}", err),
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let last_emit_clone = last_emit.clone();
            let samples_clone = monitor_samples.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !is_monitoring_clone.load(Ordering::SeqCst) {
                        return;
                    }
                    let float_data: Vec<f32> = data
                        .iter()
                        .map(|&s| (s as f32 / 32768.0 * gain).clamp(-1.0, 1.0))
                        .collect();
                    collect_monitor_samples(
                        &float_data,
                        source_channels,
                        max_monitor_samples,
                        &samples_clone,
                    );
                    emit_mic_level(&float_data, source_channels, &last_emit_clone, &app_handle);
                },
                |err| eprintln!("Mic monitor stream error: {}", err),
                None,
            )
        }
        format => {
            return Err(format!("Unsupported sample format: {:?}", format));
        }
    }
    .map_err(|e| format!("Failed to build mic monitor stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start mic monitor stream: {}", e))?;

    state.is_monitoring.store(true, Ordering::SeqCst);
    let handle = StreamHandle::new(stream);
    *state.monitor_stream.lock().unwrap() = Some(handle);
    *state.monitor_capture.lock().unwrap() = Some(MonitorCapture {
        sample_rate: source_sample_rate,
        samples: monitor_samples,
    });

    let _ = app.emit(
        "mic-monitoring-status",
        MicMonitoringStatusPayload { monitoring: true },
    );

    Ok(())
}

#[tauri::command]
pub fn stop_mic_monitoring(app: AppHandle) -> Result<(), String> {
    stop_mic_monitoring_internal(app, false).map(|_| ())
}

#[tauri::command]
pub fn stop_mic_monitoring_with_recording(app: AppHandle) -> Result<Option<String>, String> {
    stop_mic_monitoring_internal(app, true)
}

fn stop_mic_monitoring_internal(
    app: AppHandle,
    include_recording: bool,
) -> Result<Option<String>, String> {
    let state = app.state::<AudioState>();

    state.is_monitoring.store(false, Ordering::SeqCst);

    let mut stream_lock = state.monitor_stream.lock().unwrap();
    if let Some(mut handle) = stream_lock.take() {
        unsafe {
            handle.drop_inner();
        }
    }

    let _ = app.emit(
        "mic-monitoring-status",
        MicMonitoringStatusPayload { monitoring: false },
    );

    if !include_recording {
        *state.monitor_capture.lock().unwrap() = None;
        return Ok(None);
    }

    let capture = state.monitor_capture.lock().unwrap().take();
    let Some(capture) = capture else {
        return Ok(None);
    };

    let samples = capture.samples.lock().unwrap();
    if samples.is_empty() {
        return Ok(None);
    }

    let wav = build_wav_from_pcm16(&samples, capture.sample_rate, 1);
    let b64 = base64::engine::general_purpose::STANDARD.encode(wav);
    Ok(Some(b64))
}

/// Start recording from the selected input device (or default).
/// Audio is captured as 16kHz mono PCM16 and emitted as base64 chunks.
#[tauri::command]
pub fn start_recording(
    app: AppHandle,
    device_id: Option<String>,
    input_gain: Option<f32>,
) -> Result<(), String> {
    let state = app.state::<AudioState>();

    if state.is_recording.load(Ordering::SeqCst) {
        return Err("Already recording".to_string());
    }

    if state.is_monitoring.load(Ordering::SeqCst) {
        let _ = stop_mic_monitoring(app.clone());
    }

    let host = cpal::default_host();
    let device = pick_input_device(&host, device_id)?;

    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    // We want 16kHz mono PCM16 for Gemini
    let target_sample_rate = 16000u32;
    let gain = input_gain.unwrap_or(1.0).clamp(0.25, 3.0);
    let source_sample_rate = default_config.sample_rate().0;
    let source_channels = default_config.channels() as usize;

    let config = cpal::StreamConfig {
        channels: default_config.channels(),
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    let app_handle = app.clone();
    let is_recording = Arc::new(AtomicBool::new(true));
    let is_recording_clone = is_recording.clone();
    let debug_capture = state.debug_capture.clone();
    let pcm_emit_buffer = state.pcm_emit_buffer.clone();

    *debug_capture.lock().unwrap() = None;
    pcm_emit_buffer.lock().unwrap().clear();
    if app.state::<DebugLogState>().is_enabled() {
        match create_debug_audio_capture(&app, target_sample_rate) {
            Ok(capture) => {
                *debug_capture.lock().unwrap() = Some(capture);
            }
            Err(err) => {
                eprintln!("Failed to initialize debug audio file: {}", err);
            }
        }
    }

    // Accumulator for sample rate conversion
    let sample_accumulator: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let stream = match default_config.sample_format() {
        cpal::SampleFormat::F32 => {
            let acc = sample_accumulator.clone();
            let debug_capture_clone = debug_capture.clone();
            let emit_buffer_clone = pcm_emit_buffer.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !is_recording_clone.load(Ordering::SeqCst) {
                        return;
                    }
                    process_audio_f32(
                        data,
                        source_channels,
                        source_sample_rate,
                        target_sample_rate,
                        gain,
                        &acc,
                        &app_handle,
                        &debug_capture_clone,
                        &emit_buffer_clone,
                    );
                },
                |err| eprintln!("Audio stream error: {}", err),
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let acc = sample_accumulator.clone();
            let debug_capture_clone = debug_capture.clone();
            let emit_buffer_clone = pcm_emit_buffer.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !is_recording_clone.load(Ordering::SeqCst) {
                        return;
                    }
                    let float_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    process_audio_f32(
                        &float_data,
                        source_channels,
                        source_sample_rate,
                        target_sample_rate,
                        gain,
                        &acc,
                        &app_handle,
                        &debug_capture_clone,
                        &emit_buffer_clone,
                    );
                },
                |err| eprintln!("Audio stream error: {}", err),
                None,
            )
        }
        format => {
            return Err(format!("Unsupported sample format: {:?}", format));
        }
    };

    let stream = match stream {
        Ok(stream) => stream,
        Err(e) => {
            discard_debug_capture(&debug_capture);
            return Err(format!("Failed to build input stream: {}", e));
        }
    };

    if let Err(e) = stream.play() {
        discard_debug_capture(&debug_capture);
        return Err(format!("Failed to start stream: {}", e));
    }

    // Store state
    state.is_recording.store(true, Ordering::SeqCst);
    let handle = StreamHandle::new(stream);
    *state.stream.lock().unwrap() = Some(handle);

    // Notify frontend
    let _ = app.emit(
        "recording-status",
        RecordingStatusPayload { recording: true },
    );

    Ok(())
}

fn pick_input_device(host: &cpal::Host, device_id: Option<String>) -> Result<cpal::Device, String> {
    let requested_device_id = device_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty() && *id != "default");

    if let Some(requested_id) = requested_device_id {
        let matched = host
            .input_devices()
            .map_err(|e| format!("Failed to enumerate input devices: {}", e))?
            .find_map(|d| match d.name() {
                Ok(name) if name == requested_id => Some(d),
                _ => None,
            });

        if let Some(device) = matched {
            return Ok(device);
        }

        eprintln!(
            "Requested input device '{}' not found, falling back to default input device",
            requested_id
        );
    }

    host.default_input_device()
        .ok_or("No input device available".to_string())
}

fn emit_mic_level(
    data: &[f32],
    source_channels: usize,
    last_emit: &Arc<Mutex<std::time::Instant>>,
    app: &AppHandle,
) {
    let mut guard = last_emit.lock().unwrap();
    if guard.elapsed().as_millis() < 33 {
        return;
    }
    *guard = std::time::Instant::now();
    drop(guard);

    let mono: Vec<f32> = data
        .chunks(source_channels)
        .map(|frame| frame.iter().sum::<f32>() / source_channels as f32)
        .collect();

    if mono.is_empty() {
        return;
    }

    let sum_sq: f32 = mono.iter().map(|s| s * s).sum();
    let rms = (sum_sq / mono.len() as f32).sqrt();

    let _ = app.emit("mic-level", MicLevelPayload { rms });
}

/// Stop recording and clean up the audio stream.
#[tauri::command]
pub fn stop_recording(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AudioState>();

    state.is_recording.store(false, Ordering::SeqCst);

    // Drop the stream to stop it
    let mut stream_lock = state.stream.lock().unwrap();
    if let Some(mut handle) = stream_lock.take() {
        unsafe {
            handle.drop_inner();
        }
    }

    // Notify frontend
    let _ = app.emit(
        "recording-status",
        RecordingStatusPayload { recording: false },
    );

    flush_pending_emit_audio(&app, &state.pcm_emit_buffer);

    let mut debug_capture = state.debug_capture.lock().unwrap();
    if let Some(capture) = debug_capture.take() {
        finalize_debug_audio_capture(capture)?;
    }

    Ok(())
}

/// Process f32 audio data: downmix to mono, resample to target rate, convert to PCM16, emit as base64.
fn process_audio_f32(
    data: &[f32],
    source_channels: usize,
    source_sample_rate: u32,
    target_sample_rate: u32,
    gain: f32,
    accumulator: &Arc<Mutex<Vec<f32>>>,
    app: &AppHandle,
    debug_capture: &Arc<Mutex<Option<DebugAudioCapture>>>,
    emit_buffer: &Arc<Mutex<Vec<u8>>>,
) {
    // Downmix to mono by averaging channels
    let mono: Vec<f32> = data
        .chunks(source_channels)
        .map(|frame| {
            let mixed = frame.iter().sum::<f32>() / source_channels as f32;
            (mixed * gain).clamp(-1.0, 1.0)
        })
        .collect();

    // Simple linear resampling
    let ratio = source_sample_rate as f64 / target_sample_rate as f64;

    let mut acc = accumulator.lock().unwrap();
    acc.extend_from_slice(&mono);

    // Calculate how many output samples we can produce
    let output_samples = (acc.len() as f64 / ratio) as usize;
    if output_samples == 0 {
        return;
    }

    let mut resampled = Vec::with_capacity(output_samples);
    for i in 0..output_samples {
        let src_idx = i as f64 * ratio;
        let idx = src_idx as usize;
        let frac = src_idx - idx as f64;

        let sample = if idx + 1 < acc.len() {
            acc[idx] * (1.0 - frac as f32) + acc[idx + 1] * frac as f32
        } else if idx < acc.len() {
            acc[idx]
        } else {
            0.0
        };
        resampled.push(sample);
    }

    // Remove consumed samples from accumulator
    let consumed = (output_samples as f64 * ratio) as usize;
    let consumed = consumed.min(acc.len());
    acc.drain(..consumed);
    drop(acc);

    // Calculate RMS energy for silence detection
    let rms = if !resampled.is_empty() {
        let sum_sq: f32 = resampled.iter().map(|s| s * s).sum();
        (sum_sq / resampled.len() as f32).sqrt()
    } else {
        0.0
    };

    // Convert to PCM16 little-endian bytes
    let pcm16_bytes: Vec<u8> = resampled
        .iter()
        .flat_map(|&sample| {
            let clamped = sample.clamp(-1.0, 1.0);
            let pcm16 = (clamped * 32767.0) as i16;
            pcm16.to_le_bytes().to_vec()
        })
        .collect();

    append_debug_audio_chunk(debug_capture, &pcm16_bytes);
    emit_coalesced_audio_chunks(app, emit_buffer, &pcm16_bytes, rms);
}

fn emit_coalesced_audio_chunks(
    app: &AppHandle,
    emit_buffer: &Arc<Mutex<Vec<u8>>>,
    pcm16_bytes: &[u8],
    rms: f32,
) {
    if pcm16_bytes.is_empty() {
        return;
    }

    let mut pending = emit_buffer.lock().unwrap();
    pending.extend_from_slice(pcm16_bytes);

    while pending.len() >= EMIT_PCM_CHUNK_BYTES {
        let chunk = pending[..EMIT_PCM_CHUNK_BYTES].to_vec();
        pending.drain(..EMIT_PCM_CHUNK_BYTES);
        let b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
        let _ = app.emit("audio-chunk", AudioChunkPayload { data: b64, rms });
    }
}

fn flush_pending_emit_audio(app: &AppHandle, emit_buffer: &Arc<Mutex<Vec<u8>>>) {
    let mut pending = emit_buffer.lock().unwrap();
    if pending.is_empty() {
        return;
    }

    let mut chunk = pending.clone();
    pending.clear();

    if chunk.len() < EMIT_PCM_CHUNK_BYTES {
        chunk.resize(EMIT_PCM_CHUNK_BYTES, 0);
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
    let _ = app.emit(
        "audio-chunk",
        AudioChunkPayload {
            data: b64,
            rms: 0.0,
        },
    );
}

fn collect_monitor_samples(
    data: &[f32],
    source_channels: usize,
    max_samples: usize,
    samples: &Arc<Mutex<Vec<i16>>>,
) {
    let mut guard = samples.lock().unwrap();

    for frame in data.chunks(source_channels) {
        let mono = frame.iter().sum::<f32>() / source_channels as f32;
        let clamped = mono.clamp(-1.0, 1.0);
        guard.push((clamped * 32767.0) as i16);
    }

    if guard.len() > max_samples {
        let overflow = guard.len() - max_samples;
        guard.drain(..overflow);
    }
}

fn build_wav_from_pcm16(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
    let data_bytes = (samples.len() * std::mem::size_of::<i16>()) as u32;
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    let mut header = Vec::with_capacity(44);

    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&(36u32 + data_bytes).to_le_bytes());
    header.extend_from_slice(b"WAVE");
    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&16u32.to_le_bytes());
    header.extend_from_slice(&1u16.to_le_bytes());
    header.extend_from_slice(&channels.to_le_bytes());
    header.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * channels as u32 * 2;
    header.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = channels * 2;
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&16u16.to_le_bytes());
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_bytes.to_le_bytes());

    wav.extend_from_slice(&header);
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }

    wav
}

fn create_debug_audio_capture(
    app: &AppHandle,
    sample_rate: u32,
) -> Result<DebugAudioCapture, String> {
    let debug_log_path = resolve_log_file_path(app)?;
    let base_dir = debug_log_path
        .parent()
        .ok_or("Failed to resolve debug log directory".to_string())?;
    let audio_dir = base_dir.join("debug-audio");
    fs::create_dir_all(&audio_dir)
        .map_err(|e| format!("Failed to create debug audio directory: {}", e))?;

    let ts_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to compute timestamp: {}", e))?
        .as_millis();

    let path = audio_dir.join(format!("recording-{}.wav", ts_millis));
    let mut file =
        File::create(&path).map_err(|e| format!("Failed to create debug audio file: {}", e))?;
    file.write_all(&[0u8; 44])
        .map_err(|e| format!("Failed to initialize debug audio file: {}", e))?;

    if let Err(err) = prune_debug_audio_recordings(&audio_dir) {
        eprintln!("Failed to prune debug audio recordings: {}", err);
    }

    Ok(DebugAudioCapture {
        file,
        data_bytes: 0,
        sample_rate,
        channels: 1,
        bits_per_sample: 16,
        path,
    })
}

fn prune_debug_audio_recordings(audio_dir: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    let dir_iter = fs::read_dir(audio_dir)
        .map_err(|e| format!("Failed to read debug audio directory: {}", e))?;

    for item in dir_iter {
        let entry = item.map_err(|e| format!("Failed to read debug audio entry: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        let Some(ts) = parse_debug_recording_timestamp(file_name) else {
            continue;
        };

        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        entries.push((path, modified, ts));
    }

    if entries.len() <= MAX_DEBUG_AUDIO_RECORDINGS {
        return Ok(());
    }

    entries.sort_by(|a, b| {
        if let (Some(a_modified), Some(b_modified)) = (&a.1, &b.1) {
            let cmp = a_modified.cmp(b_modified);
            if cmp != std::cmp::Ordering::Equal {
                return cmp;
            }
        }

        let ts_cmp = a.2.cmp(&b.2);
        if ts_cmp != std::cmp::Ordering::Equal {
            return ts_cmp;
        }

        a.0.cmp(&b.0)
    });

    let to_remove = entries.len().saturating_sub(MAX_DEBUG_AUDIO_RECORDINGS);
    for (path, _, _) in entries.into_iter().take(to_remove) {
        fs::remove_file(&path).map_err(|e| {
            format!(
                "Failed to remove old debug audio file '{}': {}",
                path.display(),
                e
            )
        })?;
    }

    Ok(())
}

fn parse_debug_recording_timestamp(file_name: &str) -> Option<u128> {
    let ts = file_name.strip_prefix("recording-")?.strip_suffix(".wav")?;
    ts.parse::<u128>().ok()
}

fn append_debug_audio_chunk(capture: &Arc<Mutex<Option<DebugAudioCapture>>>, pcm16_bytes: &[u8]) {
    if pcm16_bytes.is_empty() {
        return;
    }

    let mut guard = capture.lock().unwrap();
    if let Some(active) = guard.as_mut() {
        if active.file.write_all(pcm16_bytes).is_ok() {
            active.data_bytes = active.data_bytes.saturating_add(pcm16_bytes.len() as u32);
        }
    }
}

fn discard_debug_capture(capture: &Arc<Mutex<Option<DebugAudioCapture>>>) {
    let mut guard = capture.lock().unwrap();
    let _ = guard.take();
}

fn finalize_debug_audio_capture(mut capture: DebugAudioCapture) -> Result<(), String> {
    write_wav_header(
        &mut capture.file,
        capture.sample_rate,
        capture.channels,
        capture.bits_per_sample,
        capture.data_bytes,
    )?;
    capture.file.flush().map_err(|e| {
        format!(
            "Failed to flush debug audio file '{}': {}",
            capture.path.display(),
            e
        )
    })
}

fn write_wav_header(
    file: &mut File,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    data_bytes: u32,
) -> Result<(), String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Failed to seek debug audio file: {}", e))?;

    let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
    let block_align = channels * bits_per_sample / 8;

    file.write_all(b"RIFF")
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&(36u32 + data_bytes).to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(b"WAVE")
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(b"fmt ")
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&16u32.to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&1u16.to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&channels.to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&sample_rate.to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&byte_rate.to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&block_align.to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&bits_per_sample.to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(b"data")
        .map_err(|e| format!("Failed to write WAV header: {}", e))?;
    file.write_all(&data_bytes.to_le_bytes())
        .map_err(|e| format!("Failed to write WAV header: {}", e))
}
