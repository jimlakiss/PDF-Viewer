// pdf_viewer.js
// Step 2C — Region selection + delete

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
   REGION STATE
   ============================================================ */

const regionsByPage = {}; // { pageNum: [ {id,x,y,w,h}, ... ] }
let selectedRegionId = null;
let regionIdCounter = 1;

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
   REGION DRAWING
   ============================================================ */

overlay.addEventListener("mousedown", (e) => {
  // If clicking existing rect, selection logic handles it
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

  const rx = Math.min(startX, x);
  const ry = Math.min(startY, y);
  const rw = Math.abs(x - startX);
  const rh = Math.abs(y - startY);

  activeRect.setAttribute("x", rx);
  activeRect.setAttribute("y", ry);
  activeRect.setAttribute("width", rw);
  activeRect.setAttribute("height", rh);
});

overlay.addEventListener("mouseup", () => {
  if (!isDrawing || !activeRect) return;

  isDrawing = false;

  const x = +activeRect.getAttribute("x");
  const y = +activeRect.getAttribute("y");
  const w = +activeRect.getAttribute("width");
  const h = +activeRect.getAttribute("height");

  if (w < 2 || h < 2) {
    activeRect.remove();
    activeRect = null;
    return;
  }

  const region = {
    id: regionIdCounter++,
    x: x / canvas.width,
    y: y / canvas.height,
    w: w / canvas.width,
    h: h / canvas.height,
  };

  if (!regionsByPage[currentPage]) regionsByPage[currentPage] = [];
  regionsByPage[currentPage].push(region);

  activeRect = null;
  redrawRegions();
});

/* ============================================================
   REDRAW REGIONS + SELECTION
   ============================================================ */

function redrawRegions() {
  overlay.innerHTML = "";

  const regions = regionsByPage[currentPage];
  if (!regions) return;

  regions.forEach((r) => {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", r.x * canvas.width);
    rect.setAttribute("y", r.y * canvas.height);
    rect.setAttribute("width", r.w * canvas.width);
    rect.setAttribute("height", r.h * canvas.height);
    rect.dataset.id = r.id;

    if (r.id === selectedRegionId) {
      rect.classList.add("selected");
    }

    rect.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      selectedRegionId = r.id;
      redrawRegions();
    });

    overlay.appendChild(rect);
  });
}

/* ============================================================
   DELETE SELECTED REGION
   ============================================================ */

window.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && selectedRegionId) {
    const regions = regionsByPage[currentPage];
    if (!regions) return;

    regionsByPage[currentPage] =
      regions.filter((r) => r.id !== selectedRegionId);

    selectedRegionId = null;
    redrawRegions();
    e.preventDefault();
  }
});

/* ============================================================
   MOUSEWHEEL: PAN + ZOOM (unchanged)
   ============================================================ */

pdfScroll.addEventListener("wheel", (e) => {
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
}, { passive: false });