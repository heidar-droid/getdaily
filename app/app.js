/* Daily — client (public, multi-user). Clerk auth + Supabase Postgres w/ RLS. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Clerk } from "https://esm.sh/@clerk/clerk-js@5";
import { renderShareCard, shareOrDownload } from "/app/share-card.js";

const CLERK_PK = "pk_live_Y2xlcmsuZ2V0ZGFpbHkuZGF5JA";
const clerk = new Clerk(CLERK_PK);

const SB_URL = "https://vsroavacejmeiaosgubk.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzcm9hdmFjZWptZWlhb3NndWJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxNTEwMjAsImV4cCI6MjA5OTcyNzAyMH0.5N8n2qYjVo0ys4FAbts6nHTx6L3l_83UHiUUDDZFQ9g";
const sb = createClient(SB_URL, SB_ANON, {
  accessToken: async () => (clerk.session ? await clerk.session.getToken() : null),
});

const $ = (s) => document.querySelector(s);
const THEME_STORE = "daily.theme";
const DAY_ROLL_HOUR = 4; // day rolls at 04:00, not midnight

let viewDate = todayStr();
let state = { tasks: [], rituals: [], notes: [] };
let checksByRitual = new Map(); // ritual_id -> Set("YYYY-MM-DD")
let shownPct = 0;
let profile = { name: "", avatar: null, onboarded: true };
let userEmail = "";

// ---------- helpers ----------

function updateScrolly(el) {
  requestAnimationFrame(() => el.classList.toggle("scrolly", el.scrollHeight > el.clientHeight + 2));
}

function collapse(el, done) {
  const h = el.offsetHeight;
  el.style.overflow = "hidden";
  const cs = getComputedStyle(el);
  const anim = el.animate(
    [
      { height: h + "px", opacity: 1, transform: "none",
        marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
      { height: h + "px", opacity: 0, transform: "translateX(18px) scale(.97)", offset: .45,
        marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
      { height: "0px", opacity: 0, transform: "translateX(18px) scale(.97)",
        marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" },
    ],
    { duration: 480, easing: "cubic-bezier(.22,1,.36,1)" }
  );
  anim.onfinish = done;
}

// ---------- day math ----------

function todayStr() {
  return localISO(new Date(Date.now() - DAY_ROLL_HOUR * 3600 * 1000));
}
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shiftDate(iso, days) {
  const [y, m, dd] = iso.split("-").map(Number);
  return localISO(new Date(y, m - 1, dd + days));
}
function asDate(iso) {
  const [y, m, dd] = iso.split("-").map(Number);
  return new Date(y, m - 1, dd);
}

// ---------- save indicator ----------

const saveEl = $("#save-state");
let saveTimer;
function saving() { saveEl.dataset.state = "saving"; saveEl.textContent = "saving"; }
function saved() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveEl.dataset.state = "saved"; saveEl.textContent = "saved"; }, 150);
}
async function persist(fn) {
  saving();
  try { const r = await fn(); saved(); return r; }
  catch (e) { saveEl.dataset.state = "saving"; saveEl.textContent = "offline"; throw e; }
}
function must({ data, error }) {
  if (error) throw error;
  return data;
}

// ---------- auth (Clerk) ----------

const gate = $("#gate");
let authMode = "signin";
let pendingSignupName = "";

function showGate() {
  gate.hidden = false;
  $("#app").hidden = true;
}
function authError(msg) {
  gate.classList.remove("shake");
  void gate.offsetWidth;
  gate.classList.add("shake");
  $("#auth-error").textContent = (msg || "something went wrong").toLowerCase();
  setTimeout(() => ($("#auth-error").innerHTML = "&nbsp;"), 3500);
}

$("#auth-google").addEventListener("click", async () => {
  try {
    await clerk.client.signIn.authenticateWithRedirect({
      strategy: "oauth_google",
      redirectUrl: "/app/#sso",
      redirectUrlComplete: "/app/",
    });
  } catch (e) {
    authError(e.errors?.[0]?.longMessage || e.message);
  }
});

$("#auth-mode").addEventListener("click", () => {
  authMode = authMode === "signin" ? "signup" : "signin";
  $("#auth-name").hidden = authMode === "signin";
  $("#auth-code").hidden = true;
  $("#auth-submit").textContent = authMode === "signin" ? "Sign in" : "Create account";
  $("#auth-mode").innerHTML = authMode === "signin"
    ? "New here? <strong>Create an account</strong>"
    : "Have an account? <strong>Sign in</strong>";
  $("#auth-pass").autocomplete = authMode === "signin" ? "current-password" : "new-password";
  (authMode === "signup" ? $("#auth-name") : $("#auth-email")).focus();
});

let awaitingCode = false;

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const pass = $("#auth-pass").value;
  $("#auth-submit").disabled = true;
  try {
    if (awaitingCode) {
      const res = await clerk.client.signUp.attemptEmailAddressVerification({ code: $("#auth-code").value.trim() });
      if (res.status === "complete") {
        await clerk.setActive({ session: res.createdSessionId });
        gate.hidden = true;
        start();
      } else {
        authError("that code didn't work");
      }
      return;
    }
    if (authMode === "signup") {
      const name = $("#auth-name").value.trim();
      if (!name) { $("#auth-name").focus(); return; }
      pendingSignupName = name;
      const res = await clerk.client.signUp.create({ emailAddress: email, password: pass, firstName: name });
      if (res.status === "complete") {
        await clerk.setActive({ session: res.createdSessionId });
        gate.hidden = true;
        start();
      } else if (res.unverifiedFields?.includes("email_address")) {
        await clerk.client.signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        awaitingCode = true;
        $("#auth-code").hidden = false;
        $("#auth-submit").textContent = "Verify";
        $("#auth-code").focus();
      } else {
        authError("couldn't finish sign up");
      }
    } else {
      const res = await clerk.client.signIn.create({ identifier: email, password: pass });
      if (res.status === "complete") {
        await clerk.setActive({ session: res.createdSessionId });
        gate.hidden = true;
        start();
      } else {
        authError("sign in needs another step; try google");
      }
    }
  } catch (err) {
    authError(err.errors?.[0]?.longMessage || err.message);
  } finally {
    $("#auth-submit").disabled = false;
  }
});

// ---------- masthead ----------

function renderDate() {
  const d = asDate(viewDate);
  const isToday = viewDate === todayStr();
  const month = d.toLocaleDateString("en-GB", { month: "long" });
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  $("#date-title").innerHTML =
    `${month} ${d.getDate()}` + (isToday ? "" : `<span class="past-tag">${weekday}</span>`);
  const who = profile.name || "there";
  let greet;
  if (isToday) {
    const h = new Date().getHours();
    greet = h < DAY_ROLL_HOUR ? `Still yours till 04:00, ${who}`
      : h < 12 ? `Good morning, ${who}`
      : h < 18 ? `Good afternoon, ${who}`
      : `Good evening, ${who}`;
  } else {
    greet = "Looking back";
  }
  $("#greeting").textContent = greet;
}

// ---------- day pills ----------

async function renderDays() {
  const today = todayStr();
  const first = shiftDate(today, -13);
  const [tasks, notes] = await Promise.all([
    sb.from("tasks").select("date,done").gte("date", first).lte("date", today),
    sb.from("notes").select("date").gte("date", first).lte("date", today),
  ]);
  const tmap = {};
  for (const t of tasks.data || []) {
    tmap[t.date] = tmap[t.date] || { total: 0, done: 0 };
    tmap[t.date].total++;
    if (t.done) tmap[t.date].done++;
  }
  const noteDays = new Set((notes.data || []).map((n) => n.date));

  const nav = $("#days");
  nav.innerHTML = "";
  for (let i = 13; i >= 0; i--) {
    const dstr = shiftDate(today, -i);
    const dt = asDate(dstr);
    const t = tmap[dstr];
    const b = document.createElement("button");
    b.className = "day-pill";
    b.dataset.current = dstr === viewDate ? "1" : "0";
    b.dataset.has = (t?.total || noteDays.has(dstr)) ? "1" : "0";
    b.innerHTML =
      `<span class="dow">${dt.toLocaleDateString("en-GB", { weekday: "short" }).slice(0, 2).toUpperCase()}</span>` +
      `<span class="dom">${dt.getDate()}</span>` +
      `<span class="mark"></span>`;
    b.addEventListener("click", () => gotoDate(dstr));
    nav.appendChild(b);
  }
  nav.scrollLeft = nav.scrollWidth;
}

// ---------- hero ring ----------

const RING_DOTS = 24;

function buildRing() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 132 132");
  const c = 66;
  [46, 53, 60].forEach((r, ri) => {
    const n = Math.round(r * 0.55);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ri * 0.35;
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", (c + r * Math.cos(a)).toFixed(2));
      dot.setAttribute("cy", (c + r * Math.sin(a)).toFixed(2));
      dot.setAttribute("r", "1");
      dot.setAttribute("class", "halo-dot");
      dot.setAttribute("opacity", (0.16 - ri * 0.05).toFixed(2));
      svg.appendChild(dot);
    }
  });
  for (let i = 0; i < RING_DOTS; i++) {
    const a = (i / RING_DOTS) * Math.PI * 2 - Math.PI / 2;
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", (c + 34 * Math.cos(a)).toFixed(2));
    dot.setAttribute("cy", (c + 34 * Math.sin(a)).toFixed(2));
    dot.setAttribute("r", "2.4");
    dot.setAttribute("class", "p-dot");
    dot.dataset.idx = i;
    svg.appendChild(dot);
  }
  $("#ring").appendChild(svg);
}

function renderHero() {
  const total = state.tasks.length;
  const done = state.tasks.filter((t) => t.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const on = total ? Math.round((done / total) * RING_DOTS) : 0;
  document.querySelectorAll(".p-dot").forEach((dot) => {
    const i = Number(dot.dataset.idx);
    const should = i < on;
    if (should === dot.classList.contains("on")) return;
    setTimeout(() => dot.classList.toggle("on", should), Math.abs(i - on) * 18);
  });
  const el = $("#pct"), from = shownPct, delta = pct - from;
  if (delta !== 0) {
    const t0 = performance.now(), dur = 550;
    (function step(t) {
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.innerHTML = `${Math.round(from + delta * eased)}<span class="pct-sign">%</span>`;
      if (k < 1) requestAnimationFrame(step);
    })(t0);
    shownPct = pct;
  } else {
    el.innerHTML = `${pct}<span class="pct-sign">%</span>`;
  }
  $("#pct-sub").textContent = total
    ? `${done} of ${total} task${total === 1 ? "" : "s"} done`
    : "nothing on the board yet";
}

// ---------- rituals ----------

const CHECK_SVG = `<svg viewBox="0 0 26 26"><circle class="ring-c" cx="13" cy="13" r="11"/><circle class="fill-c" cx="13" cy="13" r="11"/><path class="tick-c" d="M8.5 13.4l3.1 3.1 6-6.8"/></svg>`;

function streakOf(ritualId, upto) {
  const set = checksByRitual.get(ritualId) || new Set();
  let streak = 0, cur = upto;
  while (set.has(cur)) { streak++; cur = shiftDate(cur, -1); }
  return streak;
}

function renderRituals() {
  const ul = $("#rituals");
  ul.innerHTML = "";
  state.rituals.forEach((r, i) => {
    const checked = (checksByRitual.get(r.id) || new Set()).has(viewDate);
    const streak = streakOf(r.id, viewDate);
    const li = document.createElement("li");
    li.className = "ritual" + (checked ? " checked-row" : "");
    li.style.animationDelay = `${i * 40}ms`;
    li.innerHTML = `
      <button class="check" aria-label="Toggle">${CHECK_SVG}</button>
      <span class="ritual-label"></span>
      <span class="streak">${streak > 0 ? "×" + streak : ""}</span>
      <button class="ritual-del" aria-label="Remove">×</button>`;
    li.querySelector(".ritual-label").textContent = r.label;
    li.querySelector(".check").addEventListener("click", () => toggleRitual(r, li));
    li.querySelector(".ritual-del").addEventListener("click", async () => {
      if (!confirm(`Remove "${r.label}" and its streak?`)) return;
      persist(async () => must(await sb.from("rituals").update({ active: false }).eq("id", r.id).select()));
      collapse(li, () => { state.rituals = state.rituals.filter((x) => x.id !== r.id); renderRituals(); });
    });
    ul.appendChild(li);
  });
  updateScrolly(ul);
}

async function toggleRitual(r, li) {
  const set = checksByRitual.get(r.id) || new Set();
  checksByRitual.set(r.id, set);
  const nowChecked = !set.has(viewDate);
  if (nowChecked) set.add(viewDate); else set.delete(viewDate);
  li.classList.toggle("checked-row", nowChecked);
  const st = li.querySelector(".streak");
  const streak = streakOf(r.id, viewDate);
  st.textContent = streak > 0 ? "×" + streak : "";
  st.classList.remove("tick"); void st.offsetWidth; st.classList.add("tick");
  if (nowChecked) maybeMilestone(r, streak);
  await persist(async () => {
    if (nowChecked) {
      must(await sb.from("ritual_checks").upsert({ ritual_id: r.id, date: viewDate }).select());
    } else {
      must(await sb.from("ritual_checks").delete().eq("ritual_id", r.id).eq("date", viewDate).select());
    }
  });
}

$("#ritual-add-btn").addEventListener("click", () => {
  const f = $("#ritual-form");
  f.hidden = !f.hidden;
  if (!f.hidden) $("#ritual-input").focus();
});
$("#ritual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#ritual-input");
  const label = input.value.trim();
  if (!label) return;
  input.value = "";
  $("#ritual-form").hidden = true;
  await persist(async () => {
    const row = must(await sb.from("rituals").insert({ label }).select().single());
    state.rituals.push(row);
    renderRituals();
  });
});
$("#ritual-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#ritual-form").hidden = true;
});

// ---------- tasks ----------

function renderTasks() {
  const ul = $("#tasks");
  ul.innerHTML = "";
  const ordered = [...state.tasks].sort((a, b) => (a.done - b.done) || (a.position - b.position) || (a.id - b.id));
  ordered.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "task" + (t.done ? " done" : "");
    li.style.animationDelay = `${i * 35}ms`;
    li.dataset.id = t.id;
    li.innerHTML = `
      <button class="check" aria-label="Toggle">${CHECK_SVG}</button>
      <span class="task-text"></span>
      <button class="task-del" aria-label="Delete">×</button>`;
    li.querySelector(".task-text").textContent = t.text;
    li.querySelector(".check").addEventListener("click", () => toggleTask(t, li));
    li.querySelector(".task-del").addEventListener("click", async () => {
      persist(async () => must(await sb.from("tasks").delete().eq("id", t.id).select()));
      collapse(li, () => {
        state.tasks = state.tasks.filter((x) => x.id !== t.id);
        renderTasks(); renderHero(); renderDays();
      });
    });
    ul.appendChild(li);
  });
  const total = state.tasks.length, done = state.tasks.filter((t) => t.done).length;
  $("#task-count").textContent = total ? `${done} / ${total}` : "";
  $("#tasks-empty").hidden = total > 0;
  updateScrolly(ul);
}

function toggleTask(t, li) {
  const ul = $("#tasks");
  const first = new Map([...ul.children].map((el) => [el.dataset.id, el.getBoundingClientRect().top]));
  t.done = !t.done;
  li.classList.toggle("done", t.done);
  renderHero();
  persist(async () =>
    must(await sb.from("tasks").update({ done: t.done, done_at: t.done ? new Date().toISOString() : null }).eq("id", t.id).select())
  ).then(() => renderDays());
  setTimeout(() => {
    renderTasks();
    for (const el of [...$("#tasks").children]) {
      const prev = first.get(el.dataset.id);
      if (prev == null) continue;
      const delta = prev - el.getBoundingClientRect().top;
      el.style.animation = "none";
      if (!delta) continue;
      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        { duration: 450, easing: "cubic-bezier(.16,1,.3,1)" }
      );
    }
  }, 420);
}

$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#task-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await persist(async () => {
    const pos = state.tasks.length ? Math.max(...state.tasks.map((t) => t.position)) + 1 : 0;
    const row = must(await sb.from("tasks").insert({ date: viewDate, text, position: pos }).select().single());
    state.tasks.push(row);
    renderTasks(); renderHero(); renderDays();
    const tl = $("#tasks");
    const lastOpen = [...tl.children].filter((el) => !el.classList.contains("done")).pop();
    (lastOpen || tl.lastElementChild)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  input.focus();
});

// ---------- notes ----------

const noteInput = $("#note-input");

function renderNotes() {
  const ul = $("#notes");
  ul.innerHTML = "";
  state.notes.forEach((n, i) => {
    const li = document.createElement("li");
    li.className = "note-item";
    li.style.animationDelay = `${i * 35}ms`;
    const when = new Date(n.created_at);
    const hhmm = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    li.innerHTML = `
      <p class="note-text"></p>
      <div class="note-meta">
        <span class="note-time">${hhmm}</span>
        <button class="note-del" aria-label="Delete note">×</button>
      </div>`;
    li.querySelector(".note-text").textContent = n.text;
    li.querySelector(".note-del").addEventListener("click", async () => {
      persist(async () => must(await sb.from("notes").delete().eq("id", n.id).select()));
      collapse(li, () => {
        state.notes = state.notes.filter((x) => x.id !== n.id);
        renderNotes(); renderDays();
      });
    });
    ul.appendChild(li);
  });
  const count = state.notes.length;
  $("#note-count").textContent = count || "";
  $("#notes-empty").hidden = count > 0;
  updateScrolly(ul);
}

async function submitNote() {
  const text = noteInput.value.trim();
  if (!text) return;
  noteInput.value = "";
  autoGrow();
  await persist(async () => {
    const row = must(await sb.from("notes").insert({ date: viewDate, text }).select().single());
    state.notes.push(row);
    renderNotes(); renderDays();
    const last = $("#notes").lastElementChild;
    if (last) { last.style.animationDelay = "0ms"; last.classList.add("fresh"); }
    $("#notes").scrollTop = $("#notes").scrollHeight;
  });
  noteInput.focus();
}

$("#note-form").addEventListener("submit", (e) => { e.preventDefault(); submitNote(); });
noteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitNote(); }
});
noteInput.addEventListener("input", autoGrow);
function autoGrow() {
  noteInput.style.height = "auto";
  noteInput.style.height = Math.min(noteInput.scrollHeight, 144) + "px";
}

// ---------- day navigation ----------

async function gotoDate(d) {
  if (d === viewDate || d > todayStr()) return;
  const panel = $("#panel"), head = document.querySelector(".masthead-top");
  panel.classList.add("swap-out"); head.classList.add("swap-out");
  await new Promise((r) => setTimeout(r, 200));
  viewDate = d;
  await loadDay();
  for (const el of [panel, head]) {
    el.classList.remove("swap-out"); el.classList.add("swap-in");
    setTimeout(() => el.classList.remove("swap-in"), 450);
  }
}

// ---------- theme ----------

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_STORE, t);
}
function toggleTheme(x, y) {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  if (!document.startViewTransition) { applyTheme(next); return; }
  const vt = document.startViewTransition(() => applyTheme(next));
  vt.ready.then(() => {
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 650, easing: "cubic-bezier(.16,1,.3,1)", pseudoElement: "::view-transition-new(root)" }
    );
  });
}
$("#theme-toggle").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  toggleTheme(r.left + r.width / 2, r.top + r.height / 2);
});

// ---------- profile ----------

const sheet = $("#profile-sheet"), backdrop = $("#sheet-backdrop");

function renderAvatar() {
  const photo = profile.avatar || (clerk.user?.hasImage ? clerk.user.imageUrl : null);
  for (const el of [$("#avatar"), $("#avatar-big")]) {
    if (photo) {
      el.style.backgroundImage = `url(${photo})`;
      el.textContent = "";
    } else {
      el.style.backgroundImage = "";
      el.textContent = (profile.name || "?").slice(0, 1).toUpperCase();
    }
  }
}

function openSheet() {
  $("#profile-name").value = profile.name;
  $("#sheet-email").textContent = userEmail;
  backdrop.hidden = false; sheet.hidden = false;
  backdrop.classList.remove("closing"); sheet.classList.remove("closing");
}
function closeSheet() {
  backdrop.classList.add("closing"); sheet.classList.add("closing");
  setTimeout(() => { backdrop.hidden = true; sheet.hidden = true; }, 280);
  const name = $("#profile-name").value.trim();
  if (name && name !== profile.name) {
    profile.name = name;
    renderDate(); renderAvatar();
    persist(async () => must(await sb.from("profiles").update({ name }).eq("id", uid()).select()));
  }
}
$("#profile-btn").addEventListener("click", openSheet);
backdrop.addEventListener("click", closeSheet);
$("#profile-name").addEventListener("keydown", (e) => { if (e.key === "Enter") closeSheet(); });
$("#sheet-theme").addEventListener("click", () => toggleTheme(innerWidth / 2, innerHeight / 2));
$("#sign-out").addEventListener("click", async () => {
  await clerk.signOut();
  location.href = "/app/";
});

let sessionUserId = null;
function uid() { return sessionUserId; }

// avatar cropper
const cropper = $("#cropper"), cropImg = $("#crop-img"), cropZoom = $("#crop-zoom");
const VIEW = 264;
let crop = null;

$("#avatar-edit").addEventListener("click", () => $("#avatar-file").click());
$("#avatar-file").addEventListener("change", () => {
  const file = $("#avatar-file").files[0];
  $("#avatar-file").value = "";
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const minS = Math.max(VIEW / img.naturalWidth, VIEW / img.naturalHeight);
    crop = { natW: img.naturalWidth, natH: img.naturalHeight, minS, s: minS,
      x: (VIEW - img.naturalWidth * minS) / 2, y: (VIEW - img.naturalHeight * minS) / 2 };
    cropImg.src = img.src;
    cropZoom.value = 0;
    cropper.hidden = false;
    applyCrop();
  };
  img.src = URL.createObjectURL(file);
});

function clampCrop() {
  crop.x = Math.min(0, Math.max(VIEW - crop.natW * crop.s, crop.x));
  crop.y = Math.min(0, Math.max(VIEW - crop.natH * crop.s, crop.y));
}
function applyCrop() {
  clampCrop();
  cropImg.style.transform = `translate(${crop.x}px, ${crop.y}px) scale(${crop.s})`;
  cropImg.style.width = crop.natW + "px";
}

let dragging = null;
$("#crop-viewport").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  dragging = { px: e.clientX, py: e.clientY };
  e.currentTarget.setPointerCapture(e.pointerId);
});
$("#crop-viewport").addEventListener("pointermove", (e) => {
  if (!dragging || !crop) return;
  crop.x += e.clientX - dragging.px;
  crop.y += e.clientY - dragging.py;
  dragging = { px: e.clientX, py: e.clientY };
  applyCrop();
});
$("#crop-viewport").addEventListener("pointerup", () => { dragging = null; });
$("#crop-viewport").addEventListener("pointercancel", () => { dragging = null; });

cropZoom.addEventListener("input", () => {
  if (!crop) return;
  const t = Number(cropZoom.value) / 100;
  const next = crop.minS * (1 + 3 * t);
  const cx = (VIEW / 2 - crop.x) / crop.s, cy = (VIEW / 2 - crop.y) / crop.s;
  crop.s = next;
  crop.x = VIEW / 2 - cx * crop.s;
  crop.y = VIEW / 2 - cy * crop.s;
  applyCrop();
});

function closeCropper() {
  cropper.hidden = true;
  if (cropImg.src.startsWith("blob:")) URL.revokeObjectURL(cropImg.src);
  cropImg.src = "";
  crop = null;
}
$("#crop-cancel").addEventListener("click", closeCropper);
$("#crop-save").addEventListener("click", async () => {
  if (!crop) return;
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = S; canvas.height = S;
  canvas.getContext("2d").drawImage(
    cropImg, -crop.x / crop.s, -crop.y / crop.s, VIEW / crop.s, VIEW / crop.s, 0, 0, S, S
  );
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  closeCropper();
  profile.avatar = dataUrl;
  renderAvatar();
  await persist(async () => must(await sb.from("profiles").update({ avatar: dataUrl }).eq("id", uid()).select()));
});

// ---------- coach-mark tour ----------

const TOUR_STEPS = [
  { sel: ".card-hero", text: "This ring fills as you finish today's tasks. Small wins, made visible." },
  { sel: "#card-rituals", text: "Non-negotiables — the few things you do every single day. They reset each morning and build a streak." },
  { sel: "#share-btn", text: "When a streak is worth flexing, share it. This turns your streaks into a card for your Story, no task text ever included." },
  { sel: ".card-ink", text: "Today's tasks. Done work stays on the board — wins should be seen." },
  { sel: "#card-notes", text: "Catch thoughts here as they come. Each one is saved with its moment." },
  { sel: "#days", text: "Your last 14 days. Tap any dot to look back. And one detail: your day rolls over at 04:00, not midnight." },
];
let tourStep = 0;

function tourShow(i) {
  tourStep = i;
  const step = TOUR_STEPS[i];
  const target = document.querySelector(step.sel);
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => {
    const r = target.getBoundingClientRect();
    const spot = $("#tour-spot");
    spot.style.top = r.top - 8 + "px";
    spot.style.left = r.left - 8 + "px";
    spot.style.width = r.width + 16 + "px";
    spot.style.height = r.height + 16 + "px";
    $("#tour-text").textContent = step.text;
    $("#tour-dots").innerHTML = TOUR_STEPS.map((_, j) =>
      `<span class="tour-dot${j === i ? " on" : ""}"></span>`).join("");
    $("#tour-next").textContent = i === TOUR_STEPS.length - 1 ? "Done" : "Next";
    const tip = $("#tour-tip");
    const below = r.bottom + 12;
    tip.style.top = (below + 170 < innerHeight ? below : Math.max(12, r.top - 12 - 150)) + "px";
    tip.style.left = Math.min(Math.max(12, r.left), innerWidth - tip.offsetWidth - 12) + "px";
  }, 350);
}

async function endTour() {
  $("#tour").hidden = true;
  profile.onboarded = true;
  await sb.from("profiles").update({ onboarded: true }).eq("id", uid());
}
$("#tour-skip").addEventListener("click", endTour);
$("#tour-next").addEventListener("click", () => {
  if (tourStep >= TOUR_STEPS.length - 1) endTour();
  else tourShow(tourStep + 1);
});

function maybeStartTour() {
  if (profile.onboarded) return;
  setTimeout(() => { $("#tour").hidden = false; tourShow(0); }, 900);
}

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing) { if (e.key === "Escape") document.activeElement.blur(); return; }
  if (e.key === "Escape" && !sheet.hidden) { closeSheet(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "t") { e.preventDefault(); $("#task-input").focus(); }
  if (e.key === "n") { e.preventDefault(); noteInput.focus(); }
  if (e.key === "[") gotoDate(shiftDate(viewDate, -1));
  if (e.key === "]") gotoDate(shiftDate(viewDate, 1));
  if (e.key === "d") { const r = $("#theme-toggle").getBoundingClientRect(); toggleTheme(r.left + 18, r.top + 18); }
});

// ---------- boot ----------

async function loadDay() {
  const [tasks, notes, rituals, checks] = await Promise.all([
    sb.from("tasks").select().eq("date", viewDate).order("position").order("id"),
    sb.from("notes").select().eq("date", viewDate).order("id"),
    sb.from("rituals").select().eq("active", true).order("position").order("id"),
    sb.from("ritual_checks").select("ritual_id,date").lte("date", viewDate).order("date", { ascending: false }).limit(2000),
  ]);
  state.tasks = tasks.data || [];
  state.notes = notes.data || [];
  state.rituals = rituals.data || [];
  checksByRitual = new Map();
  for (const c of checks.data || []) {
    if (!checksByRitual.has(c.ritual_id)) checksByRitual.set(c.ritual_id, new Set());
    checksByRitual.get(c.ritual_id).add(c.date);
  }
  renderDate();
  renderRituals();
  renderTasks();
  renderHero();
  renderNotes();
  renderDays();
}

async function start() {
  if (!clerk.user) { showGate(); return; }
  sessionUserId = clerk.user.id;
  userEmail = clerk.user.primaryEmailAddress?.emailAddress || "";
  let { data: p } = await sb.from("profiles").select().eq("id", sessionUserId).maybeSingle();
  if (!p) {
    const name = pendingSignupName || clerk.user.firstName ||
      (userEmail ? userEmail.split("@")[0] : "there");
    const ins = await sb.from("profiles").insert({ id: sessionUserId, name }).select().maybeSingle();
    p = ins.data || { id: sessionUserId, name, avatar: null, onboarded: false };
  }
  profile = p;
  renderAvatar();
  gate.hidden = true;
  $("#app").hidden = false;
  if (!$("#ring svg")) buildRing();
  await loadDay();
  maybeStartTour();
  setInterval(renderDate, 60_000);
}

// ---------- share card ----------

const shareSheet = $("#share-sheet");
const shareCanvas = $("#share-canvas");
let shareTheme = "dark";

function shareData() {
  const streaks = state.rituals
    .map((r) => ({ label: r.label, streak: streakOf(r.id, viewDate) }))
    .filter((s) => s.streak > 0)
    .sort((a, b) => b.streak - a.streak)
    .slice(0, 3);
  const d = asDate(viewDate);
  return {
    streaks,
    completion: { done: state.tasks.filter((t) => t.done).length, total: state.tasks.length },
    dateLabel: d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
  };
}

function paintShareFlip() {
  $("#share-theme-dark").classList.toggle("on", shareTheme === "dark");
  $("#share-theme-light").classList.toggle("on", shareTheme === "light");
}

function openShareSheet() {
  shareTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  paintShareFlip();
  renderShareCard(shareCanvas, shareData(), shareTheme);
  const go = $("#share-go");
  go.textContent = "Share"; go.classList.remove("done");
  backdrop.hidden = false; shareSheet.hidden = false;
  backdrop.classList.remove("closing"); shareSheet.classList.remove("closing");
}
function closeShareSheet() {
  backdrop.classList.add("closing"); shareSheet.classList.add("closing");
  setTimeout(() => { backdrop.hidden = true; shareSheet.hidden = true; }, 280);
}
function flipShareTheme(t) {
  if (t === shareTheme) return;
  shareTheme = t;
  paintShareFlip();
  shareCanvas.classList.add("flipping");
  setTimeout(async () => {
    await renderShareCard(shareCanvas, shareData(), shareTheme);
    shareCanvas.classList.remove("flipping");
  }, 180);
}

$("#share-btn").addEventListener("click", openShareSheet);
$("#share-theme-dark").addEventListener("click", () => flipShareTheme("dark"));
$("#share-theme-light").addEventListener("click", () => flipShareTheme("light"));
$("#share-go").addEventListener("click", async () => {
  const go = $("#share-go");
  const result = await shareOrDownload(shareCanvas);
  if (result === "cancelled") return;
  go.textContent = result === "shared" ? "Shared ✓" : "Saved ✓";
  go.classList.add("done");
  setTimeout(closeShareSheet, 900);
});
backdrop.addEventListener("click", () => { if (!shareSheet.hidden) closeShareSheet(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !shareSheet.hidden) closeShareSheet();
});

// milestone nudge: one-time toast when a streak lands on a milestone
const MILESTONES = [7, 14, 30, 50, 100, 365];
let toastTimer = null;

function maybeMilestone(r, streak) {
  if (!MILESTONES.includes(streak)) return;
  const key = `daily.ms.${r.id}.${streak}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, "1");
  const toast = $("#milestone-toast");
  $("#milestone-text").textContent = `×${streak} on ${r.label} —`;
  toast.hidden = false;
  toast.classList.remove("leaving");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dismissToast(), 7000);
  toast.onclick = () => { dismissToast(); openShareSheet(); };
}
function dismissToast() {
  const toast = $("#milestone-toast");
  if (toast.hidden) return;
  toast.classList.add("leaving");
  setTimeout(() => { toast.hidden = true; }, 300);
}

applyTheme(localStorage.getItem(THEME_STORE) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

(async () => {
  await clerk.load({ standardBrowser: true });
  if (location.hash === "#sso") {
    try {
      await clerk.handleRedirectCallback({ redirectUrlComplete: "/app/" });
      return; // clerk navigates on completion
    } catch (e) {
      history.replaceState(null, "", "/app/");
    }
  }
  start();
})();
