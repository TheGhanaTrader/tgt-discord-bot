// src/services/rewardsLedger.js
"use strict";

const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

const JOB_KEY = "rewards_ledger";

let _pool = null;

function pool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (rewards ledger in Postgres)");

  _pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return _pool;
}

function defaultDB() {
  return { months: {} };
}

async function readDB() {
  try {
    const p = pool();
    const q = `SELECT state_json FROM public.job_state WHERE job_key = $1 LIMIT 1`;
    const { rows } = await p.query(q, [JOB_KEY]);
    const raw = rows?.[0]?.state_json;

    const db = raw && typeof raw === "object" ? raw : {};
    db.months = db.months || {};
    return db;
  } catch {
    // Never crash callers; return safe defaults
    return defaultDB();
  }
}

async function writeDB(db) {
  const p = pool();
  const safe = db && typeof db === "object" ? db : defaultDB();
  safe.months = safe.months || {};

  const q = `
    INSERT INTO public.job_state (job_key, state_json, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()
  `;
  await p.query(q, [JOB_KEY, JSON.stringify(safe)]);
}

// Optional best-effort lock to avoid double-writes (safe in multi-instance Railway)
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

  // If lock not acquired, still run read-only calls safely (but skip writes)
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

/**
 * Records winners and their verification codes for a month.
 * Structure:
 * months[monthKey] = { createdAt, winners: [{ userId, rank, reward, code, certPath, createdAt }] }
 *
 * NOTE: This is now async because Postgres.
 */
async function saveMonthWinners(monthKey, winners) {
  if (!monthKey) return;

  return withLock(async ({ locked }) => {
    // If lock not acquired, avoid clobbering; best-effort safety
    if (!locked) return;

    const db = await readDB();
    db.months[monthKey] = {
      createdAt: Date.now(),
      winners: (winners || []).map((w) => ({
        userId: w.userId,
        rank: w.rank,
        reward: w.reward,
        code: w.code,
        certPath: w.certPath || null,
        createdAt: Date.now(),
      })),
    };
    await writeDB(db);
  });
}

async function getMonthWinners(monthKey) {
  if (!monthKey) return [];
  const db = await readDB();
  return db.months?.[monthKey]?.winners || [];
}

// ✅ convenience guard: has this month already been locked/saved?
async function hasMonthRecord(monthKey) {
  if (!monthKey) return false;
  const db = await readDB();
  return !!db.months?.[monthKey]; // lock even if winners is []
}

module.exports = {
  saveMonthWinners,
  getMonthWinners,
  hasMonthRecord,
};
