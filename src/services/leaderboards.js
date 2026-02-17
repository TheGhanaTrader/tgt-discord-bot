// src/services/leaderboards.js
"use strict";

const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");
const { EmbedBuilder } = require("discord.js");
const referrals = require("./referrals");

// Marker to reliably identify our dashboard embeds (safe + minimal)
const LEADERBOARD_PIN_MARKER = "TGT_LEADERBOARD_PIN";

// Postgres job_state key for leaderboards persistence
const JOB_KEY = "leaderboards_state";

// 7 days
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function nowMs() {
  const v = Number(process.env.TGT_NOW_MS);
  return Number.isFinite(v) && v > 0 ? v : Date.now();
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

function topNFromStats(stats, pickKey, tieKey, n = 10) {
  return Object.entries(stats)
    .map(([id, row]) => ({
      id,
      a: Number(row?.[pickKey] || 0),
      b: Number(row?.[tieKey] || 0),
    }))
    .filter((r) => r.a > 0 || r.b > 0)
    .sort((x, y) => y.a - x.a || y.b - x.b)
    .slice(0, n);
}

// ✅ PUBLIC: Referral leaderboard shows JOINS ONLY (no revenue ever)
function buildReferralEmbed({ monthKey, rows }) {
  const updated = nowUnix();

  const lines =
    rows.length === 0
      ? ["No referrals counted yet (joins will count only after contract acceptance)."]
      : rows.map((r, i) => `**${i + 1}.** <@${r.id}> — **${r.a}** joins`);

  return new EmbedBuilder()
    .setTitle("🏁 Referral Leaderboard")
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Cycle (UTC)", value: monthKey, inline: true },
      { name: "Updated", value: `<t:${updated}:R>`, inline: true }
    )
    // ✅ Add marker so we can reliably reuse the pinned message after Railway deploys
    .setFooter({
      text: `The Ghana Trader Desk • Referrals count only after contract acceptance. • ${LEADERBOARD_PIN_MARKER}`,
    })
    .setColor(0xc9a24d);
}

// ✅ PUBLIC: Affiliate leaderboard shows SALES ONLY (revenue hidden publicly)
function buildAffiliateEmbed({ monthKey, rows }) {
  const updated = nowUnix();

  const lines =
    rows.length === 0
      ? ["No affiliate sales yet (first paid conversion only)."]
      : rows.map((r, i) => `**${i + 1}.** <@${r.id}> — **${r.a}** sales`);

  return new EmbedBuilder()
    .setTitle("💎 Affiliate Sales Leaderboard")
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Cycle (UTC)", value: monthKey, inline: true },
      { name: "Updated", value: `<t:${updated}:R>`, inline: true }
    )
    // ✅ Add marker so we can reliably reuse the pinned message after Railway deploys
    .setFooter({
      text: `The Ghana Trader Desk • Only first paid conversion counts. • ${LEADERBOARD_PIN_MARKER}`,
    })
    .setColor(0xc9a24d);
}

// -------------------- Postgres job_state (NO /data) --------------------
let _pool = null;

function getPool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (leaderboards state in Postgres)");

  _pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return _pool;
}

function defaultDB() {
  return {
    referral: { messageId: null, prevMessageId: null, prevMonthKey: null },
    affiliate: { messageId: null, prevMessageId: null, prevMonthKey: null },
    currentMonthKey: null,
    rolloverAtMs: null,
    archived: {},
  };
}

async function readDB() {
  const p = getPool();

  try {
    const q = `SELECT state FROM public.job_state WHERE job_key = $1 LIMIT 1`;
    const { rows } = await p.query(q, [JOB_KEY]);
    const raw = rows?.[0]?.state;

    const db = raw && typeof raw === "object" ? raw : {};
    db.referral = db.referral || { messageId: null, prevMessageId: null, prevMonthKey: null };
    db.affiliate = db.affiliate || { messageId: null, prevMessageId: null, prevMonthKey: null };
    db.archived = db.archived || {};
    db.currentMonthKey = db.currentMonthKey || null;
    db.rolloverAtMs = db.rolloverAtMs || null;
    return db;
  } catch {
    // If anything fails, return safe defaults (do not crash job loop)
    return defaultDB();
  }
}

