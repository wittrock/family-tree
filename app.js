let DATA = null;
let META = null;
let CRYPTO_KEY = null;
let ENC_MODE = false;
let BASE_PREFIX = "../";

let selectedPid = null;
let activeView = "pedigree";
let activeFilter = "all";
let searchQuery = "";

// Dynamic Vertical Family Tree state
let treeRootPid = null;
let selectedTreePid = null;
let expandedParents = new Set();
let expandedDown = new Set();
let expandedSiblings = new Set();
let collapsedSiblings = new Set();
let expandedExtraSpouses = new Set();
let showAllSiblings = false;
let panX = 0;
let panY = 0;
let zoom = 1;
let treeNeedsInitialCenter = true;
let lastNodePositions = new Map(); // pid -> { x, y }

// Encrypted media blob URL caches
const mediaUrlPromiseCache = new Map();
const mediaUrlSyncCache = new Map();
let imgObserver = null;

const CARD_W = 232;
const CARD_H = 88;
const COUPLE_GAP = 34;
const SIBLING_GAP = 24;
const ROW_H = 164;

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveAesKey(password, saltB64, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: b64ToBytes(saltB64),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

async function decryptArrayBuffer(buf, key) {
  const bytes = new Uint8Array(buf);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    ciphertext
  );
}

function getSyncMediaHref(m) {
  if (!m) return null;
  if (!ENC_MODE) {
    return m.localFile ? BASE_PREFIX + m.localFile : null;
  }
  return mediaUrlSyncCache.get(m.id) || null;
}

async function getMediaUrl(m) {
  if (!m) return null;
  if (!ENC_MODE) {
    return m.localFile ? BASE_PREFIX + m.localFile : null;
  }
  if (!m.encFile) return null;
  if (mediaUrlPromiseCache.has(m.id)) return mediaUrlPromiseCache.get(m.id);

  const p = (async () => {
    const res = await fetch(BASE_PREFIX + m.encFile);
    if (!res.ok) throw new Error(`Failed to fetch media ${m.id}`);
    const encBuf = await res.arrayBuffer();
    const decBuf = await decryptArrayBuffer(encBuf, CRYPTO_KEY);
    const blob = new Blob([decBuf], { type: m.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    mediaUrlSyncCache.set(m.id, url);
    return url;
  })();

  mediaUrlPromiseCache.set(m.id, p);
  return p;
}

function ensureImageObserver() {
  if (imgObserver || typeof IntersectionObserver === "undefined") return;
  imgObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        imgObserver.unobserve(img);
        loadEncryptedImgElement(img);
      }
    },
    { rootMargin: "200px" }
  );
}

async function loadEncryptedImgElement(img) {
  const mid = img.dataset.encMedia;
  if (!mid || !DATA?.media?.[mid]) return;
  try {
    const url = await getMediaUrl(DATA.media[mid]);
    if (url) {
      img.src = url;
      img.classList.remove("enc-pending");
      const initEl = img.parentElement?.querySelector(".avatar-initials");
      if (initEl) initEl.classList.add("hidden");
      const pendingLabel = img.parentElement?.querySelector(".thumb-loading");
      if (pendingLabel) pendingLabel.classList.add("hidden");
    }
  } catch {
    // Keep initials / placeholder on error
  }
}

function hydrateMediaImages(rootEl, immediate = false) {
  if (!ENC_MODE || !rootEl) return;
  const imgs = rootEl.querySelectorAll("img[data-enc-media]");
  if (!imgs.length) return;
  if (immediate || typeof IntersectionObserver === "undefined") {
    imgs.forEach((img) => loadEncryptedImgElement(img));
  } else {
    ensureImageObserver();
    imgs.forEach((img) => imgObserver.observe(img));
  }
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[parts.length - 1]?.[0] || "")).toUpperCase();
}

function renderAvatar(person, cls = "avatar-sm") {
  const pm = person.primaryMediaId ? DATA.media[person.primaryMediaId] : null;
  const genderCls = person.gender === "Female" ? "female" : "";
  const syncHref = pm && pm.type === "photo" ? getSyncMediaHref(pm) : null;
  const initStr = esc(initials(person.name));

  if (syncHref) {
    return `<div class="${cls} ${genderCls}"><img src="${esc(syncHref)}" alt="${esc(person.name)}" loading="lazy" /></div>`;
  }
  if (ENC_MODE && pm && pm.type === "photo" && pm.encFile) {
    return `
      <div class="${cls} ${genderCls}">
        <span class="avatar-initials">${initStr}</span>
        <img data-enc-media="${esc(pm.id)}" class="enc-pending" alt="${esc(person.name)}" />
      </div>`;
  }
  return `<div class="${cls} ${genderCls}">${initStr}</div>`;
}

/* ==================== Initialization & Lock Screen ==================== */

async function init() {
  try {
    const metaRes = await fetch("meta.json", { cache: "no-store" });
    if (metaRes.ok) {
      META = await metaRes.json();
      BASE_PREFIX = "";
    }
  } catch {
    META = null;
  }

  if (META && META.encrypted) {
    ENC_MODE = true;
    document.getElementById("appShell").classList.add("hidden");
    document.getElementById("lockScreen").classList.remove("hidden");
    if (META.treeTitle) {
      document.getElementById("lockTitle").textContent = META.treeTitle;
      document.title = META.treeTitle;
    }

    if (!window.crypto?.subtle) {
      showLockError("Encrypted archives require HTTPS or localhost.");
      return;
    }

    bindLockControls();

    const savedPw =
      sessionStorage.getItem("ancestry_pw") || localStorage.getItem("ancestry_pw");
    if (savedPw) {
      await attemptUnlock(savedPw, false, Boolean(localStorage.getItem("ancestry_pw")));
    }
    return;
  }

  // Unencrypted mode (either local serve.py or --unencrypted dist)
  const treeUrl = META ? META.treeFile : "../export/tree.json";
  const res = await fetch(treeUrl);
  DATA = await res.json();
  startApp();
}

function showLockError(msg) {
  const el = document.getElementById("lockError");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function setLockStatus(msg) {
  const el = document.getElementById("lockStatus");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function bindLockControls() {
  const form = document.getElementById("lockForm");
  const pwInput = document.getElementById("lockPassword");
  const eyeBtn = document.getElementById("togglePwBtn");

  eyeBtn.addEventListener("click", () => {
    const isPw = pwInput.type === "password";
    pwInput.type = isPw ? "text" : "password";
    eyeBtn.textContent = isPw ? "🙈" : "👁";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = pwInput.value;
    const remember = document.getElementById("rememberPw").checked;
    await attemptUnlock(pw, true, remember);
  });
}

async function attemptUnlock(password, showErrors, remember) {
  const submitBtn = document.getElementById("lockSubmit");
  showLockError("");
  setLockStatus("Verifying password…");
  submitBtn.disabled = true;

  try {
    const key = await deriveAesKey(password, META.salt, META.iterations);
    const checkBuf = b64ToBytes(META.check).buffer;
    const plainCheck = await decryptArrayBuffer(checkBuf, key);
    const checkStr = new TextDecoder().decode(plainCheck);
    if (checkStr !== "ANCESTRY_TREE_OK") {
      throw new Error("Verification failed");
    }

    CRYPTO_KEY = key;
    sessionStorage.setItem("ancestry_pw", password);
    if (remember) {
      localStorage.setItem("ancestry_pw", password);
    } else {
      localStorage.removeItem("ancestry_pw");
    }

    setLockStatus("Decrypting family tree data…");
    const treeRes = await fetch(BASE_PREFIX + META.treeFile);
    if (!treeRes.ok) throw new Error("Failed to load encrypted tree data");
    const encTreeBuf = await treeRes.arrayBuffer();
    const decTreeBuf = await decryptArrayBuffer(encTreeBuf, CRYPTO_KEY);
    DATA = JSON.parse(new TextDecoder().decode(decTreeBuf));

    document.getElementById("lockScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("hidden");
    setLockStatus("");
    startApp();
  } catch (err) {
    sessionStorage.removeItem("ancestry_pw");
    localStorage.removeItem("ancestry_pw");
    setLockStatus("");
    if (showErrors) {
      showLockError("Incorrect password. Please check with your family and try again.");
    }
  } finally {
    submitBtn.disabled = false;
  }
}

function lockArchive() {
  sessionStorage.removeItem("ancestry_pw");
  localStorage.removeItem("ancestry_pw");
  location.reload();
}

/* ==================== App Startup & Navigation ==================== */

function startApp() {
  selectedPid = DATA.tree.rootPersonId;
  initTreeRoot(DATA.tree.rootPersonId);

  document.title = DATA.tree.treeName;
  document.getElementById("treeTitle").textContent = DATA.tree.treeName;
  const c = DATA.tree.counts;
  document.getElementById("treeStats").textContent =
    `${c.people} people · ${c.facts} facts · ${c.mediaDownloaded}/${c.mediaTotal} media`;
  const searchEl = document.getElementById("searchInput");
  if (searchEl) {
    searchEl.placeholder = `Search ${c.people} people, places, years, notes…`;
  }

  bindControls();
  renderSidebar();
  renderMain();
}

function initTreeRoot(pid) {
  treeRootPid = pid;
  selectedTreePid = pid;
  expandedParents = new Set();
  expandedDown = new Set();
  expandedSiblings = new Set();
  collapsedSiblings = new Set();
  expandedExtraSpouses = new Set();
  lastNodePositions = new Map();
  treeNeedsInitialCenter = true;

  const p = DATA.people[pid];
  if (!p) return;

  // Expand 2 generations of ancestors above root by default (parents + grandparents)
  expandedParents.add(pid);
  for (const par of [...(p.family.fathers || []), ...(p.family.mothers || [])]) {
    expandedParents.add(par.id);
  }

  // Show immediate spouse & children for root if present
  if ((p.family.spouses && p.family.spouses.length) || (p.family.children && p.family.children.length)) {
    expandedDown.add(pid);
  }
}

function bindControls() {
  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderSidebar();
  });

  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      renderSidebar();
    });
  });

  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveView(tab.dataset.view);
    });
  });

  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("mediaModal").addEventListener("click", (e) => {
    if (e.target.id === "mediaModal") closeModal();
  });

  bindFeedbackControls();

  // Mobile sidebar drawer
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  const closeDrawer = () => {
    sidebar.classList.remove("open");
    backdrop.classList.add("hidden");
  };
  document.getElementById("sidebarOpenBtn").addEventListener("click", () => {
    sidebar.classList.add("open");
    backdrop.classList.remove("hidden");
  });
  document.getElementById("sidebarCloseBtn").addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);
}

function setActiveView(view) {
  activeView = view;
  document.querySelectorAll(".nav-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === view);
  });
  renderMain();
}

function selectPerson(pid, switchToProfile = true) {
  if (!DATA.people[pid]) return;
  selectedPid = pid;
  if (!switchToProfile && activeView === "pedigree") {
    initTreeRoot(pid);
  }
  if (switchToProfile) {
    activeView = "profile";
    document.querySelectorAll(".nav-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.view === "profile");
    });
  }
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarBackdrop").classList.add("hidden");
  renderSidebar();
  renderMain();
}

/* ==================== Sidebar ==================== */

