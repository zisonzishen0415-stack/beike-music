import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).toString();

const PAGE_SIZE = 72;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

const state = {
  items: [],
  filtered: [],
  visible: PAGE_SIZE,
  query: "",
  sort: "relevance",
  view: "grid",
};

const collator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base", numeric: true });

const el = {
  search: document.getElementById("search"),
  searchForm: document.getElementById("searchbox"),
  clearSearch: document.getElementById("clear-search"),
  sort: document.getElementById("sort"),
  viewToggle: document.getElementById("view-toggle"),
  results: document.getElementById("results"),
  sentinel: document.getElementById("sentinel"),
  worksTitle: document.getElementById("works-title"),
  statCount: document.getElementById("stat-count"),
  viewer: document.getElementById("viewer"),
  viewerShell: document.querySelector(".viewer-shell"),
  viewerTitle: document.getElementById("viewer-title"),
  viewerKicker: document.getElementById("viewer-kicker"),
  viewerDownload: document.getElementById("viewer-download"),
  viewerCopy: document.getElementById("viewer-copy"),
  infoToggle: document.getElementById("info-toggle"),
  stage: document.getElementById("viewer-stage"),
  canvas: document.getElementById("pdf-canvas"),
  image: document.getElementById("image-page"),
  pageLoading: document.getElementById("page-loading"),
  pageInput: document.getElementById("page-input"),
  pageTotal: document.getElementById("page-total"),
  pageStrip: document.getElementById("page-strip"),
  prevPage: document.getElementById("prev-page"),
  nextPage: document.getElementById("next-page"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  zoomLabel: document.getElementById("zoom-label"),
  infoComposer: document.getElementById("info-composer"),
  infoPages: document.getElementById("info-pages"),
  infoSize: document.getElementById("info-size"),
  infoFormat: document.getElementById("info-format"),
  infoSource: document.getElementById("info-source"),
  infoTags: document.getElementById("info-tags"),
  viewTabs: [...document.querySelectorAll("[data-app-view]")],
  libraryView: document.getElementById("library-view"),
  setlistsView: document.getElementById("setlists-view"),
  setlistsList: document.getElementById("setlists-list"),
  setlistIndex: document.getElementById("setlist-index"),
  setlistDetail: document.getElementById("setlist-detail"),
  setlistCount: document.getElementById("setlist-count"),
  newSetlist: document.getElementById("new-setlist"),
  exportSetlists: document.getElementById("export-setlists"),
  importSetlists: document.getElementById("import-setlists"),
  importSetlistsFile: document.getElementById("import-setlists-file"),
  setlistModal: document.getElementById("setlist-modal"),
  setlistForm: document.getElementById("setlist-form"),
  setlistName: document.getElementById("setlist-name"),
  setlistDate: document.getElementById("setlist-date"),
  setlistVenue: document.getElementById("setlist-venue"),
  songPicker: document.getElementById("song-picker"),
  pickerSearch: document.getElementById("picker-search"),
  pickerResults: document.getElementById("picker-results"),
  pickerTabs: [...document.querySelectorAll("[data-picker-tab]")],
  pendingForm: document.getElementById("pending-form"),
  pendingTitle: document.getElementById("pending-title"),
  pendingComposer: document.getElementById("pending-composer"),
  addSetlistModal: document.getElementById("add-setlist-modal"),
  addSetlistList: document.getElementById("add-setlist-list"),
  addSetlistNew: document.getElementById("add-setlist-new"),
  viewerAddSetlist: document.getElementById("viewer-add-setlist"),
  toast: document.getElementById("toast"),
};

let pdfDoc = null;
let pdfLoading = null;
let renderTask = null;
let current = null;
let pageNum = 1;
let zoom = 1;
let imageBaseWidth = 0;
let loadSeq = 0;
let lastFocus = null;

/* ---------- utilities ---------- */

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));

