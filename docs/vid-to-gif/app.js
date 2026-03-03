const { FFmpeg } = FFmpegWASM;
const { fetchFile, toBlobURL } = FFmpegUtil;

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

const sourceFpsEl = document.getElementById("source-fps");
const useSourceFpsCheckbox = document.getElementById("use-source-fps");

let selectedFiles = [];
let ffmpeg = null;
let aborted = false;
let detectedFps = null;

// When checkbox is toggled on and we already have a detected FPS, apply it
useSourceFpsCheckbox.addEventListener("change", () => {
  if (useSourceFpsCheckbox.checked && detectedFps) {
    fpsInput.value = Math.round(detectedFps);
  }
});

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

  detectedFps = null;
  sourceFpsEl.classList.add("hidden");

  fileListPreview.innerHTML = selectedFiles
    .map((f) => `<div class="file-entry">${f.name} (${formatSize(f.size)})</div>`)
    .join("");
  fileListPreview.classList.remove("hidden");
  convertBtn.disabled = false;
}

async function loadFFmpeg() {
  if (ffmpeg) return;

  loadingEl.classList.remove("hidden");
  loadingEl.textContent = "Loading ffmpeg (~25 MB, first time only)...";

  try {
    ffmpeg = new FFmpeg();

    ffmpeg.on("log", ({ message }) => {
      // Match only the stream info line, e.g.:
      // "Stream #0:0: Video: h264 ... 25 fps"
      // Avoid matching encoding speed lines like "fps= 45.2"
      const match = message.match(/Stream\s+#.*Video:.*\b(\d+(?:\.\d+)?)\s*fps/);
      if (match && !detectedFps) {
        detectedFps = parseFloat(match[1]);
        sourceFpsEl.textContent = `(source: ${detectedFps} fps)`;
        sourceFpsEl.classList.remove("hidden");
        if (useSourceFpsCheckbox.checked) {
          fpsInput.value = Math.round(detectedFps);
        }
      }
    });

    ffmpeg.on("progress", ({ progress }) => {
      if (currentItemEl && currentPhase === "gif") {
        const pct = Math.round(Math.max(0, Math.min(progress, 1)) * 100);
        const statusEl = currentItemEl.querySelector(".status");
        const fillEl = currentItemEl.querySelector(".fill");
        statusEl.textContent = `Creating GIF... ${pct}%`;
        fillEl.style.width = `${pct}%`;
      }
    });

    const coreURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
    const ffmpegURL = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${coreURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${coreURL}/ffmpeg-core.wasm`, "application/wasm"),
      classWorkerURL: await toBlobURL(`${ffmpegURL}/814.ffmpeg.js`, "text/javascript"),
    });
  } catch (err) {
    loadingEl.textContent = `Failed to load ffmpeg: ${err.message}`;
    loadingEl.style.color = "#f44336";
    ffmpeg = null;
    throw err;
  }

  loadingEl.classList.add("hidden");
}

let currentItemEl = null;
let currentPhase = "";

convertBtn.addEventListener("click", async () => {
  if (selectedFiles.length === 0) return;

  const width = parseInt(widthInput.value) || 1080;

  convertBtn.disabled = true;
  abortBtn.classList.remove("hidden");
  aborted = false;
  resultsEl.innerHTML = "";
  summaryEl.classList.add("hidden");
  summaryEl.style.color = "";
  progressArea.classList.remove("hidden");

  try {
    await loadFFmpeg();
  } catch {
    convertBtn.disabled = false;
    abortBtn.classList.add("hidden");
    return;
  }

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

      const statusEl = item.querySelector(".status");
      const fillEl = item.querySelector(".fill");

      // Pass 1: palette — also triggers FPS detection from stream info logs
      currentPhase = "palette";
      detectedFps = null;
      statusEl.textContent = "Generating palette...";
      fillEl.classList.add("pulse");

      // Use a temporary filter for palette pass (FPS not critical here)
      const paletteFps = parseInt(fpsInput.value) || 15;
      await ffmpeg.exec([
        "-i", "input",
        "-vf", `fps=${paletteFps},scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff`,
        "-y", "palette.png",
      ]);

      if (aborted) break;

      // Read FPS after detection — use the (potentially updated) input value
      const fps = parseInt(fpsInput.value) || 15;
      const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;

      // Pass 2: GIF (progress events work here)
      currentPhase = "gif";
      statusEl.textContent = "Creating GIF... 0%";
      fillEl.classList.remove("pulse");
      fillEl.style.width = "0%";
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

      statusEl.textContent = `${formatSize(file.size)} → ${formatSize(blob.size)}`;
      statusEl.className = "status done";
      fillEl.classList.remove("pulse");
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
      const errStatusEl = item.querySelector(".status");
      const errFillEl = item.querySelector(".fill");
      errStatusEl.textContent = aborted ? "Aborted" : `Failed: ${err.message}`;
      errStatusEl.className = "status error";
      errFillEl.classList.remove("pulse");
      errFillEl.style.width = "100%";
      errFillEl.style.background = "#f44336";
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
  if (ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null;
  }
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