function filteredPeople() {
  return Object.values(DATA.people)
    .filter((p) => {
      if (activeFilter === "media" && (!p.mediaIds || p.mediaIds.length === 0)) return false;
      if (activeFilter === "sources" && (!p.sources || p.sources.length === 0)) return false;
      if (!searchQuery) return true;
      const factSnippets = (p.facts || [])
        .filter((f) => ["Political", "Election", "Military", "Occupation"].includes(f.type) || (f.description && /occupation/i.test(f.description)))
        .flatMap((f) => [f.title, f.value, f.description]);
      const hay = [
        p.name,
        p.birthDate,
        p.birthPlace,
        p.deathDate,
        p.deathPlace,
        p.notes,
        ...(p.alternateNames || []),
        ...factSnippets,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(searchQuery);
    })
    .sort((a, b) => (a.surname || "").localeCompare(b.surname || "") || (a.givenName || "").localeCompare(b.givenName || ""));
}

function renderSidebar() {
  const list = document.getElementById("peopleList");
  const people = filteredPeople();
  list.innerHTML = people
    .map(
      (p) => `
      <div class="person-row ${p.id === selectedPid ? "active" : ""}" data-pid="${esc(p.id)}">
        ${renderAvatar(p, "avatar-sm")}
        <div class="person-row-meta">
          <div class="person-row-name">${esc(p.name || "(Unnamed)")}</div>
          <div class="person-row-dates">${esc(p.lifeRange || p.birthDate || "")}</div>
        </div>
        <div class="person-row-badges">
          ${p.mediaIds.length ? `<span title="Media">📷${p.mediaIds.length}</span>` : ""}
        </div>
      </div>`
    )
    .join("");

  list.querySelectorAll(".person-row").forEach((el) => {
    el.addEventListener("click", () => selectPerson(el.dataset.pid, activeView !== "pedigree"));
  });

  hydrateMediaImages(list, false);
}

/* ==================== Main Content Router ==================== */

function renderMain() {
  const container = document.getElementById("mainContent");
  const topActions = document.getElementById("topActions");
  const person = DATA.people[selectedPid];

  topActions.innerHTML = `
    ${person ? `<span>Selected: <strong>${esc(person.name)}</strong></span>` : ""}
    ${ENC_MODE ? `<button class="btn btn-sm" id="lockArchiveBtn" title="Lock archive and clear session">🔒 Lock</button>` : ""}
  `;
  if (ENC_MODE) {
    document.getElementById("lockArchiveBtn")?.addEventListener("click", lockArchive);
  }

  container.classList.toggle("tree-mode", activeView === "pedigree");

  if (activeView === "pedigree") {
    renderPedigreeView(container);
  } else if (activeView === "profile") {
    renderProfile(container, person);
  } else if (activeView === "media") {
    renderAllMedia(container);
  } else if (activeView === "sources") {
    renderAllSources(container);
  }
}

/* ==================== Biographical Highlights & Sibling Helpers ==================== */

function parseBirthYear(p) {
  if (!p) return 9999;
  const s = p.birthDate || p.lifeRange || "";
  const m = String(s).match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : 9999;
}

function getBioHighlights(p) {
  if (!p) {
    return {
      notes: "",
      political: [],
      military: [],
      occupations: [],
      stories: [],
      lifeStory: "",
      cardTagline: null,
      hasRichBio: false,
    };
  }
  const notes = (p.notes || "").trim();
  const lifeStory = (p.lifeStory?.narrative || p.lifeStory?.defaultNarrative || "").trim();

  const political = [];
  const military = [];
  const occupations = [];
  const occSeen = new Set();

  for (const f of p.facts || []) {
    const t = (f.type || "").toLowerCase();
    if (t === "political" || t === "election") {
      const summary = f.value || f.description || f.title || "Political campaign";
      political.push({
        date: f.date || "",
        title: f.title && !f.title.startsWith("Person/") ? f.title : "Political",
        summary,
        detail: f.description || f.narrative || f.value || "",
        place: f.place || "",
      });
    } else if (t === "military") {
      const descClean = (f.description || "").replace(/\s*\n+\s*/g, " · ").trim();
      const summary = descClean || f.value || (f.date ? `Military (${f.date})` : f.place ? `Military (${f.place})` : "Military service");
      military.push({
        date: f.date || "",
        title: f.title && !f.title.startsWith("Person/") ? f.title : "Military Service",
        summary,
        hasCustomDesc: Boolean(descClean || f.value),
        detail: descClean || f.narrative || (f.place ? `Served in ${f.place}` : ""),
        place: f.place || "",
      });
    } else if (t === "occupation") {
      const val = (f.value || f.description || "").trim();
      if (val && !occSeen.has(val.toLowerCase())) {
        occSeen.add(val.toLowerCase());
        occupations.push({ label: val, date: f.date || "" });
      }
    } else if (f.description && /occupation\s*:/i.test(f.description)) {
      const m = f.description.match(/occupation\s*:\s*([^;\n]+)/i);
      if (m && m[1]) {
        const val = m[1].trim();
        if (val && !occSeen.has(val.toLowerCase())) {
          occSeen.add(val.toLowerCase());
          occupations.push({ label: val, date: f.date || "" });
        }
      }
    }
  }

  const richMilitary = military
    .filter((m) => m.detail || m.date)
    .sort((a, b) => Number(b.hasCustomDesc) - Number(a.hasCustomDesc));
  const finalMilitary = richMilitary.length ? richMilitary : military.slice(0, 1);

  const stories = (p.mediaIds || [])
    .map((mid) => DATA?.media?.[mid])
    .filter((m) => m && (m.type === "story_pdf" || m.type === "story_inline"))
    .map((m) => ({
      id: m.id,
      type: m.type,
      title: (m.title || m.id).replace(/_/g, " "),
    }));

  let cardTagline = null;
  if (political.length) {
    const pol = political[0];
    cardTagline = {
      kind: "political",
      icon: "🏛",
      text: `${pol.date ? pol.date + " · " : ""}${pol.summary}`,
      tooltip: pol.detail || pol.summary,
    };
  } else if (finalMilitary.length) {
    const mil = finalMilitary[0];
    const shortMil = mil.hasCustomDesc
      ? mil.summary
      : [mil.date ? `Military (${mil.date})` : "Military service", mil.place].filter(Boolean).join(" · ");
    cardTagline = {
      kind: "military",
      icon: "🎖",
      text: shortMil,
      tooltip: [mil.date, mil.detail || mil.summary, mil.place].filter(Boolean).join(" · "),
    };
  } else if (occupations.length) {
    const occText = occupations.map((o) => o.label).join(", ");
    cardTagline = {
      kind: "occupation",
      icon: "💼",
      text: occText,
      tooltip: `Occupation: ${occText}`,
    };
  } else if (stories.length) {
    cardTagline = {
      kind: "story",
      icon: "📖",
      text: stories[0].title,
      tooltip: `Linked story: ${stories[0].title}`,
    };
  } else if (notes) {
    cardTagline = {
      kind: "note",
      icon: "📝",
      text: notes,
      tooltip: notes,
    };
  }

  return {
    notes,
    political,
    military: finalMilitary,
    occupations,
    stories,
    lifeStory,
    cardTagline,
    hasRichBio: Boolean(political.length || finalMilitary.length || occupations.length || stories.length || notes),
  };
}

function isSiblingsExpanded(pid) {
  return showAllSiblings ? !collapsedSiblings.has(pid) : expandedSiblings.has(pid);
}

function toggleSiblingsFor(pid) {
  if (showAllSiblings) {
    if (collapsedSiblings.has(pid)) collapsedSiblings.delete(pid);
    else collapsedSiblings.add(pid);
  } else {
    if (expandedSiblings.has(pid)) expandedSiblings.delete(pid);
    else expandedSiblings.add(pid);
  }
}

function getPersonSiblings(pid, excludePids = null) {
  const p = DATA.people[pid];
  if (!p) return [];
  const raw = [
    ...(p.family.siblings || []).map((s) => ({ id: s.id, isHalf: false })),
    ...(p.family.halfSiblings || []).map((s) => ({ id: s.id, isHalf: true })),
  ];
  const seen = new Set([pid]);
  const out = [];
  for (const item of raw) {
    if (seen.has(item.id)) continue;
    if (excludePids && excludePids.has(item.id)) continue;
    if (!DATA.people[item.id]) continue;
    seen.add(item.id);
    out.push(item);
  }
  out.sort((a, b) => parseBirthYear(DATA.people[a.id]) - parseBirthYear(DATA.people[b.id]));
  return out;
}

function toggleExtraSpousesFor(pid) {
  if (expandedExtraSpouses.has(pid)) expandedExtraSpouses.delete(pid);
  else expandedExtraSpouses.add(pid);
}

function getMarriageYear(pidA, pidB) {
  const findYear = (p, targetId, targetName) => {
    if (!p?.facts) return null;
    for (const f of p.facts) {
      if (f.type !== "Marriage") continue;
      if (
        (f.targetPersonId && f.targetPersonId === targetId) ||
        (targetName && f.targetPersonName && f.targetPersonName === targetName)
      ) {
        if (f.parsedDate?.Year) return String(f.parsedDate.Year);
        const m = String(f.date || f.sortDate || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/);
        if (m) return m[1];
      }
    }
    return null;
  };
  const pA = DATA.people[pidA];
  const pB = DATA.people[pidB];
  return findYear(pA, pidB, pB?.name) || findYear(pB, pidA, pA?.name) || null;
}

function getMarriageTag(pidA, pidB) {
  const yr = getMarriageYear(pidA, pidB);
  return yr ? `m. ${yr}` : null;
}

function childHasParent(childPid, parentPid) {
  const c = DATA.people[childPid];
  if (!c) return false;
  return (
    (c.family.fathers || []).some((f) => f.id === parentPid) ||
    (c.family.mothers || []).some((m) => m.id === parentPid)
  );
}

function pickPrimarySpouse(pid, candidateSpouses) {
  if (!candidateSpouses || !candidateSpouses.length) return null;
  const p = DATA.people[pid];
  const children = p?.family.children || [];
  if (children.length > 0) {
    for (const sp of candidateSpouses) {
      if (children.some((c) => childHasParent(c.id, sp.id))) return sp;
    }
  }
  return candidateSpouses[0];
}

function getPersonExtraSpouses(pid, excludePids = null) {
  const p = DATA.people[pid];
  if (!p) return [];
  const seen = new Set([pid]);
  const out = [];
  for (const sp of p.family.spouses || []) {
    if (!sp?.id || seen.has(sp.id)) continue;
    if (excludePids && excludePids.has(sp.id)) continue;
    if (!DATA.people[sp.id]) continue;
    seen.add(sp.id);
    out.push(sp);
  }
  return out;
}

/* ==================== Vertical Dynamic Family Graph ==================== */

function collectAllAncestors(pid, seen = new Set()) {
  if (!pid || seen.has(pid)) return seen;
  seen.add(pid);
  const p = DATA.people[pid];
  if (!p) return seen;
  for (const f of p.family.fathers || []) collectAllAncestors(f.id, seen);
  for (const m of p.family.mothers || []) collectAllAncestors(m.id, seen);
  return seen;
}

function collectVisiblePrimaryAncPids(pid, out = new Set()) {
  if (!pid || out.has(pid)) return out;
  const p = DATA.people[pid];
  if (!p) return out;
  out.add(pid);
  if (expandedParents.has(pid)) {
    const fId = p.family.fathers?.[0]?.id;
    const mId = p.family.mothers?.[0]?.id;
    if (fId) collectVisiblePrimaryAncPids(fId, out);
    if (mId) collectVisiblePrimaryAncPids(mId, out);
  }
  return out;
}

function buildAncSubtree(pid, row, sibSide = "left", primaryPids = null, allowExtraSpouses = true) {
  const p = DATA.people[pid];
  if (!p) return null;
  const fatherId = p.family.fathers?.[0]?.id || null;
  const motherId = p.family.mothers?.[0]?.id || null;
  const hasParents = Boolean(fatherId || motherId);
  const isExpanded = hasParents && expandedParents.has(pid);

  const extraSpouseList = allowExtraSpouses ? getPersonExtraSpouses(pid, primaryPids) : [];
  const extraSpouseCount = extraSpouseList.length;
  const extraSpousesExpanded = extraSpouseCount > 0 && expandedExtraSpouses.has(pid);
  const extraSpousesW = extraSpousesExpanded
    ? extraSpouseCount * (CARD_W + COUPLE_GAP)
    : 0;

  const sibList = getPersonSiblings(pid, primaryPids);
  const sibCount = sibList.length;
  const sibsExpanded = sibCount > 0 && isSiblingsExpanded(pid);
  const sibsW = sibsExpanded ? sibCount * (CARD_W + SIBLING_GAP) : 0;
  const rowStripW = CARD_W + extraSpousesW + sibsW;

  if (!isExpanded) {
    const defaultAnchorCx =
      sibSide === "left" ? rowStripW - CARD_W / 2 : CARD_W / 2;
    return {
      pid,
      row,
      width: rowStripW,
      parentsW: 0,
      parentsAnchorRelX: 0,
      defaultAnchorCx,
      father: null,
      mother: null,
      hasParents,
      parentCount: (fatherId ? 1 : 0) + (motherId ? 1 : 0),
      isExpanded: false,
      sibSide,
      sibList,
      sibCount,
      sibsExpanded,
      sibStripW: rowStripW,
      extraSpouseList,
      extraSpouseCount,
      extraSpousesExpanded,
      extraSpousesW,
    };
  }

  const fNode = fatherId ? buildAncSubtree(fatherId, row - 1, "left", primaryPids, true) : null;
  const mNode = motherId ? buildAncSubtree(motherId, row - 1, "right", primaryPids, true) : null;

  let parentsW;
  let parentsAnchorRelX;
  if (fNode && mNode) {
    parentsW = fNode.width + COUPLE_GAP + mNode.width;
    parentsAnchorRelX = fNode.width + COUPLE_GAP / 2;
  } else {
    const only = fNode || mNode;
    parentsW = only.width;
    parentsAnchorRelX = only.defaultAnchorCx;
  }

  const width = Math.max(parentsW, rowStripW);
  let defaultAnchorCx;
  if (sibsExpanded || extraSpousesExpanded) {
    const stripLeft = (width - rowStripW) / 2;
    defaultAnchorCx =
      sibSide === "left"
        ? stripLeft + rowStripW - CARD_W / 2
        : stripLeft + CARD_W / 2;
  } else {
    const parentsOffset = (width - parentsW) / 2;
    defaultAnchorCx = parentsOffset + parentsAnchorRelX;
  }

  return {
    pid,
    row,
    width,
    parentsW,
    parentsAnchorRelX,
    defaultAnchorCx,
    father: fNode,
    mother: mNode,
    hasParents,
    parentCount: (fNode ? 1 : 0) + (mNode ? 1 : 0),
    isExpanded: true,
    sibSide,
    sibList,
    sibCount,
    sibsExpanded,
    sibStripW: rowStripW,
    extraSpouseList,
    extraSpouseCount,
    extraSpousesExpanded,
    extraSpousesW,
  };
}

function buildDescSubtree(pid, row, seenDown, isChildLevel = true) {
  const p = DATA.people[pid];
  if (!p || seenDown.has(pid)) return null;
  seenDown.add(pid);

  const spouses = (p.family.spouses || []).filter((s) => !seenDown.has(s.id) && DATA.people[s.id]);
  const children = (p.family.children || []).filter((c) => !seenDown.has(c.id) && DATA.people[c.id]);
  const hasDown = spouses.length > 0 || children.length > 0;
  const isExpanded = hasDown && expandedDown.has(pid);

  if (!isExpanded || !isChildLevel) {
    return {
      pid,
      row,
      spousesShown: [],
      extraSpouses: [],
      extraSpousesExpanded: false,
      extraSpousesW: 0,
      childNodes: [],
      unitW: CARD_W,
      width: CARD_W,
      hasDown,
      downCount: children.length || spouses.length,
      isExpanded: false,
    };
  }

  const primarySp = pickPrimarySpouse(pid, spouses);
  const spousesShown = primarySp ? [primarySp] : [];
  for (const sp of spousesShown) seenDown.add(sp.id);

  const extraSpouses = primarySp ? spouses.filter((s) => s.id !== primarySp.id) : [];
  const extraSpousesExpanded = extraSpouses.length > 0 && expandedExtraSpouses.has(pid);
  if (extraSpousesExpanded) {
    for (const sp of extraSpouses) seenDown.add(sp.id);
  }
  const extraSpousesW = extraSpousesExpanded
    ? extraSpouses.length * (CARD_W + COUPLE_GAP)
    : 0;

  const baseUnitW = spousesShown.length ? 2 * CARD_W + COUPLE_GAP : CARD_W;
  const unitW = baseUnitW + extraSpousesW;
  const childNodes = children
    .map((c) => buildDescSubtree(c.id, row + 1, seenDown, true))
    .filter(Boolean);

  const childrenW = childNodes.length
    ? childNodes.reduce((acc, cn) => acc + cn.width, 0) + SIBLING_GAP * (childNodes.length - 1)
    : 0;

  return {
    pid,
    row,
    spousesShown,
    extraSpouses,
    extraSpousesExpanded,
    extraSpousesW,
    childNodes,
    unitW,
    childrenW,
    width: Math.max(unitW, childrenW),
    hasDown,
    downCount: children.length || spouses.length,
    isExpanded: true,
  };
}

function computeFamilyLayout() {
  const nodes = new Map(); // pid -> node meta
  const edges = []; // { type: 'couple'|'line', d?, x1?, y1?, x2?, y2?, midX?, midY?, pids: [], dashed?, sibling?, secondary?, label? }

  const rootP = DATA.people[treeRootPid];
  const rootSpouses = (rootP?.family.spouses || []).filter((s) => DATA.people[s.id]);
  const rootChildren = (rootP?.family.children || []).filter((c) => DATA.people[c.id]);
  const rootHasDown = rootSpouses.length > 0 || rootChildren.length > 0;
  const rootShowDown = rootHasDown && expandedDown.has(treeRootPid);
  const primaryRootSpouse = rootShowDown ? pickPrimarySpouse(treeRootPid, rootSpouses) : null;

  // Collect primary visible ancestor/root/primary-spouse PIDs so sibling & extra-spouse handles never duplicate visible primary nodes
  const primaryPids = new Set();
  collectVisiblePrimaryAncPids(treeRootPid, primaryPids);
  if (primaryRootSpouse) {
    collectVisiblePrimaryAncPids(primaryRootSpouse.id, primaryPids);
  }

  const placeExtraSpousesRow = (anchorPid, anchorCx, y, row, side, extraSpouseList) => {
    const placed = [];
    const midY = y + CARD_H / 2;
    for (let i = 0; i < extraSpouseList.length; i++) {
      const sp = extraSpouseList[i];
      if (nodes.has(sp.id)) continue;
      const spCx =
        side === "left"
          ? anchorCx - (i + 1) * (CARD_W + COUPLE_GAP)
          : anchorCx + (i + 1) * (CARD_W + COUPLE_GAP);
      const marriageLabel = getMarriageTag(anchorPid, sp.id);
      nodes.set(sp.id, {
        pid: sp.id,
        x: spCx - CARD_W / 2,
        y,
        cx: spCx,
        cy: midY,
        row,
        isRoot: false,
        isSibling: false,
        isHalfSibling: false,
        isExtraSpouse: true,
        spouseAnchorPid: anchorPid,
        marriageLabel,
        hasParents: false,
        parentCount: 0,
        parentsExpanded: false,
        hasDown: false,
        downCount: 0,
        downExpanded: false,
        canToggleDown: false,
        sibCount: 0,
        sibsExpanded: false,
        sibSide: side,
        extraSpouseCount: 0,
        extraSpousesExpanded: false,
        extraSpouseSide: side,
      });

      if (i === 0) {
        const x1 = side === "left" ? spCx + CARD_W / 2 : anchorCx + CARD_W / 2;
        const x2 = side === "left" ? anchorCx - CARD_W / 2 : spCx - CARD_W / 2;
        const midX = (x1 + x2) / 2;
        edges.push({
          type: "couple",
          secondary: true,
          label: marriageLabel,
          x1,
          y1: midY,
          x2,
          y2: midY,
          midX,
          midY,
          pids: [anchorPid, sp.id],
        });
        placed.push({ id: sp.id, cx: spCx, coupleMidX: midX, coupleOriginY: midY });
      } else {
        const railY = y + CARD_H + 14 + (i - 1) * 10;
        edges.push({
          type: "line",
          secondaryCouple: true,
          d: `M ${anchorCx} ${y + CARD_H} V ${railY} H ${spCx} V ${y + CARD_H}`,
          pids: [anchorPid, sp.id],
        });
        placed.push({ id: sp.id, cx: spCx, coupleMidX: spCx, coupleOriginY: railY });
      }
    }
    return placed;
  };

  const placeAnc = (anc, leftX, forcedCardCx, isRootNode = false) => {
    const cardCx =
      forcedCardCx !== null && forcedCardCx !== undefined
        ? forcedCardCx
        : leftX + anc.defaultAnchorCx;
    const x = cardCx - CARD_W / 2;
    const y = anc.row * ROW_H;

    const existing = nodes.get(anc.pid);
    nodes.set(anc.pid, {
      pid: anc.pid,
      x,
      y,
      cx: cardCx,
      cy: y + CARD_H / 2,
      row: anc.row,
      isRoot: existing?.isRoot || isRootNode,
      isSibling: false,
      isHalfSibling: false,
      isExtraSpouse: false,
      hasParents: anc.hasParents,
      parentCount: anc.parentCount,
      parentsExpanded: anc.isExpanded,
      hasDown: existing?.hasDown || false,
      downCount: existing?.downCount || 0,
      downExpanded: existing?.downExpanded || false,
      canToggleDown: existing?.canToggleDown || false,
      sibCount: anc.sibCount,
      sibsExpanded: anc.sibsExpanded,
      sibSide: anc.sibSide,
      extraSpouseCount: anc.extraSpouseCount,
      extraSpousesExpanded: anc.extraSpousesExpanded,
      extraSpouseSide: anc.sibSide,
    });

    // Place expanded extra spouses immediately adjacent to this person on anc.sibSide
    let placedExtraSpouses = [];
    if (anc.extraSpousesExpanded && anc.extraSpouseList.length > 0) {
      placedExtraSpouses = placeExtraSpousesRow(
        anc.pid,
        cardCx,
        y,
        anc.row,
        anc.sibSide,
        anc.extraSpouseList
      );
    }

    // Place expanded siblings beyond extra spouses inside [leftX, leftX + anc.width]
    const groupMembers = [{ pid: anc.pid, cx: cardCx, isHalf: false }];
    if (anc.sibsExpanded && anc.sibList.length > 0) {
      const k = anc.sibList.length;
      for (let i = 0; i < k; i++) {
        const sib = anc.sibList[i];
        if (nodes.has(sib.id)) continue;
        const sCx =
          anc.sibSide === "left"
            ? cardCx - anc.extraSpousesW - (k - i) * (CARD_W + SIBLING_GAP)
            : cardCx + anc.extraSpousesW + (i + 1) * (CARD_W + SIBLING_GAP);
        nodes.set(sib.id, {
          pid: sib.id,
          x: sCx - CARD_W / 2,
          y,
          cx: sCx,
          cy: y + CARD_H / 2,
          row: anc.row,
          isRoot: false,
          isSibling: true,
          isHalfSibling: sib.isHalf,
          isExtraSpouse: false,
          siblingAnchorPid: anc.pid,
          hasParents: false,
          parentCount: 0,
          parentsExpanded: false,
          hasDown: false,
          downCount: 0,
          downExpanded: false,
          canToggleDown: false,
          sibCount: 0,
          sibsExpanded: false,
          sibSide: anc.sibSide,
          extraSpouseCount: 0,
          extraSpousesExpanded: false,
          extraSpouseSide: anc.sibSide,
        });
        groupMembers.push({ pid: sib.id, cx: sCx, isHalf: sib.isHalf });
      }
    }

    const groupMinCx = Math.min(...groupMembers.map((g) => g.cx));
    const groupMaxCx = Math.max(...groupMembers.map((g) => g.cx));
    const groupMidCx = (groupMinCx + groupMaxCx) / 2;
    const groupPids = groupMembers.map((g) => g.pid);

    if (!anc.isExpanded) {
      // Parents collapsed, but siblings expanded -> draw subtle sibling bracket above the group
      if (groupMembers.length > 1) {
        const busY = y - 22;
        edges.push({
          type: "line",
          d: `M ${groupMinCx} ${busY} H ${groupMaxCx}`,
          pids: groupPids,
          sibling: true,
        });
        for (const g of groupMembers) {
          edges.push({
            type: "line",
            d: `M ${g.cx} ${busY} V ${y}`,
            pids: groupPids,
            sibling: true,
            dashed: g.isHalf,
          });
        }
      }
      return placedExtraSpouses;
    }

    // Center parents above the sibling group, clamped strictly inside [leftX, leftX + anc.width]
    const idealParentsLeftX = groupMidCx - anc.parentsAnchorRelX;
    const parentsLeftX = Math.max(
      leftX,
      Math.min(leftX + anc.width - anc.parentsW, idealParentsLeftX)
    );

    let parentOriginX;
    let parentOriginY;
    let parentPids;

    if (anc.father && anc.mother) {
      const splitX = parentsLeftX + anc.father.width + COUPLE_GAP / 2;
      const fCx = splitX - COUPLE_GAP / 2 - CARD_W / 2;
      const mCx = splitX + COUPLE_GAP / 2 + CARD_W / 2;
      placeAnc(anc.father, parentsLeftX, fCx, false);
      placeAnc(anc.mother, parentsLeftX + anc.father.width + COUPLE_GAP, mCx, false);

      const parentRowMidY = (anc.row - 1) * ROW_H + CARD_H / 2;
      edges.push({
        type: "couple",
        x1: fCx + CARD_W / 2,
        y1: parentRowMidY,
        x2: mCx - CARD_W / 2,
        y2: parentRowMidY,
        midX: splitX,
        midY: parentRowMidY,
        pids: [anc.father.pid, anc.mother.pid, ...groupPids],
      });

      parentOriginX = splitX;
      parentOriginY = parentRowMidY;
      parentPids = [anc.father.pid, anc.mother.pid];
    } else {
      const only = anc.father || anc.mother;
      placeAnc(only, parentsLeftX, null, false);
      const pNode = nodes.get(only.pid);
      parentOriginX = pNode.cx;
      parentOriginY = pNode.y + CARD_H;
      parentPids = [only.pid];
    }

    if (groupMembers.length === 1) {
      const childTopX = cardCx;
      const childTopY = y;
      let d;
      if (Math.abs(parentOriginX - childTopX) < 1) {
        d = `M ${parentOriginX} ${parentOriginY} V ${childTopY}`;
      } else {
        const elbowY = childTopY - 30;
        d = `M ${parentOriginX} ${parentOriginY} V ${elbowY} H ${childTopX} V ${childTopY}`;
      }
      edges.push({
        type: "line",
        d,
        pids: [...parentPids, anc.pid],
      });
    } else {
      // Full sibling bus connecting parents down to all expanded siblings
      const busY = y - 30;
      edges.push({
        type: "line",
        d: `M ${parentOriginX} ${parentOriginY} V ${busY}`,
        pids: [...parentPids, ...groupPids],
      });
      const minBusX = Math.min(parentOriginX, groupMinCx);
      const maxBusX = Math.max(parentOriginX, groupMaxCx);
      edges.push({
        type: "line",
        d: `M ${minBusX} ${busY} H ${maxBusX}`,
        pids: [...parentPids, ...groupPids],
      });
      for (const g of groupMembers) {
        edges.push({
          type: "line",
          d: `M ${g.cx} ${busY} V ${y}`,
          pids: [...parentPids, g.pid],
          dashed: g.isHalf,
        });
      }
    }
    return placedExtraSpouses;
  };

  const placeDescChildrenAt = (
    parentMidX,
    parentOriginY,
    parentPids,
    childNodes,
    row,
    startX = null,
    busYOffset = 0,
    secondaryEdges = false
  ) => {
    if (!childNodes || !childNodes.length) return;
    const totalW =
      childNodes.reduce((acc, cn) => acc + cn.width, 0) + SIBLING_GAP * (childNodes.length - 1);
    let curX = startX !== null ? startX : parentMidX - totalW / 2;
    const busY = row * ROW_H + CARD_H + 36 + busYOffset;
    const childTopY = (row + 1) * ROW_H;
    const childCxs = [];

    for (const cn of childNodes) {
      const childMidX = curX + cn.width / 2;
      let cCx = childMidX;
      let coupleMidX = childMidX;
      let cOriginY = childTopY + CARD_H;

      if (cn.spousesShown.length > 0) {
        const unitLeft = childMidX - cn.unitW / 2;
        cCx = unitLeft + cn.extraSpousesW + CARD_W / 2;
        const spCx = cCx + CARD_W + COUPLE_GAP;
        coupleMidX = (cCx + spCx) / 2;
        const spId = cn.spousesShown[0].id;

        nodes.set(cn.pid, {
          pid: cn.pid,
          x: cCx - CARD_W / 2,
          y: childTopY,
          cx: cCx,
          cy: childTopY + CARD_H / 2,
          row: row + 1,
          isRoot: false,
          isSibling: false,
          isHalfSibling: false,
          isExtraSpouse: false,
          hasParents: false,
          parentCount: 0,
          parentsExpanded: false,
          hasDown: cn.hasDown,
          downCount: cn.downCount,
          downExpanded: cn.isExpanded,
          canToggleDown: cn.hasDown,
          sibCount: 0,
          sibsExpanded: false,
          sibSide: "left",
          extraSpouseCount: cn.extraSpouses.length,
          extraSpousesExpanded: cn.extraSpousesExpanded,
          extraSpouseSide: "left",
        });

        nodes.set(spId, {
          pid: spId,
          x: spCx - CARD_W / 2,
          y: childTopY,
          cx: spCx,
          cy: childTopY + CARD_H / 2,
          row: row + 1,
          isRoot: false,
          isSibling: false,
          isHalfSibling: false,
          isExtraSpouse: false,
          hasParents: false,
          parentCount: 0,
          parentsExpanded: false,
          hasDown: false,
          downCount: 0,
          downExpanded: false,
          canToggleDown: false,
          sibCount: 0,
          sibsExpanded: false,
          sibSide: "right",
          extraSpouseCount: 0,
          extraSpousesExpanded: false,
          extraSpouseSide: "right",
        });

        if (cn.extraSpousesExpanded && cn.extraSpouses.length > 0) {
          placeExtraSpousesRow(cn.pid, cCx, childTopY, row + 1, "left", cn.extraSpouses);
        }

        edges.push({
          type: "couple",
          x1: cCx + CARD_W / 2,
          y1: childTopY + CARD_H / 2,
          x2: spCx - CARD_W / 2,
          y2: childTopY + CARD_H / 2,
          midX: coupleMidX,
          midY: childTopY + CARD_H / 2,
          pids: [cn.pid, spId],
        });
        cOriginY = childTopY + CARD_H / 2;
      } else {
        nodes.set(cn.pid, {
          pid: cn.pid,
          x: cCx - CARD_W / 2,
          y: childTopY,
          cx: cCx,
          cy: childTopY + CARD_H / 2,
          row: row + 1,
          isRoot: false,
          isSibling: false,
          isHalfSibling: false,
          isExtraSpouse: false,
          hasParents: false,
          parentCount: 0,
          parentsExpanded: false,
          hasDown: cn.hasDown,
          downCount: cn.downCount,
          downExpanded: cn.isExpanded,
          canToggleDown: cn.hasDown,
          sibCount: 0,
          sibsExpanded: false,
          sibSide: "left",
          extraSpouseCount: 0,
          extraSpousesExpanded: false,
          extraSpouseSide: "left",
        });
      }

      childCxs.push({ cx: cCx, pid: cn.pid });
      if (cn.isExpanded && cn.childNodes.length) {
        const nextPids = cn.spousesShown.length ? [cn.pid, cn.spousesShown[0].id] : [cn.pid];
        placeDescChildrenAt(coupleMidX, cOriginY, nextPids, cn.childNodes, row + 1);
      }
      curX += cn.width + SIBLING_GAP;
    }

    // Stem from parent down to sibling bus
    edges.push({
      type: "line",
      secondaryCouple: secondaryEdges,
      d: `M ${parentMidX} ${parentOriginY} V ${busY}`,
      pids: parentPids,
    });
    if (childCxs.length === 1 && Math.abs(childCxs[0].cx - parentMidX) < 1) {
      edges.push({
        type: "line",
        secondaryCouple: secondaryEdges,
        d: `M ${parentMidX} ${busY} V ${childTopY}`,
        pids: [...parentPids, childCxs[0].pid],
      });
    } else {
      const minX = Math.min(parentMidX, ...childCxs.map((c) => c.cx));
      const maxX = Math.max(parentMidX, ...childCxs.map((c) => c.cx));
      edges.push({
        type: "line",
        secondaryCouple: secondaryEdges,
        d: `M ${minX} ${busY} H ${maxX}`,
        pids: parentPids,
      });
      for (const c of childCxs) {
        edges.push({
          type: "line",
          secondaryCouple: secondaryEdges,
          d: `M ${c.cx} ${busY} V ${childTopY}`,
          pids: [...parentPids, c.pid],
        });
      }
    }
  };

  const rootSibSide = rootShowDown && primaryRootSpouse ? "left" : "right";
  const rootAnc = buildAncSubtree(treeRootPid, 0, rootSibSide, primaryPids, rootShowDown);

  if (!rootShowDown || !primaryRootSpouse) {
    placeAnc(rootAnc, 0, null, true);
    const rNode = nodes.get(treeRootPid);
    rNode.hasDown = rootHasDown;
    rNode.downCount = rootChildren.length || rootSpouses.length;
    rNode.downExpanded = rootShowDown;
    rNode.canToggleDown = rootHasDown;

    if (rootShowDown && rootChildren.length > 0) {
      const seenDown = new Set([treeRootPid]);
      const childNodes = rootChildren
        .map((c) => buildDescSubtree(c.id, 1, seenDown, true))
        .filter(Boolean);
      placeDescChildrenAt(rNode.cx, CARD_H, [treeRootPid], childNodes, 0);
    }
  } else {
    const spId = primaryRootSpouse.id;
    const spAnc = buildAncSubtree(spId, 0, "right", primaryPids, true);
    const coupleMidX = rootAnc.width + COUPLE_GAP / 2;
    const rootCardCx = coupleMidX - COUPLE_GAP / 2 - CARD_W / 2;
    const spCardCx = coupleMidX + COUPLE_GAP / 2 + CARD_W / 2;

    const placedRootExtraSpouses = placeAnc(rootAnc, 0, rootCardCx, true) || [];
    placeAnc(spAnc, rootAnc.width + COUPLE_GAP, spCardCx, false);

    const rNode = nodes.get(treeRootPid);
    rNode.hasDown = rootHasDown;
    rNode.downCount = rootChildren.length || rootSpouses.length;
    rNode.downExpanded = true;
    rNode.canToggleDown = true;

    edges.push({
      type: "couple",
      x1: rootCardCx + CARD_W / 2,
      y1: CARD_H / 2,
      x2: spCardCx - CARD_W / 2,
      y2: CARD_H / 2,
      midX: coupleMidX,
      midY: CARD_H / 2,
      pids: [treeRootPid, spId],
    });

    if (rootChildren.length > 0) {
      const seenDown = new Set([
        treeRootPid,
        spId,
        ...placedRootExtraSpouses.map((s) => s.id),
      ]);

      // Group root's children by expanded extra spouse (left-to-right) + primary couple so parentage is unambiguous
      const groups = [];
      const assignedChildIds = new Set();

      // Left-side extra spouses ordered left-to-right (furthest left first)
      const leftExtraOrdered = [...placedRootExtraSpouses].reverse();
      for (const esp of leftExtraOrdered) {
        const espKids = rootChildren.filter(
          (c) =>
            !assignedChildIds.has(c.id) &&
            childHasParent(c.id, esp.id) &&
            !childHasParent(c.id, spId)
        );
        if (espKids.length > 0) {
          const cNodes = espKids
            .map((c) => buildDescSubtree(c.id, 1, seenDown, true))
            .filter(Boolean);
          if (cNodes.length > 0) {
            for (const c of espKids) assignedChildIds.add(c.id);
            groups.push({
              parentMidX: esp.coupleMidX,
              parentOriginY: esp.coupleOriginY,
              parentPids: [treeRootPid, esp.id],
              childNodes: cNodes,
              secondary: true,
            });
          }
        }
      }

      const primaryKids = rootChildren.filter((c) => !assignedChildIds.has(c.id));
      if (primaryKids.length > 0) {
        const cNodes = primaryKids
          .map((c) => buildDescSubtree(c.id, 1, seenDown, true))
          .filter(Boolean);
        if (cNodes.length > 0) {
          groups.push({
            parentMidX: coupleMidX,
            parentOriginY: CARD_H / 2,
            parentPids: [treeRootPid, spId],
            childNodes: cNodes,
            secondary: false,
          });
        }
      }

      if (groups.length === 1) {
        const g = groups[0];
        placeDescChildrenAt(g.parentMidX, g.parentOriginY, g.parentPids, g.childNodes, 0, null, 0, g.secondary);
      } else if (groups.length > 1) {
        const GROUP_GAP = SIBLING_GAP + 18;
        const groupWidths = groups.map(
          (g) =>
            g.childNodes.reduce((acc, cn) => acc + cn.width, 0) +
            SIBLING_GAP * (g.childNodes.length - 1)
        );
        const allW =
          groupWidths.reduce((a, b) => a + b, 0) + GROUP_GAP * (groups.length - 1);
        const anchorMid = (groups[0].parentMidX + groups[groups.length - 1].parentMidX) / 2;
        let gx = anchorMid - allW / 2;
        groups.forEach((g, idx) => {
          placeDescChildrenAt(
            g.parentMidX,
            g.parentOriginY,
            g.parentPids,
            g.childNodes,
            0,
            gx,
            g.secondary ? -6 : 6,
            g.secondary
          );
          gx += groupWidths[idx] + GROUP_GAP;
        });
      }
    }
  }

  return { nodes, edges };
}

function renderPedigreeView(container) {
  const rootP = DATA.people[treeRootPid];
  if (!rootP) {
    container.innerHTML = `<div class="loading">Select a person from the left sidebar.</div>`;
    return;
  }

  const ancTotal = collectAllAncestors(treeRootPid).size - 1;
  const isOriginalRoot = treeRootPid === DATA.tree.rootPersonId;

  container.innerHTML = `
    <div class="tree-toolbar">
      <div class="tree-toolbar-left">
        <span class="tree-root-label">Tree: ${esc(rootP.name)}</span>
        <span class="pill neutral" id="treeCountPill">${ancTotal} ancestors</span>
        <button class="btn" id="btnReset2Gen" title="Show 2 generations of parents">2 Gens</button>
        <button class="btn primary" id="btnExpandAll" title="Expand all ancestors of ${esc(rootP.name)}">Expand All Ancestors</button>
        <button class="btn ${showAllSiblings ? "active-toggle" : ""}" id="btnToggleSiblings" aria-pressed="${showAllSiblings ? "true" : "false"}" title="Toggle showing siblings for all visible people in the tree">${showAllSiblings ? "✓ " : ""}Show Siblings</button>
        <button class="btn" id="btnCollapseAll">Collapse</button>
        ${
          !isOriginalRoot
            ? `<button class="btn" id="btnBackToMainRoot" title="Return to ${esc(DATA.people[DATA.tree.rootPersonId]?.name)}">↩ Main Root</button>`
            : ""
        }
      </div>
      <div class="tree-toolbar-right">
        <button class="btn" id="btnFitTree" title="Fit entire visible tree in view">Fit</button>
        <button class="btn" id="btnCenterRoot" title="Center on ${esc(rootP.name)}">Center Root</button>
        <div class="zoom-group">
          <button id="btnZoomOut" title="Zoom out">−</button>
          <span class="zoom-readout" id="zoomReadout">${Math.round(zoom * 100)}%</span>
          <button id="btnZoomIn" title="Zoom in">+</button>
        </div>
      </div>
    </div>

    <div class="tree-viewport" id="treeViewport">
      <div class="tree-stage" id="treeStage">
        <svg class="tree-edges" id="treeEdges"></svg>
        <div class="tree-nodes" id="treeNodes"></div>
      </div>
      <div class="tree-inspector hidden" id="treeInspector"></div>
      <div class="insp-hint">Drag canvas to pan · Scroll to zoom · Click ▲ / ▼ / + sibs / ♥ spouse on cards to expand family</div>
    </div>
  `;

  bindTreeToolbar(rootP);
  bindViewportPanZoom();
  renderTreeGraph(null);
}

function updateSiblingsToggleButton() {
  const btn = document.getElementById("btnToggleSiblings");
  if (!btn) return;
  btn.classList.toggle("active-toggle", showAllSiblings);
  btn.setAttribute("aria-pressed", showAllSiblings ? "true" : "false");
  btn.textContent = showAllSiblings ? "✓ Show Siblings" : "Show Siblings";
}

function bindTreeToolbar(rootP) {
  document.getElementById("btnReset2Gen").addEventListener("click", () => {
    initTreeRoot(treeRootPid);
    renderTreeGraph(null);
    centerOnNode(treeRootPid, true);
  });

  document.getElementById("btnExpandAll").addEventListener("click", () => {
    expandedParents = collectAllAncestors(treeRootPid);
    renderTreeGraph(null);
    fitTreeInViewport();
  });

  document.getElementById("btnToggleSiblings").addEventListener("click", () => {
    showAllSiblings = !showAllSiblings;
    expandedSiblings.clear();
    collapsedSiblings.clear();
    updateSiblingsToggleButton();
    renderTreeGraph(selectedTreePid || treeRootPid);
  });

  document.getElementById("btnCollapseAll").addEventListener("click", () => {
    expandedParents.clear();
    expandedDown.clear();
    expandedSiblings.clear();
    collapsedSiblings.clear();
    expandedExtraSpouses.clear();
    showAllSiblings = false;
    updateSiblingsToggleButton();
    renderTreeGraph(null);
    centerOnNode(treeRootPid, true);
  });

  document.getElementById("btnBackToMainRoot")?.addEventListener("click", () => {
    selectPerson(DATA.tree.rootPersonId, false);
  });

  document.getElementById("btnFitTree").addEventListener("click", fitTreeInViewport);
  document.getElementById("btnCenterRoot").addEventListener("click", () => {
    centerOnNode(treeRootPid, true);
  });

  document.getElementById("btnZoomIn").addEventListener("click", () => zoomAtCenter(1.22));
  document.getElementById("btnZoomOut").addEventListener("click", () => zoomAtCenter(1 / 1.22));
}

function applyTransform() {
  const stage = document.getElementById("treeStage");
  if (stage) {
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
  const readout = document.getElementById("zoomReadout");
  if (readout) {
    readout.textContent = `${Math.round(zoom * 100)}%`;
  }
}

function zoomAtViewportPoint(factor, vx, vy) {
  const nextZoom = Math.min(1.9, Math.max(0.14, zoom * factor));
  const actualFactor = nextZoom / zoom;
  panX = vx - (vx - panX) * actualFactor;
  panY = vy - (vy - panY) * actualFactor;
  zoom = nextZoom;
  applyTransform();
}

function zoomAtCenter(factor) {
  const vp = document.getElementById("treeViewport");
  if (!vp) return;
  const rect = vp.getBoundingClientRect();
  zoomAtViewportPoint(factor, rect.width / 2, rect.height / 2);
}

function centerOnNode(pid, resetZoom = false) {
  const vp = document.getElementById("treeViewport");
  const pos = lastNodePositions.get(pid);
  if (!vp || !pos) return;
  const rect = vp.getBoundingClientRect();
  if (resetZoom) zoom = 0.95;
  panX = rect.width / 2 - (pos.x + CARD_W / 2) * zoom;
  panY = rect.height * 0.62 - (pos.y + CARD_H / 2) * zoom;
  applyTransform();
}

function fitTreeInViewport() {
  const vp = document.getElementById("treeViewport");
  if (!vp || lastNodePositions.size === 0) return;
  const rect = vp.getBoundingClientRect();
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pos of lastNodePositions.values()) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + CARD_W);
    maxY = Math.max(maxY, pos.y + CARD_H);
  }
  const pad = 64;
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  zoom = Math.min(1.05, Math.max(0.15, Math.min(rect.width / bw, rect.height / bh)));
  panX = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
  panY = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  applyTransform();
}