const fold = (value) => String(value ?? "").normalize("NFKC").toLowerCase();
const squash = (value) => fold(value).replace(/[\s\-_.·•、，,。:：;；/\\|()[\]{}（）【】'"]+/g, "");

function tokenize(query) {
  return fold(query).split(/\s+/).map(squash).filter(Boolean);
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${index === 0 || size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function totalPages(item) {
  return Math.max(1, Number(item.pages) || (item.files ? item.files.length : 1) || 1);
}

function highlight(text, query) {
  const source = String(text ?? "");
  const needle = String(query ?? "").trim();
  if (!needle) return escapeHtml(source);
  const index = source.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return escapeHtml(source);
  return (
    escapeHtml(source.slice(0, index)) +
    "<mark>" +
    escapeHtml(source.slice(index, index + needle.length)) +
    "</mark>" +
    escapeHtml(source.slice(index + needle.length))
  );
}

const formatLabel = (item) => (item.format === "pdf" ? "PDF" : "图片");
const formatShort = (item) => (item.format === "pdf" ? "PDF" : "IMG");

/* ---------- URL state ---------- */

function readUrlState() {
  const params = new URLSearchParams(location.search);
  state.query = params.get("q") || "";
  const sort = params.get("sort");
  state.sort = ["relevance", "title", "newest", "largest"].includes(sort) ? sort : "relevance";
  const view = params.get("view");
  state.view = view === "list" || view === "grid" ? view : localStorage.getItem("puji-view") === "list" ? "list" : "grid";
  el.search.value = state.query;
  el.sort.value = state.sort;
  el.clearSearch.hidden = !state.query;
  setViewButtons();
}

function updateUrlState() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.sort !== "relevance") params.set("sort", state.sort);
  if (state.view !== "grid") params.set("view", state.view);
  const search = params.toString();
  history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
}

function setViewButtons() {
  el.viewToggle.querySelectorAll("button").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  el.results.classList.toggle("grid", state.view === "grid");
  el.results.classList.toggle("list", state.view === "list");
}

/* ---------- data ---------- */

function prepareItem(item) {
  item._titleFold = squash(item.title);
  item._composerFold = squash(item.composer);
  item._folderFold = squash([item.category, item.folder, item.instrument, (item.tags || []).join(" ")].join(" "));
  item._py = String(item.search?.py || "").toLowerCase();
  item._pyi = String(item.search?.pyi || "").toLowerCase();
  item._titlePy = String(item.search?.titlePy || "").toLowerCase();
  item._titlePyi = String(item.search?.titlePyi || "").toLowerCase();
  item._titleSimp = squash(item.search?.titleSimp || "");
  item._titleTrad = squash(item.search?.titleTrad || "");
  item._simp = squash(item.search?.simp || "");
  item._trad = squash(item.search?.trad || "");
  item._hay = squash([
    item.title,
    item.composer,
    item.category,
    item.folder,
    item.instrument,
    (item.tags || []).join(" "),
    (item.aliases || []).join(" "),
    item.source,
    item.search?.simp,
    item.search?.trad,
  ].join(" "));
  item._bytes = Number(item.bytes) || 0;
  item._date = Date.parse(item.modified) || 0;
  item._score = 0;
  return item;
}

function scoreItem(item, tokens) {
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    if (item._titleFold === token) best = 1200;
    else if (item._titleFold.startsWith(token)) best = 720;
    else if (item._titleFold.includes(token)) best = 540;
    else if (item._titleSimp.includes(token)) best = 560;
    else if (item._titleTrad.includes(token)) best = 550;
    else if (item._titlePyi.startsWith(token)) best = 470;
    else if (item._titlePy.startsWith(token)) best = 450;
    else if (item._pyi.includes(token)) best = 400;
    else if (item._py.includes(token)) best = 360;
    else if (item._composerFold.includes(token)) best = 280;
    else if (item._folderFold.includes(token)) best = 200;
    else if (item._simp.includes(token) || item._trad.includes(token)) best = 140;
    else if (item._hay.includes(token)) best = 120;
    else return -1;
    total += best;
  }
  if (tokens.length && item._titleFold === tokens.join("")) total += 400;
  return total;
}

function applyFilters() {
  const tokens = tokenize(state.query);
  const list = state.items
    .map((item) => ({ item, score: tokens.length ? scoreItem(item, tokens) : 0 }))
    .filter((entry) => entry.score >= 0);

  const sorters = {
    relevance: (a, b) => (b.score - a.score) || collator.compare(a.item.title, b.item.title),
    title: (a, b) => collator.compare(a.item.title, b.item.title),
    newest: (a, b) => (b.item._date - a.item._date) || collator.compare(a.item.title, b.item.title),
    largest: (a, b) => (b.item._bytes - a.item._bytes) || collator.compare(a.item.title, b.item.title),
  };

  list.sort(sorters[state.sort] || sorters.relevance);
  state.filtered = list.map((entry) => {
    entry.item._score = entry.score;
    return entry.item;
  });
  state.visible = PAGE_SIZE;
  renderResults();
  updateWorksTitle();
  el.statCount.textContent = `${state.filtered.length}`;
  updateUrlState();
}

function updateWorksTitle() {
  el.worksTitle.innerHTML = state.query
    ? "搜索结果 <span>/ SEARCH RESULTS</span>"
    : "全部曲谱 <span>/ ALL WORKS</span>";
}

/* ---------- results ---------- */

function cardMarkup(item) {
  const sub = item.composer || "未标注作者";
  const pages = item.pages ? `${item.pages}P` : "--";

  return `<button class="work-card" type="button" data-id="${escapeHtml(item.id)}" aria-label="预览 ${escapeHtml(item.title)}">
    <span class="work-cover">
      <img src="${escapeHtml(item.thumb)}" alt="" loading="lazy" decoding="async">
      <span class="work-open" aria-hidden="true">OPEN</span>
    </span>
    <span class="work-caption">
      <span class="work-title">${highlight(item.title, state.query)}</span>
      <span class="work-sub">${escapeHtml(sub)}</span>
      <span class="work-meta"><span class="work-fmt">${formatShort(item)}</span><span>${escapeHtml(pages)}</span><span class="work-size">${fmtBytes(item._bytes)}</span></span>
    </span>
  </button>`;
}

function emptyMarkup() {
  if (!state.items.length) {
    return `<div class="state">
      <p class="state-code">NO_DATA</p>
      <h2>曲谱库还是空的</h2>
      <p>点「上传曲谱」把 PDF / 图片传到 GitHub 的 <code>uploads/</code>，Actions 会自动入库并发布，约 1–2 分钟后刷新。</p>
    </div>`;
  }
  return `<div class="state">
    <p class="state-code">NO_RESULTS</p>
    <h2>${state.query ? `没有找到「${escapeHtml(state.query)}」` : "没有可显示的曲谱"}</h2>
    <p>换个歌名、拼音、首字母或歌手片段再试。</p>
    <button type="button" class="state-action" data-action="clear">清空搜索</button>
  </div>`;
}

function attachImageFallbacks() {
  el.results.querySelectorAll(".work-cover img").forEach((image) => {
    image.addEventListener("error", () => {
      image.remove();
      const parent = image.parentElement;
      if (parent && !parent.querySelector(".fallback")) {
        const fallback = document.createElement("span");
        fallback.className = "fallback";
        fallback.textContent = "𝄞";
        fallback.setAttribute("aria-hidden", "true");
        parent.appendChild(fallback);
      }
    }, { once: true });
  });
}

function renderResults() {
  el.results.classList.toggle("grid", state.view === "grid");
  el.results.classList.toggle("list", state.view === "list");
  el.results.setAttribute("aria-busy", "false");

  if (!state.filtered.length) {
    el.results.innerHTML = emptyMarkup();
    el.sentinel.hidden = true;
    return;
  }

  const slice = state.filtered.slice(0, state.visible);
  const listHead = state.view === "list"
    ? `<div class="list-head" aria-hidden="true"><span></span><span>曲名 / TITLE</span><span>作者 / AUTHOR</span><span>页数 · 大小</span></div>`
    : "";
  el.results.innerHTML = listHead + slice.map(cardMarkup).join("");
  el.sentinel.hidden = state.visible >= state.filtered.length;
  attachImageFallbacks();
}

/* ---------- viewer ---------- */

function setHash() {
  if (!current) return;
  const hash = `#s=${encodeURIComponent(current.id)}${pageNum > 1 ? `&p=${pageNum}` : ""}`;
  history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
}

function clearHash() {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function destroyPdf() {
  if (renderTask) {
    try { renderTask.cancel(); } catch { /* already finished */ }
    renderTask = null;
  }
  if (pdfDoc) {
    pdfDoc.destroy();
    pdfDoc = null;
  }
  pdfLoading = null;
}

function fillInfo(item) {
  el.viewerTitle.textContent = item.title;
  el.viewerKicker.textContent = `BEI KE MUSIC / ${item.format === "pdf" ? "PDF SCORE" : "IMAGE SCORE"}`;
  el.infoComposer.textContent = item.composer || "未标注";
  el.infoPages.textContent = `${totalPages(item)} 页`;
  el.infoSize.textContent = fmtBytes(item._bytes);
  el.infoFormat.textContent = formatLabel(item);
  el.infoSource.textContent = item.source || "—";
  el.infoTags.innerHTML = (item.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
}

function renderPageStrip() {
  if (!current) return;
  const total = totalPages(current);
  if (el.pageStrip.dataset.total !== String(total)) {
    el.pageStrip.dataset.total = String(total);
    el.pageStrip.hidden = total <= 1;
    el.pageStrip.innerHTML = Array.from({ length: total }, (_, index) => {
      const page = index + 1;
      return `<button type="button" data-page="${page}" aria-label="第 ${page} 页">${page}</button>`;
    }).join("");
  }
  el.pageStrip.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.page) === pageNum);
  });
  if (el.pageStrip.dataset.active !== String(pageNum)) {
    el.pageStrip.dataset.active = String(pageNum);
    const active = el.pageStrip.querySelector("button.active");
    if (active) {
      el.pageStrip.scrollTo({
        left: active.offsetLeft - el.pageStrip.clientWidth / 2 + active.offsetWidth / 2,
        behavior: "smooth",
      });
    }
  }
}

