// pdf_viewer.js
// Multi-page PDF viewer + region drawing + vector/OCR extraction + templates + JSON/CSV export
// ============================================================
// EXTRACTION MODES
// ============================================================

// Vector extraction toggle (OCR-only when false)
const ENABLE_VECTOR_EXTRACTION = false;

const DOCUMENT_DETAILS = ["prepared_by", "project_id"];

const REGION_TYPES = [
  "sheet_id",
  "description",
  "issue_id",
  "date",
  "issue_description",
];

const fileInput = document.getElementById("file-input");
const canvas = document.getElementById("pdf-canvas");
const ctx = canvas.getContext("2d");

const sidebar = document.getElementById("sidebar");
const pageIndicator = document.getElementById("page-indicator");

const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");

const pdfScroll = document.getElementById("pdf-scroll");
const overlay = document.getElementById("overlay");

const regionTypeSelect = document.getElementById("region-type");
const drawTypeSwatch = document.getElementById("draw-type-swatch");

const preparedByInput = document.getElementById("prepared-by");
const projectIdInput = document.getElementById("project-id");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ============================================================
   STATE
   ============================================================ */

let TEMPLATE_MASTER_PAGE = null;

let pdfDoc = null;
let currentPage = 1;
let scale = 1.5;

let pdfFileBaseName = "pdf_extracted_data";

const documentDetails = {
  prepared_by: "",
  project_id: "",
};

const sheetDetailsByPage = {}; // { [pageNum]: { field: value } }
const regionsByPage = {}; // { [pageNum]: [ {id,type,x,y,w,h} ] }

const regionTemplates = {}; // { [fieldType]: {type,x,y,w,h} }

let selectedRegionIds = [];
let selectedRegionId = null; // legacy mirror of selection (last selected)
let clipboardRegions = [];
let clipboardBase = null; // {minX, minY} of copied group
let clipboardPasteSerial = 0;
let regionIdCounter = 1;

/* ============================================================
   OCR WORKER (robust)
   ============================================================ */

let ocrWorkerPromise = null;

async function getOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;

  if (!window.Tesseract?.createWorker) {
    throw new Error(
      "Tesseract.createWorker not available (is tesseract.js loaded?)"
    );
  }

  const workerOptions = {
    workerPath: "https://unpkg.com/tesseract.js@5.0.4/dist/worker.min.js",
    corePath:
      "https://unpkg.com/tesseract.js-core@5.0.0/tesseract-core-simd.wasm.js",
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
  };

  ocrWorkerPromise = (async () => {
    let worker;

    // Try v5 signature first (eng, numWorkers, options)
    try {
      worker = await Tesseract.createWorker("eng", 1, workerOptions);
      return worker;
    } catch (_) {
      // Fall back to classic signature (options) then load/init
    }

    worker = await Tesseract.createWorker(workerOptions);
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    return worker;
  })();

  return ocrWorkerPromise;
}

/* ============================================================
   INIT UI
   ============================================================ */

(function initRegionTypeSelect() {
  if (!regionTypeSelect) return;

  regionTypeSelect.innerHTML = "";

  const ogDoc = document.createElement("optgroup");
  ogDoc.label = "DOCUMENT_DETAILS";

  DOCUMENT_DETAILS.forEach((type) => {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = type;
    ogDoc.appendChild(opt);
  });

  const ogSheet = document.createElement("optgroup");
  ogSheet.label = "REGION_TYPES";

  REGION_TYPES.forEach((type) => {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = type;
    ogSheet.appendChild(opt);
  });

  regionTypeSelect.appendChild(ogDoc);
  regionTypeSelect.appendChild(ogSheet);

  // Keep the draw-type colour swatch in sync with the current selection
  function syncDrawTypeSwatch() {
    if (!drawTypeSwatch) return;
    drawTypeSwatch.setAttribute("data-swatch", regionTypeSelect.value);
  }
  regionTypeSelect.addEventListener("change", syncDrawTypeSwatch);
  syncDrawTypeSwatch();
})();