function bindViewportPanZoom() {
  const vp = document.getElementById("treeViewport");
  if (!vp) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origPanX = 0;
  let origPanY = 0;
  let movedDist = 0;

  // Touch pinch state
  const activePointers = new Map();
  let lastPinchDist = null;

  vp.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tree-inspector") || e.target.closest(".t-handle") || e.target.closest(".t-node-fb")) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      dragging = true;
      movedDist = 0;
      startX = e.clientX;
      startY = e.clientY;
      origPanX = panX;
      origPanY = panY;
      vp.classList.add("panning");
    } else if (activePointers.size === 2) {
      dragging = false;
      const pts = [...activePointers.values()];
      lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  });

  window.addEventListener("pointermove", (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 2) {
      const pts = [...activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (lastPinchDist && dist > 0) {
        const rect = vp.getBoundingClientRect();
        const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
        const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
        zoomAtViewportPoint(dist / lastPinchDist, midX, midY);
      }
      lastPinchDist = dist;
      return;
    }

    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    movedDist = Math.hypot(dx, dy);
    panX = origPanX + dx;
    panY = origPanY + dy;
    applyTransform();
  });

  const endPointer = (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) lastPinchDist = null;
    if (dragging) {
      dragging = false;
      vp.classList.remove("panning");
      vp.dataset.justDragged = movedDist > 5 ? "1" : "";
    }
  };
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  vp.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const vx = e.clientX - rect.left;
      const vy = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0014);
      zoomAtViewportPoint(factor, vx, vy);
    },
    { passive: false }
  );
}

