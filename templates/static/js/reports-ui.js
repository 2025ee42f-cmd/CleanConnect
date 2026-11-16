// reports-ui.js — shared rendering helpers for report cards, status pills,
// workflow timeline, and the full-screen photo viewer.
// Used by reports.html, crew.html and admin.html.

const STATUS_ORDER = ["Submitted", "In Progress", "Resolved", "Verified"];
const BADGE_CLASS = {
  Submitted: "badge-submitted",
  "In Progress": "badge-inprogress",
  Resolved: "badge-resolved",
  Verified: "badge-verified",
};

function statusBadge(status) {
  return `<span class="badge ${BADGE_CLASS[status] || ""}">${CC.escapeHtml(status)}</span>`;
}

function renderTimeline(report) {
  return `
    <div class="timeline">
      ${STATUS_ORDER.map((s, i) => {
        const idx = STATUS_ORDER.indexOf(report.status);
        const done = idx >= i;
        return `${i > 0 ? '<span class="timeline-arrow">→</span>' : ""}<span class="timeline-step ${done ? "done" : ""}">${s}</span>`;
      }).join("")}
    </div>
  `;
}

function photoIndicator(label, hasPhoto) {
  return `<span class="photo-indicator">${hasPhoto ? "📷" : "🚫"} ${CC.escapeHtml(label)}${hasPhoto ? "" : " — none"}</span>`;
}

function renderReportCard(report, actionsHtml = "") {
  const photos = [];
  if (report.beforePhoto) photos.push(`<img class="photo-thumb" src="${report.beforePhoto}" alt="Before photo" data-photo-view="true" data-photo-label="Before photo">`);
  if (report.afterPhoto) photos.push(`<img class="photo-thumb" src="${report.afterPhoto}" alt="After photo" data-photo-view="true" data-photo-label="After-cleaning photo">`);

  return `
    <div class="glass card report-card" data-report-id="${report.id}">
      <div class="report-card-head">
        <div>
          <div class="report-issue">${CC.escapeHtml(report.issueType)}</div>
        </div>
        ${statusBadge(report.status)}
      </div>
      <p class="report-desc">${CC.escapeHtml(report.description)}</p>
      <div class="report-meta">
        <span>📍 ${CC.escapeHtml(report.location)}</span>
        <span>🙋 ${CC.escapeHtml(report.reportedBy?.name || "")}</span>
        <span>🕒 ${CC.timeAgo(report.createdAt)}</span>
        ${report.assignedCrew ? `<span>🧹 ${CC.escapeHtml(report.assignedCrew.name)}</span>` : ""}
      </div>
      <div class="photo-row">
        ${photoIndicator("Before photo", !!report.beforePhoto)}
        ${photoIndicator("After photo", !!report.afterPhoto)}
      </div>
      ${photos.length ? `<div class="photo-row">${photos.join("")}</div>` : ""}
      ${renderTimeline(report)}
      ${actionsHtml ? `<div class="report-actions">${actionsHtml}</div>` : ""}
    </div>
  `;
}

function ensurePhotoViewer() {
  if (document.getElementById("photoViewerBackdrop")) return;
  const el = document.createElement("div");
  el.id = "photoViewerBackdrop";
  el.className = "photo-viewer-backdrop";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = `
    <div class="photo-viewer" role="document">
      <button type="button" class="photo-viewer-close" id="photoViewerClose" aria-label="Close photo viewer">&times;</button>
      <div class="photo-viewer-caption" id="photoViewerCaption">Photo</div>
      <img class="photo-viewer-image" id="photoViewerImage" alt="Expanded report photo">
      <div class="photo-viewer-controls" aria-label="Photo zoom controls">
        <button type="button" id="photoZoomOut" aria-label="Zoom out">−</button>
        <button type="button" id="photoZoomReset" aria-label="Reset zoom">100%</button>
        <button type="button" id="photoZoomIn" aria-label="Zoom in">+</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  let zoom = 1;
  const backdrop = el;
  const image = el.querySelector("#photoViewerImage");
  const caption = el.querySelector("#photoViewerCaption");
  const applyZoom = () => {
    image.style.transform = `scale(${zoom})`;
    image.style.transformOrigin = "center center";
    image.style.cursor = zoom > 1 ? "zoom-out" : "zoom-in";
    el.querySelector("#photoZoomReset").textContent = `${Math.round(zoom * 100)}%`;
  };
  const close = () => {
    backdrop.classList.remove("open");
    image.src = "";
    zoom = 1;
    applyZoom();
  };
  const open = (src, label) => {
    image.src = src;
    caption.textContent = label || "Report photo";
    zoom = 1;
    applyZoom();
    backdrop.classList.add("open");
  };

  document.addEventListener("click", (event) => {
    const thumb = event.target.closest("[data-photo-view]");
    if (thumb) open(thumb.currentSrc || thumb.src, thumb.dataset.photoLabel);
  });
  el.querySelector("#photoViewerClose").addEventListener("click", close);
  el.querySelector("#photoZoomIn").addEventListener("click", () => { zoom = Math.min(3, zoom + .25); applyZoom(); });
  el.querySelector("#photoZoomOut").addEventListener("click", () => { zoom = Math.max(.5, zoom - .25); applyZoom(); });
  el.querySelector("#photoZoomReset").addEventListener("click", () => { zoom = 1; applyZoom(); });
  image.addEventListener("click", () => {
    zoom = zoom > 1 ? 1 : 2;
    applyZoom();
  });
  image.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom = Math.max(.5, Math.min(3, zoom + (event.deltaY < 0 ? .1 : -.1)));
    applyZoom();
  }, { passive: false });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && backdrop.classList.contains("open")) close();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ensurePhotoViewer, { once: true });
} else {
  ensurePhotoViewer();
}

window.ReportsUI = { statusBadge, renderTimeline, photoIndicator, renderReportCard, STATUS_ORDER, ensurePhotoViewer };
