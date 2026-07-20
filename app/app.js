/* Daily — client (public, multi-user). Clerk auth + Supabase Postgres w/ RLS. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Clerk } from "https://esm.sh/@clerk/clerk-js@5";
import { renderShareCard, shareOrDownload, downloadCard } from "/app/share-card.js";

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
    decorateInstants(li, "ritual", r, checked);
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
  if (nowChecked) freshProve.add("ritual:" + r.id);
  decorateInstants(li, "ritual", r, nowChecked);
  crewPing();
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
    decorateInstants(li, "task", t, !!t.done);
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
  if (t.done) freshProve.add("task:" + t.id);
  renderHero();
  crewPing();
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
  paintPushRow();
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
  { sel: "#proof-card", text: "Check something off and a little camera appears — your photo pins to that exact check, and every shot lands here: your private gallery of proof." },
  { sel: "#crew-card", text: "Start a crew — 3 to 6 people who see each other show up. One link invites anyone, even friends without Daily." },
  { sel: "#days", text: "Your last 14 days. Tap any dot to look back. And one detail: your day rolls over at 04:00, not midnight." },
  { sel: "#profile-btn", text: "Your profile lives here — themes, and reminders: Daily can nudge you before a streak breaks." },
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
  const [tasks, notes, rituals, checks, instants] = await Promise.all([
    sb.from("tasks").select().eq("date", viewDate).order("position").order("id"),
    sb.from("notes").select().eq("date", viewDate).order("id"),
    sb.from("rituals").select().eq("active", true).order("position").order("id"),
    sb.from("ritual_checks").select("ritual_id,date").lte("date", viewDate).order("date", { ascending: false }).limit(2000),
    sb.from("instants").select().eq("user_id", uid()).eq("date", viewDate).order("id"),
  ]);
  state.tasks = tasks.data || [];
  state.notes = notes.data || [];
  state.rituals = rituals.data || [];
  state.instants = instants.data || [];
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
  loadCrew();
}

async function start() {
  if (!clerk.user) { showGate(); return; }
  sessionUserId = clerk.user.id;
  userEmail = clerk.user.primaryEmailAddress?.emailAddress || "";
  let p = must(await sb.from("profiles").select().eq("id", sessionUserId).maybeSingle());
  if (!p) {
    const name = pendingSignupName || clerk.user.firstName ||
      (userEmail ? userEmail.split("@")[0] : "there");
    const ins = await sb.from("profiles").insert({ id: sessionUserId, name }).select().maybeSingle();
    if (ins.error) {
      // The user.created webhook may have created the row first (race) — re-read the
      // authoritative row. Never fall through to an unpersisted in-memory profile:
      // that was the ghost-account bug (Clerk user, no profiles row, no seeded ritual).
      p = must(await sb.from("profiles").select().eq("id", sessionUserId).maybeSingle());
      if (!p) throw ins.error;
    } else {
      p = ins.data;
    }
  }
  profile = p;
  if (!profile.avatar && clerk.user?.hasImage && clerk.user.imageUrl) {
    profile.avatar = clerk.user.imageUrl;
    sb.from("profiles").update({ avatar: profile.avatar }).eq("id", sessionUserId).then(() => {});
  }
  renderAvatar();
  gate.hidden = true;
  $("#app").hidden = false;
  if (!$("#ring svg")) buildRing();
  registerSW();
  await loadDay();
  renderProofPeek();
  await consumeJoinCode();
  maybeStartTour();
  maybeWhatsNew();
  setInterval(renderDate, 60_000);
}

// ---------- share card ----------

const shareSheet = $("#share-sheet");
const shareCanvas = $("#share-canvas");
let shareTheme = "dark";

function shareData() {
  const streaks = state.rituals
    // a streak still counts if it's alive through yesterday, even before today's check
    .map((r) => ({ label: r.label, streak: streakOf(r.id, viewDate) || streakOf(r.id, shiftDate(viewDate, -1)) }))
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
$("#share-save").addEventListener("click", async () => {
  const b = $("#share-save");
  await downloadCard(shareCanvas);
  b.textContent = "saved ✓";
  setTimeout(() => { b.textContent = "save"; }, 1600);
});
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

// ---------- push notifications ----------
// iOS: Web Push only inside an installed (Add to Home Screen) app, 16.4+.
// Permission may only be requested from a user gesture — the Reminders chip.

const VAPID_PUBLIC = "BPnVBBPWc1c5f-YO4nQdOyxAEfj5zcYIPSI1WpDqgrUiSXK6rTd4Tl6yQwKIE-4Jz0EtxMTQasLdkCUpGVhRf0Q";
const pushChip = $("#push-chip");
const pushHint = $("#push-hint");

function b64ToU8(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

async function registerSW() {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/app/sw.js"); }
  catch { return null; }
}

async function paintPushRow() {
  pushHint.hidden = true;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    if (isIOS() && !isStandalone()) {
      pushChip.textContent = "install first";
      pushHint.textContent = "reminders need Daily on your home screen — Share, then Add to Home Screen, then come back here";
      pushHint.hidden = false;
    } else {
      pushChip.textContent = "not supported";
      pushChip.disabled = true;
    }
    return;
  }
  if (Notification.permission === "denied") {
    pushChip.textContent = "blocked";
    pushHint.textContent = "notifications are blocked for Daily in your device settings";
    pushHint.hidden = false;
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration("/app/");
  const sub = reg && (await reg.pushManager.getSubscription());
  pushChip.textContent = sub ? "on ✓" : "turn on";
  pushChip.classList.toggle("on", !!sub);
}

async function enablePush() {
  pushChip.textContent = "…";
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { await paintPushRow(); return; }
    const reg = (await navigator.serviceWorker.getRegistration("/app/")) || (await registerSW());
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToU8(VAPID_PUBLIC),
    });
    const j = sub.toJSON();
    await persist(async () =>
      must(await sb.from("push_subs").upsert(
        { endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
          ua: navigator.userAgent.slice(0, 200),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null },
        { onConflict: "endpoint" }
      ).select())
    );
    await paintPushRow();
    pushHint.textContent = "you're set — Daily will nudge you when it matters";
    pushHint.hidden = false;
  } catch (e) {
    pushChip.textContent = "turn on";
    pushHint.textContent = "couldn't turn reminders on — try again in a moment";
    pushHint.hidden = false;
  }
}

pushChip.addEventListener("click", () => {
  if (pushChip.textContent === "on ✓") return;
  enablePush();
});


// ---------- toast ----------

let appToastTimer = null;
function showToast(msg) {
  const t = $("#app-toast");
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove("leaving");
  clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => { t.hidden = true; }, 350);
  }, 3200);
}

// ---------- focus mode ----------
// Any card's corner button expands it fullscreen — a FLIP morph.

let focusState = null;
const focusBackdrop = document.createElement("div");
focusBackdrop.className = "focus-backdrop";
focusBackdrop.hidden = true;
document.body.appendChild(focusBackdrop);

function focusTargetRect() {
  const desktop = innerWidth >= 920;
  if (!desktop) {
    const m = 10;
    return { top: m, left: m, width: innerWidth - m * 2, height: innerHeight - m * 2 };
  }
  const w = Math.min(760, innerWidth * 0.92);
  const hgt = Math.min(innerHeight * 0.88, 820);
  return { top: (innerHeight - hgt) / 2, left: (innerWidth - w) / 2, width: w, height: hgt };
}

function enterFocus(card) {
  if (focusState) return;
  const from = card.getBoundingClientRect();
  const ph = document.createElement("div");
  ph.style.width = from.width + "px";
  ph.style.height = from.height + "px";
  ph.style.flex = "none";
  card.parentNode.insertBefore(ph, card);
  Object.assign(card.style, {
    position: "fixed", zIndex: 30, margin: 0,
    top: from.top + "px", left: from.left + "px",
    width: from.width + "px", height: from.height + "px",
  });
  card.classList.add("focused");
  focusBackdrop.hidden = false;
  focusBackdrop.classList.remove("closing");
  document.body.style.overflow = "hidden";
  const to = focusTargetRect();
  const anim = card.animate(
    [
      { top: from.top + "px", left: from.left + "px", width: from.width + "px", height: from.height + "px" },
      { top: to.top + "px", left: to.left + "px", width: to.width + "px", height: to.height + "px" },
    ],
    { duration: 520, easing: "cubic-bezier(.22,1.2,.36,1)", fill: "forwards" }
  );
  anim.onfinish = () => {
    Object.assign(card.style, { top: to.top + "px", left: to.left + "px", width: to.width + "px", height: to.height + "px" });
    anim.cancel();
  };
  focusState = { card, placeholder: ph };
  if (card.id === "crew-card") renderRoom();
  if (card.id === "proof-card") renderProofGallery();
}

function exitFocus() {
  if (!focusState) return;
  const { card, placeholder } = focusState;
  focusState = null;
  const from = card.getBoundingClientRect();
  const to = placeholder.getBoundingClientRect();
  focusBackdrop.classList.add("closing");
  card.classList.add("collapsing");
  const anim = card.animate(
    [
      { top: from.top + "px", left: from.left + "px", width: from.width + "px", height: from.height + "px",
        boxShadow: "0 2px 6px rgb(0 0 0 / .1), 0 40px 90px -20px rgb(0 0 0 / .4)" },
      { top: to.top + "px", left: to.left + "px", width: to.width + "px", height: to.height + "px",
        boxShadow: "0 1px 2px rgb(0 0 0 / .03), 0 12px 32px -12px rgb(0 0 0 / .10)" },
    ],
    { duration: 480, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }
  );
  anim.onfinish = () => {
    card.classList.remove("focused", "collapsing");
    card.style.cssText = (card.dataset.baseStyle || "") + "; animation: none;";
    placeholder.remove();
    anim.cancel();
    focusBackdrop.hidden = true;
    document.body.style.overflow = "";
  };
}

document.querySelectorAll(".card[data-focusable]").forEach((card) => {
  card.dataset.baseStyle = card.getAttribute("style") || "";
  card.querySelector(".focus-btn")?.addEventListener("click", () => {
    if (focusState?.card === card) exitFocus();
    else enterFocus(card);
  });
});
focusBackdrop.addEventListener("click", exitFocus);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && focusState) exitFocus();
});

// ---------- instants ----------
// Check something off, prove it. Photos live in private storage under crew-law
// RLS; rows carry the check's label from the moment of capture.

const CAMERA_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>`;
const instantFile = $("#instant-file");
const freshProve = new Set();
let instantTarget = null;
const instSrcCache = new Map(); // storage path → object URL

async function instSrc(path) {
  if (instSrcCache.has(path)) return instSrcCache.get(path);
  const { data, error } = await sb.storage.from("instants").download(path);
  if (error) throw error;
  const url = URL.createObjectURL(data);
  instSrcCache.set(path, url);
  return url;
}

function setTileImg(img, path) {
  instSrc(path).then((u) => { img.src = u; }).catch(() => {});
}

function instantsFor(kind, refId) {
  return (state.instants || []).filter((i) => i.kind === kind && i.ref_id === refId);
}

function decorateInstants(li, kind, obj, active) {
  li.querySelector(".prove-btn")?.remove();
  li.querySelector(".instant-strip")?.remove();
  const shots = instantsFor(kind, obj.id);
  if (active) {
    const btn = document.createElement("button");
    btn.className = "prove-btn" + (freshProve.has(kind + ":" + obj.id) && !shots.length ? " pulse" : "");
    btn.setAttribute("aria-label", "Attach a photo proof");
    btn.innerHTML = CAMERA_SVG;
    btn.addEventListener("click", () => {
      instantTarget = { kind, obj };
      openCamera(obj.label || obj.text);
    });
    li.insertBefore(btn, li.querySelector(kind === "task" ? ".task-del" : ".ritual-del"));
  }
  if (shots.length) {
    const strip = document.createElement("div");
    strip.className = "instant-strip";
    for (const s of shots) {
      const tile = document.createElement("button");
      tile.className = "instant-tile";
      tile.setAttribute("aria-label", "View proof");
      const img = document.createElement("img");
      img.alt = "";
      setTileImg(img, s.path);
      tile.appendChild(img);
      tile.addEventListener("click", () => openLightbox(s));
      strip.appendChild(tile);
    }
    li.appendChild(strip);
  }
}

function rerenderInstantRow(kind, refId) {
  if (refId == null) { renderTasks(); renderRituals(); return; }
  if (kind === "ritual") renderRituals();
  else renderTasks();
}

// downscale + recompress to a JPEG blob under the bucket cap.
async function fitBlob(source, natW, natH, mirror = false, zoom = 1) {
  const sw = natW / zoom, sh = natH / zoom;
  const sx = (natW - sw) / 2, sy = (natH - sh) / 2;
  for (const [maxDim, q] of [[1280, .78], [1024, .7], [800, .6]]) {
    const k = Math.min(1, maxDim / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * k);
    canvas.height = Math.round(sh * k);
    const g = canvas.getContext("2d");
    if (mirror) { g.translate(canvas.width, 0); g.scale(-1, 1); }
    g.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size < 950_000) return blob;
  }
  throw new Error("image too large");
}

async function saveInstant(blob) {
  if (!instantTarget) return;
  const { kind, obj } = instantTarget;
  instantTarget = null;
  freshProve.delete(kind + ":" + obj.id);
  const path = `${uid()}/${crypto.randomUUID()}.jpg`;
  await persist(async () => {
    const up = await sb.storage.from("instants").upload(path, blob, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
    const row = must(await sb.from("instants").insert({
      kind, ref_id: obj.id, label: (obj.label || obj.text || "—").slice(0, 120), date: viewDate, path,
      visibility: crew ? proofVis : "private",
    }).select().single());
    (state.instants = state.instants || []).push(row);
    rerenderInstantRow(kind, obj.id);
    renderProofPeek();
  });
}

instantFile.addEventListener("change", async () => {
  const file = instantFile.files[0];
  instantFile.value = "";
  if (!file || !instantTarget) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    await saveInstant(await fitBlob(img, img.naturalWidth, img.naturalHeight));
  } finally { URL.revokeObjectURL(url); }
});

// ---------- custom camera (in-app viewfinder; native picker fallback) ----------

const camEl = $("#camera"), camVideo = $("#cam-video");
let camStream = null;
let camFacing = "environment";
let camZoom = 1;
let camZoomHw = null;
let camZoomRaf = false;

function paintZoom() {
  camVideo.style.transform =
    (camFacing === "user" ? "scaleX(-1) " : "") +
    (camZoomHw ? "" : `scale(${camZoom})`);
  const badge = $("#cam-zoom");
  badge.textContent = camZoom.toFixed(1).replace(/\.0$/, "") + "×";
  badge.hidden = camZoom === 1;
}

function applyZoom() {
  if (camZoomRaf) return;
  camZoomRaf = true;
  requestAnimationFrame(() => {
    camZoomRaf = false;
    const track = camStream?.getVideoTracks()[0];
    if (camZoomHw && track) track.applyConstraints({ advanced: [{ zoom: camZoom }] }).catch(() => {});
    paintZoom();
  });
}

async function startStream() {
  stopStream();
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: camFacing, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false,
  });
  camVideo.srcObject = camStream;
  camZoom = 1;
  const caps = camStream.getVideoTracks()[0].getCapabilities?.();
  camZoomHw = caps?.zoom && caps.zoom.max > 1 ? { min: Math.max(1, caps.zoom.min), max: Math.min(5, caps.zoom.max) } : null;
  paintZoom();
  await camVideo.play().catch(() => {});
}
function stopStream() {
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  camVideo.srcObject = null;
}

let proofVis = localStorage.getItem("daily.proofvis") || "crew";
function paintVis() {
  const wrap = $("#cam-vis");
  wrap.hidden = !crew; // no crew → everything is yours alone anyway
  wrap.querySelectorAll(".cam-vis-opt").forEach((b) =>
    b.classList.toggle("on", b.dataset.vis === proofVis));
}
document.querySelectorAll(".cam-vis-opt").forEach((b) =>
  b.addEventListener("click", () => {
    proofVis = b.dataset.vis;
    localStorage.setItem("daily.proofvis", proofVis);
    paintVis();
  }));

async function openCamera(label) {
  if (!navigator.mediaDevices?.getUserMedia) { instantFile.click(); return; }
  $("#cam-tag").textContent = `${label} · now`;
  paintVis();
  try { await startStream(); }
  catch { instantFile.click(); return; }
  camEl.hidden = false;
  requestAnimationFrame(() => camEl.classList.add("open"));
  document.body.style.overflow = "hidden";
}

function closeCamera() {
  camEl.classList.remove("open");
  setTimeout(() => { camEl.hidden = true; stopStream(); document.body.style.overflow = ""; }, 320);
}

const camPointers = new Map();
let pinchBase = null, lastTap = 0;
const camVf = document.querySelector(".cam-viewfinder");
const zClamp = (z) => Math.min(camZoomHw ? camZoomHw.max : 5, Math.max(1, z));

camVf.addEventListener("pointerdown", (e) => {
  camPointers.set(e.pointerId, e);
  if (camPointers.size === 1) {
    const now = performance.now();
    if (now - lastTap < 320) { camZoom = zClamp(camZoom > 1.5 ? 1 : 2); applyZoom(); }
    lastTap = now;
  }
});
camVf.addEventListener("pointermove", (e) => {
  if (!camPointers.has(e.pointerId)) return;
  camPointers.set(e.pointerId, e);
  if (camPointers.size === 2) {
    const [a, b] = [...camPointers.values()];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!pinchBase) pinchBase = { dist, zoom: camZoom };
    else { camZoom = zClamp(pinchBase.zoom * (dist / pinchBase.dist)); applyZoom(); }
  }
});
for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
  camVf.addEventListener(ev, (e) => {
    camPointers.delete(e.pointerId);
    if (camPointers.size < 2) pinchBase = null;
  });
}

$("#cam-skip").addEventListener("click", () => { instantTarget = null; closeCamera(); });
$("#cam-flip").addEventListener("click", async () => {
  camFacing = camFacing === "environment" ? "user" : "environment";
  try { await startStream(); } catch { camFacing = camFacing === "user" ? "environment" : "user"; }
});
$("#cam-shutter").addEventListener("click", async () => {
  if (!camStream || !camVideo.videoWidth) return;
  const flash = $("#cam-flash");
  flash.classList.remove("fire"); void flash.offsetWidth; flash.classList.add("fire");
  const blob = await fitBlob(camVideo, camVideo.videoWidth, camVideo.videoHeight,
    camFacing === "user", camZoomHw ? 1 : camZoom);
  setTimeout(closeCamera, 240);
  await saveInstant(blob);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !camEl.hidden) { instantTarget = null; closeCamera(); }
});

// ---------- lightbox ----------

const lightbox = $("#lightbox"), lightboxImg = $("#lightbox-img");
let lightboxShot = null;

function openLightbox(shot) {
  lightboxShot = shot;
  setTileImg(lightboxImg, shot.path);
  const when = new Date(shot.created_at);
  const hhmm = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  $("#lightbox-meta").textContent = `${shot.label} · ${hhmm}`;
  $("#lightbox-del").hidden = shot.user_id !== uid();
  if (shot.user_id === uid() && shot.visibility === "private" && crew) $("#lightbox-meta").textContent += " · just you";
  lightbox.hidden = false;
  requestAnimationFrame(() => lightbox.classList.add("open"));
}
function closeLightbox() {
  lightbox.classList.remove("open");
  setTimeout(() => { lightbox.hidden = true; lightboxImg.src = ""; lightboxShot = null; }, 260);
}
lightbox.addEventListener("click", (e) => { if (e.target === lightbox || e.target === lightboxImg) closeLightbox(); });
$("#lightbox-del").addEventListener("click", async () => {
  if (!lightboxShot) return;
  const shot = lightboxShot;
  closeLightbox();
  await persist(async () => {
    must(await sb.from("instants").delete().eq("id", shot.id).select());
    await sb.storage.from("instants").remove([shot.path]);
  });
  state.instants = (state.instants || []).filter((i) => i.id !== shot.id);
  rerenderInstantRow(shot.kind, shot.ref_id);
  renderProofPeek();
  if ($("#crew-card").classList.contains("focused")) renderRoom();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !lightbox.hidden) closeLightbox();
});

// ---------- proof (your gallery of instants) ----------

let proofMonth = todayStr().slice(0, 7);
let proofFilter = null;
const proofCache = new Map();

async function fetchProofMonth(m) {
  if (proofCache.has(m)) return proofCache.get(m);
  const rows = must(await sb.from("instants").select()
    .eq("user_id", uid()).gte("date", m + "-01").lte("date", m + "-31")
    .order("date", { ascending: false }).order("id", { ascending: false }));
  proofCache.set(m, rows);
  return rows;
}

function proofTile(s, big) {
  const tile = document.createElement("button");
  tile.className = "instant-tile " + (big ? "proof-tile" : "peek-tile");
  const img = document.createElement("img");
  img.alt = ""; img.loading = "lazy";
  setTileImg(img, s.path);
  tile.appendChild(img);
  if (big) {
    const d = document.createElement("span");
    d.className = "proof-day";
    d.textContent = Number(String(s.date).slice(8));
    tile.appendChild(d);
  }
  tile.addEventListener("click", () => openLightbox(s));
  return tile;
}

function monthLabel(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}
function shiftMonth(m, d) {
  const [y, mo] = m.split("-").map(Number);
  const dt = new Date(y, mo - 1 + d, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}

async function renderProofPeek() {
  proofCache.clear();
  proofMonth = todayStr().slice(0, 7);
  proofFilter = null;
  const rows = must(await sb.from("instants").select()
    .eq("user_id", uid()).order("id", { ascending: false }).limit(3));
  const peek = $("#proof-peek");
  peek.innerHTML = "";
  rows.forEach((s) => peek.appendChild(proofTile(s, false)));
  $("#proof-empty").hidden = rows.length > 0;
  if ($("#proof-card").classList.contains("focused")) renderProofGallery();
}

async function renderProofGallery() {
  const rows = await fetchProofMonth(proofMonth);
  $("#proof-month").textContent = monthLabel(proofMonth);
  $("#proof-next").disabled = proofMonth >= todayStr().slice(0, 7);
  const labels = [...new Set(rows.map((r) => r.label))];
  const fwrap = $("#proof-filters");
  fwrap.innerHTML = "";
  if (labels.length > 1) {
    for (const l of ["all", ...labels]) {
      const chip = document.createElement("button");
      chip.className = "pf-chip" + ((l === "all" ? null : l) === proofFilter ? " cur" : "");
      chip.textContent = l;
      chip.addEventListener("click", () => { proofFilter = l === "all" ? null : l; renderProofGallery(); });
      fwrap.appendChild(chip);
    }
  }
  const grid = $("#proof-grid");
  grid.innerHTML = "";
  const vis = rows.filter((r) => !proofFilter || r.label === proofFilter);
  vis.forEach((s) => grid.appendChild(proofTile(s, true)));
  $("#proof-grid-empty").hidden = vis.length > 0;
}

$("#proof-prev").addEventListener("click", () => { proofMonth = shiftMonth(proofMonth, -1); proofFilter = null; renderProofGallery(); });
$("#proof-next").addEventListener("click", () => { proofMonth = shiftMonth(proofMonth, 1); proofFilter = null; renderProofGallery(); });

// ---------- crew ----------
// A room of 3-6. The invite link is the whole mechanic; RLS is the whole
// privacy model. room_status() exposes shape (counts/names/avatars), never text.

const RX_EMOJI = ["🔥", "💪", "👏", "😮"];
const RING_DASH = 113;
let crew = null;          // { id, name, code, owner }
let roomMembers = [];     // room_status() rows
let crewPingTimer = null;

function crewLink() { return `${location.origin}/c/${crew.code}`; }

function memberProgress(m) {
  if (m.tasks_total > 0) return m.tasks_done / m.tasks_total;
  if (m.rituals_total > 0) return m.checks / m.rituals_total;
  return 0;
}

function crewAvatarHTML(m, progress) {
  const face = m.avatar
    ? `<span class="cw-face" style="background:url(${m.avatar}) center/cover no-repeat"></span>`
    : `<span class="cw-face cw-face-init">${(m.name || "?").slice(0, 1).toUpperCase()}</span>`;
  return `<span class="cw-av"><svg viewBox="0 0 40 40"><circle class="cw-tr" cx="20" cy="20" r="18"/><circle class="cw-fl" cx="20" cy="20" r="18" style="stroke-dashoffset:${(RING_DASH * (1 - progress)).toFixed(1)}"/></svg>${face}</span>`;
}

async function loadCrew() {
  const crews = must(await sb.from("crews").select());
  crew = crews[0] || null;
  if (!crew) {
    $("#crew-empty").hidden = false;
    $("#crew-invite-btn").hidden = true;
    $("#crew-count").textContent = "";
    $("#crew-list").innerHTML = "";
    $("#crew-room").innerHTML = "";
    return;
  }
  $("#crew-empty").hidden = true;
  $("#crew-invite-btn").hidden = false;
  roomMembers = must(await sb.rpc("room_status", { d: viewDate }));
  renderCrewList();
  if ($("#crew-card").classList.contains("focused")) renderRoom();
}

function renderCrewList() {
  const list = $("#crew-list");
  list.innerHTML = "";
  let inCount = 0;
  for (const m of roomMembers) {
    const me = m.user_id === uid();
    const p = memberProgress(m);
    if (p > 0) inCount++;
    const li = document.createElement("li");
    li.className = "cw-row" + (p === 0 && !me ? " cw-out" : "");
    const status = p >= 1 ? "closed" : p > 0 ? (me ? `${Math.round(p * 100)}% in` : "on it") : "not in yet";
    li.innerHTML = crewAvatarHTML(m, p) +
      `<span class="cw-name">${me ? "You" : ""}</span><span class="cw-status">${status}</span>`;
    li.querySelector(".cw-name").textContent = me ? "You" : m.name;
    list.appendChild(li);
  }
  $("#crew-count").textContent = roomMembers.length ? `${inCount}/${roomMembers.length} in` : "";
}

function crewPing() {
  // refresh the room's shape shortly after my own state changes
  clearTimeout(crewPingTimer);
  if (!crew) return;
  crewPingTimer = setTimeout(loadCrew, 900);
}

async function shareCrewLink() {
  const link = crewLink();
  if (navigator.share) {
    try { await navigator.share({ title: "Join my crew on Daily", url: link }); return; } catch {}
  }
  await navigator.clipboard.writeText(link).catch(() => {});
  showToast("link copied — send it to your people");
}

$("#crew-invite-btn").addEventListener("click", shareCrewLink);
$("#crew-create-btn").addEventListener("click", () => {
  $("#crew-empty").hidden = true;
  $("#crew-form").hidden = false;
  $("#crew-name-input").focus();
});
$("#crew-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#crew-name-input").value.trim();
  if (!name) return;
  $("#crew-form").hidden = true;
  $("#crew-name-input").value = "";
  try {
    await persist(async () => {
      const res = await sb.rpc("create_crew", { crew_name: name });
      if (res.error) throw res.error;
      await loadCrew();
      showToast(`${name} is live — share your link`);
      shareCrewLink();
    });
  } catch (e) {
    if (!crew) $("#crew-empty").hidden = false;
    showToast(String(e.message || "").includes("already") ? "you're already in a crew" : "couldn't start the crew — try again");
  }
});
$("#crew-name-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#crew-form").hidden = true; if (!crew) $("#crew-empty").hidden = false; }
});

async function renderRoom() {
  const room = $("#crew-room");
  if (!crew) { room.innerHTML = ""; return; }
  room.innerHTML = `<p class="room-note">the room · today &amp; yesterday, then it's yours alone</p>`;
  const days = [viewDate, shiftDate(viewDate, -1)];
  const shots = must(await sb.from("instants").select().in("date", days)
    .order("created_at", { ascending: false }));
  const ids = shots.map((s) => s.id);
  const rx = ids.length ? must(await sb.from("reactions").select().in("instant_id", ids)) : [];
  const nameOf = new Map(roomMembers.map((m) => [m.user_id, m.user_id === uid() ? "You" : m.name]));

  const byUser = new Map();
  for (const s of shots) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }
  // you first, then crewmates in room order
  const order = [uid(), ...roomMembers.map((m) => m.user_id).filter((u) => u !== uid())];
  let any = false;
  for (const u of order) {
    const mine = u === uid();
    const list = byUser.get(u) || [];
    if (!list.length && !mine) continue;
    const sec = document.createElement("div");
    sec.className = "room-sec";
    sec.innerHTML = `<div class="room-who"><b></b></div>`;
    sec.querySelector("b").textContent = nameOf.get(u) || "—";
    if (!list.length) {
      sec.innerHTML += `<p class="room-empty">check something off and prove it — it lands here</p>`;
    }
    for (const s of list) {
      any = true;
      const when = new Date(s.created_at);
      const hhmm = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
      const item = document.createElement("div");
      item.className = "room-item";
      const tile = document.createElement("button");
      tile.className = "instant-tile room-tile";
      const img = document.createElement("img");
      img.alt = ""; setTileImg(img, s.path);
      tile.appendChild(img);
      tile.addEventListener("click", () => openLightbox(s));
      const meta = document.createElement("div");
      meta.className = "room-meta";
      meta.textContent = `${s.label} ✓ · ${hhmm}`;
      item.appendChild(tile);
      item.appendChild(meta);
      item.appendChild(rxBar(s, rx.filter((r) => r.instant_id === s.id)));
      sec.appendChild(item);
    }
    room.appendChild(sec);
  }
  const foot = document.createElement("button");
  foot.className = "room-leave";
  foot.textContent = "leave the crew";
  foot.addEventListener("click", async () => {
    if (!confirm(`Leave ${crew.name}? Your instants stay yours.`)) return;
    await persist(async () => {
      const res = await sb.rpc("leave_crew");
      if (res.error) throw res.error;
    });
    exitFocus();
    await loadCrew();
  });
  room.appendChild(foot);
}

function rxBar(shot, rows) {
  const bar = document.createElement("div");
  bar.className = "rx-bar";
  for (const e of RX_EMOJI) {
    const all = rows.filter((r) => r.emoji === e);
    const mine = all.some((r) => r.user_id === uid());
    const chip = document.createElement("button");
    chip.className = "rx-chip" + (mine ? " hot" : "");
    chip.innerHTML = `${e}${all.length ? ` <b>${all.length}</b>` : ""}`;
    chip.addEventListener("click", async () => {
      if (mine) {
        await sb.from("reactions").delete().eq("instant_id", shot.id).eq("emoji", e).eq("user_id", uid());
      } else {
        await sb.from("reactions").insert({ instant_id: shot.id, emoji: e });
        fetch("/api/react-notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instant_id: shot.id, emoji: e }),
        }).catch(() => {});
      }
      renderRoom();
    });
    bar.appendChild(chip);
  }
  return bar;
}

// ---------- invite code (arrives via getdaily.day/c/CODE) ----------

async function consumeJoinCode() {
  const code = localStorage.getItem("daily.join");
  if (!code) return;
  localStorage.removeItem("daily.join");
  try {
    const res = await sb.rpc("join_crew", { invite_code: code });
    if (res.error) throw res.error;
    await loadCrew();
    showToast(res.data.already ? `you're already in ${res.data.name}` : `you're in ${res.data.name} — welcome to the room`);
  } catch (e) {
    const msg = String(e.message || e);
    showToast(msg.includes("full") ? "that crew is full" :
              msg.includes("already in a crew") ? "you're already in a crew" :
              "that invite link didn't work");
  }
}

// ---------- what's new ----------

const WN_KEY = "daily.wn.2026-07-20";
const WN_BEATS = [
  ["Check it off, prove it", "Attach a photo the moment you finish something. The camera opens in-app, the shot pins to that exact check."],
  ["Any card, fullscreen", "Tap the corner of any card and it expands to fill the screen. Your thoughts, your tasks — room to breathe."],
  ["Crews are here", "3 to 6 people who see each other show up. One link invites anyone — even friends who don't have Daily yet."],
  ["Reminders that know when", "Only when a streak is truly on the line, when the room reacts, or when you're the last one in."],
];
const wnEl = $("#whatsnew");
let wnStep = 0;

function wnPaint() {
  document.querySelectorAll(".wn-v").forEach((v) => v.classList.toggle("on", Number(v.dataset.wn) === wnStep));
  $("#wn-title").textContent = WN_BEATS[wnStep][0];
  $("#wn-text").textContent = WN_BEATS[wnStep][1];
  $("#wn-dots").innerHTML = WN_BEATS.map((_, i) => `<span class="wn-dot${i === wnStep ? " on" : ""}"></span>`).join("");
  const last = wnStep === WN_BEATS.length - 1;
  $("#wn-btn").textContent = !last ? "next"
    : (("Notification" in window) && Notification.permission !== "granted" ? "turn on reminders" : "done");
}

function wnClose() {
  localStorage.setItem(WN_KEY, "1");
  wnEl.classList.remove("open");
  setTimeout(() => { wnEl.hidden = true; }, 320);
}

function maybeWhatsNew() {
  if (localStorage.getItem(WN_KEY)) return;
  if (!profile.onboarded) return; // new users get the tour, not the changelog
  const photo = profile.avatar || (clerk.user?.hasImage ? clerk.user.imageUrl : null);
  const meFace = photo
    ? `<span class="cw-av wn-big"><svg viewBox="0 0 40 40"><circle class="cw-tr" cx="20" cy="20" r="18"/><circle class="cw-fl" cx="20" cy="20" r="18" style="stroke-dashoffset:0"/></svg><span class="cw-face" style="background:url(${photo}) center/cover no-repeat"></span></span>`
    : crewAvatarHTML({ name: profile.name }, 1);
  $("#wn-crew-vis").innerHTML = meFace +
    crewAvatarHTML({ name: "Sam", avatar: "/app/demo/sam.jpg" }, .6) +
    crewAvatarHTML({ name: "Mira", avatar: "/app/demo/mira.jpg" }, .35);
  wnStep = 0;
  wnPaint();
  setTimeout(() => {
    wnEl.hidden = false;
    requestAnimationFrame(() => wnEl.classList.add("open"));
  }, 900);
}

$("#wn-btn").addEventListener("click", async () => {
  if (wnStep < WN_BEATS.length - 1) { wnStep++; wnPaint(); return; }
  if ($("#wn-btn").textContent === "turn on reminders") {
    wnClose();
    openSheet();
    setTimeout(enablePush, 400);
    return;
  }
  wnClose();
});
$("#wn-skip").addEventListener("click", wnClose);

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