function renderTreeGraph(anchorPid = null) {
  const prevAnchorPos = anchorPid ? lastNodePositions.get(anchorPid) : null;
  const { nodes, edges } = computeFamilyLayout();

  // Preserve clicked node's exact screen coordinates when expanding/collapsing
  if (anchorPid && prevAnchorPos && nodes.has(anchorPid)) {
    const nextPos = nodes.get(anchorPid);
    panX += (prevAnchorPos.x - nextPos.x) * zoom;
    panY += (prevAnchorPos.y - nextPos.y) * zoom;
  }

  lastNodePositions = new Map();
  for (const [pid, n] of nodes.entries()) {
    lastNodePositions.set(pid, { x: n.x, y: n.y });
  }

  // Update count pill
  const countPill = document.getElementById("treeCountPill");
  if (countPill) {
    const ancTotal = collectAllAncestors(treeRootPid).size - 1;
    countPill.textContent = `${nodes.size} shown · ${ancTotal} ancestors`;
  }

  // Render SVG edges
  const svgEl = document.getElementById("treeEdges");
  const activeSet = new Set([selectedTreePid]);
  const selP = DATA.people[selectedTreePid];
  if (selP) {
    for (const r of [
      ...(selP.family.fathers || []),
      ...(selP.family.mothers || []),
      ...(selP.family.spouses || []),
      ...(selP.family.children || []),
      ...(selP.family.siblings || []),
      ...(selP.family.halfSiblings || []),
    ]) {
      activeSet.add(r.id);
    }
  }

  const edgesHtml = edges
    .map((ed) => {
      const isHi =
        selectedTreePid &&
        ed.pids?.includes(selectedTreePid) &&
        ed.pids.some((id) => id !== selectedTreePid && activeSet.has(id));
      if (ed.type === "couple") {
        const secCls = ed.secondary ? "secondary-couple-bar" : "";
        const jointSecCls = ed.secondary ? "secondary-couple-joint" : "";
        const labelSvg = ed.label
          ? `<text class="couple-label ${isHi ? "highlight" : ""}" x="${ed.midX}" y="${ed.midY - 10}" text-anchor="middle">${esc(ed.label)}</text>`
          : "";
        return `
          <line class="edge-line couple-bar ${secCls} ${isHi ? "highlight" : ""}" x1="${ed.x1}" y1="${ed.y1}" x2="${ed.x2}" y2="${ed.y2}" />
          <circle class="couple-joint ${jointSecCls}" cx="${ed.midX}" cy="${ed.midY}" r="4.5" />
          ${labelSvg}
        `;
      }
      const cls = [
        "edge-line",
        ed.sibling ? "sibling-edge" : "",
        ed.dashed ? "half-sibling-edge" : "",
        ed.secondaryCouple ? "secondary-couple-bar" : "",
        isHi ? "highlight" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<path class="${cls}" d="${ed.d}" />`;
    })
    .join("");
  svgEl.innerHTML = edgesHtml;

  // Render HTML Person Cards
  const nodesEl = document.getElementById("treeNodes");
  const cardsHtml = [];
  for (const n of nodes.values()) {
    const p = DATA.people[n.pid];
    if (!p) continue;
    const genderCls =
      p.gender === "Female" ? "female" : p.gender === "Male" ? "male" : "unknown";
    const selCls = n.pid === selectedTreePid ? "selected" : "";
    const rootCls = n.isRoot ? "root-node" : "";
    const sibCls = n.isSibling ? "sibling-node" : "";
    const extraSpCls = n.isExtraSpouse ? "extra-spouse-node" : "";
    const rightSpHandleCls =
      n.extraSpouseCount > 0 && n.extraSpouseSide === "right" ? "has-spouse-right" : "";
    const bio = getBioHighlights(p);
    const bioCls = bio.hasRichBio ? "has-bio" : "";

    const pm = p.primaryMediaId ? DATA.media[p.primaryMediaId] : null;
    const syncHref = pm && pm.type === "photo" ? getSyncMediaHref(pm) : null;
    const initStr = esc(initials(p.name));

    let avatarInner = initStr;
    if (syncHref) {
      avatarInner = `<img src="${esc(syncHref)}" alt="${esc(p.name)}" />`;
    } else if (ENC_MODE && pm && pm.type === "photo" && pm.encFile) {
      avatarInner = `<span class="avatar-initials">${initStr}</span><img data-enc-media="${esc(pm.id)}" class="enc-pending" alt="${esc(p.name)}" />`;
    }

    const topHandle = n.hasParents
      ? `<button class="t-handle t-handle-top ${n.parentsExpanded ? "expanded" : ""}" data-handle-up="${esc(n.pid)}" title="${
          n.parentsExpanded ? "Collapse parents" : `Expand parents (${n.parentCount})`
        }">${n.parentsExpanded ? "−" : `▲ ${n.parentCount}`}</button>`
      : "";

    const bottomHandle = n.canToggleDown
      ? `<button class="t-handle t-handle-bottom ${n.downExpanded ? "expanded" : ""}" data-handle-down="${esc(n.pid)}" title="${
          n.downExpanded ? "Hide spouse & children" : "Show spouse & children"
        }">${n.downExpanded ? "−" : `▼ ${n.downCount || 1}`}</button>`
      : "";

    const sibLabel = n.sibCount === 1 ? "1 sib" : `${n.sibCount} sibs`;
    const sibHandleSideCls = n.sibSide === "left" ? "t-handle-sib-left" : "t-handle-sib-right";
    const sibHandle =
      n.sibCount > 0
        ? `<button class="t-handle t-handle-sib ${sibHandleSideCls} ${n.sibsExpanded ? "expanded" : ""}" data-handle-sib="${esc(n.pid)}" title="${
            n.sibsExpanded ? `Hide ${sibLabel}` : `Show ${sibLabel}`
          }">${n.sibsExpanded ? `− ${sibLabel}` : `+ ${sibLabel}`}</button>`
        : "";

    const spouseLabel = n.extraSpouseCount === 1 ? "1 spouse" : `${n.extraSpouseCount} spouses`;
    const spouseHandleSideCls =
      n.extraSpouseSide === "left" ? "t-handle-spouse-left" : "t-handle-spouse-right";
    const spouseHandle =
      n.extraSpouseCount > 0
        ? `<button class="t-handle t-handle-spouse ${spouseHandleSideCls} ${n.extraSpousesExpanded ? "expanded" : ""}" data-handle-spouse="${esc(n.pid)}" title="${
            n.extraSpousesExpanded ? `Hide ${spouseLabel}` : `Show ${spouseLabel}`
          }">${n.extraSpousesExpanded ? `♥ −${spouseLabel}` : `♥ +${spouseLabel}`}</button>`
        : "";

    const metaBits = [];
    if (n.isHalfSibling) metaBits.push(`<span class="t-half-tag">Half-sib</span>`);
    if (n.isExtraSpouse) {
      metaBits.push(`<span class="t-spouse-tag">♥ ${esc(n.marriageLabel || "Spouse")}</span>`);
    }
    if (p.mediaIds?.length) metaBits.push(`📷 ${p.mediaIds.length}`);
    if (p.sources?.length) metaBits.push(`📚 ${p.sources.length}`);
    if (bio.stories.length && bio.cardTagline?.kind !== "story") metaBits.push(`📖 ${bio.stories.length}`);
    if (bio.occupations.length && bio.cardTagline?.kind !== "occupation") metaBits.push(`💼`);
    if (bio.military.length && bio.cardTagline?.kind !== "military") metaBits.push(`🎖`);
    if (bio.notes && bio.cardTagline?.kind !== "note") metaBits.push(`📝`);

    const bioStrip = bio.cardTagline
      ? `<div class="t-node-bio bio-${esc(bio.cardTagline.kind)}" title="${esc(bio.cardTagline.tooltip)}"><span class="t-node-bio-ico">${bio.cardTagline.icon}</span><span class="t-node-bio-txt">${esc(bio.cardTagline.text)}</span></div>`
      : "";

    cardsHtml.push(`
      <div class="t-node ${genderCls} ${selCls} ${rootCls} ${sibCls} ${extraSpCls} ${rightSpHandleCls} ${bioCls}" data-node-pid="${esc(n.pid)}" style="left:${n.x}px;top:${n.y}px">
        ${topHandle}
        ${spouseHandle}
        <button class="t-node-fb" data-node-fb="${esc(n.pid)}" title="Send feedback about ${esc(p.name)}" aria-label="Send feedback about ${esc(p.name)}">✉</button>
        <div class="tree-avatar">${avatarInner}</div>
        <div class="t-node-body">
          <div class="t-node-name" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="t-node-dates">${esc(p.lifeRange || (p.isLiving ? "Living" : "Dates unknown"))}</div>
          ${bioStrip}
          ${metaBits.length ? `<div class="t-node-meta">${metaBits.join(" · ")}</div>` : ""}
        </div>
        ${bottomHandle}
        ${sibHandle}
      </div>
    `);
  }
  nodesEl.innerHTML = cardsHtml.join("");

  // Bind feedback icons
  nodesEl.querySelectorAll("[data-node-fb]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFeedbackModal(btn.dataset.nodeFb);
    });
  });

  // Bind handles
  nodesEl.querySelectorAll("[data-handle-up]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pid = btn.dataset.handleUp;
      if (expandedParents.has(pid)) {
        expandedParents.delete(pid);
      } else {
        expandedParents.add(pid);
      }
      renderTreeGraph(pid);
    });
  });

  nodesEl.querySelectorAll("[data-handle-down]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pid = btn.dataset.handleDown;
      if (expandedDown.has(pid)) {
        expandedDown.delete(pid);
      } else {
        expandedDown.add(pid);
      }
      renderTreeGraph(pid);
    });
  });

  nodesEl.querySelectorAll("[data-handle-sib]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pid = btn.dataset.handleSib;
      toggleSiblingsFor(pid);
      renderTreeGraph(pid);
    });
  });

  nodesEl.querySelectorAll("[data-handle-spouse]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pid = btn.dataset.handleSpouse;
      toggleExtraSpousesFor(pid);
      renderTreeGraph(pid);
    });
  });

  // Bind node click / double-click
  nodesEl.querySelectorAll(".t-node").forEach((card) => {
    card.addEventListener("click", () => {
      const vp = document.getElementById("treeViewport");
      if (vp?.dataset.justDragged === "1") {
        vp.dataset.justDragged = "";
        return;
      }
      const pid = card.dataset.nodePid;
      selectedTreePid = pid;
      selectedPid = pid;
      renderSidebar();
      renderTreeGraph(null);
    });
    card.addEventListener("dblclick", () => {
      selectPerson(card.dataset.nodePid, true);
    });
  });

  if (treeNeedsInitialCenter) {
    treeNeedsInitialCenter = false;
    requestAnimationFrame(() => fitOrCenterInitial());
  } else {
    applyTransform();
  }

  hydrateMediaImages(nodesEl, true);
  renderTreeInspector(nodes);
}