/* ============================================================
   LOAD PDF
   ============================================================ */

fileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  // Base name for exports: PDF filename (without extension)
  pdfFileBaseName =
    (file.name || "pdf_extracted_data").replace(/\.[^.]+$/, "") ||
    "pdf_extracted_data";

  // Reset state for new PDF
  pdfDoc = null;
  currentPage = 1;
  scale = 1.5;
  selectedRegionIds = [];
  selectedRegionId = null;
  regionIdCounter = 1;

  for (const k of Object.keys(documentDetails)) documentDetails[k] = "";
  for (const k of Object.keys(sheetDetailsByPage)) delete sheetDetailsByPage[k];
  for (const k of Object.keys(regionsByPage)) delete regionsByPage[k];
  for (const k of Object.keys(regionTemplates)) delete regionTemplates[k];

  if (preparedByInput) preparedByInput.value = "";
  if (projectIdInput) projectIdInput.value = "";

  const reader = new FileReader();
  reader.onload = async () => {
    const data = new Uint8Array(reader.result);
    pdfDoc = await pdfjsLib.getDocument(data).promise;
    await buildThumbnails();
    await renderPage(1);
  };
  reader.readAsArrayBuffer(file);
});

/* ============================================================
   MANUAL OVERRIDES (document fields)
   ============================================================ */

preparedByInput?.addEventListener("input", () => {
  documentDetails.prepared_by = preparedByInput.value || "";
});

projectIdInput?.addEventListener("input", () => {
  documentDetails.project_id = projectIdInput.value || "";
});

/* ============================================================
   RENDER PAGE
   ============================================================ */

async function renderPage(pageNum) {
  if (!pdfDoc) return;

  currentPage = pageNum;
  selectedRegionIds = [];
  selectedRegionId = null;

  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  overlay.setAttribute("width", viewport.width);
  overlay.setAttribute("height", viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  if (pageIndicator) {
    pageIndicator.textContent = `Page ${currentPage} / ${pdfDoc.numPages}`;
  }

  highlightActiveThumb();
  redrawRegions();
}

/* ============================================================
   ZOOM BUTTONS
   ============================================================ */

zoomInBtn?.addEventListener("click", () => {
  scale *= 1.1;
  renderPage(currentPage);
});

zoomOutBtn?.addEventListener("click", () => {
  scale /= 1.1;
  renderPage(currentPage);
});

/* ============================================================
   THUMBNAILS
   ============================================================ */

async function buildThumbnails() {
  if (!pdfDoc || !sidebar) return;

  sidebar.innerHTML = "";

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 0.2 });

    const c = document.createElement("canvas");
    c.width = viewport.width;
    c.height = viewport.height;
    c.classList.add("thumb");

    await page.render({ canvasContext: c.getContext("2d"), viewport }).promise;

    c.addEventListener("click", () => renderPage(i));
    sidebar.appendChild(c);
  }

  highlightActiveThumb();
}

function highlightActiveThumb() {
  document.querySelectorAll(".thumb").forEach((t, i) =>
    t.classList.toggle("active", i + 1 === currentPage)
  );
}

/* ============================================================
   REGION DRAWING + SELECTION
   ============================================================ */

let isDrawing = false;
let startX = 0;
let startY = 0;
let activeRect = null;

// --- Drag-move selected regions (Enhancement/1 Step 3)
let isDraggingRegions = false;
let dragStartPx = { x: 0, y: 0 };
let dragHasMoved = false;
let dragClickShouldToggleOff = false; // only for single-select re-click
let dragStartById = new Map(); // id -> {x,y,w,h}

function getOverlayPoint(evt) {
  const r = overlay.getBoundingClientRect();
  return { x: evt.clientX - r.left, y: evt.clientY - r.top };
}

