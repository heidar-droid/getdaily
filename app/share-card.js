// share-card.js — renders the streak-flex share card on a canvas and hands it
// to the native share sheet (or downloads it where sharing isn't supported).
// Hand-drawn Canvas 2D, no dependencies. Card is 1080x1920 (IG Story).

const W = 1080, H = 1920;

const THEMES = {
  dark:  { bg: "#111111", ink: "#f4f4f4", soft: "#9a9a9a", faint: "#6f6f6f", row: "rgba(255,255,255,.09)", chipBg: "#f4f4f4", chipInk: "#111111" },
  light: { bg: "#f6f5f2", ink: "#141414", soft: "#8a8a8a", faint: "#a3a3a3", row: "#ffffff", chipBg: "#141414", chipInk: "#ffffff" },
};

const F = (w, s) => `${w} ${s}px Fredoka, sans-serif`;

function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
  return text + "…";
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawChrome(ctx, t, dateLabel) {
  // brand: ring + wordmark, centered as a group
  ctx.font = F(600, 52);
  const word = "Daily", wordW = ctx.measureText(word).width;
  const ringR = 24, gap = 22, total = ringR * 2 + gap + wordW;
  const x0 = (W - total) / 2, cy = 172;
  ctx.strokeStyle = t.ink; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.arc(x0 + ringR, cy, ringR, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = t.ink; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.fillText(word, x0 + ringR * 2 + gap, cy + 2);
  // footer
  ctx.textAlign = "center";
  ctx.font = F(300, 34); ctx.fillStyle = t.soft;
  ctx.fillText(dateLabel, W / 2, H - 176);
  ctx.font = F(500, 38); ctx.fillStyle = t.ink;
  ctx.fillText("getdaily.day", W / 2, H - 112);
}

function drawStreakCard(ctx, t, data) {
  const [top, ...rest] = data.streaks;
  const rows = rest.slice(0, 2);
  // vertically balance: fewer rows -> hero sits lower
  const base = rows.length === 2 ? 760 : rows.length === 1 ? 830 : 910;
  ctx.textAlign = "center";
  // hero number
  ctx.fillStyle = t.ink; ctx.font = F(600, 250);
  ctx.fillText(`×${top.streak}`, W / 2, base);
  ctx.font = F(300, 46); ctx.fillStyle = t.soft;
  ctx.fillText(top.streak === 1 ? "day in a row" : "days in a row", W / 2, base + 145);
  ctx.font = F(500, 56); ctx.fillStyle = t.ink;
  ctx.fillText(ellipsize(ctx, top.label, W - 220), W / 2, base + 230);
  // remaining streak rows (max 2)
  const rw = 780, rh = 118, rx = (W - rw) / 2;
  let ry = base + 370;
  for (const s of rows) {
    ctx.fillStyle = t.row;
    rr(ctx, rx, ry, rw, rh, 30); ctx.fill();
    ctx.font = F(400, 40); ctx.fillStyle = t.ink; ctx.textAlign = "left";
    const chipText = `×${s.streak}`;
    ctx.font = F(600, 32);
    const chipW = ctx.measureText(chipText).width + 44;
    ctx.font = F(400, 40);
    ctx.fillText(ellipsize(ctx, s.label, rw - chipW - 110), rx + 44, ry + rh / 2 + 2);
    ctx.fillStyle = t.chipBg;
    rr(ctx, rx + rw - chipW - 36, ry + rh / 2 - 29, chipW, 58, 29); ctx.fill();
    ctx.fillStyle = t.chipInk; ctx.font = F(600, 32); ctx.textAlign = "center";
    ctx.fillText(chipText, rx + rw - 36 - chipW / 2, ry + rh / 2 + 2);
    ctx.textAlign = "center";
    ry += rh + 34;
  }
}

function drawFallbackCard(ctx, t, data) {
  const { done, total } = data.completion;
  const pct = total ? done / total : 0;
  const cx = W / 2, cy = 810, R = 265, LW = 42;
  ctx.lineCap = "round";
  ctx.strokeStyle = t.row === "#ffffff" ? "#e4e2dd" : "rgba(255,255,255,.14)";
  ctx.lineWidth = LW;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  if (pct > 0) {
    ctx.strokeStyle = t.ink;
    ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2); ctx.stroke();
  }
  ctx.textAlign = "center"; ctx.fillStyle = t.ink;
  ctx.font = F(600, 120);
  ctx.fillText(`${Math.round(pct * 100)}%`, cx, cy - 16);
  ctx.font = F(300, 40); ctx.fillStyle = t.soft;
  ctx.fillText(`${done} of ${total} tasks done`, cx, cy + 78);
  ctx.font = F(600, 72); ctx.fillStyle = t.ink;
  ctx.fillText(pct >= 1 ? "Day complete." : "Today, so far.", cx, 1310);
}