function fitOrCenterInitial() {
  const vp = document.getElementById("treeViewport");
  if (!vp || lastNodePositions.size === 0) return;
  const rect = vp.getBoundingClientRect();
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pos of lastNodePositions.values()) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + CARD_W);
    maxY = Math.max(maxY, pos.y + CARD_H);
  }
  const pad = 56;
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  zoom = Math.min(0.95, Math.max(0.35, Math.min(rect.width / bw, rect.height / bh)));
  panX = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
  panY = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  applyTransform();
}

function renderTreeInspector(layoutNodes = null) {
  const insp = document.getElementById("treeInspector");
  if (!insp) return;
  const p = DATA.people[selectedTreePid];
  if (!p) {
    insp.classList.add("hidden");
    return;
  }
  insp.classList.remove("hidden");

  const bio = getBioHighlights(p);
  const layoutNode = layoutNodes?.get(p.id) || null;

  const parents = [...(p.family.fathers || []), ...(p.family.mothers || [])];
  const spouses = p.family.spouses || [];
  const children = p.family.children || [];
  const siblings = [...(p.family.siblings || []), ...(p.family.halfSiblings || [])];

  const relButtons = [
    ...parents.map((m) => `<button class="ped-mini-btn" data-insp-root="${esc(m.id)}">↑ ${esc(m.name)}</button>`),
    ...spouses.map((m) => {
      const mTag = getMarriageTag(p.id, m.id);
      return `<button class="ped-mini-btn" data-insp-root="${esc(m.id)}">♥ ${esc(m.name)}${mTag ? ` (${esc(mTag)})` : ""}</button>`;
    }),
    ...children.slice(0, 5).map((m) => `<button class="ped-mini-btn" data-insp-root="${esc(m.id)}">↓ ${esc(m.name)}</button>`),
    ...siblings.slice(0, 6).map((m) => `<button class="ped-mini-btn" data-insp-root="${esc(m.id)}">↔ ${esc(m.name)}</button>`),
  ].join("");

  // Build Biographical Highlights block for Quick Inspector
  const bioParts = [];
  if (bio.notes) {
    bioParts.push(`<div class="insp-note"><strong>📝 Note:</strong> ${esc(bio.notes)}</div>`);
  }
  const factItems = [];
  for (const pol of bio.political) {
    factItems.push(
      `<div class="insp-bio-item bio-political"><span class="insp-bio-ico">🏛</span><div><strong>${esc(pol.title)}${pol.date ? ` (${esc(pol.date)})` : ""}</strong>${pol.detail ? `<div class="insp-bio-sub">${esc(pol.detail)}</div>` : ""}</div></div>`
    );
  }
  for (const mil of bio.military) {
    factItems.push(
      `<div class="insp-bio-item bio-military"><span class="insp-bio-ico">🎖</span><div><strong>${esc(mil.title)}${mil.date ? ` (${esc(mil.date)})` : ""}</strong>${mil.detail ? `<div class="insp-bio-sub">${esc(mil.detail)}</div>` : ""}</div></div>`
    );
  }
  if (bio.occupations.length) {
    factItems.push(
      `<div class="insp-bio-item bio-occupation"><span class="insp-bio-ico">💼</span><div><strong>Occupation:</strong> ${esc(bio.occupations.map((o) => (o.date ? `${o.label} (${o.date})` : o.label)).join("; "))}</div></div>`
    );
  }
  if (factItems.length) {
    bioParts.push(`<div class="insp-bio-list">${factItems.join("")}</div>`);
  }
  if (bio.stories.length) {
    bioParts.push(`
      <div class="insp-stories">
        ${bio.stories
          .map(
            (st) =>
              `<button class="insp-story-btn" data-insp-story="${esc(st.id)}">📖 ${esc(st.title)}</button>`
          )
          .join("")}
      </div>
    `);
  }
  if (bio.lifeStory) {
    bioParts.push(`<div class="insp-lifestory">${esc(bio.lifeStory)}</div>`);
  }

  const canToggleSibInInsp = layoutNode && layoutNode.sibCount > 0;
  const sibBtnLabel = layoutNode?.sibsExpanded
    ? `Hide ${layoutNode.sibCount} ${layoutNode.sibCount === 1 ? "Sibling" : "Siblings"}`
    : `+ ${layoutNode?.sibCount} ${layoutNode?.sibCount === 1 ? "Sibling" : "Siblings"}`;

  const canToggleSpouseInInsp = layoutNode && layoutNode.extraSpouseCount > 0;
  const spouseBtnLabel = layoutNode?.extraSpousesExpanded
    ? `Hide ${layoutNode.extraSpouseCount === 1 ? "Other Spouse" : `${layoutNode.extraSpouseCount} Other Spouses`}`
    : `♥ +${layoutNode?.extraSpouseCount} ${layoutNode?.extraSpouseCount === 1 ? "Spouse" : "Spouses"}`;

  insp.innerHTML = `
    <div class="insp-head">
      ${renderAvatar(p, "avatar-sm")}
      <div style="min-width:0;flex:1">
        <div class="insp-name">${esc(p.name)}</div>
        <div class="insp-dates">${esc(p.lifeRange || (p.isLiving ? "Living" : ""))}${p.relationshipLabel ? ` · ${esc(p.relationshipLabel)}` : ""}</div>
      </div>
      <button class="insp-close" id="inspCloseBtn" aria-label="Close">✕</button>
    </div>
    <div class="insp-facts">
      ${p.birthDate || p.birthPlace ? `<div><strong>Birth:</strong> ${esc([p.birthDate, p.birthPlace].filter(Boolean).join(" · "))}</div>` : ""}
      ${p.deathDate || p.deathPlace ? `<div><strong>Death:</strong> ${esc([p.deathDate, p.deathPlace].filter(Boolean).join(" · "))}</div>` : ""}
    </div>
    ${bioParts.length ? `<div class="insp-bio">${bioParts.join("")}</div>` : ""}
    <div class="insp-actions">
      <button class="btn primary" id="inspProfileBtn">View Full Profile</button>
      ${
        p.id !== treeRootPid
          ? `<button class="btn" id="inspSetRootBtn">Set as Tree Root</button>`
          : ""
      }
      ${
        canToggleSibInInsp
          ? `<button class="btn ${layoutNode.sibsExpanded ? "active-toggle" : ""}" id="inspToggleSibBtn">${esc(sibBtnLabel)}</button>`
          : ""
      }
      ${
        canToggleSpouseInInsp
          ? `<button class="btn ${layoutNode.extraSpousesExpanded ? "active-spouse-toggle" : ""}" id="inspToggleSpouseBtn">${esc(spouseBtnLabel)}</button>`
          : ""
      }
      <button class="btn" id="inspFeedbackBtn" title="Send a correction, story, or note">✉ Feedback</button>
    </div>
    ${relButtons ? `<div class="insp-links">${relButtons}</div>` : ""}
  `;

  document.getElementById("inspCloseBtn").addEventListener("click", () => {
    selectedTreePid = null;
    insp.classList.add("hidden");
    renderTreeGraph(null);
  });

  document.getElementById("inspProfileBtn").addEventListener("click", () => {
    selectPerson(p.id, true);
  });

  document.getElementById("inspSetRootBtn")?.addEventListener("click", () => {
    selectPerson(p.id, false);
  });

  document.getElementById("inspToggleSibBtn")?.addEventListener("click", () => {
    toggleSiblingsFor(p.id);
    renderTreeGraph(p.id);
  });

  document.getElementById("inspToggleSpouseBtn")?.addEventListener("click", () => {
    toggleExtraSpousesFor(p.id);
    renderTreeGraph(p.id);
  });

  document.getElementById("inspFeedbackBtn").addEventListener("click", () => {
    openFeedbackModal(p.id);
  });

  insp.querySelectorAll("[data-insp-story]").forEach((b) => {
    b.addEventListener("click", () => {
      openMediaModal(b.dataset.inspStory);
    });
  });

  insp.querySelectorAll("[data-insp-root]").forEach((b) => {
    b.addEventListener("click", () => {
      selectPerson(b.dataset.inspRoot, false);
    });
  });

  hydrateMediaImages(insp, true);
}

