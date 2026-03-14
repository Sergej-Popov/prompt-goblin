use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

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
    stream: Mutex<Option<StreamHandle>>,
}

unsafe impl Send for AudioState {}
unsafe impl Sync for AudioState {}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            is_recording: AtomicBool::new(false),
            stream: Mutex::new(None),
        }
    }
}

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

/// Start recording from the default input device.
/// Audio is captured as 16kHz mono PCM16 and emitted as base64 chunks.
#[tauri::command]
pub fn start_recording(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AudioState>();

    if state.is_recording.load(Ordering::SeqCst) {
        return Err("Already recording".to_string());
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No input device available")?;

    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {}", e))?;

    // We want 16kHz mono PCM16 for Gemini
    let target_sample_rate = 16000u32;
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

    // Accumulator for sample rate conversion
    let sample_accumulator: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let stream = match default_config.sample_format() {
        cpal::SampleFormat::F32 => {
            let acc = sample_accumulator.clone();
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
                        &acc,
                        &app_handle,
                    );
                },
                |err| eprintln!("Audio stream error: {}", err),
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let acc = sample_accumulator.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !is_recording_clone.load(Ordering::SeqCst) {
                        return;
                    }
                    let float_data: Vec<f32> =
                        data.iter().map(|&s| s as f32 / 32768.0).collect();
                    process_audio_f32(
                        &float_data,
                        source_channels,
                        source_sample_rate,
                        target_sample_rate,
                        &acc,
                        &app_handle,
                    );
                },
                |err| eprintln!("Audio stream error: {}", err),
                None,
            )
        }
        format => {
            return Err(format!("Unsupported sample format: {:?}", format));
        }
    }
    .map_err(|e| format!("Failed to build input stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start stream: {}", e))?;

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

    Ok(())
}

/// Process f32 audio data: downmix to mono, resample to target rate, convert to PCM16, emit as base64.
fn process_audio_f32(
    data: &[f32],
    source_channels: usize,
    source_sample_rate: u32,
    target_sample_rate: u32,
    accumulator: &Arc<Mutex<Vec<f32>>>,
    app: &AppHandle,
) {
    // Downmix to mono by averaging channels
    let mono: Vec<f32> = data
        .chunks(source_channels)
        .map(|frame| frame.iter().sum::<f32>() / source_channels as f32)
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

    // Encode as base64 and emit
    let b64 = base64::engine::general_purpose::STANDARD.encode(&pcm16_bytes);

    let _ = app.emit("audio-chunk", AudioChunkPayload { data: b64, rms });
}
