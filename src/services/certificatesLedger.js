// src/services/certificatesLedger.js
"use strict";

const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

const JOB_KEY = "certificates_ledger";

let _pool = null;

function pool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (certificates ledger in Postgres)");

  _pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return _pool;
}

function defaultDB() {
  return {
    issued: [],
    indexByCode: {},
    legacy: [],
    legacyIndexByCode: {},
  };
}

async function readDB() {
  try {
    const p = pool();
    const q = `SELECT state_json FROM public.job_state WHERE job_key = $1 LIMIT 1`;
    const { rows } = await p.query(q, [JOB_KEY]);
    const raw = rows?.[0]?.state_json;

    const db = raw && typeof raw === "object" ? raw : {};
    db.issued = Array.isArray(db.issued) ? db.issued : [];
    db.indexByCode = db.indexByCode && typeof db.indexByCode === "object" ? db.indexByCode : {};

    // legacy support (for /verifycert legacy:true)
    db.legacy = Array.isArray(db.legacy) ? db.legacy : [];
    db.legacyIndexByCode =
      db.legacyIndexByCode && typeof db.legacyIndexByCode === "object"
        ? db.legacyIndexByCode
        : {};

    return db;
  } catch {
    return defaultDB();
  }
}

async function writeDB(db) {
  const p = pool();
  const safe = db && typeof db === "object" ? db : defaultDB();

  safe.issued = Array.isArray(safe.issued) ? safe.issued : [];
  safe.indexByCode = safe.indexByCode && typeof safe.indexByCode === "object" ? safe.indexByCode : {};

  safe.legacy = Array.isArray(safe.legacy) ? safe.legacy : [];
  safe.legacyIndexByCode =
    safe.legacyIndexByCode && typeof safe.legacyIndexByCode === "object"
      ? safe.legacyIndexByCode
      : {};

  const q = `
    INSERT INTO public.job_state (job_key, state_json, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()
  `;
  await p.query(q, [JOB_KEY, JSON.stringify(safe)]);
}

// Optional best-effort lock to avoid duplicate issuance in multi-instance Railway
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

/**
 * Record a certificate issuance (idempotent by code).
 * category examples:
 * - WINNER_TOP_SALES
 * - WINNER_2ND_SALES
 * - WINNER_TOP_REFERRER
 * - TOP10_SALES
 * - TOP10_REFERRALS
 *
 * NOTE: async because Postgres
 */
async function recordCertificate({
  monthKey,
  userId,
  username,
  category,
  rankLabel,
  rewardLabel,
  rewardClaimable,
  code,
  filePath,
}) {
  if (!code) return;

  const normalized = String(code).trim().toUpperCase();
  if (!normalized) return;

  return withLock(async ({ locked }) => {
    // If lock not acquired, avoid races; best-effort skip
    if (!locked) return;

    const db = await readDB();

    // If code already exists, do nothing (idempotent)
    if (db.indexByCode?.[normalized]) return;

    const entry = {
      monthKey: String(monthKey || ""),
      userId: String(userId || ""),
      username: String(username || ""),
      category: String(category || ""),
      rankLabel: String(rankLabel || ""),
      rewardLabel: String(rewardLabel || ""),
      code: normalized,
      filePath: filePath || null,
      createdAt: Date.now(),
      rewardClaimable:
        typeof rewardClaimable === "boolean" ? rewardClaimable : undefined,
      claimed: false,
      claimedAt: null,
      claimedBy: null,
    };

    db.issued = Array.isArray(db.issued) ? db.issued : [];
    db.indexByCode = db.indexByCode || {};

    db.issued.push(entry);
    db.indexByCode[normalized] = entry;

    await writeDB(db);
  });
}

async function findCertificateByCode(code) {
  const db = await readDB();
  const normalized = String(code || "").trim().toUpperCase();
  return db.indexByCode?.[normalized] || null;
}

async function getUserCertificates(userId, monthKey = null) {
  const db = await readDB();
  const uid = String(userId || "");
  const list = Array.isArray(db.issued) ? db.issued : [];
  const filtered = list.filter((x) => x.userId === uid);
  if (!monthKey) return filtered;
  return filtered.filter((x) => x.monthKey === String(monthKey));
}

