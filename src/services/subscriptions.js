// src/services/subscriptions.js
"use strict";

const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

// Postgres job_state key
const JOB_KEY = "subscriptions_store";

let _pool = null;

function pool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (subscriptions in Postgres)");

  _pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return _pool;
}

// ---- Storage shape (same as your JSON file) ----
function defaultStore() {
  return { users: {} };
}

async function readStore() {
  try {
    const p = pool();

    // ✅ IMPORTANT: your table has `state` (jsonb), not state_json
    const q = `SELECT state FROM public.job_state WHERE job_key = $1 LIMIT 1`;
    const { rows } = await p.query(q, [JOB_KEY]);
    const raw = rows?.[0]?.state;

    const parsed = raw && typeof raw === "object" ? raw : {};
    if (!parsed.users) parsed.users = {};
    return parsed;
  } catch {
    return defaultStore();
  }
}

async function writeStore(store) {
  const p = pool();

  const safe = store && typeof store === "object" ? store : defaultStore();
  if (!safe.users) safe.users = {};

  const q = `
    INSERT INTO public.job_state (job_key, state, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
  `;

  await p.query(q, [JOB_KEY, JSON.stringify(safe)]);
}

// ---- Best-effort lock (replaces Windows EPERM write guard) ----
// Keeps “no overlapping writes” intent, but for multi-instance Railway.
async function withLock(fn, ttlSeconds = 20) {
  const p = pool();
  const lockBy = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

  const q = `
    INSERT INTO public.job_state (job_key, state, locked_until, locked_by, updated_at)
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

  // If we don't own the lock, we DO NOT write (prevents clobber)
  if (owner !== lockBy) return fn({ locked: false, lockBy });

  try {
    return await fn({ locked: true, lockBy });
  } finally {
    await p
      .query(
        `UPDATE public.job_state
         SET locked_until = NULL, locked_by = NULL, updated_at = NOW()
         WHERE job_key = $1 AND locked_by = $2`,
        [JOB_KEY, lockBy]
      )
      .catch(() => null);
  }
}

// ---- Public API (same behavior, now async) ----

async function getSubscription(discordId) {
  const store = await readStore();
  return store.users[String(discordId)] || null;
}

async function upsertSubscription(discordId, patch) {
  const id = String(discordId);

  return withLock(async ({ locked }) => {
    // If lock not acquired, avoid conflicting writes
    if (!locked) return null;

    const store = await readStore();

    const current = store.users[id] || {
      discord_id: id,
      tier: null,
      status: "inactive",
      expires_at: null,
      last_paystack_ref: null,
      expired_notified_at: null,
      reminders: { d3: false, h24: false },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const next = {
      ...current,
      ...patch,
      discord_id: current.discord_id || id,
      reminders: {
        ...current.reminders,
        ...(patch?.reminders || {}),
      },
      updated_at: new Date().toISOString(),
    };

    store.users[id] = next;
    await writeStore(store);
    return next;
  });
}

async function listAllSubscriptions() {
  const store = await readStore();
  return Object.entries(store.users || {}).map(([id, sub]) => ({
    discord_id: sub.discord_id || id,
    ...sub,
  }));
}

module.exports = {
  getSubscription,
  upsertSubscription,
  listAllSubscriptions,
};
