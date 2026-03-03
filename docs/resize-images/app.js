const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileListPreview = document.getElementById("file-list-preview");
const resizeBtn = document.getElementById("resize");
const progressArea = document.getElementById("progress-area");
const resultsEl = document.getElementById("results");
const summaryEl = document.getElementById("summary");
const dpiInput = document.getElementById("dpi");
const qualityInput = document.getElementById("quality");
const qualityVal = document.getElementById("quality-val");
const upscaleCheckbox = document.getElementById("upscale");

let selectedFiles = [];

// Quality slider label
qualityInput.addEventListener("input", () => {
  qualityVal.textContent = qualityInput.value;
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
  selectedFiles = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  if (selectedFiles.length === 0) return;

  fileListPreview.innerHTML =
    `<div class="file-entry" style="color:#888;margin-bottom:0.25rem">${selectedFiles.length} image${selectedFiles.length > 1 ? "s" : ""} selected</div>` +
    selectedFiles
      .map((f) => `<div class="file-entry">${f.name} (${formatSize(f.size)})</div>`)
      .join("");
  fileListPreview.classList.remove("hidden");
  resizeBtn.disabled = false;
}

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality / 100);
  });
}

function setJpegDpi(jpegArrayBuffer, dpi) {
  const view = new DataView(jpegArrayBuffer);
  // Verify JPEG SOI marker
  if (view.getUint16(0) !== 0xffd8) return jpegArrayBuffer;
  // Verify JFIF APP0 marker
  if (view.getUint16(2) !== 0xffe0) return jpegArrayBuffer;
  // APP0 data starts at byte 4, header length at 4-5, then "JFIF\0" at 6-10
  // Byte 11: density unit (1 = DPI)
  // Bytes 12-13: X density
  // Bytes 14-15: Y density
  view.setUint8(11, 1);
  view.setUint16(12, dpi, false);
  view.setUint16(14, dpi, false);
  return jpegArrayBuffer;
}

resizeBtn.addEventListener("click", async () => {
  if (selectedFiles.length === 0) return;

  const mode = getMode();
  const dpi = parseInt(dpiInput.value) || 150;
  const quality = parseInt(qualityInput.value) || 90;
  const allowUpscale = upscaleCheckbox.checked;

  resizeBtn.disabled = true;
  resultsEl.innerHTML = "";
  summaryEl.classList.add("hidden");
  summaryEl.innerHTML = "";
  progressArea.classList.remove("hidden");

  const zip = new JSZip();
  const total = selectedFiles.length;
  let resized = 0;
  let skipped = 0;

  for (let i = 0; i < total; i++) {
    const file = selectedFiles[i];
    const current = i + 1;
    const outName = file.name.replace(/\.[^.]+$/, ".jpg");

    const item = document.createElement("div");
    item.className = "file-item";
    item.innerHTML = `
      <div class="filename">[${current}/${total}] ${file.name}</div>
      <div class="status">Processing...</div>
    `;
    resultsEl.appendChild(item);
    const statusEl = item.querySelector(".status");

    try {
      const img = await loadImage(file);
      const origW = img.naturalWidth;
      const origH = img.naturalHeight;

      let newW, newH;
      if (mode === "height") {
        newH = 1080;
        newW = Math.round((origW / origH) * newH);
      } else {
        newW = 1920;
        newH = Math.round((origH / origW) * newW);
      }

      // Check if upscaling is needed
      const wouldUpscale =
        (mode === "height" && origH < 1080) ||
        (mode === "width" && origW < 1920);

      if (wouldUpscale && !allowUpscale) {
        statusEl.textContent = `Skipped — already ${origW}×${origH}`;
        statusEl.className = "status skipped";
        skipped++;
        URL.revokeObjectURL(img.src);
        continue;
      }

      const canvas = document.createElement("canvas");
      canvas.width = newW;
      canvas.height = newH;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, newW, newH);
      URL.revokeObjectURL(img.src);

      const blob = await canvasToJpegBlob(canvas, quality);
      const buf = await blob.arrayBuffer();
      setJpegDpi(buf, dpi);

      zip.file(outName, buf);
      resized++;
      statusEl.textContent = `${origW}×${origH} → ${newW}×${newH} (${formatSize(buf.byteLength)})`;
      statusEl.className = "status done";
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.className = "status error";
    }
  }

  // Generate ZIP
  if (resized > 0) {
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    summaryEl.innerHTML = `Done: ${resized} resized, ${skipped} skipped<br/>
      <a href="${url}" download="resized-images.zip" class="download-link">Download ZIP (${formatSize(zipBlob.size)})</a>`;
  } else {
    summaryEl.textContent = `No images resized (${skipped} skipped)`;
  }

  summaryEl.classList.remove("hidden");
  resizeBtn.disabled = false;
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