export async function renderShareCard(canvas, data, theme) {
  await document.fonts.ready;
  const t = THEMES[theme] || THEMES.dark;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "middle";
  if (data.streaks.length) drawStreakCard(ctx, t, data);
  else drawFallbackCard(ctx, t, data);
  drawChrome(ctx, t, data.dateLabel);
}

export function canNativeShare() {
  return !!(navigator.canShare && navigator.canShare({ files: [new File([""], "x.png", { type: "image/png" })] }));
}

export async function downloadCard(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "daily-streak.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return "downloaded";
}

export async function shareOrDownload(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  const file = new File([blob], "daily-streak.png", { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
    }
  }
  return downloadCard(canvas);
}

// ---------- v2: animated card, proof + fan models, video export ----------
// The card plays a 4s choreography (brand settles → hero counts up → rows
// cascade → footer lands). Preview loops on the sheet canvas; "Share" records
// the same frames into an MP4 via captureStream + MediaRecorder and hands it
// to the native share sheet. No MP4 recorder → today's still PNG, unchanged.

const DUR = 4000, HOLD = 1200;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeBack = (p) => { const c = 1.9; p -= 1; return 1 + p * p * ((c + 1) * p + c); };
const seg = (ms, a, b, ease = easeOut) => ease(clamp01((ms - a) / (b - a)));

function coverImg(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawBrandFrame(ctx, t, ms) {
  const a = seg(ms, 0, 500);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(0, (1 - a) * 26);
  ctx.font = F(600, 52);
  const word = "Daily", wordW = ctx.measureText(word).width;
  const ringR = 24, gap = 22, total = ringR * 2 + gap + wordW;
  const x0 = (W - total) / 2, cy = 172;
  ctx.strokeStyle = t.ink; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.arc(x0 + ringR, cy, ringR, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = t.ink; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.fillText(word, x0 + ringR * 2 + gap, cy + 2);
  ctx.restore();
}

function drawFooterFrame(ctx, t, dateLabel, ms, from = 2600) {
  const a = seg(ms, from, from + 400);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = F(300, 34); ctx.fillStyle = t.soft;
  ctx.fillText(dateLabel, W / 2, H - 176);
  ctx.font = F(500, 38); ctx.fillStyle = t.ink;
  ctx.fillText("getdaily.day", W / 2, H - 112);
  ctx.restore();
}

function drawChipC(ctx, t, text, cx, cy, size, pad, scale, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy); ctx.scale(scale, scale);
  ctx.font = F(600, size);
  const w = ctx.measureText(text).width + pad * 2, h = size + pad * 1.3;
  ctx.fillStyle = t.chipBg;
  rr(ctx, -w / 2, -h / 2, w, h, h / 2); ctx.fill();
  ctx.fillStyle = t.chipInk; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 2);
  ctx.restore();
}

