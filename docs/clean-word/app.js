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
    cleanHtml = await convertDocx(arrayBuffer);
    plainText = htmlToPlainText(cleanHtml);

    previewContent.innerHTML = cleanHtml;
    preview.classList.remove("hidden");
    actions.classList.remove("hidden");
  } catch (err) {
    showError(`Failed to process file: ${err.message}`);
  }
}

// ─── DOCX to HTML Converter ────────────────────────────────────

async function convertDocx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);

  const docXml = await readXml(zip, "word/document.xml");
  const stylesXml = await readXml(zip, "word/styles.xml");
  const relsXml = await readXml(zip, "word/_rels/document.xml.rels");
  const numXml = await readXml(zip, "word/numbering.xml");

  if (!docXml) throw new Error("No document.xml found in .docx");

  const ctx = {
    styles: buildStyles(stylesXml),
    rels: buildRels(relsXml),
    numDefs: buildNumbering(numXml),
  };

  const body = docXml.querySelector("body");
  if (!body) throw new Error("No document body found");

  return convertBody(body, ctx);
}

async function readXml(zip, path) {
  const entry = zip.file(path);
  if (!entry) return null;
  const text = await entry.async("string");
  return parseXml(text);
}

function parseXml(str) {
  // Strip namespace prefixes for simpler querying
  str = str.replace(/<(\/?)\w+:/g, "<$1");
  str = str.replace(/\s\w+:(\w+)=/g, " $1=");
  str = str.replace(/\sxmlns(:\w+)?="[^"]*"/g, "");
  return new DOMParser().parseFromString(str, "text/xml");
}

// ─── Style Resolution ──────────────────────────────────────────

function buildStyles(doc) {
  const map = {};
  if (!doc) return map;

  for (const el of doc.querySelectorAll("style")) {
    const id = el.getAttribute("styleId");
    if (!id) continue;

    map[id] = {
      name: el.querySelector("name")?.getAttribute("val") || id,
      basedOn: el.querySelector("basedOn")?.getAttribute("val"),
      pPr: parseParagraphProps(el.querySelector("pPr")),
      rPr: parseRunProps(el.querySelector("rPr")),
    };
  }

  // Resolve single-level inheritance
  for (const style of Object.values(map)) {
    if (style.basedOn && map[style.basedOn]) {
      const base = map[style.basedOn];
      style.pPr = { ...base.pPr, ...style.pPr };
      style.rPr = { ...base.rPr, ...style.rPr };
    }
  }

  return map;
}