async function writeDB(db) {
  const p = getPool();
  const safe = db && typeof db === "object" ? db : defaultDB();

  const q = `
  INSERT INTO public.job_state (job_key, state, updated_at)
  VALUES ($1, $2::jsonb, NOW())
  ON CONFLICT (job_key)
  DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
`;

  await p.query(q, [JOB_KEY, JSON.stringify(safe)]);
}

// ✅ Find existing pinned dashboard message (reuses after Railway deploy)
// - Keeps oldest match
// - Unpins any newer duplicates (self-clean)
async function findPinnedDashboardMessage(channel, wantTitle) {
  const pins = await channel.messages.fetchPinned().catch(() => null);
  if (!pins) return null;

  // First pass: strict match (title + marker)
  const strict = pins
    .filter((p) => {
      if (!p.author?.bot) return false;
      const title = p.embeds?.[0]?.title || "";
      if (title !== wantTitle) return false;
      const footerText = p.embeds?.[0]?.footer?.text || "";
      return footerText.includes(LEADERBOARD_PIN_MARKER);
    })
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  let keeper = strict.first() || null;

  // Fallback: title-only (for legacy pins created before marker existed)
  if (!keeper) {
    const legacy = pins
      .filter((p) => {
        if (!p.author?.bot) return false;
        const title = p.embeds?.[0]?.title || "";
        return title === wantTitle;
      })
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    keeper = legacy.first() || null;
  }

  if (!keeper) return null;

  // Unpin other dashboard pins for this title (keeps the channel clean)
  for (const p of pins.values()) {
    if (p.id === keeper.id) continue;
    const title = p.embeds?.[0]?.title || "";
    if (title !== wantTitle) continue;
    try {
      await p.unpin();
    } catch {}
  }

  return keeper;
}

// ✅ Fetch saved messageId OR reuse pinned dashboard OR create new once
async function fetchOrCreateDashboardMessage(channel, savedMessageId, fallbackText, wantTitle) {
  // 1) Try saved messageId
  if (savedMessageId) {
    const byId = await channel.messages.fetch(savedMessageId).catch(() => null);
    if (byId) return byId;
  }

  // 2) Try pinned dashboard (marker + title)
  const pinned = await findPinnedDashboardMessage(channel, wantTitle).catch(() => null);
  if (pinned) return pinned;

  // 3) Create new once
  return await channel.send({ content: fallbackText }).catch(() => null);
}

async function ensurePinned(channel, msg) {
  if (!msg) return;
  const pinned = await channel.messages.fetchPinned().catch(() => null);
  const isPinned = pinned?.some((p) => p.id === msg.id);
  if (!isPinned) {
    await msg.pin().catch(() => null);
  }
}

async function safeUnpin(channel, msgId) {
  if (!msgId) return;
  const m = await channel.messages.fetch(msgId).catch(() => null);
  if (!m) return;
  await m.unpin().catch(() => null);
}

async function safeDelete(channel, msgId) {
  if (!msgId) return;
  const m = await channel.messages.fetch(msgId).catch(() => null);
  if (!m) return;
  await m.delete().catch(() => null);
}

async function upsertPinnedEmbed(channel, kind /* "referral" | "affiliate" */, embed, db) {
  const savedId = db?.[kind]?.messageId || null;
  const wantTitle =
    kind === "referral" ? "🏁 Referral Leaderboard" : "💎 Affiliate Sales Leaderboard";

  // ✅ Critical fix: reuse pinned message if Railway lost saved messageId
  let msg = await fetchOrCreateDashboardMessage(
    channel,
    savedId,
    "⏳ Building leaderboard dashboard…",
    wantTitle
  );

  if (!msg) return { ok: false, reason: "send_failed" };

  await msg.edit({ content: "", embeds: [embed] }).catch(() => null);
  await ensurePinned(channel, msg);

  db[kind] = db[kind] || {};
  db[kind].messageId = msg.id;

  await writeDB(db);

  return { ok: true, messageId: msg.id };
}