function beginRegionDrag(evt, clickShouldToggleOff) {
  if (!overlay) return;

  isDraggingRegions = true;
  dragHasMoved = false;
  dragClickShouldToggleOff = !!clickShouldToggleOff;
  dragStartPx = getOverlayPoint(evt);

  // Snapshot starting positions for all selected regions (normalized)
  dragStartById = new Map();
  const regs = regionsByPage[currentPage] || [];
  const sel = new Set(selectedRegionIds);
  regs.forEach((r) => {
    if (sel.has(r.id)) {
      dragStartById.set(r.id, { x: r.x, y: r.y, w: r.w, h: r.h });
    }
  });

  // Track move/end even if pointer leaves the overlay
  window.addEventListener("mousemove", onRegionDragMove, true);
  window.addEventListener("mouseup", onRegionDragEnd, true);
}

function onRegionDragMove(evt) {
  if (!isDraggingRegions) return;
  if (!canvas.width || !canvas.height) return;

  const p = getOverlayPoint(evt);
  const dxPx = p.x - dragStartPx.x;
  const dyPx = p.y - dragStartPx.y;

  if (!dragHasMoved && (Math.abs(dxPx) > 2 || Math.abs(dyPx) > 2)) {
    dragHasMoved = true;
  }

  let dx = dxPx / canvas.width;
  let dy = dyPx / canvas.height;

  // Clamp as a GROUP so relative spacing is preserved.
  let minDx = -Infinity, maxDx = Infinity;
  let minDy = -Infinity, maxDy = Infinity;

  dragStartById.forEach(({ x, y, w, h }) => {
    minDx = Math.max(minDx, -x);
    maxDx = Math.min(maxDx, (1 - w) - x);
    minDy = Math.max(minDy, -y);
    maxDy = Math.min(maxDy, (1 - h) - y);
  });

  dx = Math.min(Math.max(dx, minDx), maxDx);
  dy = Math.min(Math.max(dy, minDy), maxDy);

  const regs = regionsByPage[currentPage] || [];
  const byId = new Map(regs.map(r => [r.id, r]));

  dragStartById.forEach((s, id) => {
    const r = byId.get(id);
    if (!r) return;
    r.x = s.x + dx;
    r.y = s.y + dy;
  });

  redrawRegions();
}

function onRegionDragEnd() {
  if (!isDraggingRegions) return;

  window.removeEventListener("mousemove", onRegionDragMove, true);
  window.removeEventListener("mouseup", onRegionDragEnd, true);

  const shouldToggleOff = dragClickShouldToggleOff && !dragHasMoved;

  isDraggingRegions = false;
  dragClickShouldToggleOff = false;
  dragStartById = new Map();

  if (shouldToggleOff) {
    clearSelection();
  }

  if (dragHasMoved) {
    const movedTypes = [...new Set(getSelectedRegionsOnCurrentPage().map((r) => r.type))].filter((t) => REGION_TYPES.includes(t));
    invalidateSheetFields(currentPage, movedTypes);
  }

  redrawRegions();
}


overlay?.addEventListener("mousedown", (e) => {
  // Click on an existing region selects/drag-moves it (handled by rect listener)
  if (e.target?.tagName === "rect") return;
  if (isDraggingRegions) return;

  isDrawing = true;
  selectedRegionIds = [];
  selectedRegionId = null;

  const r = overlay.getBoundingClientRect();
  startX = e.clientX - r.left;
  startY = e.clientY - r.top;

  activeRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  overlay.appendChild(activeRect);
});

overlay?.addEventListener("mousemove", (e) => {
  if (isDraggingRegions) return; // drag handled on window
  if (!isDrawing || !activeRect) return;

  const r = overlay.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;

  activeRect.setAttribute("x", Math.min(startX, x));
  activeRect.setAttribute("y", Math.min(startY, y));
  activeRect.setAttribute("width", Math.abs(x - startX));
  activeRect.setAttribute("height", Math.abs(y - startY));
});