function drawStreakFrame(ctx, t, data, ms) {
  if (!data.streaks.length) { drawFallbackFrame(ctx, t, data, ms); return; }
  const [top, ...rest] = data.streaks;
  const rows = rest.slice(0, 2);
  const base = rows.length === 2 ? 760 : rows.length === 1 ? 830 : 910;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  // hero counts up with a spring
  const heroA = seg(ms, 400, 900);
  if (heroA > 0) {
    const n = Math.round(top.streak * seg(ms, 400, 1600));
    const sc = 0.7 + 0.3 * easeBack(seg(ms, 400, 1300));
    ctx.save();
    ctx.globalAlpha = heroA;
    ctx.translate(W / 2, base); ctx.scale(sc, sc);
    ctx.fillStyle = t.ink; ctx.font = F(600, 250);
    ctx.fillText(`×${n}`, 0, 0);
    ctx.restore();
  }
  const unitA = seg(ms, 1000, 1500);
  if (unitA > 0) {
    ctx.save(); ctx.globalAlpha = unitA;
    ctx.font = F(300, 46); ctx.fillStyle = t.soft;
    ctx.fillText(top.streak === 1 ? "day in a row" : "days in a row", W / 2, base + 145);
    ctx.restore();
  }
  const labA = seg(ms, 1400, 1900);
  if (labA > 0) {
    ctx.save(); ctx.globalAlpha = labA;
    ctx.translate(0, (1 - labA) * 24);
    ctx.font = F(500, 56); ctx.fillStyle = t.ink;
    ctx.fillText(ellipsize(ctx, top.label, W - 220), W / 2, base + 230);
    ctx.restore();
  }
  const rw = 780, rh = 118, rx = (W - rw) / 2;
  let ry = base + 370;
  rows.forEach((s, i) => {
    const a = seg(ms, 1900 + i * 180, 2400 + i * 180);
    if (a > 0) {
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(0, (1 - a) * 30);
      ctx.fillStyle = t.row;
      rr(ctx, rx, ry, rw, rh, 30); ctx.fill();
      ctx.font = F(600, 32);
      const chipText = `×${s.streak}`, chipW = ctx.measureText(chipText).width + 44;
      ctx.font = F(400, 40); ctx.fillStyle = t.ink; ctx.textAlign = "left";
      ctx.fillText(ellipsize(ctx, s.label, rw - chipW - 110), rx + 44, ry + rh / 2 + 2);
      ctx.fillStyle = t.chipBg;
      rr(ctx, rx + rw - chipW - 36, ry + rh / 2 - 29, chipW, 58, 29); ctx.fill();
      ctx.fillStyle = t.chipInk; ctx.font = F(600, 32); ctx.textAlign = "center";
      ctx.fillText(chipText, rx + rw - 36 - chipW / 2, ry + rh / 2 + 2);
      ctx.restore();
      ctx.textAlign = "center";
    }
    ry += rh + 34;
  });
  drawFooterFrame(ctx, t, data.dateLabel, ms);
}

function drawFallbackFrame(ctx, t, data, ms) {
  const { done, total } = data.completion;
  const pct = total ? done / total : 0;
  const cx = W / 2, cy = 810, R = 265, LW = 42;
  const ringP = seg(ms, 400, 1800);
  ctx.lineCap = "round";
  ctx.strokeStyle = t.row === "#ffffff" ? "#e4e2dd" : "rgba(255,255,255,.14)";
  ctx.lineWidth = LW;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  if (pct * ringP > 0) {
    ctx.strokeStyle = t.ink;
    ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + pct * ringP * Math.PI * 2); ctx.stroke();
  }
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = t.ink;
  ctx.font = F(600, 120);
  ctx.fillText(`${Math.round(pct * ringP * 100)}%`, cx, cy - 16);
  const subA = seg(ms, 1500, 2000);
  if (subA > 0) {
    ctx.save(); ctx.globalAlpha = subA;
    ctx.font = F(300, 40); ctx.fillStyle = t.soft;
    ctx.fillText(`${done} of ${total} tasks done`, cx, cy + 78);
    ctx.font = F(600, 72); ctx.fillStyle = t.ink;
    ctx.fillText(pct >= 1 ? "Day complete." : "Today, so far.", cx, 1310);
    ctx.restore();
  }
  drawFooterFrame(ctx, t, data.dateLabel, ms, 2200);
}