function updatePageUi() {
  if (!current) return;
  const total = totalPages(current);
  el.pageInput.value = String(pageNum);
  el.pageInput.max = String(total);
  el.pageTotal.textContent = String(total);
  el.prevPage.disabled = pageNum <= 1;
  el.nextPage.disabled = pageNum >= total;
  el.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

  const isImage = current.format === "image";
  const file = isImage ? current.files[pageNum - 1] : current.files[0];
  el.viewerDownload.href = file;
  if (isImage) {
    const extension = (file.split(".").pop() || "jpg").toLowerCase();
    el.viewerDownload.download = `${current.title}-${String(pageNum).padStart(2, "0")}.${extension}`;
  } else {
    el.viewerDownload.download = `${current.title}.pdf`;
  }
  renderPageStrip();
}

function stageInnerSize() {
  const style = getComputedStyle(el.stage);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return {
    width: Math.max(160, el.stage.clientWidth - padX),
    height: Math.max(160, el.stage.clientHeight - padY),
  };
}

async function renderPdfPage(token) {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(pageNum);
  if (token !== loadSeq) return;

  const baseViewport = page.getViewport({ scale: 1 });
  const inner = stageInnerSize();
  const fitScale = Math.min(inner.width / baseViewport.width, inner.height / baseViewport.height);
  const scale = fitScale * zoom;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: scale * dpr });

  el.canvas.width = Math.max(1, Math.floor(viewport.width));
  el.canvas.height = Math.max(1, Math.floor(viewport.height));
  el.canvas.style.width = `${Math.max(1, Math.floor(viewport.width / dpr))}px`;
  el.canvas.style.height = `${Math.max(1, Math.floor(viewport.height / dpr))}px`;

  if (renderTask) {
    try { renderTask.cancel(); } catch { /* already finished */ }
  }
  const context = el.canvas.getContext("2d", { alpha: false });
  renderTask = page.render({ canvasContext: context, viewport });
  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name === "RenderingCancelledException") return;
    throw error;
  }
  if (token !== loadSeq) return;
  el.canvas.hidden = false;
  el.pageLoading.hidden = true;
}

function layoutImage() {
  if (!el.image.naturalWidth) return;
  const inner = stageInnerSize();
  const base = Math.min(
    el.image.naturalWidth,
    inner.width,
    inner.height * el.image.naturalWidth / el.image.naturalHeight
  );
  imageBaseWidth = base;
  el.image.style.width = `${Math.round(base * zoom)}px`;
  el.image.style.height = "auto";
}

async function loadCurrent() {
  if (!current) return;
  const token = ++loadSeq;
  el.pageLoading.hidden = false;
  el.pageLoading.textContent = "载入中…";
  el.canvas.hidden = true;
  el.image.hidden = true;
  el.image.removeAttribute("src");

  if (current.format === "pdf") {
    try {
      if (!pdfDoc) {
        pdfLoading = pdfjsLib.getDocument({
          url: current.files[0],
          cMapUrl: new URL("./vendor/cmaps/", import.meta.url).href,
          cMapPacked: true,
          standardFontDataUrl: new URL("./vendor/standard_fonts/", import.meta.url).href,
          wasmUrl: new URL("./vendor/wasm/", import.meta.url).href,
          iccUrl: new URL("./vendor/iccs/", import.meta.url).href,
        });
        pdfDoc = await pdfLoading.promise;
      }
      if (token !== loadSeq) return;
      await renderPdfPage(token);
    } catch (error) {
      if (token !== loadSeq) return;
      showViewerError(error);
    }
  } else {
    const source = current.files[pageNum - 1];
    const image = el.image;
    image.onload = () => {
      if (token !== loadSeq) return;
      el.pageLoading.hidden = true;
      image.hidden = false;
      layoutImage();
    };
    image.onerror = () => {
      if (token !== loadSeq) return;
      showViewerError(new Error("图片载入失败"));
    };
    image.src = source;
  }
}

function showViewerError(error) {
  el.pageLoading.hidden = false;
  el.pageLoading.textContent = "预览失败，请用「下载」打开";
  console.error(error);
}

function goPage(nextPage) {
  if (!current) return;
  const target = clamp(Number(nextPage) || 1, 1, totalPages(current));
  if (target === pageNum) {
    el.pageInput.value = String(pageNum);
    return;
  }
  pageNum = target;
  updatePageUi();
  setHash();
  loadCurrent();
}

function setZoom(nextZoom) {
  zoom = clamp(Math.round(nextZoom * 100) / 100, ZOOM_MIN, ZOOM_MAX);
  updatePageUi();
  if (!current) return;
  if (current.format === "pdf") {
    renderPdfPage(loadSeq).catch(showViewerError);
  } else {
    layoutImage();
  }
}

function openViewer(id, targetPage = 1, trigger = null) {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;

  if (!current || current.id !== item.id) {
    destroyPdf();
    current = item;
    zoom = 1;
    pageNum = clamp(Number(targetPage) || 1, 1, totalPages(item));
    lastFocus = trigger || document.activeElement;
    fillInfo(item);
  } else {
    pageNum = clamp(Number(targetPage) || pageNum, 1, totalPages(item));
  }

  el.viewerShell.classList.remove("show-info");
  el.infoToggle.setAttribute("aria-expanded", "false");
  el.viewer.hidden = false;
  document.body.classList.add("viewer-open");
  updatePageUi();
  setHash();
  loadCurrent();
  el.viewer.querySelector(".viewer-head .icon-btn")?.focus({ preventScroll: true });
}