overlay?.addEventListener("mouseup", () => {
  if (isDraggingRegions) return; // drag handled on window
  if (!isDrawing || !activeRect) return;
  isDrawing = false;

  const w = +activeRect.getAttribute("width");
  const h = +activeRect.getAttribute("height");

  if (w < 2 || h < 2) {
    activeRect.remove();
    activeRect = null;
    return;
  }

  const region = {
    id: regionIdCounter++,
    type: regionTypeSelect?.value || REGION_TYPES[0],
    x: +activeRect.getAttribute("x") / canvas.width,
    y: +activeRect.getAttribute("y") / canvas.height,
    w: w / canvas.width,
    h: h / canvas.height,
  };

  if (!regionsByPage[currentPage]) regionsByPage[currentPage] = [];
  regionsByPage[currentPage].push(region);

  // If this is a sheet field, invalidate cached extraction for this page+field.
  if (REGION_TYPES.includes(region.type)) {
    invalidateSheetField(currentPage, region.type);
  }

  activeRect = null;
  redrawRegions();
});

function redrawRegions() {
  if (!overlay) return;

  overlay.innerHTML = "";

  const pageRegions = regionsByPage[currentPage] || [];

  // 1) Draw real (page-specific) regions
  pageRegions.forEach((r) => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", r.x * canvas.width);
    rect.setAttribute("y", r.y * canvas.height);
    rect.setAttribute("width", r.w * canvas.width);
    rect.setAttribute("height", r.h * canvas.height);

    rect.dataset.id = String(r.id);
    rect.dataset.type = r.type;

    if (selectedRegionIds.includes(r.id)) rect.classList.add("selected");

    rect.addEventListener("mousedown", (e) => {
      e.stopPropagation();

      // Multi-select toggle (no drag)
      if (e.shiftKey) {
        toggleSelection(r.id);
        redrawRegions();
        return;
      }

      // Record click intent BEFORE any selection changes
      const preWasSelected = selectedRegionIds.includes(r.id);
      const preWasSingleSame = (selectedRegionIds.length === 1 && selectedRegionIds[0] === r.id);
      const preWasMulti = selectedRegionIds.length > 1;

      // Click behaviour:
      // - if clicking an UNSELECTED region, switch to single-select (and drag that)
      // - if clicking a SELECTED region, preserve selection so multi-select can drag as a group
      if (!preWasSelected) {
        setSingleSelection(r.id);
        redrawRegions();
        beginRegionDrag(e, false);
        return;
      }

      if (preWasMulti) {
        // Keep the multi-selection intact; dragging any selected member moves the group.
        beginRegionDrag(e, false);
        redrawRegions();
        return;
      }

      // preWasSingleSame: click again should toggle OFF unless user drags
      // We defer the toggle-off to mouseup if there was no drag movement.
      // Start drag tracking either way.
      beginRegionDrag(e, preWasSingleSame);
      redrawRegions();
    });

    overlay.appendChild(rect);
  });

  // 2) Draw ghost template regions (only where no override exists on this page)
  Object.values(regionTemplates).forEach((tpl) => {
    const hasOverrideOnThisPage = pageRegions.some((r) => r.type === tpl.type);
    if (hasOverrideOnThisPage) return;

    const ghost = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    ghost.setAttribute("x", tpl.x * canvas.width);
    ghost.setAttribute("y", tpl.y * canvas.height);
    ghost.setAttribute("width", tpl.w * canvas.width);
    ghost.setAttribute("height", tpl.h * canvas.height);

    ghost.dataset.type = tpl.type;     // 👈 inherit field colour
    ghost.setAttribute("fill", "none");
    ghost.setAttribute("stroke-width", "1");
    ghost.setAttribute("stroke-dasharray", "6 4");
    ghost.setAttribute("opacity", "0.45");
    ghost.style.pointerEvents = "none";

    overlay.appendChild(ghost);
  });
}

/* ============================================================
   HELPERS
   ============================================================ */

function invalidateSheetField(pageNum, field) {
  if (!sheetDetailsByPage[pageNum]) return;
  if (Object.prototype.hasOwnProperty.call(sheetDetailsByPage[pageNum], field)) {
    delete sheetDetailsByPage[pageNum][field];
  }
}

