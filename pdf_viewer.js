// pdf_viewer.js
// Step 2B.b — Region storage + redraw (NO new UI)

const fileInput = document.getElementById("file-input");
const canvas = document.getElementById("pdf-canvas");
const ctx = canvas.getContext("2d");

const sidebar = document.getElementById("sidebar");
const pageIndicator = document.getElementById("page-indicator");

const zoomInBtn = document.getElementById("zoom-in");
const zoomOutBtn = document.getElementById("zoom-out");

const pdfScroll = document.getElementById("pdf-scroll");
const overlay = document.getElementById("overlay");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let pdfDoc = null;
let currentPage = 1;
let scale = 1.5;

/* ============================================================
   REGION STATE (per-page, normalised coords)
   ============================================================ */

const regionsByPage = {}; // { pageNum: [ {x,y,w,h}, ... ] }

/* ============================================================
   DRAWING STATE
   ============================================================ */

let isDrawing = false;
let startX = 0;
let startY = 0;
let activeRect = null;

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
   RENDER PAGE
   ============================================================ */

async function renderPage(pageNum) {
  currentPage = pageNum;

  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  // Keep overlay in sync with canvas pixel space
  overlay.setAttribute("width", viewport.width);
  overlay.setAttribute("height", viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  pageIndicator.textContent = `Page ${currentPage} / ${pdfDoc.numPages}`;
  highlightActiveThumb();

  redrawRegions();
}

/* ============================================================
   ZOOM CONTROLS
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
   REGION DRAWING (RECTANGLES) — works because CSS now allows pointer events
   ============================================================ */

overlay.addEventListener("mousedown", (e) => {
  isDrawing = true;

  const r = overlay.getBoundingClientRect();
  startX = e.clientX - r.left;
  startY = e.clientY - r.top;

  activeRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  activeRect.setAttribute("x", startX);
  activeRect.setAttribute("y", startY);
  activeRect.setAttribute("width", 0);
  activeRect.setAttribute("height", 0);

  overlay.appendChild(activeRect);
});

overlay.addEventListener("mousemove", (e) => {
  if (!isDrawing || !activeRect) return;

  const r = overlay.getBoundingClientRect();
  const currentX = e.clientX - r.left;
  const currentY = e.clientY - r.top;

  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  const w = Math.abs(currentX - startX);
  const h = Math.abs(currentY - startY);

  activeRect.setAttribute("x", x);
  activeRect.setAttribute("y", y);
  activeRect.setAttribute("width", w);
  activeRect.setAttribute("height", h);
});

overlay.addEventListener("mouseup", () => {
  if (!isDrawing || !activeRect) return;

  isDrawing = false;

  const x = parseFloat(activeRect.getAttribute("x"));
  const y = parseFloat(activeRect.getAttribute("y"));
  const w = parseFloat(activeRect.getAttribute("width"));
  const h = parseFloat(activeRect.getAttribute("height"));

  // Ignore accidental clicks (tiny rectangles)
  if (w < 2 || h < 2) {
    activeRect.remove();
    activeRect = null;
    return;
  }

  const region = {
    x: x / canvas.width,
    y: y / canvas.height,
    w: w / canvas.width,
    h: h / canvas.height,
  };

  if (!regionsByPage[currentPage]) regionsByPage[currentPage] = [];
  regionsByPage[currentPage].push(region);

  console.log("📐 Region (normalised):", { page: currentPage, ...region });
  console.log("📦 regionsByPage:", regionsByPage);

  activeRect = null;

  redrawRegions();
});

/* ============================================================
   REDRAW REGIONS (per page)
   ============================================================ */

function redrawRegions() {
  // Clear overlay and redraw all committed regions for this page
  overlay.innerHTML = "";

  const regions = regionsByPage[currentPage];
  if (!regions || regions.length === 0) return;

  for (const r of regions) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", r.x * canvas.width);
    rect.setAttribute("y", r.y * canvas.height);
    rect.setAttribute("width", r.w * canvas.width);
    rect.setAttribute("height", r.h * canvas.height);
    overlay.appendChild(rect);
  }
}

/* ============================================================
   MOUSEWHEEL: PAN + ZOOM
   - Shift disabled (bug guard)
   - Ctrl = horizontal
   - Option/Alt = vertical
   - Otherwise zoom-to-cursor
   NOTE: Listener attached to BOTH pdfScroll and overlay (wheel-safe).
   ============================================================ */

function onWheel(e) {
  e.preventDefault();

  if (e.shiftKey) return;

  const PAN_MULT = 3;
  const zoomFactor = 1.1;

  if (e.ctrlKey) {
    pdfScroll.scrollLeft += e.deltaY * PAN_MULT;
    return;
  }

  if (e.altKey) {
    pdfScroll.scrollTop += e.deltaY * PAN_MULT;
    return;
  }

  const rect = pdfScroll.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const px = (pdfScroll.scrollLeft + mx) / scale;
  const py = (pdfScroll.scrollTop + my) / scale;

  scale *= e.deltaY < 0 ? zoomFactor : 1 / zoomFactor;
  scale = Math.min(Math.max(scale, 0.3), 5);

  renderPage(currentPage);

  requestAnimationFrame(() => {
    pdfScroll.scrollLeft = px * scale - mx;
    pdfScroll.scrollTop = py * scale - my;
  });
}

pdfScroll.addEventListener("wheel", onWheel, { passive: false });
overlay.addEventListener("wheel", onWheel, { passive: false });

/* ============================================================
   PREVENT PAGE KEYS
   ============================================================ */

window.addEventListener("keydown", (e) => {
  const blocked = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"];
  if (blocked.includes(e.key)) e.preventDefault();
});