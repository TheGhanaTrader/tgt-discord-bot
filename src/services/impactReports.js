// src/services/impactReports.js
"use strict";

const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");

const DATA_DIR = path.join(process.cwd(), "data");

// Future-proof ledgers (we’ll build these later). For now, safe defaults (0).
const FUNDED_LEDGER = path.join(DATA_DIR, "prop_funded.json");
const PAYOUT_LEDGER = path.join(DATA_DIR, "prop_payouts.json");
const LOSS_LEDGER = path.join(DATA_DIR, "prop_losses.json");
const DENIAL_LEDGER = path.join(DATA_DIR, "prop_denials.json");

function safeReadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
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
 * - funded: [{ userId, firm, accountSize, monthKey, yearKey, status: "live"|"lost", ts }]
 * - payouts: [{ userId, firm, payoutAmount, monthKey, yearKey, statusAfter: "still_funded"|"lost_after", ts }]
 * - losses: [{ userId, firm, accountSizeLost, monthKey, yearKey, reason, lessons, ts }]
 * - denials: [{ userId, firm, payoutAmountRequested, monthKey, yearKey, reason, ts }]
 */

function computeCapitalStats() {
  const now = Date.now();
  const mk = monthKeyUTC(now);
  const yk = yearKeyUTC(now);

  const funded = safeReadJSON(FUNDED_LEDGER, []);
  const payouts = safeReadJSON(PAYOUT_LEDGER, []);

  const fundedPrevMonthTotal = sumWhere(funded, (x) => x?.monthKey === mk, "accountSize"); // NOTE: until we add true "prev month", this reports current month safely.
  const fundedYTD = sumWhere(funded, (x) => x?.yearKey === yk, "accountSize");
  const fundedAll = sumWhere(funded, () => true, "accountSize");

  const payoutsPrevMonthTotal = sumWhere(payouts, (x) => x?.monthKey === mk, "payoutAmount"); // same note as above
  const payoutsYTD = sumWhere(payouts, (x) => x?.yearKey === yk, "payoutAmount");
  const payoutsAll = sumWhere(payouts, () => true, "payoutAmount");

  const liveCapital = sumWhere(funded, (x) => String(x?.status || "").toLowerCase() === "live", "accountSize");
  const liveAccounts = countWhere(funded, (x) => String(x?.status || "").toLowerCase() === "live");

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

function computeRiskStats() {
  const now = Date.now();
  const mk = monthKeyUTC(now);
  const yk = yearKeyUTC(now);

  const losses = safeReadJSON(LOSS_LEDGER, []);
  const denials = safeReadJSON(DENIAL_LEDGER, []);

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

  const stats = computeCapitalStats();
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

  const stats = computeRiskStats();
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
};
