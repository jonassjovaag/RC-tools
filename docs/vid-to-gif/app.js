import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile, toBlobURL } from "https://esm.sh/@ffmpeg/util@0.12.1";

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileListPreview = document.getElementById("file-list-preview");
const convertBtn = document.getElementById("convert");
const abortBtn = document.getElementById("abort");
const loadingEl = document.getElementById("loading");
const progressArea = document.getElementById("progress-area");
const resultsEl = document.getElementById("results");
const summaryEl = document.getElementById("summary");
const widthInput = document.getElementById("width");
const fpsInput = document.getElementById("fps");

let selectedFiles = [];
let ffmpeg = null;
let aborted = false;

// Drag and drop
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener("change", () => {
  handleFiles(fileInput.files);
});

function handleFiles(fileList) {
  selectedFiles = Array.from(fileList).filter((f) => f.type.startsWith("video/"));
  if (selectedFiles.length === 0) return;

  fileListPreview.innerHTML = selectedFiles
    .map((f) => `<div class="file-entry">${f.name} (${formatSize(f.size)})</div>`)
    .join("");
  fileListPreview.classList.remove("hidden");
  convertBtn.disabled = false;
}

async function loadFFmpeg() {
  if (ffmpeg) return;

  loadingEl.classList.remove("hidden");
  ffmpeg = new FFmpeg();

  ffmpeg.on("progress", ({ progress }) => {
    if (currentItemEl) {
      const pct = Math.round(Math.max(0, Math.min(progress, 1)) * 100);
      const statusEl = currentItemEl.querySelector(".status");
      const fillEl = currentItemEl.querySelector(".fill");
      statusEl.textContent = `Converting... ${pct}%`;
      fillEl.style.width = `${pct}%`;
    }
  });

  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });

  loadingEl.classList.add("hidden");
}

let currentItemEl = null;

convertBtn.addEventListener("click", async () => {
  if (selectedFiles.length === 0) return;

  const width = parseInt(widthInput.value) || 1080;
  const fps = parseInt(fpsInput.value) || 15;

  convertBtn.disabled = true;
  abortBtn.classList.remove("hidden");
  aborted = false;
  resultsEl.innerHTML = "";
  summaryEl.classList.add("hidden");
  summaryEl.style.color = "";
  progressArea.classList.remove("hidden");

  await loadFFmpeg();

  const total = selectedFiles.length;
  let converted = 0;

  for (let i = 0; i < selectedFiles.length; i++) {
    if (aborted) break;

    const file = selectedFiles[i];
    const gifName = file.name.replace(/\.[^.]+$/, ".gif");
    const current = i + 1;

    // Create progress item
    const item = document.createElement("div");
    item.className = "file-item";
    item.innerHTML = `
      <div class="filename">[${current}/${total}] ${file.name}</div>
      <div class="status converting">Converting... 0%</div>
      <div class="progress-bar"><div class="fill" style="width: 0%"></div></div>
    `;
    resultsEl.appendChild(item);
    currentItemEl = item;

    try {
      // Write input file to ffmpeg virtual filesystem
      await ffmpeg.writeFile("input", await fetchFile(file));

      const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;

      // Pass 1: palette
      await ffmpeg.exec([
        "-i", "input",
        "-vf", `${filters},palettegen=stats_mode=diff`,
        "-y", "palette.png",
      ]);

      if (aborted) break;

      // Pass 2: GIF
      await ffmpeg.exec([
        "-i", "input",
        "-i", "palette.png",
        "-lavfi", `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`,
        "-y", "output.gif",
      ]);

      if (aborted) break;

      // Read output and create download link
      const data = await ffmpeg.readFile("output.gif");
      const blob = new Blob([data.buffer], { type: "image/gif" });
      const url = URL.createObjectURL(blob);

      const statusEl = item.querySelector(".status");
      const fillEl = item.querySelector(".fill");
      statusEl.textContent = `${formatSize(file.size)} → ${formatSize(blob.size)}`;
      statusEl.className = "status done";
      fillEl.style.width = "100%";

      const link = document.createElement("a");
      link.href = url;
      link.download = gifName;
      link.textContent = `Download ${gifName}`;
      link.className = "download-link";
      item.appendChild(link);

      converted++;

      // Cleanup virtual filesystem
      await ffmpeg.deleteFile("input");
      await ffmpeg.deleteFile("palette.png");
      await ffmpeg.deleteFile("output.gif");
    } catch (err) {
      const statusEl = item.querySelector(".status");
      const fillEl = item.querySelector(".fill");
      statusEl.textContent = aborted ? "Aborted" : `Failed: ${err.message}`;
      statusEl.className = "status error";
      fillEl.style.width = "100%";
      fillEl.style.background = "#f44336";
    }
  }

  currentItemEl = null;

  if (aborted) {
    summaryEl.textContent = `Aborted — ${converted}/${total} converted`;
    summaryEl.style.color = "#ff9800";
  } else {
    summaryEl.textContent = `Done: ${converted}/${total} converted`;
  }
  summaryEl.classList.remove("hidden");

  convertBtn.disabled = false;
  abortBtn.classList.add("hidden");
  abortBtn.disabled = false;
  abortBtn.textContent = "Abort";
});

abortBtn.addEventListener("click", () => {
  aborted = true;
  abortBtn.disabled = true;
  abortBtn.textContent = "Aborting...";
  // Terminate ffmpeg execution
  if (ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null; // Will be reloaded on next convert
  }
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
