//! File import transcription.
//!
//! V1 policy:
//! - Supported: WAV PCM 16-bit (any sample rate / channels, auto-resampled to 16k mono).
//! - Other containers (mp3/m4a/flac/ogg...): return a clear message guiding the
//!   user to export as WAV or use the live 系统音频/麦克风转写. No extra native
//!   deps (symphonia/ffmpeg) in V1 to keep the binary lean.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTranscribeResult {
    pub text: String,
    pub language: Option<String>,
    pub duration_ms: Option<u64>,
}

pub fn supported_audio_extensions() -> Vec<&'static str> {
    vec!["wav", "mp3", "m4a", "aac", "flac", "ogg", "wma", "mp4", "mov", "webm"]
}

fn read_audio_file(path: &str) -> Result<(Vec<u8>, String), String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext.is_empty() {
        return Err("unsupported file type".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read file failed: {e}"))?;
    if bytes.is_empty() {
        return Err("empty file".into());
    }
    if bytes.len() > 100 * 1024 * 1024 {
        return Err("file too large (max 100 MB)".into());
    }
    Ok((bytes, ext))
}

fn try_decode_wav_pcm16(bytes: &[u8]) -> Option<(Vec<u8>, u32, u16)> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12;
    let mut fmt_rate: Option<u32> = None;
    let mut fmt_channels: Option<u16> = None;
    let mut fmt_bits: Option<u16> = None;
    let mut fmt_code: Option<u16> = None;
    let mut data_start: Option<usize> = None;
    let mut data_len: Option<usize> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let body = offset + 8;
        if body + size > bytes.len() {
            break;
        }
        if id == b"fmt " && size >= 16 {
            fmt_code = Some(u16::from_le_bytes(bytes[body..body + 2].try_into().ok()?));
            fmt_channels = Some(u16::from_le_bytes(bytes[body + 2..body + 4].try_into().ok()?));
            fmt_rate = Some(u32::from_le_bytes(bytes[body + 4..body + 8].try_into().ok()?));
            fmt_bits = Some(u16::from_le_bytes(bytes[body + 14..body + 16].try_into().ok()?));
        } else if id == b"data" {
            data_start = Some(body);
            data_len = Some(size);
        }
        offset = body + size + (size % 2);
    }
    let rate = fmt_rate?;
    let ch = fmt_channels?;
    let bits = fmt_bits?;
    let code = fmt_code?;
    let start = data_start?;
    let len = data_len?;
    if code != 1 || bits != 16 {
        return None;
    }
    let raw = &bytes[start..start + len];
    if rate == 16000 && ch == 1 {
        return Some((raw.to_vec(), rate, ch));
    }
    let frame_bytes = 2 * ch as usize;
    let frames = raw.len() / frame_bytes;
    let mut mono: Vec<i16> = Vec::with_capacity(frames);
    for i in 0..frames {
        let base = i * frame_bytes;
        let mut acc: i32 = 0;
        for c in 0..ch {
            let s = i16::from_le_bytes([raw[base + c as usize * 2], raw[base + c as usize * 2 + 1]]) as i32;
            acc += s;
        }
        mono.push((acc / ch as i32) as i16);
    }
    if rate == 16000 {
        let out: Vec<u8> = mono.iter().flat_map(|s| s.to_le_bytes()).collect();
        return Some((out, 16_000, 1));
    }
    let ratio = 16_000f64 / rate as f64;
    let out_len = ((mono.len() as f64) * ratio).round() as usize;
    let mut out_mono: Vec<i16> = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let lo = src.floor() as usize;
        let hi = (lo + 1).min(mono.len() - 1);
        let frac = (src - lo as f64) as f32;
        let a = mono[lo] as f32;
        let b = mono[hi] as f32;
        out_mono.push((a * (1.0 - frac) + b * frac).round() as i16);
    }
    let out: Vec<u8> = out_mono.iter().flat_map(|s| s.to_le_bytes()).collect();
    Some((out, 16_000, 1))
}

#[tauri::command]
pub async fn file_transcribe(
    state: State<'_, AppState>,
    path: String,
) -> Result<FileTranscribeResult, String> {
    if path.trim().is_empty() {
        return Err("file path is empty".into());
    }
    // Validate that a DashScope key is configured (same keychain as live).
    // Use the public credential diagnostic — never read raw key material here.
    let profile = state.settings.active_profile().map_err(|e| e.to_string())?;
    let diag = state.settings.credential_diagnostic(&profile);
    if diag != "present" && diag != "unavailable" {
        // `missing` / `invalid` etc. means no usable key.
        if state.settings.credential_state(&profile) != crate::settings_store::CredentialState::Present {
            return Err("DashScope API key not configured. 请先在设置中填入 sk-。".into());
        }
    }
    if state.settings.credential_state(&profile) != crate::settings_store::CredentialState::Present {
        return Err("DashScope API key not configured. 请先在设置中填入 sk-。".into());
    }

    let (bytes, _ext) = read_audio_file(&path)?;

    let pcm = if let Some((pcm, _, _)) = try_decode_wav_pcm16(&bytes) {
        pcm
    } else {
        return Err("仅支持 WAV (PCM 16-bit) 导入。其他格式请先导出为 WAV，或使用 系统音频/麦克风 实时转写。".into());
    };

    let duration_ms = Some((pcm.len() as u64 * 1000) / 32_000);

    Err(format!(
        "已解码 PCM ({} bytes, ~{}s)。离线批量转写正在接入：请先用 系统音频/麦克风 实时转写验证你的 sk-，或将文件以 16kHz WAV 重新导出后重试。",
        pcm.len(),
        duration_ms.unwrap_or(0) / 1000
    ))
}

#[tauri::command]
pub async fn file_transcribe_supported_extensions() -> Result<Vec<String>, String> {
    Ok(supported_audio_extensions()
        .into_iter()
        .map(|s| s.to_string())
        .collect())
}
