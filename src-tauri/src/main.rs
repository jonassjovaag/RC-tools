use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Emitter;
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

        // Emit: converting
        let _ = app.emit(
            "conversion-progress",
            ProgressPayload {
                file_name: file_name.clone(),
                status: "converting".to_string(),
                detail: String::new(),
                current,
                total,
            },
        );

        let gif_path = video.with_extension("gif");
        let palette_path = folder_path.join(format!(".palette_{}.png", i));
        let filters = format!("fps={},scale={}:-1:flags=lanczos", fps, width);

        // Pass 1: generate palette
        let palette_result = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("Failed to create sidecar: {}", e))?
            .args([
                "-i",
                &video.to_string_lossy(),
                "-vf",
                &format!("{},palettegen=stats_mode=diff", filters),
                "-y",
                &palette_path.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(|e| format!("Palette generation failed: {}", e))?;

        if !palette_result.status.success() {
            let stderr = String::from_utf8_lossy(&palette_result.stderr);
            let detail = format!("Palette failed: {}", truncate_end(&stderr, 200));
            let _ = app.emit(
                "conversion-progress",
                ProgressPayload {
                    file_name: file_name.clone(),
                    status: "error".to_string(),
                    detail,
                    current,
                    total,
                },
            );
            let _ = fs::remove_file(&palette_path);
            continue;
        }

        // Pass 2: convert using palette
        let gif_result = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("Failed to create sidecar: {}", e))?
            .args([
                "-i",
                &video.to_string_lossy(),
                "-i",
                &palette_path.to_string_lossy(),
                "-lavfi",
                &format!(
                    "{} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5",
                    filters
                ),
                "-y",
                &gif_path.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(|e| format!("GIF conversion failed: {}", e))?;

        // Clean up palette
        let _ = fs::remove_file(&palette_path);

        if !gif_result.status.success() {
            let stderr = String::from_utf8_lossy(&gif_result.stderr);
            let detail = format!("Convert failed: {}", truncate_end(&stderr, 200));
            let _ = app.emit(
                "conversion-progress",
                ProgressPayload {
                    file_name: file_name.clone(),
                    status: "error".to_string(),
                    detail,
                    current,
                    total,
                },
            );
            continue;
        }

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
