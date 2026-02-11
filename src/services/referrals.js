// src/services/referrals.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "referrals.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Default shape
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ affiliates: {}, referredUsers: {} }, null, 2));
  }
}

function readDB() {
  ensure();
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const db = raw ? JSON.parse(raw) : {};
    if (!db.affiliates) db.affiliates = {};
    if (!db.referredUsers) db.referredUsers = {};
    return db;
  } catch {
    const safe = { affiliates: {}, referredUsers: {} };
    fs.writeFileSync(FILE, JSON.stringify(safe, null, 2));
    return safe;
  }
}

function writeDB(db) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

// YYYY-MM in UTC
function getMonthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * mapInvite(memberId, inviterId)
 * Saves who referred who (one-time, does not overwrite).
 */
function mapInvite(memberId, inviterId) {
  if (!memberId || !inviterId) return { ok: false, reason: "missing_params" };
  if (memberId === inviterId) return { ok: false, reason: "self_referral" };

  const db = readDB();

 // Don't overwrite if already mapped (rejoin anti-farm)
// Also record that they tried to remap (for later staff review)
if (db.referredUsers[memberId]) {
  const row = db.referredUsers[memberId];
  row.remapAttempts = Number(row.remapAttempts || 0) + 1;
  row.lastRemapAttemptAt = Date.now();
  db.referredUsers[memberId] = row;
  writeDB(db);
  return { ok: false, reason: "already_mapped" };
}

  db.referredUsers[memberId] = {
    affiliateId: inviterId,
    joinedAt: Date.now(),
    joinedCountedAt: null, // ✅ join counts ONCE (when contract accepted)
    // we will set this after first paid conversion
    convertedAt: null,
  };

  writeDB(db);
  return { ok: true };
}

/**
 * bump("join"|"sale", payload)
 * - join: increments monthly joins for referrer
 * - sale: increments monthly sales + revenue for referrer
 *
 * IMPORTANT:
 * - Join is "COUNT ONCE" per member (idempotent)
 * - Sale is "FIRST PAID CONVERSION ONLY" per member.
 *   If member already converted once, we ignore and return { ignored: true }.
 */
function bump(type, payload = {}) {
  const { referrerId, memberId } = payload;

  if (!referrerId) return { ok: false, reason: "missing_referrer" };
  if (memberId && memberId === referrerId) return { ok: false, reason: "self_referral" };

  const db = readDB();
  const month = getMonthKey();

  if (!db.affiliates[referrerId]) {
    db.affiliates[referrerId] = {
      lifetime: { joins: 0, sales: 0, revenue: 0 },
      monthly: {},
    };
  }
  if (!db.affiliates[referrerId].monthly[month]) {
    db.affiliates[referrerId].monthly[month] = { joins: 0, sales: 0, revenue: 0 };
  }

  const m = db.affiliates[referrerId].monthly[month];
  const life = db.affiliates[referrerId].lifetime;

  if (type === "join") {
    // ✅ Require memberId so we can enforce "count once"
    if (!memberId) return { ok: false, reason: "missing_memberId" };

    const referredRow = db.referredUsers?.[memberId] || null;

    // Must be mapped to THIS referrer (prevents fake credit)
    if (!referredRow || referredRow.affiliateId !== referrerId) {
      return { ok: false, reason: "no_referral_mapping" };
    }

    // ✅ COUNT ONCE per member (idempotent)
    if (referredRow.joinedCountedAt) {
      return { ok: true, ignored: true, reason: "join_already_counted" };
    }

    m.joins += 1;
    life.joins += 1;

    // mark join counted
    referredRow.joinedCountedAt = Date.now();
    db.referredUsers[memberId] = referredRow;

    writeDB(db);
    return { ok: true, month, stats: db.affiliates[referrerId].monthly[month] };
  }

  if (type === "sale") {
    // Must have memberId to enforce first conversion
    if (!memberId) return { ok: false, reason: "missing_memberId" };

    const referredRow = db.referredUsers?.[memberId] || null;

    // If user isn't mapped to this referrer, ignore (prevents fake credit)
    if (!referredRow || referredRow.affiliateId !== referrerId) {
      return { ok: false, reason: "no_referral_mapping" };
    }

    // FIRST PAID CONVERSION ONLY
    if (referredRow.convertedAt) {
      return { ok: true, ignored: true, reason: "already_converted" };
    }

    // Accept either `amountGhs` (from webhook) OR `amount` for compatibility
    const amountGhs = Number(payload.amountGhs ?? payload.amount ?? 0);

    m.sales += 1;
    life.sales += 1;

    if (!Number.isNaN(amountGhs) && amountGhs > 0) {
      m.revenue += amountGhs;
      life.revenue += amountGhs;
    }

    // mark conversion
    referredRow.convertedAt = Date.now();
    db.referredUsers[memberId] = referredRow;

    writeDB(db);
    return { ok: true, month, stats: db.affiliates[referrerId].monthly[month] };
  }

  return { ok: false, reason: "unknown_type" };
}

/**
 * getStats(monthKey)
 * Returns stats object shaped like:
 * { userId: { joins, sales, revenue } }
 */
function getStats(monthKey) {
  const db = readDB();
  const out = {};

  const key = monthKey || getMonthKey();

  for (const [affiliateId, row] of Object.entries(db.affiliates || {})) {
    const m = row?.monthly?.[key] || { joins: 0, sales: 0, revenue: 0 };
    out[affiliateId] = {
      joins: Number(m.joins || 0),
      sales: Number(m.sales || 0),
      revenue: Number(m.revenue || 0),
    };
  }

  return out;
}

function getReferrerByInvite(memberId) {
  if (!memberId) return null;
  const db = readDB();
  return db.referredUsers?.[memberId]?.affiliateId || null;
}

function getAffiliateRow(affiliateId) {
  if (!affiliateId) return null;
  const db = readDB();
  return db.affiliates?.[affiliateId] || null;
}

function getAffiliateStats(affiliateId, monthKey = getMonthKey()) {
  const row = getAffiliateRow(affiliateId) || { lifetime: { joins: 0, sales: 0, revenue: 0 }, monthly: {} };
  const m = row.monthly?.[monthKey] || { joins: 0, sales: 0, revenue: 0 };

  return {
    monthKey,
    monthly: {
      joins: Number(m.joins || 0),
      sales: Number(m.sales || 0),
      revenue: Number(m.revenue || 0),
    },
    lifetime: {
      joins: Number(row.lifetime?.joins || 0),
      sales: Number(row.lifetime?.sales || 0),
      revenue: Number(row.lifetime?.revenue || 0),
    },
  };
}

module.exports = {
  getMonthKey,
  getStats,
  mapInvite,
  bump,
  getReferrerByInvite,
  getAffiliateStats,
};
