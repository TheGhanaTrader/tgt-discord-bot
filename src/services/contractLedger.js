// src/services/contractLedger.js
"use strict";

const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

const JOB_KEY = "contract_ledger";

let _pool = null;

function pool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (contract ledger in Postgres)");

  _pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return _pool;
}

function defaultLedger() {
  return { users: {} };
}

async function readLedger() {
  try {
    const p = pool();
    const q = `SELECT state_json FROM public.job_state WHERE job_key = $1 LIMIT 1`;
    const { rows } = await p.query(q, [JOB_KEY]);
    const raw = rows?.[0]?.state_json;

    const ledger = raw && typeof raw === "object" ? raw : {};
    ledger.users = ledger.users && typeof ledger.users === "object" ? ledger.users : {};
    return ledger;
  } catch {
    return defaultLedger();
  }
}

async function writeLedger(data) {
  const p = pool();
  const safe = data && typeof data === "object" ? data : defaultLedger();
  safe.users = safe.users && typeof safe.users === "object" ? safe.users : {};

  const q = `
    INSERT INTO public.job_state (job_key, state_json, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()
  `;
  await p.query(q, [JOB_KEY, JSON.stringify(safe)]);
}

// Best-effort lock (prevents multi-instance double-accept races)
async function withLock(fn, ttlSeconds = 20) {
  const p = pool();
  const lockBy = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

  const q = `
    INSERT INTO public.job_state (job_key, state_json, locked_until, locked_by, updated_at)
    VALUES ($1, '{}'::jsonb, NOW() + ($2 || ' seconds')::interval, $3, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET
      locked_until = CASE
        WHEN public.job_state.locked_until IS NULL OR public.job_state.locked_until < NOW()
        THEN NOW() + ($2 || ' seconds')::interval
        ELSE public.job_state.locked_until
      END,
      locked_by = CASE
        WHEN public.job_state.locked_until IS NULL OR public.job_state.locked_until < NOW()
        THEN $3
        ELSE public.job_state.locked_by
      END,
      updated_at = NOW()
    RETURNING locked_by
  `;

  const { rows } = await p.query(q, [JOB_KEY, String(ttlSeconds), lockBy]);
  const owner = rows?.[0]?.locked_by;

  if (owner !== lockBy) {
    return fn({ locked: false, lockBy });
  }

  try {
    return await fn({ locked: true, lockBy });
  } finally {
    await p
      .query(
        `UPDATE public.job_state SET locked_until = NULL, locked_by = NULL, updated_at = NOW() WHERE job_key = $1 AND locked_by = $2`,
        [JOB_KEY, lockBy]
      )
      .catch(() => null);
  }
}

async function hasAccepted(userId) {
  const ledger = await readLedger();
  return Boolean(ledger.users?.[String(userId)]?.acceptedAtUtc);
}

async function getAcceptance(userId) {
  const ledger = await readLedger();
  return ledger.users?.[String(userId)] || null;
}

async function recordAcceptance({ userId, username, tier, acceptedAtUtc, pdfPath }) {
  const id = String(userId);

  return withLock(async ({ locked }) => {
    if (!locked) return { ok: false, reason: "busy_try_again" };

    const ledger = await readLedger();

    // ✅ harden against old/corrupt ledger shapes
    ledger.users = ledger.users || {};

    // ✅ TRUE idempotency: if already accepted, do NOT overwrite
    if (ledger.users[id]?.acceptedAtUtc) {
      return { ok: false, already: true, existing: ledger.users[id] };
    }

    ledger.users[id] = {
      userId: id,
      username,
      tier,
      acceptedAtUtc,
      pdfPath,
    };

    await writeLedger(ledger);
    return { ok: true, already: false, entry: ledger.users[id] };
  });
}

module.exports = {
  hasAccepted,
  getAcceptance,
  recordAcceptance,
};
