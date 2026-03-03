const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const actions = document.getElementById("actions");
const copyRichBtn = document.getElementById("copy-rich");
const copyPlainBtn = document.getElementById("copy-plain");
const downloadBtn = document.getElementById("download-doc");
const toast = document.getElementById("toast");
const preview = document.getElementById("preview");
const previewContent = document.getElementById("preview-content");
const errorEl = document.getElementById("error");

let cleanHtml = "";
let plainText = "";
let fileName = "";

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
  if (e.dataTransfer.files.length > 0) {
    processFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    processFile(fileInput.files[0]);
  }
});

async function processFile(file) {
  errorEl.classList.add("hidden");
  preview.classList.add("hidden");
  actions.classList.add("hidden");

  fileName = file.name.replace(/\.[^.]+$/, "");

  if (file.name.toLowerCase().endsWith(".doc") && !file.name.toLowerCase().endsWith(".docx")) {
    showError(
      'Legacy .doc format is not supported. Please open the file in Word and save as .docx first (File → Save As → .docx).'
    );
    return;
  }

  if (!file.name.toLowerCase().endsWith(".docx")) {
    showError("Please upload a .docx file.");
    return;
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });

    cleanHtml = result.value;
    plainText = htmlToPlainText(cleanHtml);

    if (result.messages.length > 0) {
      console.log("Mammoth warnings:", result.messages);
    }

    previewContent.innerHTML = cleanHtml;
    preview.classList.remove("hidden");
    actions.classList.remove("hidden");
  } catch (err) {
    showError(`Failed to process file: ${err.message}`);
  }
}

function htmlToPlainText(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || div.innerText || "";
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2000);
}

// Copy formatted text (rich text — preserves bold, italic, links)
copyRichBtn.addEventListener("click", async () => {
  try {
    const blob = new Blob([cleanHtml], { type: "text/html" });
    const textBlob = new Blob([plainText], { type: "text/plain" });
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": blob,
        "text/plain": textBlob,
      }),
    ]);
    showToast("Formatted text copied!");
  } catch {
    // Fallback: select preview content
    const range = document.createRange();
    range.selectNodeContents(previewContent);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("copy");
    sel.removeAllRanges();
    showToast("Copied!");
  }
});

// Copy plain text
copyPlainBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(plainText);
    showToast("Plain text copied!");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = plainText;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    showToast("Copied!");
  }
});

// Download as .doc (HTML wrapped in Word-compatible format)
downloadBtn.addEventListener("click", () => {
  const docContent = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>body { font-family: Calibri, sans-serif; font-size: 11pt; line-height: 1.5; }</style>
</head><body>${cleanHtml}</body></html>`;

  const blob = new Blob([docContent], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileName}-clean.doc`;
  a.click();
  URL.revokeObjectURL(url);
});