function invalidateSheetFields(pageNum, fields) {
  if (!fields || !fields.length) return;
  fields.forEach((f) => invalidateSheetField(pageNum, f));
}

// If a MASTER template changes geometry for a field, clear cached values for that
// field on all pages so applyTemplatesToAllPages() will re-extract correctly.
function invalidateSheetFieldAcrossAllPages(field) {
  if (!pdfDoc || !field) return;
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    invalidateSheetField(p, field);
  }
}


function syncLegacySelectedId() {
  selectedRegionId =
    selectedRegionIds.length > 0
      ? selectedRegionIds[selectedRegionIds.length - 1]
      : null;
}

function setSingleSelection(id) {
  selectedRegionIds = [id];
  syncLegacySelectedId();
}

function toggleSelection(id) {
  const idx = selectedRegionIds.indexOf(id);
  if (idx >= 0) {
    selectedRegionIds.splice(idx, 1);
  } else {
    selectedRegionIds.push(id);
  }
  syncLegacySelectedId();
}

function clearSelection() {
  selectedRegionIds = [];
  selectedRegionId = null;
}

function isEditableTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function clamp01(v) {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function getSelectedRegionsOnCurrentPage() {
  const regions = regionsByPage[currentPage] || [];
  if (!selectedRegionIds.length) return [];
  const sel = new Set(selectedRegionIds);
  return regions.filter((r) => sel.has(r.id));
}

function copySelectionToClipboard() {
  const regs = getSelectedRegionsOnCurrentPage();
  if (!regs.length) return false;

  const minX = Math.min(...regs.map((r) => r.x));
  const minY = Math.min(...regs.map((r) => r.y));

  clipboardBase = { minX, minY };
  clipboardRegions = regs.map((r) => ({
    type: r.type,
    dx: r.x - minX,
    dy: r.y - minY,
    w: r.w,
    h: r.h,
  }));

  clipboardPasteSerial = 0;
  console.log(`📋 Copied ${clipboardRegions.length} region(s)`);
  return true;
}

function pasteClipboardToCurrentPage() {
  if (!clipboardRegions.length || !clipboardBase) return false;

  // Nudge each paste so it’s visible
  clipboardPasteSerial += 1;
  const nudgePx = 10 * clipboardPasteSerial;
  const nudgeX = canvas.width ? nudgePx / canvas.width : 0.01;
  const nudgeY = canvas.height ? nudgePx / canvas.height : 0.01;

  const baseX = clipboardBase.minX + nudgeX;
  const baseY = clipboardBase.minY + nudgeY;

  if (!regionsByPage[currentPage]) regionsByPage[currentPage] = [];

  const newIds = [];

  clipboardRegions.forEach((it) => {
    const id = regionIdCounter++;

    let x = baseX + it.dx;
    let y = baseY + it.dy;

    // keep within page bounds
    x = clamp01(x);
    y = clamp01(y);
    x = Math.min(x, 1 - it.w);
    y = Math.min(y, 1 - it.h);

    regionsByPage[currentPage].push({
      id,
      type: it.type,
      x,
      y,
      w: it.w,
      h: it.h,
    });

    newIds.push(id);
  });

  selectedRegionIds = newIds;
  syncLegacySelectedId();
  const changedTypes = [...new Set(clipboardRegions.map((r) => r.type))].filter((t) => REGION_TYPES.includes(t));
  invalidateSheetFields(currentPage, changedTypes);
  redrawRegions();

  console.log(`📋 Pasted ${newIds.length} region(s) onto page ${currentPage}`);
  return true;
}
function getMostRecentRegionOfType(pageNum, type) {
  const regions = regionsByPage[pageNum] || [];
  for (let i = regions.length - 1; i >= 0; i--) {
    if (regions[i].type === type) return regions[i];
  }
  return null;
}

function resolveRegionForPage(pageNum, type) {
  const pageRegions = regionsByPage[pageNum] || [];
  const override = [...pageRegions].reverse().find((r) => r.type === type);
  if (override) return override;
  if (regionTemplates[type]) return regionTemplates[type];
  return null;
}

function promoteRegionToTemplate(region) {
  if (!region || !region.type) return;

  const prev = regionTemplates[region.type];
  const next = {
    type: region.type,
    x: region.x,
    y: region.y,
    w: region.w,
    h: region.h,
  };

  // Detect geometry change (tiny epsilon to avoid noise)
  const EPS = 1e-9;
  const changed =
    !prev ||
    Math.abs((prev.x ?? 0) - next.x) > EPS ||
    Math.abs((prev.y ?? 0) - next.y) > EPS ||
    Math.abs((prev.w ?? 0) - next.w) > EPS ||
    Math.abs((prev.h ?? 0) - next.h) > EPS;

  regionTemplates[region.type] = next;

  // Critical: if the master template changed, cached per-page values must be
  // cleared so Apply Templates re-extracts for all pages using the new region.
  if (changed && typeof invalidateSheetFieldAcrossAllPages === "function") {
    invalidateSheetFieldAcrossAllPages(region.type);
  }

  console.log(`📐 Template set for "${region.type}"`, regionTemplates[region.type]);
}

/* ============================================================
   VECTOR EXTRACTION (kept, but OCR is used in Extract All)
   ============================================================ */

async function extractVectorTextFromRegion(pageNum, region) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const textContent = await page.getTextContent();

  const xMin = region.x * viewport.width;
  const yMin = region.y * viewport.height;
  const xMax = xMin + region.w * viewport.width;
  const yMax = yMin + region.h * viewport.height;

  const strings = [];

  textContent.items.forEach((item) => {
    const [, , , , tx, ty] = pdfjsLib.Util.transform(
      viewport.transform,
      item.transform
    );

    if (tx >= xMin && tx <= xMax && ty >= yMin && ty <= yMax) {
      strings.push(item.str);
    }
  });

  return strings.join(" ").replace(/\s+/g, " ").trim();
}

