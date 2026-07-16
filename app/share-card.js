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
