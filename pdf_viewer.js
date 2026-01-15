// pdf_viewer.js
// Field-colour strategy + per-field Extract buttons (minimal changes)

const DOCUMENT_DETAILS = [
  "prepared_by",
  "project_id",
];

const REGION_TYPES = [
  "sheet_id",
  "description",
  "issue_id",
  "date",
  "issue_description"
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
const preparedByInput = document.getElementById("prepared-by");
const projectIdInput = document.getElementById("project-id");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ============================================================
   REGION TEMPLATES (Feature 1 — Step 1)
   ============================================================ */

// One template per sheet-level field (geometry only, normalised)
const regionTemplates = {};

/* ============================================================
   STATE
   ============================================================ */

let pdfDoc = null;
let currentPage = 1;
let scale = 1.5;

const documentDetails = {
  prepared_by: "",
  project_id: ""
};

const sheetDetailsByPage = {};
const regionsByPage = {};
let selectedRegionId = null;
let regionIdCounter = 1;

/* ============================================================
   OCR WORKER (ROBUST, SINGLE INSTANCE)
   ============================================================ */

let ocrWorkerPromise = null;

async function getOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;

  if (!window.Tesseract?.createWorker) {
    throw new Error("Tesseract.createWorker not available");
  }

  const workerOptions = {
    workerPath: "https://unpkg.com/tesseract.js@5.0.4/dist/worker.min.js",
    corePath: "https://unpkg.com/tesseract.js-core@5.0.0/tesseract-core-simd.wasm.js",
    langPath: "https://tessdata.projectnaptha.com/4.0.0"
  };

  ocrWorkerPromise = (async () => {
    let worker = null;
    const errors = [];

    try {
      worker = await Tesseract.createWorker("eng", 1, workerOptions);
      return worker;
    } catch (e) { errors.push(e); }

    try {
      worker = await Tesseract.createWorker("eng", workerOptions);
      return worker;
    } catch (e) { errors.push(e); }

    try {
      worker = await Tesseract.createWorker(workerOptions);
      await worker.loadLanguage("eng");
      await worker.initialize("eng");
      return worker;
    } catch (e) { errors.push(e); }

    try {
      worker = await Tesseract.createWorker();
      await worker.loadLanguage("eng");
      await worker.initialize("eng");
      return worker;
    } catch (e) { errors.push(e); }

    console.error("OCR worker init failed", errors);
    throw errors[errors.length - 1];
  })();

  return ocrWorkerPromise;
}

/* ============================================================
   INIT (populate draw-type dropdown)
   ============================================================ */

(function initRegionTypeSelect() {
  regionTypeSelect.innerHTML = "";

  const ogDoc = document.createElement("optgroup");
  ogDoc.label = "DOCUMENT_DETAILS";
  DOCUMENT_DETAILS.forEach(type => {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = type;
    ogDoc.appendChild(opt);
  });

  const ogSheet = document.createElement("optgroup");
  ogSheet.label = "REGION_TYPES";
  REGION_TYPES.forEach(type => {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = type;
    ogSheet.appendChild(opt);
  });

  regionTypeSelect.appendChild(ogDoc);
  regionTypeSelect.appendChild(ogSheet);
})();

/* ============================================================
   LOAD PDF
   ============================================================ */

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    const data = new Uint8Array(reader.result);
    pdfDoc = await pdfjsLib.getDocument(data).promise;
    await buildThumbnails();
    renderPage(1);
  };
  reader.readAsArrayBuffer(file);
});

/* ============================================================
   DOCUMENT DETAILS (manual override)
   ============================================================ */

preparedByInput.addEventListener("input", () => {
  documentDetails.prepared_by = preparedByInput.value;
});

projectIdInput.addEventListener("input", () => {
  documentDetails.project_id = projectIdInput.value;
});

/* ============================================================
   RENDER PAGE
   ============================================================ */

