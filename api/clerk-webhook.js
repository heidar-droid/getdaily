// Clerk `user.created` webhook -> create the Supabase `profiles` row server-side.
//
// Why this exists: the client only inserts a profile after the post-OAuth page
// reload runs start(). A user who bounces during that reload window is left as a
// verified Clerk account with no profile row (and no seeded ritual) — a ghost that
// only self-heals if they ever return. This webhook creates the row the instant the
// Clerk user exists, independent of the browser, so ghosts become impossible.
//
// The insert fires the `on_profile_created` trigger, which seeds the default ritual —
// identical to the client path. It's idempotent: if the client already created the
// profile (race), ON CONFLICT DO NOTHING is a no-op and no duplicate ritual is seeded.

const crypto = require("crypto");
const { Pool } = require("pg");

// Module-scoped pool is reused across warm invocations. Tiny max: webhook volume is
// one call per signup. Uses the Supabase transaction pooler (:6543) via DATABASE_URL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
});

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Verify a Svix (Clerk) webhook signature. Header `svix-signature` is a
// space-separated list of `v1,<base64sig>`; the signed content is
// `${id}.${timestamp}.${rawBody}` HMAC-SHA256'd with the base64 secret.
function verifySvix(secret, headers, rawBody) {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const sigHeader = headers["svix-signature"];
  if (!id || !timestamp || !sigHeader) return false;

  // Reject stale payloads (>5 min) to blunt replay attacks.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", key).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);

  return sigHeader.split(" ").some((part) => {
    const sig = part.split(",")[1];
    if (!sig) return false;
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret || !process.env.DATABASE_URL) {
    console.error("clerk-webhook: missing CLERK_WEBHOOK_SECRET or DATABASE_URL env");
    res.status(500).json({ error: "not configured" });
    return;
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    res.status(400).json({ error: "bad body" });
    return;
  }

  if (!verifySvix(secret, req.headers, raw)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  let evt;
  try {
    evt = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    res.status(400).json({ error: "bad json" });
    return;
  }

  // We only act on user creation; ack everything else so Clerk stops retrying.
  if (evt.type !== "user.created") {
    res.status(200).json({ ok: true, ignored: evt.type });
    return;
  }

  const u = evt.data || {};
  const id = u.id;
  if (!id) {
    res.status(400).json({ error: "no user id" });
    return;
  }
  const email = u.email_addresses?.[0]?.email_address || "";
  const name = u.first_name || (email ? email.split("@")[0] : "there");

  try {
    await pool.query(
      "insert into public.profiles (id, name) values ($1, $2) on conflict (id) do nothing",
      [id, name]
    );
  } catch (e) {
    // 500 -> Clerk retries with backoff, so a transient DB blip self-heals.
    console.error("clerk-webhook: profile insert failed", e.message);
    res.status(500).json({ error: "db insert failed" });
    return;
  }

  res.status(200).json({ ok: true, id });
};
