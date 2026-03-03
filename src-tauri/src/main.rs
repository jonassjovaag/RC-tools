use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

const VIDEO_EXTENSIONS: &[&str] = &[
    ".mp4", ".avi", ".mov", ".mkv", ".webm", ".wmv", ".flv", ".m4v",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    file_name: String,
    status: String,
    detail: String,
    current: usize,
    total: usize,
    progress: u32,
}

#[derive(Serialize)]
struct ConvertResult {
    converted: usize,
    total: usize,
}

fn get_video_files(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return vec![];
    };

    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| {
                        let dotted = format!(".{}", ext.to_lowercase());
                        VIDEO_EXTENSIONS.contains(&dotted.as_str())
                    })
                    .unwrap_or(false)
        })
        .collect();

    files.sort();
    files
}

/// Parse "HH:MM:SS.ms" into seconds.
fn parse_time_str(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].trim().parse().ok()?;
        let m: f64 = parts[1].trim().parse().ok()?;
        let s: f64 = parts[2].trim().parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + s)
    } else {
        None
    }
}

/// Get video duration in seconds by probing with ffmpeg.
async fn get_video_duration(app: &tauri::AppHandle, video_path: &str) -> Option<f64> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .ok()?
        .args(["-i", video_path])
        .output()
        .await
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        let trimmed = line.trim();
        if let Some(pos) = trimmed.find("Duration:") {
            let after = &trimmed[pos + 9..];
            if let Some(comma) = after.find(',') {
                return parse_time_str(after[..comma].trim());
            }
        }
    }
    None
}

/// Parse `out_time_us=<microseconds>` from ffmpeg -progress output.
fn parse_out_time_us(line: &str) -> Option<u64> {
    line.trim().strip_prefix("out_time_us=")?.parse().ok()
}

/// Run an ffmpeg pass using spawn(), streaming progress via -progress pipe:1.
async fn run_ffmpeg_pass(
    app: &tauri::AppHandle,
    args: Vec<String>,
    duration_secs: f64,
    progress_base: f64,
    progress_span: f64,
    file_name: &str,
    current: usize,
    total: usize,
) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Sidecar error: {}", e))?
        .args(&args)
        .spawn()
        .map_err(|e| format!("Spawn error: {}", e))?;

    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                if let Some(time_us) = parse_out_time_us(&line) {
                    if duration_secs > 0.0 {
                        let fraction = (time_us as f64 / 1_000_000.0 / duration_secs).min(1.0);
                        let pct = progress_base + fraction * progress_span;
                        let _ = app.emit(
                            "conversion-progress",
                            ProgressPayload {
                                file_name: file_name.to_string(),
                                status: "converting".to_string(),
                                detail: String::new(),
                                current,
                                total,
                                progress: pct as u32,
                            },
                        );
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }

    if exit_code == Some(0) {
        Ok(())
    } else {
        Err(truncate_end(&stderr_buf, 200))
    }
}

#[tauri::command]
async fn convert_videos(
    folder: String,
    width: u32,
    fps: u32,
    delete_originals: bool,
    app: tauri::AppHandle,
) -> Result<ConvertResult, String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.is_dir() {
        return Err(format!("'{}' is not a directory", folder));
    }

    let videos = get_video_files(&folder_path);
    if videos.is_empty() {
        return Err("No video files found in folder".to_string());
    }

    let total = videos.len();
    let mut converted = 0;

    for (i, video) in videos.iter().enumerate() {
        let file_name = video
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let current = i + 1;
        let video_str = video.to_string_lossy().to_string();

        // Emit: starting
        let _ = app.emit(
            "conversion-progress",
            ProgressPayload {
                file_name: file_name.clone(),
                status: "converting".to_string(),
                detail: String::new(),
                current,
                total,
                progress: 0,
            },
        );

        // Get video duration for progress calculation
        let duration = get_video_duration(&app, &video_str).await.unwrap_or(0.0);

        let gif_path = video.with_extension("gif");
        let palette_path = folder_path.join(format!(".palette_{}.png", i));
        let filters = format!("fps={},scale={}:-1:flags=lanczos", fps, width);

        // Pass 1: generate palette (0% → 20%)
        let palette_args = vec![
            "-i".into(),
            video_str.clone(),
            "-vf".into(),
            format!("{},palettegen=stats_mode=diff", filters),
            "-y".into(),
            palette_path.to_string_lossy().to_string(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
        ];

        if let Err(detail) =
            run_ffmpeg_pass(&app, palette_args, duration, 0.0, 20.0, &file_name, current, total)
                .await
        {
            let _ = app.emit(
                "conversion-progress",
                ProgressPayload {
                    file_name: file_name.clone(),
                    status: "error".to_string(),
                    detail: format!("Palette failed: {}", detail),
                    current,
                    total,
                    progress: 0,
                },
            );
            let _ = fs::remove_file(&palette_path);
            continue;
        }

        // Pass 2: convert using palette (20% → 100%)
        let gif_args = vec![
            "-i".into(),
            video_str.clone(),
            "-i".into(),
            palette_path.to_string_lossy().to_string(),
            "-lavfi".into(),
            format!(
                "{} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5",
                filters
            ),
            "-y".into(),
            gif_path.to_string_lossy().to_string(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
        ];

        if let Err(detail) =
            run_ffmpeg_pass(&app, gif_args, duration, 20.0, 80.0, &file_name, current, total).await
        {
            let _ = app.emit(
                "conversion-progress",
                ProgressPayload {
                    file_name: file_name.clone(),
                    status: "error".to_string(),
                    detail: format!("Convert failed: {}", detail),
                    current,
                    total,
                    progress: 0,
                },
            );
            let _ = fs::remove_file(&palette_path);
            continue;
        }

        // Clean up palette
        let _ = fs::remove_file(&palette_path);

        // Build detail string with file sizes
        let mut detail = String::from("Done");
        if let (Ok(vid_meta), Ok(gif_meta)) = (fs::metadata(video), fs::metadata(&gif_path)) {
            let vid_mb = vid_meta.len() as f64 / 1024.0 / 1024.0;
            let gif_mb = gif_meta.len() as f64 / 1024.0 / 1024.0;
            detail = format!("{:.1} MB → {:.1} MB", vid_mb, gif_mb);
        }

        if delete_originals {
            if let Err(e) = fs::remove_file(video) {
                detail.push_str(&format!(" (delete failed: {})", e));
            } else {
                detail.push_str(" · deleted original");
            }
        }

        converted += 1;

        let _ = app.emit(
            "conversion-progress",
            ProgressPayload {
                file_name,
                status: "done".to_string(),
                detail,
                current,
                total,
                progress: 100,
            },
        );
    }

    Ok(ConvertResult { converted, total })
}

fn truncate_end(s: &str, max_len: usize) -> String {
    let trimmed = s.trim();
    if trimmed.len() <= max_len {
        trimmed.to_string()
    } else {
        trimmed[trimmed.len() - max_len..].to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![convert_videos])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