function drawProofFrame(ctx, t, data, ms) {
  const shot = (data.instants || [])[0];
  if (!shot) { drawStreakFrame(ctx, t, data, ms); return; }
  const tw = 840, th = 1050, tx = (W - tw) / 2, ty = 420, rad = 48;
  const p = seg(ms, 400, 1300);
  if (p > 0) {
    const sc = 0.82 + 0.18 * easeBack(p);
    ctx.save();
    ctx.globalAlpha = seg(ms, 400, 800);
    ctx.translate(tx + tw / 2, ty + th / 2); ctx.scale(sc, sc); ctx.translate(-(tx + tw / 2), -(ty + th / 2));
    rr(ctx, tx, ty, tw, th, rad); ctx.clip();
    ctx.fillStyle = "#1c1c1c"; ctx.fillRect(tx, ty, tw, th);
    coverImg(ctx, shot.img, tx, ty, tw, th);
    // label tag pinned inside the photo
    ctx.font = F(500, 34);
    const tag = shot.tag, tagW = ctx.measureText(tag).width + 56;
    ctx.fillStyle = "rgba(0,0,0,.45)";
    rr(ctx, tx + 28, ty + 28, tagW, 66, 33); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(tag, tx + 56, ty + 62);
    ctx.restore();
  }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const metaA = seg(ms, 1300, 1800);
  if (metaA > 0) {
    ctx.save(); ctx.globalAlpha = metaA; ctx.translate(0, (1 - metaA) * 24);
    ctx.font = F(500, 54); ctx.fillStyle = t.ink;
    ctx.fillText("checked off, proved", W / 2, ty + th + 110);
    ctx.restore();
  }
  const top = data.streaks[0];
  if (top) {
    const chipA = seg(ms, 1800, 2200);
    drawChipC(ctx, t, `×${top.streak} ${top.streak === 1 ? "day" : "days"} in a row`,
      W / 2, ty + th + 220, 40, 34, 0.7 + 0.3 * easeBack(chipA), chipA);
  }
  drawFooterFrame(ctx, t, data.dateLabel, ms);
}

const FAN_ANGLES = { 1: [0], 2: [-7, 7], 3: [-11, 0, 11], 4: [-12, -4, 4, 12], 5: [-13, -6.5, 0, 6.5, 13] };

function drawFanFrame(ctx, t, data, ms) {
  const shots = (data.instants || []).slice(0, 5);
  if (shots.length < 2) { drawProofFrame(ctx, t, data, ms); return; }
  const angles = FAN_ANGLES[shots.length];
  // newest shot takes the middle, older ones fan outward
  const order = [...angles].sort((a, b) => Math.abs(a) - Math.abs(b));
  const cards = shots.map((s, i) => ({ shot: s, target: order[i] }));
  const tw = 450, th = 630, cy = 990, pivotY = cy + 1050, rad = 40;
  // deal right first, then up over the top and to the left
  const dealRank = (a) => [...angles].sort((x, y) => y - x).indexOf(a);
  // painter's order: outer cards first, center on top
  [...cards].sort((a, b) => Math.abs(b.target) - Math.abs(a.target)).forEach((c) => {
    const k = dealRank(c.target);
    const p = seg(ms, 500 + k * 220, 1250 + k * 220);
    const rot = (c.target * Math.PI / 180) * easeBack(p);
    const a = seg(ms, 0, 400);
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(W / 2, pivotY); ctx.rotate(rot); ctx.translate(0, -(pivotY - cy));
    ctx.shadowColor = "rgba(0,0,0,.4)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
    rr(ctx, -tw / 2, -th / 2, tw, th, rad); ctx.fillStyle = "#1c1c1c"; ctx.fill();
    ctx.shadowColor = "transparent";
    rr(ctx, -tw / 2, -th / 2, tw, th, rad); ctx.clip();
    coverImg(ctx, c.shot.img, -tw / 2, -th / 2, tw, th);
    ctx.font = F(500, 26); ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(c.shot.day, tw / 2 - 22, th / 2 - 34);
    ctx.restore();
  });
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const metaA = seg(ms, 2400, 2900);
  if (metaA > 0) {
    ctx.save(); ctx.globalAlpha = metaA; ctx.translate(0, (1 - metaA) * 24);
    ctx.font = F(500, 54); ctx.fillStyle = t.ink;
    const nd = new Set(shots.map((s) => s.day)).size;
    ctx.fillText(`${nd} ${nd === 1 ? "day" : "days"}, proved`, W / 2, 1460);
    ctx.restore();
  }
  const top = data.streaks[0];
  if (top) {
    const chipA = seg(ms, 2800, 3200);
    drawChipC(ctx, t, `×${top.streak} ${top.streak === 1 ? "day" : "days"} in a row`,
      W / 2, 1570, 40, 34, 0.7 + 0.3 * easeBack(chipA), chipA);
  }
  drawFooterFrame(ctx, t, data.dateLabel, ms, 3100);
}

