# Vid to GIF

Desktop app that converts video files to high-quality GIFs using ffmpeg's two-pass palette method. No dependencies needed — just download, install, and run.

## Install

1. Go to the [latest Actions build](../../actions) and download the artifact for your platform:
   - **Mac (Apple Silicon):** `macos-aarch64-apple-darwin` → open the `.dmg`, drag to Applications
   - **Mac (Intel):** `macos-x86_64-apple-darwin`
   - **Windows:** `windows-x64` → run the `.msi` installer
2. Launch "Vid to GIF"

## Usage

1. Click **Select Folder** and pick a folder containing videos
2. Adjust **Width** and **FPS** if needed (defaults: 1080px, 15fps)
3. Check **Delete originals after conversion** if you want source files removed
4. Click **Convert** and watch the progress

Output GIFs are saved in the same folder as the source videos.

### Supported formats

`.mp4` `.avi` `.mov` `.mkv` `.webm` `.wmv` `.flv` `.m4v`

## Development

Requires [Rust](https://rustup.rs) and [Node.js](https://nodejs.org).

```
npm install
cargo tauri dev
```

Production builds run via GitHub Actions on push to `main`.