async function claimCertificateByCode(code, userId) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return { ok: false, reason: "missing_code" };

  // claim modifies state → lock-protected
  return withLock(async ({ locked }) => {
    if (!locked) return { ok: false, reason: "busy_try_again" };

    const db = await readDB();

    const cert = db.indexByCode?.[normalized] || null;
    if (!cert) return { ok: false, reason: "not_found" };

    // Only the winner can claim their own certificate
    if (String(cert.userId || "") !== String(userId || "")) {
      return { ok: false, reason: "not_owner" };
    }

    // If not claimable, block
    const claimable =
      typeof cert.rewardClaimable === "boolean"
        ? cert.rewardClaimable
        : String(cert.rewardLabel || "").trim().toLowerCase() !== "top 10 recognition";

    if (!claimable) return { ok: false, reason: "not_claimable" };

    // Already claimed
    if (cert.claimed) return { ok: false, reason: "already_claimed" };

    cert.claimed = true;
    cert.claimedAt = Date.now();
    cert.claimedBy = String(userId || "");

    // Persist
    await writeDB(db);

    return { ok: true, cert };
  });
}

async function markCertificateClaimed(code, { adminId = null, ref = null, note = null } = {}) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return { ok: false, reason: "missing_code" };

  return withLock(async ({ locked }) => {
    if (!locked) return { ok: false, reason: "busy_try_again" };

    const db = await readDB();

    const cert = db.indexByCode?.[normalized] || null;
    if (!cert) return { ok: false, reason: "not_found" };

    // must be claimable (same rule as before)
    const claimable =
      typeof cert.rewardClaimable === "boolean"
        ? cert.rewardClaimable
        : String(cert.rewardLabel || "").trim().toLowerCase() !== "top 10 recognition";

    if (!claimable) return { ok: false, reason: "not_claimable", cert };

    if (cert.claimed) {
      return { ok: true, already: true, cert };
    }

    cert.claimed = true;
    cert.claimedAt = Date.now();
    cert.claimedBy = adminId ? String(adminId) : "admin";

    // optional audit fields (non-breaking)
    cert.claimRef = ref ? String(ref).slice(0, 120) : null;
    cert.claimNote = note ? String(note).slice(0, 500) : null;

    await writeDB(db);

    return { ok: true, already: false, cert };
  });
}

/* -------------------- legacy support -------------------- */

function normalizeCode(input) {
  return String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function findLegacyByCode(code) {
  const db = await readDB();
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  return db.legacyIndexByCode?.[normalized] || null;
}

async function markLegacyCertificate({ code, markedByUserId, note }) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, reason: "missing_code" };

  return withLock(async ({ locked }) => {
    if (!locked) return { ok: false, reason: "busy_try_again" };

    const db = await readDB();

    // If it exists as a real issued cert, do not mark legacy (prevents conflicts)
    if (db.indexByCode?.[normalized]) {
      return { ok: false, reason: "already_issued_cert" };
    }

    // idempotent legacy mark
    if (db.legacyIndexByCode?.[normalized]) {
      return { ok: true, already: true, entry: db.legacyIndexByCode[normalized] };
    }

    const entry = {
      code: normalized,
      createdAt: Date.now(),
      markedByUserId: String(markedByUserId || ""),
      note: String(note || "").trim() || null,
    };

    db.legacy = Array.isArray(db.legacy) ? db.legacy : [];
    db.legacyIndexByCode =
      db.legacyIndexByCode && typeof db.legacyIndexByCode === "object"
        ? db.legacyIndexByCode
        : {};

    db.legacy.push(entry);
    db.legacyIndexByCode[normalized] = entry;

    await writeDB(db);

    return { ok: true, already: false, entry };
  });
}

module.exports = {
  recordCertificate,
  findCertificateByCode,
  getUserCertificates,
  claimCertificateByCode,
  markCertificateClaimed,
  findLegacyByCode,
  markLegacyCertificate,
};