/* ==================== Profile View ==================== */

function renderProfile(container, p) {
  if (!p) {
    container.innerHTML = `<div class="loading">Select a person from the left sidebar.</div>`;
    return;
  }

  const bio = getBioHighlights(p);
  const storyText = bio.lifeStory;
  const mediaCards = p.mediaIds
    .map((mid) => DATA.media[mid])
    .filter(Boolean)
    .map(renderMediaCard)
    .join("");

  const timelineHtml = (p.timeline || [])
    .map((ev) => {
      const isFam = ev.category === "Family Event";
      const coordsStr = ev.coordinates ? ` (${ev.coordinates.lat.toFixed(4)}, ${ev.coordinates.lng.toFixed(4)})` : "";
      const targetBtn =
        ev.targetPersonId && DATA.people[ev.targetPersonId]
          ? ` · <button class="ped-mini-btn" data-jump="${esc(ev.targetPersonId)}">${esc(ev.targetPersonName || DATA.people[ev.targetPersonId].name)}</button>`
          : "";
      return `
        <div class="tl-item ${isFam ? "family" : ""}">
          <div class="tl-dot"></div>
          <div class="tl-head">
            <span class="tl-title">${esc(ev.title || ev.eventType)}</span>
            ${ev.date ? `<span class="tl-date">${esc(ev.date)}</span>` : ""}
            ${ev.age !== null && ev.age !== undefined ? `<span class="tl-age">Age ${esc(ev.age)}</span>` : ""}
          </div>
          ${ev.place ? `<div class="tl-place">${esc(ev.place)}${esc(coordsStr)}</div>` : ""}
          ${ev.narrative ? `<div class="tl-narr">${esc(ev.narrative)}${targetBtn}</div>` : targetBtn}
        </div>`;
    })
    .join("");

  const factsHtml = (p.facts || [])
    .map((f) => {
      const cits = (f.citationIds || [])
        .map((cid) => p.sources.find((s) => s.citationId === cid))
        .filter(Boolean)
        .map((s) => s.title)
        .join("; ");
      return `
        <div class="fact-row">
          <div class="fact-top">
            <span class="fact-type">${esc(f.type)}${f.isAlternate ? " (Alternate)" : ""}${f.value ? `: ${esc(f.value)}` : ""}</span>
            <span>${esc(f.date || "")}</span>
          </div>
          ${f.place ? `<div class="fact-detail">📍 ${esc(f.place)}</div>` : ""}
          ${f.description ? `<div class="fact-detail">${esc(f.description)}</div>` : ""}
          ${cits ? `<div class="fact-detail">📚 ${esc(cits)}</div>` : ""}
        </div>`;
    })
    .join("");

  const famSections = [
    ["Fathers", p.family.fathers],
    ["Mothers", p.family.mothers],
    ["Spouses", p.family.spouses],
    ["Children", p.family.children],
    ["Siblings", p.family.siblings],
    ["Half-Siblings", p.family.halfSiblings],
  ]
    .filter(([, arr]) => arr && arr.length > 0)
    .map(
      ([label, arr]) => `
      <div class="fam-group">
        <div class="fam-label">${esc(label)}</div>
        <div class="fam-links">
          ${arr
            .map((m) => {
              const mTag = label === "Spouses" ? getMarriageTag(p.id, m.id) : null;
              const sub = [m.lifeRange, mTag].filter(Boolean).join(" · ");
              return `
              <button class="link-btn" data-jump="${esc(m.id)}">
                <span>${esc(m.name)}</span>
                <small>${esc(sub)}</small>
              </button>`;
            })
            .join("")}
        </div>
      </div>`
    )
    .join("");

  const sourcesHtml = (p.sources || [])
    .map(
      (s) => `
      <div class="fact-row">
        <div class="fact-top"><span class="fact-type">${esc(s.title)}</span></div>
        ${s.detail ? `<div class="fact-detail">${esc(s.detail)}</div>` : ""}
        ${s.publisher || s.publishDate ? `<div class="fact-detail">${esc([s.publisher, s.publishDate].filter(Boolean).join(" · "))}</div>` : ""}
        ${
          s.recordImageId && DATA.media[s.recordImageId]
            ? `<div style="margin-top:6px"><button class="ped-mini-btn" data-media="${esc(s.recordImageId)}">View Record Image</button></div>`
            : ""
        }
      </div>`
    )
    .join("");

  const bioPills = [
    ...bio.political.map((x) => `<span class="pill bio-pill-political">🏛 ${esc(x.date ? `${x.date} Political` : "Political")}</span>`),
    ...bio.military.slice(0, 1).map((x) => `<span class="pill bio-pill-military">🎖 ${esc(x.date ? `Military (${x.date})` : "Military")}</span>`),
    ...bio.occupations.slice(0, 2).map((x) => `<span class="pill bio-pill-occupation">💼 ${esc(x.label)}</span>`),
    ...bio.stories.map((st) => `<button class="pill bio-pill-story" data-media="${esc(st.id)}">📖 ${esc(st.title)}</button>`),
  ].join("");

  container.innerHTML = `
    <div class="profile-hero">
      <div id="heroAvatarWrap">${renderAvatar(p, "avatar-lg")}</div>
      <div class="hero-info">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <h1 style="margin:0">${esc(p.name)}</h1>
          <button class="btn btn-sm" id="viewInTreeBtn">View in Family Tree</button>
          <button class="btn btn-sm" id="profileFeedbackBtn">✉ Send Feedback</button>
        </div>
        <div class="hero-sub">
          ${esc(p.gender)} · ${esc(p.lifeRange || "Dates unknown")}
          ${p.relationshipLabel ? ` · <strong>${esc(p.relationshipLabel)}</strong>` : ""}
        </div>
        ${p.birthDate || p.birthPlace ? `<div class="fact-detail"><strong>Birth:</strong> ${esc([p.birthDate, p.birthPlace].filter(Boolean).join(" • "))}</div>` : ""}
        ${p.deathDate || p.deathPlace ? `<div class="fact-detail"><strong>Death:</strong> ${esc([p.deathDate, p.deathPlace].filter(Boolean).join(" • "))}</div>` : ""}
        ${p.alternateNames?.length ? `<div class="fact-detail"><strong>Also known as:</strong> ${esc(p.alternateNames.join(", "))}</div>` : ""}
        <div class="tag-list">
          <span class="pill">ID: ${esc(p.id)}</span>
          <span class="pill neutral">${p.facts.length} facts</span>
          <span class="pill neutral">${p.sources.length} sources</span>
          <span class="pill neutral">${p.mediaIds.length} media</span>
          ${bioPills}
          ${(p.tags || []).map((t) => `<span class="pill warm">${esc(t)}</span>`).join("")}
        </div>
      </div>
    </div>

    <div class="profile-grid">
      <div>
        ${bio.notes ? `<div class="card card-note"><h2>Notes</h2><p style="margin:0">${esc(bio.notes)}</p></div>` : ""}
        ${storyText ? `<div class="card"><h2>LifeStory</h2><p style="margin:0">${esc(storyText)}</p></div>` : ""}
        <div class="card">
          <h2>Timeline (${p.timeline.length})</h2>
          <div class="timeline-list">${timelineHtml || "<div class='fact-detail'>No timeline events.</div>"}</div>
        </div>
        <div class="card">
          <h2>Facts (${p.facts.length})</h2>
          ${factsHtml || "<div class='fact-detail'>No facts recorded.</div>"}
        </div>
      </div>

      <div>
        <div class="card">
          <h2>Family</h2>
          ${famSections || "<div class='fact-detail'>No linked family members.</div>"}
        </div>
        <div class="card">
          <h2>Media &amp; Stories (${p.mediaIds.length})</h2>
          ${mediaCards ? `<div class="media-grid">${mediaCards}</div>` : "<div class='fact-detail'>No media attached.</div>"}
        </div>
        <div class="card">
          <h2>Sources (${p.sources.length})</h2>
          ${sourcesHtml || "<div class='fact-detail'>No sources attached.</div>"}
        </div>
      </div>
    </div>
  `;

  document.getElementById("viewInTreeBtn").addEventListener("click", () => {
    initTreeRoot(p.id);
    setActiveView("pedigree");
  });

  document.getElementById("profileFeedbackBtn").addEventListener("click", () => {
    openFeedbackModal(p.id);
  });

  container.querySelectorAll("[data-jump]").forEach((el) => {
    el.addEventListener("click", () => selectPerson(el.dataset.jump, true));
  });
  bindMediaClicks(container);
  if (p.primaryMediaId) {
    document.getElementById("heroAvatarWrap").addEventListener("click", () => openMediaModal(p.primaryMediaId));
  }
  hydrateMediaImages(container, true);
}

