// The nudge brain, v1. Called every 15 minutes by a scheduler (launchd curl).
// Evaluates every push-subscribed user in their own timezone and sends at most
// one push per kind per day (notify_log dedupe). Windows, not spam:
//   09:00–09:14  kickoff       — only if nothing done yet today
//   20:30–20:44  streak-at-risk — only if a streak ≥ 3 is still unchecked
//   21:30–21:44  last-one-in   — only if the whole crew closed and you didn't
// Reactions are event-driven (api/react-notify.js), not handled here.

const { Pool } = require("pg");
const webpush = require("web-push");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

const DAY_ROLL_HOURS = 4;

function localParts(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return { h: get("hour") % 24, m: get("minute") };
  } catch { return null; }
}

function localDay(tz) {
  // the user's "today" with the 04:00 roll
  const shifted = new Date(Date.now() - DAY_ROLL_HOURS * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(shifted);
}

function inWindow(t, h, m) { return t.h === h && t.m >= m && t.m < m + 15; }

function prevDay(day) {
  const [y, mo, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d - 1));
  return dt.toISOString().slice(0, 10);
}

function minusDays(day, n) {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d - n)).toISOString().slice(0, 10);
}

async function send(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await pool.query("delete from push_subs where endpoint = $1", [sub.endpoint]).catch(() => {});
    }
    return false;
  }
}

async function once(userId, kind, day) {
  const r = await pool.query(
    "insert into notify_log (user_id, kind, day) values ($1, $2, $3) on conflict do nothing returning 1",
    [userId, kind, day]
  );
  return r.rowCount > 0;
}

function streakEndingYesterday(dates, today) {
  const set = new Set(dates);
  let streak = 0, cur = prevDay(today);
  while (set.has(cur)) { streak++; cur = prevDay(cur); }
  return streak;
}

module.exports = async (req, res) => {
  if (req.headers["x-notify-secret"] !== process.env.NOTIFY_SECRET || !process.env.NOTIFY_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:hello@getdaily.day",
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY
  );

  await pool.query(`create table if not exists notify_log (
    user_id text not null, kind text not null, day text not null,
    created_at timestamptz not null default now(),
    primary key (user_id, kind, day))`);

  const { rows: subs } = await pool.query(
    "select s.*, p.name from push_subs s join profiles p on p.id = s.user_id"
  );
  const byUser = new Map();
  for (const s of subs) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }

  const sent = [];
  for (const [userId, userSubs] of byUser) {
    // Standing rule: never guess a user's clock. No timezone on file →
    // no rhythm nudges for this user (event pushes are unaffected).
    const tz = userSubs.find((s) => s.tz)?.tz;
    if (!tz) continue;
    const t = localParts(tz);
    if (!t) continue;
    const day = localDay(tz);
    let payload = null, kind = null;

    if (inWindow(t, 9, 0)) {
      const { rows: [a] } = await pool.query(
        `select
          (select count(*) from tasks where user_id=$1 and date=$2 and done) +
          (select count(*) from ritual_checks where user_id=$1 and date=$2) +
          (select count(*) from notes where user_id=$1 and date=$2) as acts,
          (select count(*) from rituals where user_id=$1 and active) as rits`,
        [userId, day]
      );
      if (Number(a.acts) === 0 && Number(a.rits) > 0) {
        kind = "kickoff";
        payload = { title: "Your day is open", body: `${a.rits} non-negotiable${a.rits == 1 ? "" : "s"} waiting. First one's the domino.`, tag: "kickoff", url: "/app/" };
      }
    } else if (inWindow(t, 20, 30)) {
      const { rows: rituals } = await pool.query(
        "select id, label from rituals where user_id=$1 and active", [userId]
      );
      let best = null;
      for (const r of rituals) {
        const { rows: checks } = await pool.query(
          "select date from ritual_checks where ritual_id=$1 and user_id=$2 and date >= $3",
          [r.id, userId, minusDays(day, 60)]
        );
        const dates = checks.map((c) => c.date);
        if (dates.includes(day)) continue; // already checked today
        const streak = streakEndingYesterday(dates, day);
        if (streak >= 3 && (!best || streak > best.streak)) best = { label: r.label, streak };
      }
      if (best) {
        kind = "risk";
        payload = { title: `${best.label} — ×${best.streak} on the line`, body: "One check keeps it.", tag: "risk", url: "/app/" };
      }
    } else if (inWindow(t, 13, 0)) {
      // crew digest: one quiet "come back" a day, never per-event
      const { rows: fresh } = await pool.query(
        `select i.label, coalesce(p.name,'someone') as name, count(*) over () as total
         from instants i
         join crew_members m1 on m1.user_id = i.user_id
         join crew_members m2 on m2.crew_id = m1.crew_id and m2.user_id = $1
         left join profiles p on p.id = i.user_id
         where i.user_id <> $1 and i.date = $2 and i.visibility = 'crew'
         order by i.created_at desc limit 1`,
        [userId, day]
      );
      if (fresh.length) {
        kind = "crewdigest";
        const f = fresh[0];
        const extra = Number(f.total) > 1 ? ` +${Number(f.total) - 1} more` : "";
        payload = { title: "New in the room", body: `${f.name} proved ${f.label}${extra}`, tag: "crewdigest", url: "/app/" };
      }
    } else if (inWindow(t, 21, 30)) {
      const { rows: mates } = await pool.query(
        `select m2.user_id, p.name,
           (select count(*) from tasks t where t.user_id=m2.user_id and t.date=$2) as total,
           (select count(*) from tasks t where t.user_id=m2.user_id and t.date=$2 and t.done) as done
         from crew_members m1 join crew_members m2 on m2.crew_id = m1.crew_id
         join profiles p on p.id = m2.user_id
         where m1.user_id = $1`,
        [userId, day]
      );
      if (mates.length > 1) {
        const me = mates.find((m) => m.user_id === userId);
        const others = mates.filter((m) => m.user_id !== userId);
        const allClosed = others.every((m) => Number(m.total) > 0 && Number(m.done) === Number(m.total));
        const meClosed = Number(me.total) > 0 && Number(me.done) === Number(me.total);
        if (allClosed && !meClosed) {
          kind = "lastone";
          const names = others.map((m) => m.name).slice(0, 3).join(", ");
          payload = { title: "You're the last one in", body: `${names} closed their day.`, tag: "lastone", url: "/app/" };
        }
      }
    }

    if (payload && (await once(userId, kind, day))) {
      for (const s of userSubs) await send(s, payload);
      sent.push({ userId: userId.slice(0, 12), kind });
    }
  }
  res.status(200).json({ ok: true, evaluated: byUser.size, sent });
};