/**
 * Archive previous month dashboards AFTER 7 DAYS:
 * - Repost the previous dashboard message content to archive channel (as an embed copy)
 * - Unpin + delete the previous message from main dashboard channel
 * Result: main stays "prestige-clean" with ONLY current month.
 */
async function archiveIfDue(client, db) {
  const rolloverAt = Number(db.rolloverAtMs || 0);
  if (!rolloverAt) return;

  const age = nowMs() - rolloverAt;
  if (age < ARCHIVE_AFTER_MS) return;

  const refMainId = String(process.env.REF_LEADERBOARD_CHANNEL_ID || "").trim();
  const affMainId = String(process.env.AFF_LEADERBOARD_CHANNEL_ID || "").trim();
  const refArchiveId = String(process.env.REF_LEADERBOARD_ARCHIVE_CHANNEL_ID || "").trim();
  const affArchiveId = String(process.env.AFF_LEADERBOARD_ARCHIVE_CHANNEL_ID || "").trim();

  // If archive channels not configured, we still clean main after 7 days (optional safety).
  const refMain =
    refMainId &&
    (client.channels.cache.get(refMainId) ||
      (await client.channels.fetch(refMainId).catch(() => null)));
  const affMain =
    affMainId &&
    (client.channels.cache.get(affMainId) ||
      (await client.channels.fetch(affMainId).catch(() => null)));

  const refArchive =
    refArchiveId &&
    (client.channels.cache.get(refArchiveId) ||
      (await client.channels.fetch(refArchiveId).catch(() => null)));
  const affArchive =
    affArchiveId &&
    (client.channels.cache.get(affArchiveId) ||
      (await client.channels.fetch(affArchiveId).catch(() => null)));

  // Referral archive
  try {
    const prevId = db.referral?.prevMessageId;
    const prevMonth = db.referral?.prevMonthKey;
    if (refMain && prevId && prevMonth) {
      const prevMsg = await refMain.messages.fetch(prevId).catch(() => null);
      if (prevMsg?.embeds?.[0] && refArchive && refArchive.isTextBased()) {
        // repost embed copy to archive channel
        await refArchive.send({ embeds: [prevMsg.embeds[0]] }).catch(() => null);
        db.archived[`ref-${prevMonth}`] = { archivedAt: Date.now(), from: prevId };
      } else {
        db.archived[`ref-${prevMonth}`] = {
          archivedAt: Date.now(),
          note: "no_source_message_or_no_archive_channel",
        };
      }

      // clean main
      await safeUnpin(refMain, prevId);
      await safeDelete(refMain, prevId);

      db.referral.prevMessageId = null;
      db.referral.prevMonthKey = null;
    }
  } catch {}

  // Affiliate archive
  try {
    const prevId = db.affiliate?.prevMessageId;
    const prevMonth = db.affiliate?.prevMonthKey;
    if (affMain && prevId && prevMonth) {
      const prevMsg = await affMain.messages.fetch(prevId).catch(() => null);
      if (prevMsg?.embeds?.[0] && affArchive && affArchive.isTextBased()) {
        await affArchive.send({ embeds: [prevMsg.embeds[0]] }).catch(() => null);
        db.archived[`aff-${prevMonth}`] = { archivedAt: Date.now(), from: prevId };
      } else {
        db.archived[`aff-${prevMonth}`] = {
          archivedAt: Date.now(),
          note: "no_source_message_or_no_archive_channel",
        };
      }

      await safeUnpin(affMain, prevId);
      await safeDelete(affMain, prevId);

      db.affiliate.prevMessageId = null;
      db.affiliate.prevMonthKey = null;
    }
  } catch {}

  // After archiving, reset rollover marker so we don’t repeat.
  db.rolloverAtMs = null;
  await writeDB(db);

  console.log("✅ LEADERBOARDS_ARCHIVED_AND_CLEANED_MAIN");
}