/* ============================================================
   OCR EXTRACTION
   ============================================================ */

async function extractOCRFromRegion(pageNum, region) {
  const page = await pdfDoc.getPage(pageNum);

  const OCR_SCALE = 3.0;
  const viewport = page.getViewport({ scale: OCR_SCALE });

  const offCanvas = document.createElement("canvas");
  offCanvas.width = viewport.width;
  offCanvas.height = viewport.height;

  await page.render({
    canvasContext: offCanvas.getContext("2d"),
    viewport,
  }).promise;

  const crop = document.createElement("canvas");
  crop.width = Math.max(1, Math.round(region.w * offCanvas.width));
  crop.height = Math.max(1, Math.round(region.h * offCanvas.height));

  crop.getContext("2d").drawImage(
    offCanvas,
    region.x * offCanvas.width,
    region.y * offCanvas.height,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height
  );

  const worker = await getOcrWorker();
  const blob = await new Promise((res) => crop.toBlob(res, "image/png"));
  const { data } = await worker.recognize(blob);

  return (data.text || "").replace(/\s+/g, " ").trim();
}

/* ============================================================
   APPLY TEMPLATES TO ALL PAGES (Step 3)
   ============================================================ */

async function applyTemplatesToAllPages(logProgress = false) {
  if (!pdfDoc) return;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    if (logProgress)
      console.log(`📐 Extracting page ${pageNum} / ${pdfDoc.numPages}`);
    if (!sheetDetailsByPage[pageNum]) sheetDetailsByPage[pageNum] = {};

    for (const field of REGION_TYPES) {
      if (sheetDetailsByPage[pageNum][field]) continue;

      const region = resolveRegionForPage(pageNum, field);
      if (!region) continue;

      let extracted = "";

      if (ENABLE_VECTOR_EXTRACTION) {
      extracted = await extractVectorTextFromRegion(pageNum, region);
      }

      if (!extracted) {
      extracted = await extractOCRFromRegion(pageNum, region);
}

      sheetDetailsByPage[pageNum][field] = extracted || "";
    }
  }

  console.log("✅ Templates applied to all pages");
}