function closeViewer() {
  if (el.viewer.hidden) return;
  el.viewer.hidden = true;
  document.body.classList.remove("viewer-open");
  el.viewerShell.classList.remove("show-info");
  clearHash();
  destroyPdf();
  current = null;
  if (lastFocus && typeof lastFocus.focus === "function") {
    lastFocus.focus({ preventScroll: true });
  }
  lastFocus = null;
}

/* ---------- setlists ---------- */

const SETLISTS_KEY = "beike-setlists-v1";
const SEEDED_KEY = "beike-setlists-seeded";
const SEED_SONGS = [
  ["孙燕姿", "遇见"],
  ["梁静茹", "宁夏"],
  ["莫文蔚", "这世界那么多人"],
  ["刘若英", "后来"],
  ["田馥甄", "小幸运"],
  ["陈绮贞", "旅行的意义"],
  ["孙燕姿", "我怀念的"],
  ["梁静茹", "暖暖"],
  ["莫文蔚", "慢慢喜欢你"],
  ["周杰伦", "晴天"],
  ["郭采洁", "答案"],
  ["杨丞琳", "雨爱"],
];

const setlistState = {
  items: [],
  currentId: null,
  shared: null,
  appView: "library",
  linkIndex: null,
  pickerTab: "library",
  addScoreId: null,
  newSetlistScoreId: null,
};

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeKey(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\-_.·•、，,。:：;；/\\|()[\]{}（）【】'"]+/g, "");
}

function updateSetlistCount() {
  const count = setlistState.items.length;
  el.setlistCount.textContent = String(count);
  el.setlistCount.hidden = count === 0;
}

function loadSetlists() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETLISTS_KEY) || "[]");
    if (!Array.isArray(parsed)) return;
    setlistState.items = parsed
      .filter((sl) => sl && typeof sl.id === "string" && typeof sl.name === "string" && Array.isArray(sl.items))
      .map((sl) => ({
        ...sl,
        items: sl.items.filter((it) => it && (it.kind === "score" || it.kind === "pending")),
      }));
  } catch (error) {
    console.warn("读取歌单失败", error);
  }
  updateSetlistCount();
}

function saveSetlists() {
  try {
    localStorage.setItem(SETLISTS_KEY, JSON.stringify(setlistState.items));
  } catch (error) {
    toast("歌单保存失败，可能是浏览器存储已满");
    console.error(error);
  }
  updateSetlistCount();
}

function currentSetlist() {
  if (setlistState.shared) return setlistState.shared;
  return setlistState.items.find((sl) => sl.id === setlistState.currentId) || null;
}

