// Reaction → push to the instant's owner, instantly. Fired by the client after
// a successful (RLS-protected) reaction insert. Trust model: we only push if
// the reaction row actually exists and is fresh — spoofing requires having
// authenticated and inserted the reaction in the first place.

const { Pool } = require("pg");
const webpush = require("web-push");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  let body;
  try { body = await readBody(req); } catch { res.status(400).json({ error: "bad json" }); return; }
  const instantId = Number(body.instant_id);
  const emoji = String(body.emoji || "");
  if (!instantId || !emoji) { res.status(400).json({ error: "missing fields" }); return; }

  // the freshest matching reaction (must exist — inserted through RLS)
  const { rows: [rx] } = await pool.query(
    `select r.user_id as reactor, i.user_id as owner, i.label,
            coalesce(p.name, 'someone') as reactor_name
     from reactions r
     join instants i on i.id = r.instant_id
     left join profiles p on p.id = r.user_id
     where r.instant_id = $1 and r.emoji = $2
       and r.created_at > now() - interval '2 minutes'
     order by r.created_at desc limit 1`,
    [instantId, emoji]
  );
  if (!rx || rx.reactor === rx.owner) { res.status(200).json({ ok: true, skipped: true }); return; }

  const { rows: subs } = await pool.query("select * from push_subs where user_id = $1", [rx.owner]);
  if (!subs.length) { res.status(200).json({ ok: true, nosubs: true }); return; }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:hello@getdaily.day",
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY
  );
  const payload = JSON.stringify({
    title: `${emoji} ${rx.reactor_name} reacted to your ${rx.label} proof`,
    body: "the room saw it",
    tag: `rx-${instantId}`,
    url: "/app/",
  });
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
        { TTL: 3600, urgency: "high" });
      delivered++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await pool.query("delete from push_subs where endpoint = $1", [s.endpoint]).catch(() => {});
      }
    }
  }
  res.status(200).json({ ok: true, delivered });
};
