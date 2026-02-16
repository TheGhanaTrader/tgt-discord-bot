// src/services/referrals.js
"use strict";

const { Pool } = require("pg");

// ---------------- ENV / PG ----------------
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const REF_BACKEND = String(process.env.REFERRALS_BACKEND || "pg").trim().toLowerCase();

if (!DATABASE_URL) {
  console.error("[REFERRALS] FATAL: DATABASE_URL missing (Postgres required).");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ---------------- Helpers ----------------
// YYYY-MM in UTC
function getMonthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function ensureAffiliateRows(client, referrerId, monthKey) {
  // Monthly
  await client.query(
    `INSERT INTO public.affiliate_stats (referrer_id, month_key, joins, sales, revenue)
     VALUES ($1, $2, 0, 0, 0)
     ON CONFLICT (referrer_id, month_key) DO NOTHING`,
    [referrerId, monthKey]
  );

  // Lifetime
  await client.query(
    `INSERT INTO public.affiliate_lifetime (referrer_id, joins, sales, revenue)
     VALUES ($1, 0, 0, 0)
     ON CONFLICT (referrer_id) DO NOTHING`,
    [referrerId]
  );
}

// ---------------- Core API ----------------

/**
 * mapInvite(memberId, inviterId)
 * Saves who referred who (one-time, immutable).
 * If already mapped: increments remap_attempts and returns already_mapped.
 */
async function mapInvite(memberId, inviterId) {
  if (REF_BACKEND !== "pg") {
    throw new Error("REFERRALS_BACKEND is not 'pg' (expected pg).");
  }

  if (!memberId || !inviterId) return { ok: false, reason: "missing_params" };
  if (String(memberId) === String(inviterId)) return { ok: false, reason: "self_referral" };

  const mid = String(memberId);
  const rid = String(inviterId);

  return withTx(async (client) => {
    const existing = await client.query(
      `SELECT member_id, referrer_id FROM public.referral_bindings WHERE member_id=$1 FOR UPDATE`,
      [mid]
    );

    if (existing.rowCount) {
      await client.query(
        `UPDATE public.referral_bindings
         SET remap_attempts = remap_attempts + 1,
             last_remap_attempt_at = NOW()
         WHERE member_id=$1`,
        [mid]
      );
      return { ok: false, reason: "already_mapped" };
    }

    await client.query(
      `INSERT INTO public.referral_bindings
       (member_id, referrer_id, joined_at, joined_counted_at, converted_at, remap_attempts, last_remap_attempt_at)
       VALUES ($1, $2, NOW(), NULL, NULL, 0, NULL)`,
      [mid, rid]
    );

    return { ok: true };
  });
}

/**
 * bump("join"|"sale", payload)
 *
 * join:
 *  - counts ONCE per member, ONLY if the member is mapped to that referrer.
 *  - you call this after contract acceptance.
 *
 * sale:
 *  - FIRST PAID CONVERSION ONLY per member (subsequent purchases ignored).
 */
async function bump(type, payload = {}) {
  if (REF_BACKEND !== "pg") {
    throw new Error("REFERRALS_BACKEND is not 'pg' (expected pg).");
  }

  const referrerId = String(payload.referrerId || "");
  const memberId = String(payload.memberId || "");

  if (!referrerId) return { ok: false, reason: "missing_referrer" };
  if (memberId && memberId === referrerId) return { ok: false, reason: "self_referral" };

  const monthKey = getMonthKey();

  if (type !== "join" && type !== "sale") return { ok: false, reason: "unknown_type" };
  if (!memberId) return { ok: false, reason: "missing_memberId" };

  return withTx(async (client) => {
    // Lock the binding row to enforce idempotency safely
    const r = await client.query(
      `SELECT member_id, referrer_id, joined_counted_at, converted_at
       FROM public.referral_bindings
       WHERE member_id=$1
       FOR UPDATE`,
      [memberId]
    );

    const row = r.rows?.[0] || null;

    if (!row) return { ok: false, reason: "no_referral_mapping" };
    if (String(row.referrer_id) !== referrerId) return { ok: false, reason: "no_referral_mapping" };

    await ensureAffiliateRows(client, referrerId, monthKey);

    if (type === "join") {
      if (row.joined_counted_at) {
        return { ok: true, ignored: true, reason: "join_already_counted" };
      }

      await client.query(
        `UPDATE public.affiliate_stats
         SET joins = joins + 1
         WHERE referrer_id=$1 AND month_key=$2`,
        [referrerId, monthKey]
      );

      await client.query(
        `UPDATE public.affiliate_lifetime
         SET joins = joins + 1
         WHERE referrer_id=$1`,
        [referrerId]
      );

      await client.query(
        `UPDATE public.referral_bindings
         SET joined_counted_at = NOW()
         WHERE member_id=$1`,
        [memberId]
      );

      return { ok: true, month: monthKey };
    }

    // type === "sale"
    if (row.converted_at) {
      return { ok: true, ignored: true, reason: "already_converted" };
    }

    const amountGhs = Number(payload.amountGhs ?? payload.amount ?? 0);
    const safeAmount = Number.isFinite(amountGhs) && amountGhs > 0 ? amountGhs : 0;

    await client.query(
      `UPDATE public.affiliate_stats
       SET sales = sales + 1,
           revenue = revenue + $3
       WHERE referrer_id=$1 AND month_key=$2`,
      [referrerId, monthKey, safeAmount]
    );

    await client.query(
      `UPDATE public.affiliate_lifetime
       SET sales = sales + 1,
           revenue = revenue + $2
       WHERE referrer_id=$1`,
      [referrerId, safeAmount]
    );

    await client.query(
      `UPDATE public.referral_bindings
       SET converted_at = NOW()
       WHERE member_id=$1`,
      [memberId]
    );

    return { ok: true, month: monthKey };
  });
}

/**
 * getStats(monthKey)
 * Returns: { [referrerId]: { joins, sales, revenue } }
 */
async function getStats(monthKey = getMonthKey()) {
  const key = String(monthKey || getMonthKey());

  const { rows } = await pool.query(
    `SELECT referrer_id, joins, sales, revenue
     FROM public.affiliate_stats
     WHERE month_key=$1`,
    [key]
  );

  const out = {};
  for (const r of rows || []) {
    out[String(r.referrer_id)] = {
      joins: Number(r.joins || 0),
      sales: Number(r.sales || 0),
      revenue: Number(r.revenue || 0),
    };
  }
  return out;
}

/**
 * getReferrerByInvite(memberId)
 * Returns referrer_id or null.
 */
async function getReferrerByInvite(memberId) {
  const mid = String(memberId || "");
  if (!mid) return null;

  const { rows } = await pool.query(
    `SELECT referrer_id FROM public.referral_bindings WHERE member_id=$1`,
    [mid]
  );
  return rows?.[0]?.referrer_id ? String(rows[0].referrer_id) : null;
}

/**
 * getAffiliateStats(affiliateId, monthKey)
 * Returns:
 * {
 *   monthKey,
 *   monthly: { joins, sales, revenue },
 *   lifetime: { joins, sales, revenue }
 * }
 */
async function getAffiliateStats(affiliateId, monthKey = getMonthKey()) {
  const rid = String(affiliateId || "");
  const mk = String(monthKey || getMonthKey());
  if (!rid) {
    return {
      monthKey: mk,
      monthly: { joins: 0, sales: 0, revenue: 0 },
      lifetime: { joins: 0, sales: 0, revenue: 0 },
    };
  }

  const [mRes, lRes] = await Promise.all([
    pool.query(
      `SELECT joins, sales, revenue
       FROM public.affiliate_stats
       WHERE referrer_id=$1 AND month_key=$2`,
      [rid, mk]
    ),
    pool.query(
      `SELECT joins, sales, revenue
       FROM public.affiliate_lifetime
       WHERE referrer_id=$1`,
      [rid]
    ),
  ]);

  const m = mRes.rows?.[0] || { joins: 0, sales: 0, revenue: 0 };
  const l = lRes.rows?.[0] || { joins: 0, sales: 0, revenue: 0 };

  return {
    monthKey: mk,
    monthly: {
      joins: Number(m.joins || 0),
      sales: Number(m.sales || 0),
      revenue: Number(m.revenue || 0),
    },
    lifetime: {
      joins: Number(l.joins || 0),
      sales: Number(l.sales || 0),
      revenue: Number(l.revenue || 0),
    },
  };
}

module.exports = {
  getMonthKey,
  mapInvite,
  bump,
  getStats,
  getReferrerByInvite,
  getAffiliateStats,
};