function setAppView(view) {
  setlistState.appView = view;
  document.body.classList.toggle("app-setlists", view === "setlists");
  el.libraryView.hidden = view !== "library";
  el.setlistsView.hidden = view !== "setlists";
  el.viewTabs.forEach((tab) => {
    const active = tab.dataset.appView === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  if (view === "setlists") {
    const sl = currentSetlist();
    if (sl) renderSetlistDetail();
    else renderSetlistIndex();
  }
}

function renderSetlistIndex() {
  setlistState.currentId = null;
  setlistState.shared = null;
  el.setlistIndex.hidden = false;
  el.setlistDetail.hidden = true;
  el.setlistDetail.innerHTML = "";
  const setlists = setlistState.items.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  if (!setlists.length) {
    el.setlistsList.innerHTML = `<div class="empty-setlists">
      <h2>还没有歌单</h2>
      <p>新建一个演出歌单，把要演的谱子按顺序收进去。</p>
      <button class="btn-dark" type="button" data-empty-new>＋ 新建歌单</button>
    </div>`;
    return;
  }
  el.setlistsList.innerHTML = setlists.map(setlistCardMarkup).join("");
}

function setlistCardMarkup(sl) {
  const scoreCount = sl.items.filter((it) => it.kind === "score").length;
  const pendingCount = sl.items.length - scoreCount;
  const date = sl.date || "未定日期";
  const venue = sl.venue || "未填场地";
  return `<article class="setlist-card">
    <button class="setlist-open" type="button" data-open-setlist="${escapeHtml(sl.id)}">
      <span class="setlist-date">${escapeHtml(date)}</span>
      <h2>${escapeHtml(sl.name)}</h2>
      <p>${escapeHtml(venue)} · ${sl.items.length} 首${pendingCount ? ` · ${pendingCount} 待补` : ""}</p>
    </button>
    <div class="setlist-actions">
      <button class="mini-btn" type="button" data-open-setlist="${escapeHtml(sl.id)}">打开</button>
      <button class="mini-btn" type="button" data-share-setlist="${escapeHtml(sl.id)}">分享</button>
      <button class="mini-btn" type="button" data-export-setlist="${escapeHtml(sl.id)}">导出</button>
      <button class="mini-btn danger" type="button" data-delete-setlist="${escapeHtml(sl.id)}">删除</button>
    </div>
  </article>`;
}

function renderSetlistDetail() {
  const sl = currentSetlist();
  if (!sl) {
    renderSetlistIndex();
    return;
  }
  el.setlistIndex.hidden = true;
  el.setlistDetail.hidden = false;
  const shared = Boolean(setlistState.shared);
  const scoreCount = sl.items.filter((it) => it.kind === "score").length;
  const pendingCount = sl.items.length - scoreCount;
  const actions = shared
    ? `<button class="btn-dark" type="button" data-import-shared>导入到我的歌单</button>
       <button class="btn-line" type="button" data-print-setlist>打印</button>`
    : `<button class="btn-dark" type="button" data-add-song>＋ 添加曲谱</button>
       <button class="btn-line" type="button" data-share-current>分享</button>
       <button class="btn-line" type="button" data-export-current>导出</button>
       <button class="btn-line" type="button" data-print-setlist>打印</button>
       <button class="btn-line danger" type="button" data-delete-current>删除</button>`;

  el.setlistDetail.innerHTML = `<div class="detail-head">
    <div class="detail-top">
      <button class="detail-back" type="button" data-back-setlists>← 全部歌单</button>
      <div class="detail-actions">${actions}</div>
    </div>
    <input class="detail-title-input" data-detail-field="name" value="${escapeHtml(sl.name)}" aria-label="歌单名称" ${shared ? "disabled" : ""}>
    <div class="detail-meta">
      <label>日期 <input type="date" data-detail-field="date" value="${escapeHtml(sl.date || "")}" ${shared ? "disabled" : ""}></label>
      <label>场地 <input data-detail-field="venue" value="${escapeHtml(sl.venue || "")}" placeholder="未填场地" ${shared ? "disabled" : ""}></label>
      <span class="detail-count">${sl.items.length} 首${pendingCount ? ` · ${pendingCount} 待补` : ""}</span>
    </div>
  </div>
  <div class="setlist-items">
    ${sl.items.length ? sl.items.map((item, index) => setlistItemMarkup(item, index, shared)).join("") : `<div class="setlist-empty">还没有曲谱。${shared ? "" : "点「添加曲谱」从曲库选，或手动加待补谱。"}</div>`}
  </div>`;
}

function setlistItemMarkup(item, index, shared) {
  const score = item.kind === "score" ? state.items.find((candidate) => candidate.id === item.scoreId) : null;
  const title = score ? score.title : item.kind === "pending" ? item.title : "曲谱已移除";
  const sub = score
    ? `${item.composer || score.composer || "未标注作者"} · ${formatLabel(score)} ${totalPages(score)}P`
    : item.kind === "pending"
      ? (item.composer || "待补谱")
      : "这份曲谱已不在当前曲库";
  const cover = score
    ? `<span class="item-cover"><img src="${escapeHtml(score.thumb)}" alt="" loading="lazy"></span>`
    : `<span class="item-cover pending-cover" aria-hidden="true">＋</span>`;
  const open = score
    ? `<button class="mini-btn" type="button" data-open-score="${escapeHtml(score.id)}">看谱</button>`
    : (!shared && item.kind === "pending" ? `<button class="mini-btn" type="button" data-item-link="${index}">挂谱</button>` : "");
  const edits = shared ? "" : `
    <button class="mini-btn" type="button" data-item-up="${index}" ${index === 0 ? "disabled" : ""} aria-label="上移">↑</button>
    <button class="mini-btn" type="button" data-item-down="${index}" ${index === (currentSetlist()?.items.length || 1) - 1 ? "disabled" : ""} aria-label="下移">↓</button>
    <button class="mini-btn danger" type="button" data-item-remove="${index}">移除</button>`;
  return `<div class="setlist-item${item.kind === "pending" ? " pending" : ""}">
    <span class="item-index">${String(index + 1).padStart(2, "0")}</span>
    ${cover}
    <span class="item-info">
      <button class="item-title" type="button" data-open-it="${index}" ${!score ? "disabled" : ""}>${escapeHtml(title)}${item.kind === "pending" ? `<span class="item-status">待补谱</span>` : ""}</button>
      <span class="item-sub">${escapeHtml(sub)}</span>
    </span>
    <span class="item-actions">${open}${edits}</span>
  </div>`;
}

function openSetlist(id) {
  const sl = setlistState.items.find((item) => item.id === id);
  if (!sl) return;
  setlistState.currentId = id;
  setlistState.shared = null;
  renderSetlistDetail();
  el.setlistsView.scrollIntoView({ behavior: "smooth", block: "start" });
}

function touchSetlist(sl) {
  sl.updatedAt = new Date().toISOString();
}

function moveSetlistItem(index, delta) {
  const sl = currentSetlist();
  if (!sl || setlistState.shared) return;
  const target = index + delta;
  if (target < 0 || target >= sl.items.length) return;
  const [item] = sl.items.splice(index, 1);
  sl.items.splice(target, 0, item);
  touchSetlist(sl);
  saveSetlists();
  renderSetlistDetail();
}

function removeSetlistItem(index) {
  const sl = currentSetlist();
  if (!sl || setlistState.shared) return;
  const item = sl.items[index];
  if (!item) return;
  if (!confirm("从歌单移除这首？")) return;
  sl.items.splice(index, 1);
  touchSetlist(sl);
  saveSetlists();
  renderSetlistDetail();
}

function addScoreToSetlist(sl, scoreId, linkIndex = null) {
  if (!sl) return false;
  const score = state.items.find((item) => item.id === scoreId);
  if (!score) return false;
  const newItem = { kind: "score", scoreId, itemId: uid("i") };
  if (linkIndex !== null && sl.items[linkIndex]?.kind === "pending") {
    if (sl.items[linkIndex].composer) newItem.composer = sl.items[linkIndex].composer;
    sl.items[linkIndex] = newItem;
    touchSetlist(sl);
    saveSetlists();
    toast(`已挂上「${score.title}」`);
    return true;
  }
  if (sl.items.some((item) => item.kind === "score" && item.scoreId === scoreId)) {
    toast("这首已经在歌单里了");
    return false;
  }
  const scoreKeys = new Set([
    normalizeKey(score.title),
    normalizeKey(score.search?.titleSimp),
    normalizeKey(score.search?.titleTrad),
  ]);
  const pendingIndex = sl.items.findIndex((item) =>
    item.kind === "pending" && scoreKeys.has(normalizeKey(item.title))
  );
  if (pendingIndex >= 0) {
    if (sl.items[pendingIndex].composer) newItem.composer = sl.items[pendingIndex].composer;
    sl.items[pendingIndex] = newItem;
    toast(`已填上待补谱「${score.title}」`);
  } else {
    sl.items.push(newItem);
    toast(`已加入「${sl.name}」`);
  }
  touchSetlist(sl);
  saveSetlists();
  return true;
}

function addPendingToSetlist(sl, title, composer) {
  if (!sl) return;
  sl.items.push({ kind: "pending", title, composer, itemId: uid("i") });
  touchSetlist(sl);
  saveSetlists();
  toast(`已添加待补谱「${title}」`);
}

function showModal(modal) {
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function hideModal(modal) {
  modal.hidden = true;
  if (modal === el.setlistModal) setlistState.newSetlistScoreId = null;
  if (modal === el.songPicker) setlistState.linkIndex = null;
  const anyOpen = [...document.querySelectorAll(".modal")].some((item) => !item.hidden);
  if (!anyOpen) document.body.classList.remove("modal-open");
}

function hideAllModals() {
  document.querySelectorAll(".modal").forEach((modal) => { modal.hidden = true; });
  document.body.classList.remove("modal-open");
}

function openSetlistModal(scoreId = null) {
  setlistState.newSetlistScoreId = scoreId;
  el.setlistForm.reset();
  document.getElementById("setlist-modal-title").textContent = "新建歌单";
  showModal(el.setlistModal);
  setTimeout(() => el.setlistName.focus(), 20);
}

function createSetlist(name, date, venue) {
  const sl = {
    id: uid("sl"),
    name,
    date,
    venue,
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setlistState.items.push(sl);
  saveSetlists();
  return sl;
}

function openSongPicker(linkIndex = null) {
  const sl = currentSetlist();
  if (!sl || setlistState.shared) return;
  setlistState.linkIndex = linkIndex;
  setlistState.pickerTab = "library";
  el.pickerSearch.value = "";
  el.pendingForm.hidden = true;
  el.pendingForm.reset();
  el.pickerResults.hidden = false;
  el.pickerTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.pickerTab === "library"));
  renderPickerResults();
  showModal(el.songPicker);
  setTimeout(() => el.pickerSearch.focus(), 20);
}

function pickerMatches(query) {
  const tokens = tokenize(query);
  if (!tokens.length) {
    return state.items.slice().sort((a, b) => collator.compare(a.title, b.title)).slice(0, 40);
  }
  return state.items
    .map((item) => ({ item, score: scoreItem(item, tokens) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => (b.score - a.score) || collator.compare(a.item.title, b.item.title))
    .slice(0, 40)
    .map((entry) => entry.item);
}

function renderPickerResults() {
  if (setlistState.pickerTab !== "library") {
    el.pickerResults.hidden = true;
    el.pendingForm.hidden = false;
    return;
  }
  el.pickerResults.hidden = false;
  el.pendingForm.hidden = true;
  const sl = currentSetlist();
  const existing = new Set((sl?.items || []).filter((item) => item.kind === "score").map((item) => item.scoreId));
  const matches = pickerMatches(el.pickerSearch.value.trim());
  if (!matches.length) {
    el.pickerResults.innerHTML = `<div class="picker-empty">没有找到，换个片段试试。</div>`;
    return;
  }
  el.pickerResults.innerHTML = matches.map((item) => {
    const added = existing.has(item.id);
    return `<div class="picker-item">
      <span class="item-cover"><img src="${escapeHtml(item.thumb)}" alt="" loading="lazy"></span>
      <span class="item-info">
        <span class="item-title">${escapeHtml(item.title)}</span>
        <span class="item-sub">${escapeHtml(item.composer || "未标注作者")} · ${formatLabel(item)} ${totalPages(item)}P</span>
      </span>
      <button class="mini-btn" type="button" data-picker-add="${escapeHtml(item.id)}" ${added && setlistState.linkIndex === null ? "disabled" : ""}>${added && setlistState.linkIndex === null ? "已在" : "加入"}</button>
    </div>`;
  }).join("");
}

function openAddToSetlist(scoreId) {
  if (!scoreId) return;
  setlistState.addScoreId = scoreId;
  const setlists = setlistState.items.slice().sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  el.addSetlistList.innerHTML = setlists.length
    ? setlists.map((sl) => `<button class="add-setlist-item" type="button" data-add-to-setlist="${escapeHtml(sl.id)}">
        <span><b>${escapeHtml(sl.name)}</b><span>${escapeHtml(sl.venue || "未填场地")} · ${sl.items.length} 首</span></span>
        <span>加入 →</span>
      </button>`).join("")
    : `<div class="add-setlist-empty">还没有歌单，先新建一个。</div>`;
  showModal(el.addSetlistModal);
}

function encodeSetlist(sl) {
  const payload = {
    v: 1,
    n: sl.name,
    d: sl.date || "",
    s: sl.venue || "",
    i: sl.items.map((item) => item.kind === "score"
      ? { k: "s", id: item.scoreId, c: item.composer || "" }
      : { k: "p", t: item.title, c: item.composer || "" }),
  };
  const base64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${location.origin}${location.pathname}#set=${base64}`;
}

function decodeSetlist(hash) {
  const match = hash.match(/^#set=(.+)$/);
  if (!match) return null;
  try {
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(decodeURIComponent(escape(atob(padded))));
    if (!payload || !Array.isArray(payload.i)) return null;
    return {
      id: "shared",
      name: payload.n || "分享歌单",
      date: payload.d || "",
      venue: payload.s || "",
      items: payload.i.map((item) => item.k === "s"
        ? { kind: "score", scoreId: item.id, composer: item.c || "", itemId: uid("i") }
        : { kind: "pending", title: item.t || "", composer: item.c || "", itemId: uid("i") }),
      shared: true,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("分享链接解析失败", error);
    return null;
  }
}

async function shareSetlist(sl) {
  const url = encodeSetlist(sl);
  try {
    await navigator.clipboard.writeText(url);
    toast("分享链接已复制");
  } catch (error) {
    window.prompt("复制这个分享链接：", url);
  }
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function exportSetlist(sl) {
  downloadJson(`${sl.name || "setlist"}.json`, { version: 1, setlists: [sl] });
}

function exportAllSetlists() {
  downloadJson("beike-setlists.json", { version: 1, setlists: setlistState.items });
}

function importSetlistsFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || ""));
      const incoming = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.setlists) ? parsed.setlists : parsed?.setlist ? [parsed.setlist] : [];
      let added = 0;
      for (const raw of incoming) {
        if (!raw || typeof raw.name !== "string" || !Array.isArray(raw.items)) continue;
        setlistState.items.push({
          id: uid("sl"),
          name: raw.name,
          date: raw.date || "",
          venue: raw.venue || "",
          items: raw.items.filter((item) => item && (item.kind === "score" || item.kind === "pending")).map((item) => ({ ...item, itemId: item.itemId || uid("i") })),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        added += 1;
      }
      saveSetlists();
      renderSetlistIndex();
      toast(added ? `导入了 ${added} 个歌单` : "没有可导入的歌单");
    } catch (error) {
      toast("导入失败：JSON 格式不对");
      console.error(error);
    }
  };
  reader.readAsText(file);
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.toast.hidden = true; }, 1800);
}

function seedSetlistIfNeeded() {
  if (setlistState.items.length || localStorage.getItem(SEEDED_KEY)) return;
  const items = SEED_SONGS.map(([composer, title]) => {
    const score = state.items.find((item) => normalizeKey(item.title) === normalizeKey(title));
    return score
      ? { kind: "score", scoreId: score.id, composer, itemId: uid("i") }
      : { kind: "pending", title, composer, itemId: uid("i") };
  });
  const sl = {
    id: uid("sl"),
    name: "演出歌单",
    date: "",
    venue: "",
    items,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setlistState.items.push(sl);
  localStorage.setItem(SEEDED_KEY, "1");
  saveSetlists();
}

/* ---------- events ---------- */

let searchTimer = 0;

function bindEvents() {
  el.viewTabs.forEach((tab) => {
    tab.addEventListener("click", () => setAppView(tab.dataset.appView));
  });

  el.newSetlist.addEventListener("click", () => openSetlistModal());
  el.exportSetlists.addEventListener("click", exportAllSetlists);
  el.importSetlists.addEventListener("click", () => el.importSetlistsFile.click());
  el.importSetlistsFile.addEventListener("change", () => {
    const file = el.importSetlistsFile.files && el.importSetlistsFile.files[0];
    if (file) importSetlistsFromFile(file);
    el.importSetlistsFile.value = "";
  });

  el.setlistForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = el.setlistName.value.trim();
    if (!name) return;
    const sl = createSetlist(name, el.setlistDate.value, el.setlistVenue.value.trim());
    const scoreId = setlistState.newSetlistScoreId;
    setlistState.newSetlistScoreId = null;
    hideModal(el.setlistModal);
    if (scoreId) {
      addScoreToSetlist(sl, scoreId);
    } else {
      setAppView("setlists");
      openSetlist(sl.id);
    }
    toast(`歌单「${name}」已创建`);
  });

  document.querySelectorAll("[data-modal-close]").forEach((button) => {
    button.addEventListener("click", () => {
      const modal = button.closest(".modal");
      if (modal) hideModal(modal);
    });
  });

  let pickerTimer = 0;
  el.pickerSearch.addEventListener("input", () => {
    window.clearTimeout(pickerTimer);
    pickerTimer = window.setTimeout(renderPickerResults, 70);
  });
  el.pickerTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setlistState.pickerTab = tab.dataset.pickerTab;
      el.pickerTabs.forEach((candidate) => candidate.classList.toggle("active", candidate === tab));
      renderPickerResults();
      if (setlistState.pickerTab === "pending") {
        window.setTimeout(() => el.pendingTitle.focus(), 20);
      }
    });
  });

  el.pickerResults.addEventListener("click", (event) => {
    const button = event.target.closest("[data-picker-add]");
    if (!button) return;
    const sl = currentSetlist();
    if (!sl) return;
    const added = addScoreToSetlist(sl, button.dataset.pickerAdd, setlistState.linkIndex);
    if (added) setlistState.linkIndex = null;
    renderPickerResults();
    renderSetlistDetail();
  });

  el.pendingForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = el.pendingTitle.value.trim();
    if (!title) return;
    const sl = currentSetlist();
    if (!sl) return;
    addPendingToSetlist(sl, title, el.pendingComposer.value.trim());
    el.pendingForm.reset();
    hideModal(el.songPicker);
    renderSetlistDetail();
  });

  el.addSetlistList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-to-setlist]");
    if (!button) return;
    const sl = setlistState.items.find((item) => item.id === button.dataset.addToSetlist);
    if (!sl || !setlistState.addScoreId) return;
    const added = addScoreToSetlist(sl, setlistState.addScoreId);
    if (added) hideModal(el.addSetlistModal);
    renderSetlistDetail();
  });

  el.addSetlistNew.addEventListener("click", () => {
    const scoreId = setlistState.addScoreId;
    hideModal(el.addSetlistModal);
    openSetlistModal(scoreId);
  });

  el.viewerAddSetlist.addEventListener("click", () => {
    if (current) openAddToSetlist(current.id);
  });

  el.setlistsList.addEventListener("click", (event) => {
    const emptyNew = event.target.closest("[data-empty-new]");
    if (emptyNew) { openSetlistModal(); return; }
    const open = event.target.closest("[data-open-setlist]");
    if (open) { openSetlist(open.dataset.openSetlist); return; }
    const share = event.target.closest("[data-share-setlist]");
    if (share) {
      const sl = setlistState.items.find((item) => item.id === share.dataset.shareSetlist);
      if (sl) shareSetlist(sl);
      return;
    }
    const exp = event.target.closest("[data-export-setlist]");
    if (exp) {
      const sl = setlistState.items.find((item) => item.id === exp.dataset.exportSetlist);
      if (sl) exportSetlist(sl);
      return;
    }
    const del = event.target.closest("[data-delete-setlist]");
    if (del) {
      const sl = setlistState.items.find((item) => item.id === del.dataset.deleteSetlist);
      if (!sl) return;
      if (!confirm(`删除歌单「${sl.name}」？`)) return;
      setlistState.items = setlistState.items.filter((item) => item.id !== sl.id);
      saveSetlists();
      renderSetlistIndex();
      toast("歌单已删除");
    }
  });

  el.setlistDetail.addEventListener("click", (event) => {
    const back = event.target.closest("[data-back-setlists]");
    if (back) {
      setlistState.currentId = null;
      setlistState.shared = null;
      renderSetlistIndex();
      return;
    }
    const add = event.target.closest("[data-add-song]");
    if (add) { openSongPicker(); return; }
    const print = event.target.closest("[data-print-setlist]");
    if (print) { window.print(); return; }
    const share = event.target.closest("[data-share-current]");
    if (share) {
      const sl = currentSetlist();
      if (sl) shareSetlist(sl);
      return;
    }
    const exp = event.target.closest("[data-export-current]");
    if (exp) {
      const sl = currentSetlist();
      if (sl) exportSetlist(sl);
      return;
    }
    const del = event.target.closest("[data-delete-current]");
    if (del) {
      const sl = currentSetlist();
      if (!sl || setlistState.shared) return;
      if (!confirm(`删除歌单「${sl.name}」？`)) return;
      setlistState.items = setlistState.items.filter((item) => item.id !== sl.id);
      saveSetlists();
      setlistState.currentId = null;
      renderSetlistIndex();
      toast("歌单已删除");
      return;
    }
    const importShared = event.target.closest("[data-import-shared]");
    if (importShared) {
      const shared = setlistState.shared;
      if (!shared) return;
      const sl = {
        id: uid("sl"),
        name: shared.name,
        date: shared.date,
        venue: shared.venue,
        items: shared.items.map((item) => ({ ...item, itemId: uid("i") })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setlistState.items.push(sl);
      saveSetlists();
      setlistState.shared = null;
      setlistState.currentId = sl.id;
      renderSetlistDetail();
      toast("已导入到我的歌单");
      return;
    }
    const openScore = event.target.closest("[data-open-score]");
    if (openScore) {
      openViewer(openScore.dataset.openScore, 1, openScore);
      return;
    }
    const openIt = event.target.closest("[data-open-it]");
    if (openIt) {
      const sl = currentSetlist();
      const item = sl && sl.items[Number(openIt.dataset.openIt)];
      if (item && item.kind === "score") openViewer(item.scoreId, 1, openIt);
      return;
    }
    const up = event.target.closest("[data-item-up]");
    if (up) { moveSetlistItem(Number(up.dataset.itemUp), -1); return; }
    const down = event.target.closest("[data-item-down]");
    if (down) { moveSetlistItem(Number(down.dataset.itemDown), 1); return; }
    const link = event.target.closest("[data-item-link]");
    if (link) { openSongPicker(Number(link.dataset.itemLink)); return; }
    const remove = event.target.closest("[data-item-remove]");
    if (remove) { removeSetlistItem(Number(remove.dataset.itemRemove)); }
  });

  el.setlistDetail.addEventListener("change", (event) => {
    const field = event.target.dataset.detailField;
    if (!field) return;
    const sl = currentSetlist();
    if (!sl || setlistState.shared) return;
    if (field === "name") {
      sl.name = event.target.value.trim() || "未命名歌单";
      event.target.value = sl.name;
    } else {
      sl[field] = event.target.value.trim();
    }
    touchSetlist(sl);
    saveSetlists();
  });

  el.search.addEventListener("input", () => {
    el.clearSearch.hidden = !el.search.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = el.search.value.trim();
      applyFilters();
    }, 70);
  });

  el.clearSearch.addEventListener("click", () => {
    el.search.value = "";
    state.query = "";
    el.clearSearch.hidden = true;
    applyFilters();
    el.search.focus();
  });

  el.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    window.clearTimeout(searchTimer);
    state.query = el.search.value.trim();
    el.clearSearch.hidden = !state.query;
    applyFilters();
    if (matchMedia("(max-width: 760px)").matches) {
      el.search.blur();
      document.querySelector(".archive")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  el.sort.addEventListener("change", () => {
    state.sort = el.sort.value;
    applyFilters();
  });

  el.viewToggle.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button) return;
    state.view = button.dataset.view;
    localStorage.setItem("puji-view", state.view);
    setViewButtons();
    updateUrlState();
    renderResults();
  });

  el.results.addEventListener("click", (event) => {
    const card = event.target.closest(".work-card[data-id]");
    if (card) {
      openViewer(card.dataset.id, 1, card);
      return;
    }
    const action = event.target.closest("[data-action='clear']");
    if (action) {
      el.search.value = "";
      state.query = "";
      state.sort = "relevance";
      el.sort.value = "relevance";
      el.clearSearch.hidden = true;
      applyFilters();
      el.search.focus();
    }
  });

  el.viewer.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) closeViewer();
  });

  el.infoToggle.addEventListener("click", () => {
    const shown = el.viewerShell.classList.toggle("show-info");
    el.infoToggle.setAttribute("aria-expanded", String(shown));
    window.setTimeout(() => {
      if (!current) return;
      if (current.format === "pdf") renderPdfPage(loadSeq).catch(showViewerError);
      else layoutImage();
    }, 120);
  });

  el.prevPage.addEventListener("click", () => goPage(pageNum - 1));
  el.nextPage.addEventListener("click", () => goPage(pageNum + 1));
  el.pageInput.addEventListener("change", () => goPage(el.pageInput.value));
  el.zoomIn.addEventListener("click", () => setZoom(zoom + 0.2));
  el.zoomOut.addEventListener("click", () => setZoom(zoom - 0.2));
  el.zoomLabel.addEventListener("click", () => setZoom(1));

  el.pageStrip.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page]");
    if (button) goPage(Number(button.dataset.page));
  });

  el.viewerCopy.addEventListener("click", async () => {
    const original = el.viewerCopy.textContent;
    try {
      await navigator.clipboard.writeText(location.href);
      el.viewerCopy.textContent = "已复制";
    } catch {
      el.viewerCopy.textContent = "复制失败";
    }
    window.setTimeout(() => { el.viewerCopy.textContent = original; }, 1400);
  });

  document.addEventListener("keydown", (event) => {
    const tag = event.target.tagName;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(tag);

    const openModal = [...document.querySelectorAll(".modal")].find((modal) => !modal.hidden);
    if (openModal) {
      if (event.key === "Escape") {
        event.preventDefault();
        hideModal(openModal);
      }
      return;
    }

    if (event.key === "/" && !typing && el.viewer.hidden && setlistState.appView === "library") {
      event.preventDefault();
      el.search.focus();
      el.search.select();
      return;
    }

    if (event.key === "Escape") {
      if (!el.viewer.hidden) {
        event.preventDefault();
        closeViewer();
      } else if (state.query && setlistState.appView === "library") {
        event.preventDefault();
        el.search.value = "";
        state.query = "";
        el.clearSearch.hidden = true;
        applyFilters();
      }
      return;
    }

    if (el.viewer.hidden) return;

    if (!typing && event.key === "ArrowLeft") {
      event.preventDefault();
      goPage(pageNum - 1);
    } else if (!typing && event.key === "ArrowRight") {
      event.preventDefault();
      goPage(pageNum + 1);
    } else if (!typing && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      setZoom(zoom + 0.2);
    } else if (!typing && event.key === "-") {
      event.preventDefault();
      setZoom(zoom - 0.2);
    } else if (event.key === "Tab") {
      const focusables = [...el.viewer.querySelectorAll("a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])")]
        .filter((node) => node.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (el.viewer.hidden || !current) return;
      if (current.format === "pdf") {
        renderPdfPage(loadSeq).catch(showViewerError);
      } else if (el.image.naturalWidth) {
        layoutImage();
      }
    }, 160);
  });

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    if (state.visible >= state.filtered.length) return;
    state.visible += PAGE_SIZE;
    renderResults();
  }, { rootMargin: "700px 0px" });
  observer.observe(el.sentinel);
}