async function refreshLeaderboards(client) {
  console.log("TGT_LB_TICK");

  const refChanId = String(process.env.REF_LEADERBOARD_CHANNEL_ID || "").trim();
  const affChanId = String(process.env.AFF_LEADERBOARD_CHANNEL_ID || "").trim();
  if (!refChanId || !affChanId) {
    console.log("LEADERBOARD_SKIP: missing REF_LEADERBOARD_CHANNEL_ID / AFF_LEADERBOARD_CHANNEL_ID");
    return { ok: false, reason: "missing_channel_ids" };
  }

  const db = await readDB();
  const monthKey = monthKeyUTC(nowMs());

  // Detect month rollover
  if (db.currentMonthKey && db.currentMonthKey !== monthKey) {
    // Move current dashboards to "prev" slots (keep them for 7 days in main)
    db.referral.prevMessageId = db.referral.messageId || null;
    db.referral.prevMonthKey = db.currentMonthKey;

    db.affiliate.prevMessageId = db.affiliate.messageId || null;
    db.affiliate.prevMonthKey = db.currentMonthKey;

    // Reset current message IDs so new month creates a fresh single pinned dashboard
    db.referral.messageId = null;
    db.affiliate.messageId = null;

    db.currentMonthKey = monthKey;
    db.rolloverAtMs = nowMs();
    await writeDB(db);

    console.log("✅ LEADERBOARD_MONTH_ROLLOVER:", db.referral.prevMonthKey, "->", monthKey);
  } else if (!db.currentMonthKey) {
    db.currentMonthKey = monthKey;
    await writeDB(db);
  }

  // Archive after 7 days (keeps only current month in main)
  await archiveIfDue(client, db);

  const stats = await referrals.getStats(monthKey);

  // Referral = joins (a), tie = sales (b) only for stable ordering
  const refRows = topNFromStats(stats, "joins", "sales", 10);
  const affRows = topNFromStats(stats, "sales", "joins", 10);

  const refEmbed = buildReferralEmbed({ monthKey, rows: refRows });
  const affEmbed = buildAffiliateEmbed({ monthKey, rows: affRows });

  const refChannel =
    client.channels.cache.get(refChanId) ||
    (await client.channels.fetch(refChanId).catch(() => null));
  const affChannel =
    client.channels.cache.get(affChanId) ||
    (await client.channels.fetch(affChanId).catch(() => null));

  if (!refChannel || !affChannel) {
    console.log("LEADERBOARD_SKIP: could not fetch leaderboard channels");
    return { ok: false, reason: "channel_fetch_failed" };
  }

  // Upsert ONLY the CURRENT month pinned dashboards (one per channel)
  await upsertPinnedEmbed(refChannel, "referral", refEmbed, db);
  await upsertPinnedEmbed(affChannel, "affiliate", affEmbed, db);
  await archiveIfDue(client, db);

  console.log("✅ LEADERBOARDS_REFRESHED:", monthKey);
  return { ok: true, monthKey };
}

let _timer = null;

function startLeaderboardDashboards(client, opts = {}) {
  // Keep your “live Updated” feeling (your screenshot showed ~30s)
  const everyMs = Number(opts.everyMs || 30_000);

  if (_timer) clearInterval(_timer);

  refreshLeaderboards(client).catch(() => null);

  _timer = setInterval(() => {
    refreshLeaderboards(client).catch(() => null);
    console.log("TGT_LB_TIMER_RUNNING");
  }, everyMs);

  console.log("✅ Leaderboard dashboards: ACTIVE (auto-refresh)");
}

/**
 * ADMIN helper: clear only the persisted state in Postgres.
 * (Used by /resetleaderboards after it deletes messages)
 */
async function resetLeaderboardsState() {
  const fresh = defaultDB();
  await writeDB(fresh);
  return { ok: true };
}

module.exports = {
  refreshLeaderboards,
  startLeaderboardDashboards,
  resetLeaderboardsState,
};