/* ==================== Media & Sources ==================== */

function renderMediaCard(m) {
  const syncHref = getSyncMediaHref(m);
  let thumb = `<span>${esc(m.type)} (${esc(m.ext)})</span>`;
  if (syncHref && (m.type === "photo" || m.type === "record_media")) {
    thumb = `<img src="${esc(syncHref)}" alt="${esc(m.title)}" loading="lazy" />`;
  } else if (ENC_MODE && m.encFile && (m.type === "photo" || m.type === "record_media")) {
    thumb = `<span class="thumb-loading">Decrypting…</span><img data-enc-media="${esc(m.id)}" class="enc-pending" alt="${esc(m.title)}" />`;
  } else if (m.type === "story_pdf") {
    thumb = `<span>📄 PDF Story<br/>Click to view</span>`;
  } else if (m.type === "story_inline") {
    thumb = `<span>📝 Inline Story<br/>Click to read</span>`;
  } else if (!m.downloaded) {
    thumb = `<span>⏳ Pending download<br/>(${esc(m.type)})</span>`;
  }

  return `
    <div class="media-card" data-media="${esc(m.id)}">
      <div class="media-thumb">${thumb}</div>
      <div class="media-meta">
        <div class="media-title" title="${esc(m.title)}">${esc(m.title || m.id)}</div>
        <div class="media-sub">${esc(m.type)}${m.downloaded ? "" : " · not yet downloaded"}</div>
      </div>
    </div>`;
}