window.applyTemplatesToAllPages = applyTemplatesToAllPages;

/* ============================================================
   EXTRACT ALL (single button)
   - OCR-first (vector is still used as fallback in applyTemplates)
   ============================================================ */

async function extractAll() {
  if (!pdfDoc) return alert("No PDF loaded");

  console.log(`🚀 Extract started (${pdfDoc.numPages} pages)`);

  // 1) Document fields (once, from current page)
  for (const field of DOCUMENT_DETAILS) {
    const region = getMostRecentRegionOfType(currentPage, field);
    if (!region) {
      console.warn(`⚠️ No region drawn for document field: ${field}`);
      continue;
    }

    let extracted = await extractOCRFromRegion(currentPage, region);
    extracted = (extracted || "").trim();

    documentDetails[field] = extracted;

    if (field === "prepared_by" && preparedByInput) preparedByInput.value = extracted;
    if (field === "project_id" && projectIdInput) projectIdInput.value = extracted;

    console.log(`📄 Document field (${field}) →`, extracted || "<empty>");
  }

  // 2) Sheet fields on current page (promote to templates)
  for (const field of REGION_TYPES) {
    const region = getMostRecentRegionOfType(currentPage, field);
    if (!region) continue;

    let extracted = await extractOCRFromRegion(currentPage, region);
    extracted = (extracted || "").trim();

    if (!sheetDetailsByPage[currentPage]) sheetDetailsByPage[currentPage] = {};
    sheetDetailsByPage[currentPage][field] = extracted;

    // promoteRegionToTemplate(region);

    if (TEMPLATE_MASTER_PAGE === null) {
      TEMPLATE_MASTER_PAGE = currentPage;
    }

    if (currentPage === TEMPLATE_MASTER_PAGE) {
      promoteRegionToTemplate(region);
    }

    console.log(`📄 Sheet field (master) (${field}) →`, extracted || "<empty>");
  }

  // 3) Apply templates to all pages (progress in console)
  await applyTemplatesToAllPages(true);

  console.log("✅ Extract All complete");
}

window.extractAll = extractAll;

/* ============================================================
   DELETE / COPY / PASTE (multi-select)
   ============================================================ */

window.addEventListener("keydown", (e) => {
  // Don’t hijack shortcuts while typing in inputs
  if (isEditableTarget(document.activeElement)) return;

  const modKey = e.ctrlKey || e.metaKey;

  // Copy
  if (modKey && (e.key === "c" || e.key === "C")) {
    if (selectedRegionIds.length) {
      copySelectionToClipboard();
      e.preventDefault();
    }
    return;
  }

  // Cut
  if (modKey && (e.key === "x" || e.key === "X")) {
    if (selectedRegionIds.length) {
      const didCopy = copySelectionToClipboard();
      if (didCopy) {
        const regions = regionsByPage[currentPage] || [];
        const sel = new Set(selectedRegionIds);
        regionsByPage[currentPage] = regions.filter((r) => !sel.has(r.id));
        const cutTypes = [...new Set(clipboardRegions.map((r) => r.type))].filter((t) => REGION_TYPES.includes(t));
        invalidateSheetFields(currentPage, cutTypes);
        clearSelection();
        redrawRegions();
        console.log(`✂️ Cut ${clipboardRegions.length} region(s) from page ${currentPage}`);
      }
      e.preventDefault();
    }
    return;
  }



  // Paste
  if (modKey && (e.key === "v" || e.key === "V")) {
    if (clipboardRegions.length) {
      pasteClipboardToCurrentPage();
      e.preventDefault();
    }
    return;
  }

  // Delete selection
  if (e.key === "Delete" || e.key === "Backspace") {
    if (!selectedRegionIds.length) return;

    const regions = regionsByPage[currentPage] || [];
    const sel = new Set(selectedRegionIds);
    const deletedTypes = [...new Set(regions.filter((r) => sel.has(r.id)).map((r) => r.type))].filter((t) => REGION_TYPES.includes(t));
    regionsByPage[currentPage] = regions.filter((r) => !sel.has(r.id));

    invalidateSheetFields(currentPage, deletedTypes);

    clearSelection();
    redrawRegions();
    e.preventDefault();
  }
});


