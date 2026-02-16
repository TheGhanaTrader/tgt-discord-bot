"use strict";

const { Pool } = require("pg");

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  console.error("[SCHED_STATE] FATAL: DATABASE_URL missing (Postgres required).");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function ensureRow(jobKey) {
  const k = String(jobKey || "").trim();
  if (!k) throw new Error("jobKey required");

  await pool.query(
    "INSERT INTO public.job_state (job_key, state) VALUES ($1, '{}'::jsonb) ON CONFLICT (job_key) DO NOTHING",
    [k]
  );
  return k;
}

async function getJob(jobKey) {
  const k = await ensureRow(jobKey);
  const { rows } = await pool.query(
    "SELECT job_key, state, lock_owner, lock_expires_at FROM public.job_state WHERE job_key=$1",
    [k]
  );
  return rows[0] || null;
}

async function setState(jobKey, patchObj) {
  const k = await ensureRow(jobKey);
  const patch = patchObj && typeof patchObj === "object" ? patchObj : {};
  // Merge patch into existing state JSON
  const { rows } = await pool.query(
    `UPDATE public.job_state
     SET state = COALESCE(state, '{}'::jsonb) || $2::jsonb
     WHERE job_key = $1
     RETURNING job_key, state, lock_owner, lock_expires_at`,
    [k, JSON.stringify(patch)]
  );
  return rows[0] || null;
}

/**
 * Acquire a lock for jobKey.
 * - owner: string identifier (e.g. "monthlyHonorsScheduler")
 * - ttlMs: lock duration; defaults 5 minutes
 */
async function acquireLock({ jobKey, owner, ttlMs = 5 * 60 * 1000 } = {}) {
  const k = await ensureRow(jobKey);
  const who = String(owner || "unknown").trim() || "unknown";
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : 5 * 60 * 1000;

  const { rows } = await pool.query(
    `
    UPDATE public.job_state
    SET lock_owner = $2,
        lock_expires_at = (now() + ($3::int || ' milliseconds')::interval)
    WHERE job_key = $1
      AND (
        lock_owner IS NULL
        OR lock_expires_at IS NULL
        OR lock_expires_at <= now()
      )
    RETURNING job_key, lock_owner, lock_expires_at
    `,
    [k, who, ttl]
  );

  if (rows && rows.length) {
    return { ok: true, owner: rows[0].lock_owner, expiresAt: rows[0].lock_expires_at };
  }

  const cur = await getJob(k);
  return {
    ok: false,
    reason: "LOCKED",
    current: cur
      ? { owner: cur.lock_owner || null, expiresAt: cur.lock_expires_at || null }
      : { owner: null, expiresAt: null },
  };
}

async function releaseLock({ jobKey, owner } = {}) {
  const k = await ensureRow(jobKey);
  const who = String(owner || "").trim();

  // if owner provided, only owner can release (safe)
  const q = who
    ? `UPDATE public.job_state
       SET lock_owner=NULL, lock_expires_at=NULL
       WHERE job_key=$1 AND lock_owner=$2
       RETURNING job_key`
    : `UPDATE public.job_state
       SET lock_owner=NULL, lock_expires_at=NULL
       WHERE job_key=$1
       RETURNING job_key`;

  const args = who ? [k, who] : [k];
  const { rows } = await pool.query(q, args);
  return rows && rows.length ? { ok: true } : { ok: false, reason: "NOT_OWNER_OR_NO_LOCK" };
}

async function clearLock({ jobKey, force = false, requestedBy = "unknown" } = {}) {
  const k = await ensureRow(jobKey);
  const reqBy = String(requestedBy || "unknown").trim() || "unknown";

  if (!force) {
    const cur = await getJob(k);
    if (!cur || !cur.lock_owner) return { ok: true, cleared: false, reason: "NO_LOCK_PRESENT", lock: null };
    if (cur.lock_expires_at && new Date(cur.lock_expires_at).getTime() > Date.now()) {
      return { ok: false, reason: "LOCK_ACTIVE_NOT_EXPIRED", lock: { owner: cur.lock_owner, expiresAt: cur.lock_expires_at } };
    }
  }

  await pool.query(
    `UPDATE public.job_state
     SET lock_owner=NULL, lock_expires_at=NULL,
         state = COALESCE(state,'{}'::jsonb) || jsonb_build_object('last_lock_cleared_by',$2,'last_lock_cleared_at', now())
     WHERE job_key=$1`,
    [k, reqBy]
  );

  return { ok: true, cleared: true, forced: !!force };
}

/**
 * Record a scheduler decision/run marker into JSON state.
 * Keep it generic so other schedulers can use it.
 */
async function recordDecision(jobKey, decisionObj) {
  const k = await ensureRow(jobKey);
  const d = decisionObj && typeof decisionObj === "object" ? decisionObj : {};
  const patch = { last_decision: { ...d, at: new Date().toISOString() } };
  return setState(k, patch);
}

async function recordRun(jobKey, runObj) {
  const k = await ensureRow(jobKey);
  const r = runObj && typeof runObj === "object" ? runObj : {};
  const patch = { last_run: { ...r, at: new Date().toISOString() } };
  return setState(k, patch);
}

/**
 * Compatibility exports (in case existing code expects these names).
 * We keep both styles to avoid breaking other modules.
 */
module.exports = {
  getJob,
  setState,
  acquireLock,
  releaseLock,
  clearLock,
  recordDecision,
  recordRun,
};