function showFatalError(error) {
  el.results.setAttribute("aria-busy", "false");
  el.results.innerHTML = `<div class="state">
    <p class="state-code">LOAD_ERROR</p>
    <h2>曲谱索引没载入成功</h2>
    <p>${escapeHtml(error?.message || String(error))}</p>
    <p>本地预览请在项目目录运行 <code>python -m http.server 8000</code>，再打开 <code>http://localhost:8000</code>。直接双击 index.html 会被浏览器拦下。</p>
  </div>`;
  el.statCount.textContent = "—";
  console.error(error);
}

async function init() {
  bindEvents();
  loadSetlists();
  readUrlState();

  try {
    const response = await fetch("data/scores.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.items = (data.items || []).map(prepareItem);

    applyFilters();

    const sharedHash = location.hash.startsWith("#set=");
    const shared = decodeSetlist(location.hash);
    if (shared) {
      setlistState.shared = shared;
      setAppView("setlists");
    } else {
      if (sharedHash) toast("分享链接无效");
      seedSetlistIfNeeded();
      setAppView(setlistState.items.length ? "setlists" : "library");
    }

    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const deepLink = hash.get("s");
    if (deepLink) {
      openViewer(decodeURIComponent(deepLink), Number(hash.get("p")) || 1);
    }
  } catch (error) {
    showFatalError(error);
  }
}

init();