function bindMediaClicks(root) {
  root.querySelectorAll("[data-media]").forEach((el) => {
    el.addEventListener("click", () => openMediaModal(el.dataset.media));
  });
}

async function openMediaModal(mid) {
  const m = DATA.media[mid];
  if (!m) return;
  document.getElementById("modalTitle").textContent = m.title || m.id;
  const body = document.getElementById("modalBody");
  document.getElementById("mediaModal").classList.remove("hidden");

  let href = getSyncMediaHref(m);
  if (!href && ENC_MODE && m.encFile) {
    body.innerHTML = `<div class="loading">Decrypting media…</div>`;
    try {
      href = await getMediaUrl(m);
    } catch {
      href = null;
    }
  }

  let mainHtml = "";
  if (href && (m.type === "photo" || m.type === "record_media")) {
    mainHtml = `<img src="${esc(href)}" alt="${esc(m.title)}" />`;
  } else if (href && m.type === "story_pdf") {
    mainHtml = `<iframe src="${esc(href)}"></iframe><p><a href="${esc(href)}" target="_blank" download="${esc(m.title || m.id)}.pdf">Open / Download PDF</a></p>`;
  } else if (m.type === "story_inline") {
    mainHtml = `<div class="story-box">${esc(m.storyText)}</div>`;
  } else {
    mainHtml = `<p>This media item is not available locally. Source URL on Ancestry:<br/><a href="${esc(m.sourceUrl)}" target="_blank">${esc(m.sourceUrl)}</a></p>`;
  }

  const linkedPeople = (m.linkedPersonIds || [])
    .map((pid) => DATA.people[pid])
    .filter(Boolean)
    .map((p) => `<button class="ped-mini-btn" data-modal-jump="${esc(p.id)}">${esc(p.name)}</button>`)
    .join(" ");

  body.innerHTML = `
    ${mainHtml}
    <div style="margin-top:12px;font-size:13px;color:var(--muted)">
      ${m.description ? `<p><strong>Description:</strong> ${esc(m.description)}</p>` : ""}
      ${m.location ? `<p><strong>Location:</strong> ${esc(m.location)}</p>` : ""}
      ${m.date ? `<p><strong>Date:</strong> ${esc(m.date)}</p>` : ""}
      ${linkedPeople ? `<p><strong>Linked People:</strong> ${linkedPeople}</p>` : ""}
    </div>
  `;

  body.querySelectorAll("[data-modal-jump]").forEach((b) => {
    b.addEventListener("click", () => {
      closeModal();
      selectPerson(b.dataset.modalJump, true);
    });
  });
}

function closeModal() {
  document.getElementById("mediaModal").classList.add("hidden");
  document.getElementById("modalBody").innerHTML = "";
}

function renderAllMedia(container) {
  const items = Object.values(DATA.media);
  container.innerHTML = `
    <div class="card">
      <h2>All Media (${items.length} total · ${items.filter((m) => m.downloaded).length} local)</h2>
      <div class="media-grid">${items.map(renderMediaCard).join("")}</div>
    </div>`;
  bindMediaClicks(container);
  hydrateMediaImages(container, false);
}

function renderAllSources(container) {
  const map = new Map();
  for (const p of Object.values(DATA.people)) {
    for (const s of p.sources || []) {
      const key = s.title || s.sourceId;
      if (!map.has(key)) map.set(key, { title: s.title, publisher: s.publisher, people: [] });
      map.get(key).people.push({ id: p.id, name: p.name, detail: s.detail });
    }
  }
  const rows = [...map.values()].sort((a, b) => b.people.length - a.people.length);
  container.innerHTML = `
    <div class="card">
      <h2>All Sources (${rows.length} unique sources)</h2>
      ${rows
        .map(
          (r) => `
          <div class="fact-row">
            <div class="fact-top">
              <span class="fact-type">${esc(r.title)}</span>
              <span class="pill neutral">${r.people.length} citations</span>
            </div>
            <div class="fact-detail" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:5px">
              ${r.people.map((x) => `<button class="ped-mini-btn" data-jump="${esc(x.id)}">${esc(x.name)}</button>`).join("")}
            </div>
          </div>`
        )
        .join("")}
    </div>`;
  container.querySelectorAll("[data-jump]").forEach((el) => {
    el.addEventListener("click", () => selectPerson(el.dataset.jump, true));
  });
}

/* ==================== Node Feedback Modal ==================== */

let feedbackPid = null;

function bindFeedbackControls() {
  document.getElementById("fbModalClose").addEventListener("click", closeFeedbackModal);
  document.getElementById("feedbackModal").addEventListener("click", (e) => {
    if (e.target.id === "feedbackModal") closeFeedbackModal();
  });

  for (const id of ["fbTopic", "fbSenderName", "fbMessage"]) {
    const el = document.getElementById(id);
    const handler = () => {
      if (id === "fbSenderName") {
        try {
          localStorage.setItem("ancestry_fb_name", el.value);
        } catch {}
      }
      updateFeedbackLinks();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  }

  document.getElementById("fbCopyBtn").addEventListener("click", async () => {
    const { to, subject, body } = buildFeedbackEmailContent();
    const text = `${to ? `To: ${to}\n` : ""}Subject: ${subject}\n\n${body}`;
    const btn = document.getElementById("fbCopyBtn");
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "✓ Copied!";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => {
      btn.textContent = "Copy Message";
    }, 2000);
  });
}

function openFeedbackModal(pid) {
  const p = DATA?.people?.[pid];
  if (!p) return;
  feedbackPid = pid;

  document.getElementById("fbModalTitle").textContent = `Send Feedback · ${p.name}`;
  document.getElementById("fbPersonBanner").innerHTML =
    `<strong>${esc(p.name)}</strong>${p.lifeRange ? ` · ${esc(p.lifeRange)}` : ""}<br/><span style="color:var(--muted);font-size:12px">Person ID: ${esc(p.id)}</span>`;

  const senderEl = document.getElementById("fbSenderName");
  if (!senderEl.value) {
    try {
      senderEl.value = localStorage.getItem("ancestry_fb_name") || "";
    } catch {}
  }
  document.getElementById("fbMessage").value = "";
  updateFeedbackLinks();

  document.getElementById("feedbackModal").classList.remove("hidden");
  document.getElementById("fbMessage").focus();
}

function closeFeedbackModal() {
  document.getElementById("feedbackModal").classList.add("hidden");
  feedbackPid = null;
}

function buildFeedbackEmailContent() {
  const p = DATA?.people?.[feedbackPid];
  const to = DATA?.tree?.feedbackEmail || "";
  const topic = document.getElementById("fbTopic").value;
  const sender = document.getElementById("fbSenderName").value.trim();
  const message = document.getElementById("fbMessage").value.trim();

  const personLabel = p ? `${p.name}${p.lifeRange ? ` (${p.lifeRange})` : ""}` : "Family Tree";
  const subject = `[Family Tree] ${topic}: ${p ? p.name : "General"}`;
  const lines = [
    `Tree: ${DATA?.tree?.treeName || "Family Tree"}`,
    `Person: ${personLabel}`,
    p ? `Person ID: ${p.id}` : "",
    `Topic: ${topic}`,
    sender ? `From: ${sender}` : "",
    "",
    message || "(Write your notes or correction here)",
  ].filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""));

  return { to, subject, body: lines.join("\n") };
}

function updateFeedbackLinks() {
  const { to, subject, body } = buildFeedbackEmailContent();
  const mailtoUrl = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  document.getElementById("fbMailtoBtn").href = mailtoUrl;
  document.getElementById("fbGmailBtn").href = gmailUrl;

  const noteEl = document.getElementById("fbRecipientNote");
  noteEl.textContent = to
    ? `Addressed to ${to} — opens pre-filled in your email app or Gmail.`
    : `Opens a pre-filled draft in your email app or Gmail (enter recipient address before sending).`;
}

init();
