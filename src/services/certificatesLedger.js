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
    if (!locked) return;

    const db = await readDB();

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
      rewardClaimable: typeof rewardClaimable === "boolean" ? rewardClaimable : undefined,
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

/* -------------------- NEW: DB-native lookup + claim overlay -------------------- */

function normalizeCode(input) {
  return String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function getClaimOverlay(code) {
  const p = pool();
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const row = await p
    .query(
      `SELECT code, claimed_at, claimed_by, claim_ref, claim_note
       FROM public.certificate_claims
       WHERE code = $1
       LIMIT 1`,
      [normalized]
    )
    .then((r) => r.rows?.[0] || null)
    .catch(() => null);

  return row || null;
}

async function findCertificateByCode(code) {
  const p = pool();
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  // ✅ Pull ONLY the one entry from JSONB (prevents huge JSON parse)
  const cert = await p
    .query(
      `SELECT state_json->'indexByCode'-> $2 AS cert
       FROM public.job_state
       WHERE job_key = $1
       LIMIT 1`,
      [JOB_KEY, normalized]
    )
    .then((r) => r.rows?.[0]?.cert || null)
    .catch(() => null);

  if (!cert || typeof cert !== "object") return null;

  // Overlay claimed state from certificate_claims table (source of truth for claims)
  const claim = await getClaimOverlay(normalized);
  if (claim) {
    cert.claimed = true;
    cert.claimedAt = claim.claimed_at ? new Date(claim.claimed_at).getTime() : Date.now();
    cert.claimedBy = claim.claimed_by || "admin";
    cert.claimRef = claim.claim_ref || null;
    cert.claimNote = claim.claim_note || null;
  }

  return cert;
}

async function getUserCertificates(userId, monthKey = null) {
  // NOTE: this still uses readDB; keep as-is to avoid behavior change.
  const db = await readDB();
  const uid = String(userId || "");
  const list = Array.isArray(db.issued) ? db.issued : [];
  const filtered = list.filter((x) => x.userId === uid);
  if (!monthKey) return filtered;
  return filtered.filter((x) => x.monthKey === String(monthKey));
}

async function claimCertificateByCode(code, userId) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, reason: "missing_code" };

  const cert = await findCertificateByCode(normalized);
  if (!cert) return { ok: false, reason: "not_found" };

  // Only the winner can claim
  if (String(cert.userId || "") !== String(userId || "")) {
    return { ok: false, reason: "not_owner" };
  }

  // If not claimable, block (same rule as before)
  const claimable =
    typeof cert.rewardClaimable === "boolean"
      ? cert.rewardClaimable
      : String(cert.rewardLabel || "").trim().toLowerCase() !== "top 10 recognition";

  if (!claimable) return { ok: false, reason: "not_claimable" };

  // Already claimed (overlay)
  if (cert.claimed) return { ok: false, reason: "already_claimed" };

  // ✅ Persist claim in DB (idempotent by primary key)
  const p = pool();
  const inserted = await p
    .query(
      `INSERT INTO public.certificate_claims (code, claimed_by, claim_ref, claim_note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING`,
      [normalized, String(userId || ""), null, null]
    )
    .then((r) => (r.rowCount || 0) > 0)
    .catch(() => false);

  if (!inserted) return { ok: false, reason: "already_claimed" };

  // Return cert with overlay refreshed
  const fresh = await findCertificateByCode(normalized);
  return { ok: true, cert: fresh || cert };
}

async function markCertificateClaimed(code, { adminId = null, ref = null, note = null } = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, reason: "missing_code" };

  const cert = await findCertificateByCode(normalized);
  if (!cert) return { ok: false, reason: "not_found" };

  const claimable =
    typeof cert.rewardClaimable === "boolean"
      ? cert.rewardClaimable
      : String(cert.rewardLabel || "").trim().toLowerCase() !== "top 10 recognition";

  if (!claimable) return { ok: false, reason: "not_claimable", cert };

  // Already claimed (overlay)
  if (cert.claimed) return { ok: true, already: true, cert };

  const p = pool();

  // ✅ Persist claim in DB (no huge JSON writes)
  const inserted = await p
    .query(
      `INSERT INTO public.certificate_claims (code, claimed_by, claim_ref, claim_note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING`,
      [
        normalized,
        adminId ? String(adminId) : "admin",
        ref ? String(ref).slice(0, 120) : null,
        note ? String(note).slice(0, 500) : null,
      ]
    )
    .then((r) => (r.rowCount || 0) > 0)
    .catch(() => false);

  if (!inserted) {
    const again = await findCertificateByCode(normalized);
    return { ok: true, already: true, cert: again || cert };
  }

  const fresh = await findCertificateByCode(normalized);
  return { ok: true, already: false, cert: fresh || cert };
}

/* -------------------- legacy support (DB-native lookup) -------------------- */

async function findLegacyByCode(code) {
  const p = pool();
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const legacy = await p
    .query(
      `SELECT state_json->'legacyIndexByCode'-> $2 AS legacy
       FROM public.job_state
       WHERE job_key = $1
       LIMIT 1`,
      [JOB_KEY, normalized]
    )
    .then((r) => r.rows?.[0]?.legacy || null)
    .catch(() => null);

  if (!legacy || typeof legacy !== "object") return null;
  return legacy;
}

async function markLegacyCertificate({ code, markedByUserId, note }) {
  // unchanged (still writes ledger json). Leave as-is to avoid behavior change.
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, reason: "missing_code" };

  return withLock(async ({ locked }) => {
    if (!locked) return { ok: false, reason: "busy_try_again" };

    const db = await readDB();

    if (db.indexByCode?.[normalized]) {
      return { ok: false, reason: "already_issued_cert" };
    }

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