const KIND_FRAME = { streak: drawStreakFrame, proof: drawProofFrame, fan: drawFanFrame };

function drawFrame(canvas, kind, data, theme, ms) {
  const t = THEMES[theme] || THEMES.dark;
  if (canvas.width !== W) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext("2d");
  ctx.globalAlpha = 1;
  ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "middle";
  drawBrandFrame(ctx, t, ms);
  (KIND_FRAME[kind] || drawStreakFrame)(ctx, t, data, ms);
}

async function renderFinal(canvas, kind, data, theme) {
  await document.fonts.ready;
  drawFrame(canvas, kind, data, theme, DUR);
}

function animateCard(canvas, kind, data, theme) {
  let raf = 0, stopped = false;
  if (REDUCED) { renderFinal(canvas, kind, data, theme); return { stop() {} }; }
  document.fonts.ready.then(() => {
    if (stopped) return;
    const start = performance.now();
    const loop = (now) => {
      if (stopped) return;
      const el = (now - start) % (DUR + HOLD);
      drawFrame(canvas, kind, data, theme, Math.min(el, DUR));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  });
  return { stop() { stopped = true; cancelAnimationFrame(raf); } };
}

function videoType() {
  if (!window.MediaRecorder) return null;
  return ["video/mp4;codecs=avc1.42E01E", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

async function recordCard(canvas, kind, data, theme) {
  const type = videoType();
  if (!type) return null;
  await document.fonts.ready;
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });
  rec.start(200);
  const t0 = performance.now();
  await new Promise((res) => {
    const step = (now) => {
      const el = now - t0;
      drawFrame(canvas, kind, data, theme, Math.min(el, DUR));
      if (el < DUR + 300) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: type.split(";")[0] });
  return blob.size > 0 ? blob : null;
}

async function shareAnimated(canvas, kind, data, theme) {
  // animated path: record MP4, share as a video Story
  if (!REDUCED) {
    const blob = await recordCard(canvas, kind, data, theme);
    if (blob) {
      const file = new File([blob], "daily-streak.mp4", { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return "shared";
        } catch (e) {
          if (e.name === "AbortError") return "cancelled";
        }
      }
    }
  }
  // still path: exactly yesterday's behavior
  await renderFinal(canvas, kind, data, theme);
  return shareOrDownload(canvas);
}

async function loadInstantImages(rows) {
  // rows: { src (object URL), label, created_at (ISO), date (YYYY-MM-DD) }
  const out = [];
  for (const r of rows) {
    try {
      const img = new Image();
      img.src = r.src;
      await img.decode();
      const dt = new Date(r.created_at);
      out.push({
        img,
        tag: `${(r.label || "—").slice(0, 24)} · ${dt.getHours()}:${String(dt.getMinutes()).padStart(2, "0")}`,
        day: new Date(r.date + "T00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      });
    } catch { /* skip undecodable */ }
  }
  return out;
}

export { renderFinal, animateCard, shareAnimated, loadInstantImages, videoType };