async function renderPage(pageNum) {
  currentPage = pageNum;
  selectedRegionId = null;

  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  overlay.setAttribute("width", viewport.width);
  overlay.setAttribute("height", viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  pageIndicator.textContent = `Page ${currentPage} / ${pdfDoc.numPages}`;
  highlightActiveThumb();
  redrawRegions();
}

/* ============================================================
   ZOOM
   ============================================================ */

zoomInBtn.onclick = () => {
  scale *= 1.1;
  renderPage(currentPage);
};

zoomOutBtn.onclick = () => {
  scale /= 1.1;
  renderPage(currentPage);
};

/* ============================================================
   THUMBNAILS
   ============================================================ */

async function buildThumbnails() {
  sidebar.innerHTML = "";
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 0.2 });

    const c = document.createElement("canvas");
    c.width = viewport.width;
    c.height = viewport.height;
    c.classList.add("thumb");

    await page.render({ canvasContext: c.getContext("2d"), viewport }).promise;
    c.onclick = () => renderPage(i);
    sidebar.appendChild(c);
  }
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

overlay.addEventListener("mousedown", (e) => {
  if (e.target.tagName === "rect") return;

  isDrawing = true;
  selectedRegionId = null;

  const r = overlay.getBoundingClientRect();
  startX = e.clientX - r.left;
  startY = e.clientY - r.top;

  activeRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  overlay.appendChild(activeRect);
});

overlay.addEventListener("mousemove", (e) => {
  if (!isDrawing || !activeRect) return;

  const r = overlay.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;

  activeRect.setAttribute("x", Math.min(startX, x));
  activeRect.setAttribute("y", Math.min(startY, y));
  activeRect.setAttribute("width", Math.abs(x - startX));
  activeRect.setAttribute("height", Math.abs(y - startY));
});

overlay.addEventListener("mouseup", () => {
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
    type: regionTypeSelect.value,
    x: +activeRect.getAttribute("x") / canvas.width,
    y: +activeRect.getAttribute("y") / canvas.height,
    w: w / canvas.width,
    h: h / canvas.height,
  };

  if (!regionsByPage[currentPage]) regionsByPage[currentPage] = [];
  regionsByPage[currentPage].push(region);

  activeRect = null;
  redrawRegions();
});

function redrawRegions() {
  overlay.innerHTML = "";

  const regions = regionsByPage[currentPage];
  if (!regions) return;

  regions.forEach(r => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", r.x * canvas.width);
    rect.setAttribute("y", r.y * canvas.height);
    rect.setAttribute("width", r.w * canvas.width);
    rect.setAttribute("height", r.h * canvas.height);
    rect.dataset.id = r.id;
    rect.dataset.type = r.type;

    if (r.id === selectedRegionId) rect.classList.add("selected");

    rect.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      selectedRegionId = r.id;
      redrawRegions();
    });

    overlay.appendChild(rect);
  });
}

/* ============================================================
   VECTOR EXTRACTION + FEATURE 1 HELPERS
   ============================================================ */

function getMostRecentRegionOfType(pageNum, type) {
  const regions = regionsByPage[pageNum] || [];
  for (let i = regions.length - 1; i >= 0; i--) {
    if (regions[i].type === type) return regions[i];
  }
  return null;
}

/* ============================================================
   FEATURE 1 HELPERS (templates + overrides)
   ============================================================ */

// Resolve region geometry for a page:
//   1) page-specific override (most recent)
//   2) template
//   3) null
function resolveRegionForPage(pageNum, type) {
  const pageRegions = regionsByPage[pageNum] || [];
  const override = [...pageRegions].reverse().find(r => r.type === type);
  if (override) return override;

  if (regionTemplates[type]) return regionTemplates[type];

  return null;
}

// Promote region geometry to a template (geometry only, normalised).
// Note: this does not affect any existing page-specific overrides.
function promoteRegionToTemplate(region) {
  if (!region || !region.type) return;

  regionTemplates[region.type] = {
    type: region.type,
    x: region.x,
    y: region.y,
    w: region.w,
    h: region.h,
  };

  console.log(`📐 Template set for "${region.type}"`, regionTemplates[region.type]);
}

