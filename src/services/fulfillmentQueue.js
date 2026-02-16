// src/services/fulfillmentQueue.js
"use strict";

const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

const JOB_KEY = "fulfillment_queue";

let _pool = null;

function pool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (fulfillment queue in Postgres)");

  _pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return _pool;
}

function defaultDB() {
  return { items: [] };
}

async function readDB() {
  try {
    const p = pool();
    const q = `SELECT state_json FROM public.job_state WHERE job_key = $1 LIMIT 1`;
    const { rows } = await p.query(q, [JOB_KEY]);
    const raw = rows?.[0]?.state_json;

    const db = raw && typeof raw === "object" ? raw : {};
    db.items = Array.isArray(db.items) ? db.items : [];
    return db;
  } catch {
    return defaultDB();
  }
}

async function writeDB(db) {
  const p = pool();
  const safe = db && typeof db === "object" ? db : defaultDB();
  safe.items = Array.isArray(safe.items) ? safe.items : [];

  const q = `
    INSERT INTO public.job_state (job_key, state_json, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()
  `;
  await p.query(q, [JOB_KEY, JSON.stringify(safe)]);
}

// Best-effort lock to avoid duplicate enqueues in multi-instance Railway
async function withLock(fn, ttlSeconds = 15) {
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

async function enqueue({ monthKey, userId, reward, provider = "FundedNext" }) {
  return withLock(async ({ locked }) => {
    if (!locked) return null;

    const db = await readDB();

    const item = {
      id: `ff_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      monthKey,
      userId,
      reward,
      provider,
      status: "pending", // pending | delivered
      createdAt: Date.now(),
      deliveredAt: null,
    };

    db.items.push(item);
    await writeDB(db);
    return item;
  });
}

async function listPending(monthKey = null) {
  const db = await readDB();
  return db.items.filter(
    (i) => i.status === "pending" && (!monthKey || i.monthKey === monthKey)
  );
}

module.exports = {
  enqueue,
  listPending,
};