function buildRels(doc) {
  const map = {};
  if (!doc) return map;

  for (const rel of doc.querySelectorAll("Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    const type = rel.getAttribute("Type") || "";
    if (id && target && type.includes("hyperlink")) {
      map[id] = target;
    }
  }

  return map;
}

function buildNumbering(doc) {
  const map = {};
  if (!doc) return map;

  const abstracts = {};
  for (const abs of doc.querySelectorAll("abstractNum")) {
    const id = abs.getAttribute("abstractNumId");
    const levels = {};
    for (const lvl of abs.querySelectorAll("lvl")) {
      const ilvl = lvl.getAttribute("ilvl");
      const numFmt = lvl.querySelector("numFmt")?.getAttribute("val") || "bullet";
      levels[ilvl] = numFmt === "bullet" ? "ul" : "ol";
    }
    abstracts[id] = levels;
  }

  for (const num of doc.querySelectorAll("num")) {
    const numId = num.getAttribute("numId");
    const absId = num.querySelector("abstractNumId")?.getAttribute("val");
    if (numId && absId && abstracts[absId]) {
      map[numId] = abstracts[absId];
    }
  }

  return map;
}

// ─── Property Parsing ──────────────────────────────────────────

function parseParagraphProps(pPr) {
  if (!pPr) return {};
  const p = {};

  const jc = pPr.querySelector("jc");
  if (jc) {
    const val = jc.getAttribute("val");
    if (val === "both") p.textAlign = "justify";
    else if (val && val !== "left" && val !== "start") p.textAlign = val;
  }

  const spacing = pPr.querySelector("spacing");
  if (spacing) {
    const before = spacing.getAttribute("before");
    const after = spacing.getAttribute("after");
    const line = spacing.getAttribute("line");
    const lineRule = spacing.getAttribute("lineRule");

    if (before && parseInt(before) > 0) p.marginTop = `${(parseInt(before) / 20).toFixed(1)}pt`;
    if (after) p.marginBottom = `${(parseInt(after) / 20).toFixed(1)}pt`;
    if (line) {
      if (lineRule === "exact" || lineRule === "atLeast") {
        p.lineHeight = `${(parseInt(line) / 20).toFixed(1)}pt`;
      } else {
        // "auto" mode: value is in 240ths of a line
        const ratio = parseInt(line) / 240;
        if (Math.abs(ratio - 1.0) > 0.05) p.lineHeight = ratio.toFixed(2);
      }
    }
  }

  const ind = pPr.querySelector("ind");
  if (ind) {
    const left = ind.getAttribute("left") || ind.getAttribute("start");
    if (left && parseInt(left) > 0) p.marginLeft = `${(parseInt(left) / 20).toFixed(1)}pt`;
  }

  return p;
}

function parseRunProps(rPr) {
  if (!rPr) return {};
  const r = {};
  const isOn = (el) => el && el.getAttribute("val") !== "false" && el.getAttribute("val") !== "0";

  if (isOn(rPr.querySelector("b"))) r.bold = true;
  if (isOn(rPr.querySelector("i"))) r.italic = true;

  const u = rPr.querySelector("u");
  if (u && u.getAttribute("val") !== "none") r.underline = true;

  if (isOn(rPr.querySelector("strike"))) r.strike = true;

  const sz = rPr.querySelector("sz");
  if (sz) r.fontSize = `${parseInt(sz.getAttribute("val")) / 2}pt`;

  const color = rPr.querySelector("color");
  if (color) {
    const val = color.getAttribute("val");
    if (val && val !== "auto" && val.toLowerCase() !== "000000") r.color = `#${val}`;
  }

  const vert = rPr.querySelector("vertAlign");
  if (vert) r.vertAlign = vert.getAttribute("val");

  return r;
}

// ─── HTML Generation ───────────────────────────────────────────

function convertBody(body, ctx) {
  let html = "";
  let listStack = [];

  for (const child of body.children) {
    if (child.tagName === "p") {
      const pPr = child.querySelector(":scope > pPr");
      const numPr = pPr?.querySelector("numPr");
      const numId = numPr?.querySelector("numId")?.getAttribute("val");

      if (numPr && numId && numId !== "0") {
        const ilvl = parseInt(numPr.querySelector("ilvl")?.getAttribute("val") || "0");
        const listType = ctx.numDefs[numId]?.[ilvl] || "ul";

        // Close deeper nesting levels
        while (listStack.length > ilvl + 1) {
          html += `</${listStack.pop()}>`;
        }

        // Open new levels
        while (listStack.length <= ilvl) {
          html += `<${listType}>`;
          listStack.push(listType);
        }

        html += `<li>${convertParagraphContent(child, ctx)}</li>`;
      } else {
        // Close all open lists
        while (listStack.length > 0) {
          html += `</${listStack.pop()}>`;
        }
        html += convertParagraph(child, ctx);
      }
    } else if (child.tagName === "tbl") {
      while (listStack.length > 0) {
        html += `</${listStack.pop()}>`;
      }
      html += convertTable(child, ctx);
    } else if (child.tagName === "sdt") {
      // Structured document tag — unwrap to get content
      const sdtContent = child.querySelector("sdtContent");
      if (sdtContent) {
        html += convertBody(sdtContent, ctx);
      }
    }
  }

  while (listStack.length > 0) {
    html += `</${listStack.pop()}>`;
  }

  return html;
}

function convertParagraph(p, ctx) {
  const pPr = p.querySelector(":scope > pPr");
  const styleId = pPr?.querySelector("pStyle")?.getAttribute("val");
  const style = styleId ? ctx.styles[styleId] : null;

  // Determine HTML tag
  let tag = "p";
  const styleName = (style?.name || "").toLowerCase();
  const headingMatch = styleName.match(/heading\s*(\d)/);
  if (headingMatch) {
    tag = `h${Math.min(parseInt(headingMatch[1]), 6)}`;
  } else if (styleName === "title") {
    tag = "h1";
  } else if (styleName === "subtitle") {
    tag = "h2";
  }

  // Merge formatting: named style + inline overrides
  // Skip "Normal" style defaults — let the target editor's styles apply
  const isNormal = !styleId || styleId === "Normal";
  const stylePpr = isNormal ? {} : (style?.pPr || {});
  const inlinePpr = parseParagraphProps(pPr);
  const fmt = { ...stylePpr, ...inlinePpr };

  // Build inline CSS
  const css = [];
  if (fmt.textAlign) css.push(`text-align: ${fmt.textAlign}`);
  if (fmt.marginTop) css.push(`margin-top: ${fmt.marginTop}`);
  if (fmt.marginBottom) css.push(`margin-bottom: ${fmt.marginBottom}`);
  if (fmt.lineHeight) css.push(`line-height: ${fmt.lineHeight}`);
  if (fmt.marginLeft) css.push(`margin-left: ${fmt.marginLeft}`);
  const styleAttr = css.length ? ` style="${css.join("; ")}"` : "";

  const content = convertParagraphContent(p, ctx);
  if (!content.trim()) return "";

  return `<${tag}${styleAttr}>${content}</${tag}>`;
}

function convertParagraphContent(p, ctx) {
  let content = "";
  for (const child of p.childNodes) {
    if (child.nodeType !== 1) continue;
    if (child.tagName === "r") {
      content += convertRun(child, ctx);
    } else if (child.tagName === "hyperlink") {
      content += convertHyperlink(child, ctx);
    }
  }
  return content;
}

function convertRun(r, ctx) {
  // Collect text content
  const parts = [];
  for (const child of r.childNodes) {
    if (child.nodeType !== 1) continue;
    if (child.tagName === "t") {
      parts.push(escapeHtml(child.textContent));
    } else if (child.tagName === "br") {
      parts.push("<br>");
    } else if (child.tagName === "tab") {
      parts.push("&emsp;");
    }
  }

  let html = parts.join("");
  if (!html) return "";

  // Resolve formatting: character style + inline overrides
  const rPr = r.querySelector(":scope > rPr");
  const styleId = rPr?.querySelector("rStyle")?.getAttribute("val");
  const charStyle = styleId ? ctx.styles[styleId] : null;
  const styleFmt = charStyle?.rPr || {};
  const inlineFmt = parseRunProps(rPr);
  const fmt = { ...styleFmt, ...inlineFmt };

  // Semantic tags
  if (fmt.vertAlign === "superscript") html = `<sup>${html}</sup>`;
  if (fmt.vertAlign === "subscript") html = `<sub>${html}</sub>`;
  if (fmt.bold) html = `<strong>${html}</strong>`;
  if (fmt.italic) html = `<em>${html}</em>`;
  if (fmt.underline) html = `<u>${html}</u>`;
  if (fmt.strike) html = `<s>${html}</s>`;

  // CSS properties (only non-default values)
  const css = [];
  if (fmt.fontSize) css.push(`font-size: ${fmt.fontSize}`);
  if (fmt.color) css.push(`color: ${fmt.color}`);
  if (css.length) {
    html = `<span style="${css.join("; ")}">${html}</span>`;
  }

  return html;
}

function convertHyperlink(link, ctx) {
  const rId = link.getAttribute("id");
  const url = ctx.rels[rId] || "#";

  let content = "";
  for (const child of link.childNodes) {
    if (child.nodeType !== 1) continue;
    if (child.tagName === "r") {
      content += convertRun(child, ctx);
    }
  }

  return `<a href="${escapeHtml(url)}">${content}</a>`;
}

function convertTable(tbl, ctx) {
  let html = "<table>";

  for (const tr of tbl.querySelectorAll(":scope > tr")) {
    html += "<tr>";
    for (const tc of tr.querySelectorAll(":scope > tc")) {
      html += "<td>";
      for (const child of tc.children) {
        if (child.tagName === "p") {
          html += convertParagraph(child, ctx);
        } else if (child.tagName === "tbl") {
          html += convertTable(child, ctx);
        }
      }
      html += "</td>";
    }
    html += "</tr>";
  }

  html += "</table>";
  return html;
}

// ─── Utilities ─────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

// ─── Copy / Download Actions ───────────────────────────────────

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
