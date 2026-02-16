// src/services/impactReports.js
"use strict";

const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");
const { EmbedBuilder } = require("discord.js");

// job_state keys (temporary ledgers until we standardize tables)
const LOSS_JOB_KEY = "prop_losses_ledger";
const DENIAL_JOB_KEY = "prop_denials_ledger";

let _pool = null;

function pool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (impact reports read Postgres)");

  _pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return _pool;
}

async function readJobState(jobKey, fallback) {
  try {
    const p = pool();
    const q = `SELECT state_json FROM public.job_state WHERE job_key = $1 LIMIT 1`;
    const { rows } = await p.query(q, [jobKey]);
    const raw = rows?.[0]?.state_json;
    return raw ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJobState(jobKey, stateObj) {
  const p = pool();
  const q = `
    INSERT INTO public.job_state (job_key, state_json, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()
  `;
  await p.query(q, [jobKey, JSON.stringify(stateObj || {})]);
}

// Best-effort lock (protect pointer-like ledgers if needed later)
async function withLock(jobKey, fn, ttlSeconds = 10) {
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
  const { rows } = await p.query(q, [jobKey, String(ttlSeconds), lockBy]);
  const owner = rows?.[0]?.locked_by;

  if (owner !== lockBy) return fn({ locked: false, lockBy });

  try {
    return await fn({ locked: true, lockBy });
  } finally {
    await p
      .query(
        `UPDATE public.job_state SET locked_until = NULL, locked_by = NULL, updated_at = NOW() WHERE job_key = $1 AND locked_by = $2`,
        [jobKey, lockBy]
      )
      .catch(() => null);
  }
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function monthKeyUTC(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function yearKeyUTC(ms) {
  const d = new Date(ms);
  return String(d.getUTCFullYear());
}

function fmtMoneyUSD(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return "$0";
  // simple, readable, prestige formatting (no cents)
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function sumWhere(items, predicate, amountKey) {
  let total = 0;
  for (const it of items) {
    if (!it) continue;
    if (!predicate(it)) continue;
    total += Number(it?.[amountKey] || 0);
  }
  return total;
}

function countWhere(items, predicate) {
  let c = 0;
  for (const it of items) {
    if (!it) continue;
    if (!predicate(it)) continue;
    c += 1;
  }
  return c;
}

/**
 * Ledger shapes we will standardize later:
 * - funded (DB): prop_funded rows (account_size, month_key, year_key, status)
 * - payouts (DB): prop_payouts rows (payout_amount, month_key, year_key)
 * - losses (job_state for now): [{ userId, firm, accountSizeLost, monthKey, yearKey, reason, lessons, ts }]
 * - denials (job_state for now): [{ userId, firm, payoutAmountRequested, monthKey, yearKey, reason, ts }]
 */

async function fetchFundedRows() {
  const p = pool();
  const q = `
    SELECT user_id, firm, account_size, status, month_key, year_key
    FROM public.prop_funded
  `;
  const { rows } = await p.query(q);
  return Array.isArray(rows) ? rows : [];
}

async function fetchPayoutRows() {
  const p = pool();
  const q = `
    SELECT user_id, firm, payout_amount, status_after, month_key, year_key
    FROM public.prop_payouts
  `;
  const { rows } = await p.query(q);
  return Array.isArray(rows) ? rows : [];
}

async function fetchLossRows() {
  const st = await readJobState(LOSS_JOB_KEY, []);
  return Array.isArray(st) ? st : [];
}

async function fetchDenialRows() {
  const st = await readJobState(DENIAL_JOB_KEY, []);
  return Array.isArray(st) ? st : [];
}

async function computeCapitalStats() {
  const now = Date.now();
  const mk = monthKeyUTC(now);
  const yk = yearKeyUTC(now);

  const fundedRows = await fetchFundedRows();
  const payoutRows = await fetchPayoutRows();

  // Map DB snake_case into the keys your existing math expects (no intent change)
  const funded = fundedRows.map((x) => ({
    userId: x.user_id,
    firm: x.firm,
    accountSize: Number(x.account_size || 0),
    status: x.status,
    monthKey: x.month_key,
    yearKey: x.year_key,
  }));

  const payouts = payoutRows.map((x) => ({
    userId: x.user_id,
    firm: x.firm,
    payoutAmount: Number(x.payout_amount || 0),
    statusAfter: x.status_after,
    monthKey: x.month_key,
    yearKey: x.year_key,
  }));

  const fundedPrevMonthTotal = sumWhere(funded, (x) => x?.monthKey === mk, "accountSize"); // NOTE: until we add true "prev month", this reports current month safely.
  const fundedYTD = sumWhere(funded, (x) => x?.yearKey === yk, "accountSize");
  const fundedAll = sumWhere(funded, () => true, "accountSize");

  const payoutsPrevMonthTotal = sumWhere(payouts, (x) => x?.monthKey === mk, "payoutAmount"); // same note as above
  const payoutsYTD = sumWhere(payouts, (x) => x?.yearKey === yk, "payoutAmount");
  const payoutsAll = sumWhere(payouts, () => true, "payoutAmount");

  const liveCapital = sumWhere(
    funded,
    (x) => String(x?.status || "").toLowerCase() === "live",
    "accountSize"
  );
  const liveAccounts = countWhere(
    funded,
    (x) => String(x?.status || "").toLowerCase() === "live"
  );

  return {
    monthKey: mk,
    yearKey: yk,
    fundedPrevMonthTotal,
    fundedYTD,
    fundedAll,
    payoutsPrevMonthTotal,
    payoutsYTD,
    payoutsAll,
    liveCapital,
    liveAccounts,
  };
}

async function computeRiskStats() {
  const now = Date.now();
  const mk = monthKeyUTC(now);
  const yk = yearKeyUTC(now);

  const losses = await fetchLossRows();
  const denials = await fetchDenialRows();

  const lostAccounts = countWhere(losses, (x) => x?.monthKey === mk);
  const lostCapital = sumWhere(losses, (x) => x?.monthKey === mk, "accountSizeLost");

  const denialCount = countWhere(denials, (x) => x?.monthKey === mk);

  // We’ll compute reason percentages later; for now keep it simple and safe.
  return {
    monthKey: mk,
    yearKey: yk,
    lostAccounts,
    lostCapital,
    denialCount,
  };
}

function buildCapitalPerformanceEmbed(stats) {
  const logoUrl = String(process.env.TGT_LOGO_URL || "").trim();
  const updated = nowUnix();

  const e = new EmbedBuilder()
    .setTitle("📊 THE GHANA TRADER DESK")
    .setDescription("**Capital Performance Report — Monthly Snapshot**")
    .addFields(
      {
        name: "💼 Funded Capital (Verified Members)",
        value:
          `• **This Month:** ${fmtMoneyUSD(stats.fundedPrevMonthTotal)}\n` +
          `• **Year-to-Date:** ${fmtMoneyUSD(stats.fundedYTD)}\n` +
          `• **All-Time:** ${fmtMoneyUSD(stats.fundedAll)}`,
      },
      {
        name: "💸 Payouts Withdrawn",
        value:
          `• **This Month:** ${fmtMoneyUSD(stats.payoutsPrevMonthTotal)}\n` +
          `• **Year-to-Date:** ${fmtMoneyUSD(stats.payoutsYTD)}\n` +
          `• **All-Time:** ${fmtMoneyUSD(stats.payoutsAll)}`,
      },
      {
        name: "🟢 Live Funded Capital",
        value:
          `• **Currently Active Capital:** ${fmtMoneyUSD(stats.liveCapital)}\n` +
          `• **Active Funded Accounts:** **${stats.liveAccounts}**`,
      },
      {
        name: "🧭 What This Means",
        value:
          "Capital entrusted to members, capital successfully withdrawn, and capital currently being traded — tracked transparently and verified continuously.",
      }
    )
    .setFooter({
      text:
        "Figures represent verified member submissions. Certificates and payout proofs are reviewed by staff. • Institutional-grade performance tracking",
    })
    .setTimestamp(new Date())
    .setColor(0xc9a24d);

  if (logoUrl) e.setThumbnail(logoUrl);

  // add a tiny “Updated” hint without clutter
  e.addFields({ name: "Updated", value: `<t:${updated}:R>`, inline: true });

  return e;
}

function buildRiskSnapshotEmbed(stats) {
  const logoUrl = String(process.env.TGT_LOGO_URL || "").trim();
  const updated = nowUnix();

  const e = new EmbedBuilder()
    .setTitle("🟠 THE GHANA TRADER DESK")
    .setDescription("**Risk & Reliability Snapshot — Aggregate View**")
    .addFields(
      {
        name: "🔴 Account Losses (Aggregate)",
        value:
          `• **Accounts Lost (This Month):** **${stats.lostAccounts}**\n` +
          `• **Capital Lost (This Month):** ${fmtMoneyUSD(stats.lostCapital)}\n` +
          "• **Primary Causes:** (will populate once loss logging goes live)",
      },
      {
        name: "⚠️ Firm Reliability Signals",
        value:
          `• **Payout Denials Logged (This Month):** **${stats.denialCount}**\n` +
          "• **Common Reasons:** (will populate once denial logging goes live)",
      }
    )
    .setFooter({
      text:
        "Data reflects aggregated outcomes from verified submissions. Individual cases are reviewed internally.",
    })
    .setTimestamp(new Date())
    .setColor(0xc9a24d);

  if (logoUrl) e.setThumbnail(logoUrl);

  e.addFields({ name: "Updated", value: `<t:${updated}:R>`, inline: true });

  return e;
}

async function safeSendEmbed(channel, embed) {
  if (!channel || !channel.isTextBased()) return { ok: false, reason: "not_text_channel" };
  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return { ok: false, reason: "send_failed" };
  return { ok: true, messageId: msg.id };
}

/**
 * Public API: Post the two monthly reports.
 * We will wire scheduling in the next task.
 */
async function postCapitalPerformanceReport(client) {
  const annId = String(process.env.ANNOUNCEMENTS_CHANNEL_ID || "").trim();
  const genId = String(process.env.GENERAL_CHANNEL_ID || "").trim();

  const stats = await computeCapitalStats();
  const embed = buildCapitalPerformanceEmbed(stats);

  const ann =
    annId && (client.channels.cache.get(annId) || (await client.channels.fetch(annId).catch(() => null)));
  const gen =
    genId && (client.channels.cache.get(genId) || (await client.channels.fetch(genId).catch(() => null)));

  const out = { ok: true, sent: {} };

  if (ann) out.sent.announcements = await safeSendEmbed(ann, embed);
  else out.sent.announcements = { ok: false, reason: "announcements_channel_missing" };

  if (gen) out.sent.general = await safeSendEmbed(gen, embed);
  else out.sent.general = { ok: false, reason: "general_channel_missing" };

  return out;
}

async function postRiskSnapshotReport(client) {
  const riskId = String(process.env.RISK_INSIGHTS_CHANNEL_ID || "").trim();
  const genId = String(process.env.GENERAL_CHANNEL_ID || "").trim();

  const stats = await computeRiskStats();
  const embed = buildRiskSnapshotEmbed(stats);

  const risk =
    riskId && (client.channels.cache.get(riskId) || (await client.channels.fetch(riskId).catch(() => null)));
  const gen =
    genId && (client.channels.cache.get(genId) || (await client.channels.fetch(genId).catch(() => null)));

  const out = { ok: true, sent: {} };

  if (risk) out.sent.risk_insights = await safeSendEmbed(risk, embed);
  else out.sent.risk_insights = { ok: false, reason: "risk_channel_missing" };

  // optional: also post a short version to general (same embed is fine for now)
  if (gen) out.sent.general = await safeSendEmbed(gen, embed);
  else out.sent.general = { ok: false, reason: "general_channel_missing" };

  return out;
}

module.exports = {
  postCapitalPerformanceReport,
  postRiskSnapshotReport,
  // exported for future testing/verification
  buildCapitalPerformanceEmbed,
  buildRiskSnapshotEmbed,
  computeCapitalStats,
  computeRiskStats,

  // reserved helpers for when loss/denial logging goes live
  _internal: {
    readJobState,
    writeJobState,
    withLock,
    LOSS_JOB_KEY,
    DENIAL_JOB_KEY,
  },
};