/* ============================================================
   WHEEL: zoom + pan (zoom-to-cursor)
   ============================================================ */

pdfScroll?.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();

    // Disable shift behaviour (reserved / buggy)
    if (e.shiftKey) return;

    const PAN_SPEED = 3;
    const ZOOM_FACTOR = 1.1;

    // Ctrl + wheel → horizontal pan
    if (e.ctrlKey) {
      pdfScroll.scrollLeft += e.deltaY * PAN_SPEED;
      return;
    }

    // Alt + wheel → vertical pan
    if (e.altKey) {
      pdfScroll.scrollTop += e.deltaY * PAN_SPEED;
      return;
    }

    // Normal wheel → zoom to cursor
    const rect = pdfScroll.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const px = (pdfScroll.scrollLeft + mx) / scale;
    const py = (pdfScroll.scrollTop + my) / scale;

    scale *= e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
    scale = Math.min(Math.max(scale, 0.3), 5);

    renderPage(currentPage);

    requestAnimationFrame(() => {
      pdfScroll.scrollLeft = px * scale - mx;
      pdfScroll.scrollTop = py * scale - my;
    });
  },
  { passive: false }
);

/* ============================================================
   EXPORT: canonical shape (document + sheets[])
   ============================================================ */

function getCanonicalExportData() {
  const doc = {
    prepared_by: (documentDetails.prepared_by || "").trim(),
    project_id: (documentDetails.project_id || "").trim(),
  };

  const sheets = [];
  const numPages = pdfDoc?.numPages || 0;

  for (let p = 1; p <= numPages; p++) {
    const s = sheetDetailsByPage[p] || {};
    sheets.push({
      page: p,
      sheet_id: (s.sheet_id || "").trim(),
      description: (s.description || "").trim(),
      issue_id: (s.issue_id || "").trim(),
      date: (s.date || "").trim(),
      issue_description: (s.issue_description || "").trim(),
    });
  }

  return { document: doc, sheets };
}

window.exportExtractedData = async function () {
  if (typeof applyTemplatesToAllPages === "function") {
    await applyTemplatesToAllPages(true);
  }
  const data = getCanonicalExportData();
  console.log(JSON.stringify(data, null, 2));
  return data;
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

window.downloadJSON = async function () {
  if (typeof applyTemplatesToAllPages === "function") {
    await applyTemplatesToAllPages(true);
  }
  const data = getCanonicalExportData();
  const json = JSON.stringify(data, null, 2);
  downloadBlob(new Blob([json], { type: "application/json" }), `${pdfFileBaseName}.json`);
  console.log("⬇️ JSON exported", `${pdfFileBaseName}.json`);
};

window.downloadCSV = async function () {
  if (typeof applyTemplatesToAllPages === "function") {
    await applyTemplatesToAllPages(true);
  }

  const { document, sheets } = getCanonicalExportData();

  const headers = [
    "prepared_by",
    "project_id",
    "page",
    "sheet_id",
    "description",
    "issue_id",
    "date",
    "issue_description",
  ];

  const rows = sheets.map((s) => [
    document.prepared_by,
    document.project_id,
    s.page,
    s.sheet_id,
    s.description,
    s.issue_id,
    s.date,
    s.issue_description,
  ]);

  const csv = [
    headers.join(","),
    ...rows.map((r) =>
      r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")
    ),
  ].join("\n");

  downloadBlob(new Blob([csv], { type: "text/csv" }), `${pdfFileBaseName}.csv`);
  console.log("⬇️ CSV exported", `${pdfFileBaseName}.csv`);
};