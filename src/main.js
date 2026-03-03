import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

const selectFolderBtn = document.getElementById("select-folder");
const folderPathEl = document.getElementById("folder-path");
const widthInput = document.getElementById("width");
const fpsInput = document.getElementById("fps");
const deleteOriginalsInput = document.getElementById("delete-originals");
const convertBtn = document.getElementById("convert");
const abortBtn = document.getElementById("abort");
const progressArea = document.getElementById("progress-area");
const fileList = document.getElementById("file-list");
const summaryEl = document.getElementById("summary");

let selectedFolder = null;
let aborted = false;

selectFolderBtn.addEventListener("click", async () => {
  const folder = await open({ directory: true, multiple: false });
  if (folder) {
    selectedFolder = folder;
    folderPathEl.textContent = folder;
    folderPathEl.style.color = "#e0e0e0";
    convertBtn.disabled = false;
  }
});

convertBtn.addEventListener("click", async () => {
  if (!selectedFolder) return;

  const width = parseInt(widthInput.value) || 1080;
  const fps = parseInt(fpsInput.value) || 15;
  const deleteOriginals = deleteOriginalsInput.checked;

  // Reset UI
  fileList.innerHTML = "";
  summaryEl.classList.add("hidden");
  summaryEl.style.color = "";
  progressArea.classList.remove("hidden");
  convertBtn.disabled = true;
  selectFolderBtn.disabled = true;
  abortBtn.classList.remove("hidden");
  aborted = false;

  // Listen for progress events
  const unlisten = await listen("conversion-progress", (event) => {
    const { fileName, status, detail, current, total, progress } = event.payload;
    updateFileStatus(fileName, status, detail, current, total, progress);
  });

  try {
    const result = await invoke("convert_videos", {
      folder: selectedFolder,
      width,
      fps,
      deleteOriginals,
    });

    if (aborted) {
      summaryEl.textContent = `Aborted — ${result.converted}/${result.total} converted`;
      summaryEl.style.color = "#ff9800";
    } else {
      summaryEl.textContent = `Done: ${result.converted}/${result.total} converted`;
    }
    summaryEl.classList.remove("hidden");
  } catch (err) {
    summaryEl.textContent = `Error: ${err}`;
    summaryEl.style.color = "#f44336";
    summaryEl.classList.remove("hidden");
  } finally {
    unlisten();
    convertBtn.disabled = false;
    selectFolderBtn.disabled = false;
    abortBtn.classList.add("hidden");
    abortBtn.disabled = false;
    abortBtn.textContent = "Abort";
  }
});

abortBtn.addEventListener("click", async () => {
  aborted = true;
  abortBtn.disabled = true;
  abortBtn.textContent = "Aborting...";
  await invoke("abort_conversion");
});

function updateFileStatus(fileName, status, detail, current, total, progress) {
  let item = document.getElementById(`file-${CSS.escape(fileName)}`);

  if (!item) {
    item = document.createElement("div");
    item.className = "file-item";
    item.id = `file-${fileName}`;
    item.innerHTML = `
      <div class="filename">[${current}/${total}] ${fileName}</div>
      <div class="status"></div>
      <div class="progress-bar"><div class="fill" style="width: 0%"></div></div>
    `;
    fileList.appendChild(item);
  }

  const statusEl = item.querySelector(".status");
  const fillEl = item.querySelector(".fill");

  if (status === "converting") {
    const pct = Math.min(progress || 0, 99);
    statusEl.textContent = `Converting... ${pct}%`;
    statusEl.className = "status converting";
    fillEl.style.width = `${pct}%`;
  } else if (status === "done") {
    statusEl.textContent = detail || "Done";
    statusEl.className = "status done";
    fillEl.style.width = "100%";
  } else if (status === "error") {
    statusEl.textContent = detail || "Failed";
    statusEl.className = "status error";
    fillEl.style.width = "100%";
    fillEl.style.background = "#f44336";
  }
}