async function extractVectorTextFromRegion(pageNum, region) {
  const page = await pdfDoc.getPage(pageNum);
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale });

  const xMin = region.x * canvas.width;
  const yMin = region.y * canvas.height;
  const xMax = xMin + region.w * canvas.width;
  const yMax = yMin + region.h * canvas.height;

  const strings = [];

  textContent.items.forEach(item => {
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
   OCR FALLBACK (ACTUALLY FIRES)
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
    viewport
  }).promise;

  const x = region.x * offCanvas.width;
  const y = region.y * offCanvas.height;
  const w = region.w * offCanvas.width;
  const h = region.h * offCanvas.height;

  const crop = document.createElement("canvas");
  crop.width = w;
  crop.height = h;

  crop.getContext("2d").drawImage(offCanvas, x, y, w, h, 0, 0, w, h);

  const worker = await getOcrWorker();

  const blob = await new Promise(resolve =>
    crop.toBlob(resolve, "image/png")
  );

  if (!blob) throw new Error("OCR crop.toBlob() returned null");

  const { data } = await worker.recognize(blob);

  return (data.text || "").replace(/\s+/g, " ").trim();
}

/* ============================================================
   PER-FIELD EXTRACT BUTTONS
   ============================================================ */

document.querySelectorAll("[data-extract-doc]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const field = btn.dataset.extractDoc;
    const region = getMostRecentRegionOfType(currentPage, field);

    if (!region) {
      alert(`No region drawn for ${field}`);
      return;
    }

    let extracted = await extractVectorTextFromRegion(currentPage, region);
    let source = "vector";

    if (!extracted) {
      extracted = await extractOCRFromRegion(currentPage, region);
      source = extracted ? "ocr" : "none";
    }

    documentDetails[field] = extracted;

    if (field === "prepared_by") preparedByInput.value = extracted;
    if (field === "project_id") projectIdInput.value = extracted;

    console.log(`📄 Document extraction (${source}): ${field}`, extracted || "<empty>");
  });
});

document.querySelectorAll("[data-extract-sheet]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const field = btn.dataset.extractSheet;
    const region = getMostRecentRegionOfType(currentPage, field);

    if (!region) {
      alert(`No region drawn for ${field}`);
      return;
    }

    let extracted = await extractVectorTextFromRegion(currentPage, region);
    let source = "vector";

    if (!extracted) {
      extracted = await extractOCRFromRegion(currentPage, region);
      source = extracted ? "ocr" : "none";
    }

    if (!sheetDetailsByPage[currentPage]) sheetDetailsByPage[currentPage] = {};
    sheetDetailsByPage[currentPage][field] = extracted;

    console.log(`📄 Sheet extraction (${source}): page ${currentPage} / ${field}`, extracted || "<empty>");
  });
});

/* ============================================================
   DELETE REGION
   ============================================================ */

window.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && selectedRegionId) {
    const regions = regionsByPage[currentPage];
    if (!regions) return;

    regionsByPage[currentPage] = regions.filter(r => r.id !== selectedRegionId);
    selectedRegionId = null;
    redrawRegions();
    e.preventDefault();
  }
});

/* ============================================================
   WHEEL
   ============================================================ */

pdfScroll.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.shiftKey) return;

  const PAN = 3;
  const ZOOM = 1.1;

  if (e.ctrlKey) {
    pdfScroll.scrollLeft += e.deltaY * PAN;
    return;
  }

  if (e.altKey) {
    pdfScroll.scrollTop += e.deltaY * PAN;
    return;
  }

  const rect = pdfScroll.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const px = (pdfScroll.scrollLeft + mx) / scale;
  const py = (pdfScroll.scrollTop + my) / scale;

  scale *= e.deltaY < 0 ? ZOOM : 1 / ZOOM;
  scale = Math.min(Math.max(scale, 0.3), 5);

  renderPage(currentPage);

  requestAnimationFrame(() => {
    pdfScroll.scrollLeft = px * scale - mx;
    pdfScroll.scrollTop = py * scale - my;
  });
}, { passive: false });

/* ============================================================
   EXPORT JSON
   ============================================================ */

function getExtractedDataAsJSON() {
  const result = { document: {}, sheets: {} };

  DOCUMENT_DETAILS.forEach(field => {
    const v = (documentDetails[field] || "").trim();
    result.document[field] = v || { error: "No value could be extracted" };
  });

  Object.keys(sheetDetailsByPage).forEach(p => {
    result.sheets[p] = {};
    REGION_TYPES.forEach(f => {
      const v = (sheetDetailsByPage[p]?.[f] || "").trim();
      result.sheets[p][f] = v || { error: "No value could be extracted" };
    });
  });

  return result;
}

window.exportExtractedData = function () {
  const data = getExtractedDataAsJSON();
  console.log(JSON.stringify(data, null, 2));
  return data;
};