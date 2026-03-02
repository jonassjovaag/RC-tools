import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

const selectFolderBtn = document.getElementById("select-folder");
const folderPathEl = document.getElementById("folder-path");
const widthInput = document.getElementById("width");
const fpsInput = document.getElementById("fps");
const deleteOriginalsInput = document.getElementById("delete-originals");
const convertBtn = document.getElementById("convert");
const progressArea = document.getElementById("progress-area");
const fileList = document.getElementById("file-list");
const summaryEl = document.getElementById("summary");

let selectedFolder = null;

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
  progressArea.classList.remove("hidden");
  convertBtn.disabled = true;
  selectFolderBtn.disabled = true;

  // Listen for progress events
  const unlisten = await listen("conversion-progress", (event) => {
    const { fileName, status, detail, current, total } = event.payload;
    updateFileStatus(fileName, status, detail, current, total);
  });

  try {
    const result = await invoke("convert_videos", {
      folder: selectedFolder,
      width,
      fps,
      deleteOriginals,
    });

    summaryEl.textContent = `Done: ${result.converted}/${result.total} converted`;
    summaryEl.classList.remove("hidden");
  } catch (err) {
    summaryEl.textContent = `Error: ${err}`;
    summaryEl.style.color = "#f44336";
    summaryEl.classList.remove("hidden");
  } finally {
    unlisten();
    convertBtn.disabled = false;
    selectFolderBtn.disabled = false;
  }
});

function updateFileStatus(fileName, status, detail, current, total) {
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
    statusEl.textContent = "Converting...";
    statusEl.className = "status converting";
    fillEl.style.width = "50%";
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
