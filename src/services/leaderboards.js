// src/services/leaderboards.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const referrals = require("./referrals");
const { getJob, setState } = require("../utils/schedulerState");

// Marker to reliably identify our dashboard embeds (safe + minimal)
const LEADERBOARD_PIN_MARKER = "TGT_LEADERBOARD_PIN";

// 7 days
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// DB key for job_state
const JOB_KEY = "leaderboards_state";

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
    .setFooter({
      text: `The Ghana Trader Desk • Only first paid conversion counts. • ${LEADERBOARD_PIN_MARKER}`,
    })
    .setColor(0xc9a24d);
}

// -------------------- DB State Helpers --------------------

function defaultState() {
  return {
    referral: { messageId: null, prevMessageId: null, prevMonthKey: null },
    affiliate: { messageId: null, prevMessageId: null, prevMonthKey: null },
    currentMonthKey: null,
    rolloverAtMs: null,
    archived: {},
  };
}

async function readState() {
  const row = await getJob(JOB_KEY);
  const s = row?.state && typeof row.state === "object" ? row.state : {};
  return {
    ...defaultState(),
    ...s,
    referral: { ...defaultState().referral, ...(s.referral || {}) },
    affiliate: { ...defaultState().affiliate, ...(s.affiliate || {}) },
    archived: s.archived && typeof s.archived === "object" ? s.archived : {},
  };
}

async function writeState(next) {
  const safe = next && typeof next === "object" ? next : defaultState();
  await setState(JOB_KEY, safe);
}

// -------------------- Discord Helpers --------------------

// ✅ Find existing pinned dashboard message (reuses after Railway deploy)
// - Keeps newest match (and unpins older duplicates)
async function findPinnedDashboardMessage(channel, wantTitle) {
  const pins = await channel.messages.fetchPinned().catch(() => null);
  if (!pins) return null;

  // strict match (title + marker)
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

  // fallback: title-only (legacy pins before marker existed)
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

  // Unpin other dashboard pins for this title
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

  // 2) Try pinned dashboard
  const pinned = await findPinnedDashboardMessage(channel, wantTitle).catch(() => null);
  if (pinned) return pinned;

  // 3) Create new once
  return await channel.send({ content: fallbackText }).catch(() => null);
}

async function ensurePinned(channel, msg) {
  if (!msg) return;
  const pins = await channel.messages.fetchPinned().catch(() => null);
  const isPinned = pins?.some((p) => p.id === msg.id);
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

async function upsertPinnedEmbed(channel, kind /* "referral" | "affiliate" */, embed, state) {
  const savedId = state?.[kind]?.messageId || null;
  const wantTitle = kind === "referral" ? "🏁 Referral Leaderboard" : "💎 Affiliate Sales Leaderboard";

  // Reuse pinned message if Railway lost messageId
  const msg = await fetchOrCreateDashboardMessage(
    channel,
    savedId,
    "⏳ Building leaderboard dashboard…",
    wantTitle
  );

  if (!msg) return { ok: false, reason: "send_failed" };

  await msg.edit({ content: "", embeds: [embed] }).catch(() => null);
  await ensurePinned(channel, msg);

  state[kind] = state[kind] || {};
  state[kind].messageId = msg.id;
  await writeState(state);

  return { ok: true, messageId: msg.id };
}

/**
 * Archive previous month dashboards AFTER 7 DAYS:
 * - If archive channels exist: repost embed copy to archive channel
 * - Unpin + delete the previous message from main channel
 * Result: main stays "prestige-clean" with ONLY current month.
 */
async function archiveIfDue(client, state) {
  const rolloverAt = Number(state.rolloverAtMs || 0);
  if (!rolloverAt) return;

  const age = nowMs() - rolloverAt;
  if (age < ARCHIVE_AFTER_MS) return;

  const refMainId = String(process.env.REF_LEADERBOARD_CHANNEL_ID || "").trim();
  const affMainId = String(process.env.AFF_LEADERBOARD_CHANNEL_ID || "").trim();
  const refArchiveId = String(process.env.REF_LEADERBOARD_ARCHIVE_CHANNEL_ID || "").trim();
  const affArchiveId = String(process.env.AFF_LEADERBOARD_ARCHIVE_CHANNEL_ID || "").trim();

  const refMain =
    refMainId && (client.channels.cache.get(refMainId) || (await client.channels.fetch(refMainId).catch(() => null)));
  const affMain =
    affMainId && (client.channels.cache.get(affMainId) || (await client.channels.fetch(affMainId).catch(() => null)));

  const refArchive =
    refArchiveId &&
    (client.channels.cache.get(refArchiveId) || (await client.channels.fetch(refArchiveId).catch(() => null)));
  const affArchive =
    affArchiveId &&
    (client.channels.cache.get(affArchiveId) || (await client.channels.fetch(affArchiveId).catch(() => null)));

  // Referral archive
  try {
    const prevId = state.referral?.prevMessageId;
    const prevMonth = state.referral?.prevMonthKey;
    if (refMain && prevId && prevMonth) {
      const prevMsg = await refMain.messages.fetch(prevId).catch(() => null);
      if (prevMsg?.embeds?.[0] && refArchive && refArchive.isTextBased()) {
        await refArchive.send({ embeds: [prevMsg.embeds[0]] }).catch(() => null);
        state.archived[`ref-${prevMonth}`] = { archivedAt: Date.now(), from: prevId };
      } else {
        state.archived[`ref-${prevMonth}`] = { archivedAt: Date.now(), note: "no_source_or_no_archive_channel" };
      }

      await safeUnpin(refMain, prevId);
      await safeDelete(refMain, prevId);

      state.referral.prevMessageId = null;
      state.referral.prevMonthKey = null;
    }
  } catch {}

  // Affiliate archive
  try {
    const prevId = state.affiliate?.prevMessageId;
    const prevMonth = state.affiliate?.prevMonthKey;
    if (affMain && prevId && prevMonth) {
      const prevMsg = await affMain.messages.fetch(prevId).catch(() => null);
      if (prevMsg?.embeds?.[0] && affArchive && affArchive.isTextBased()) {
        await affArchive.send({ embeds: [prevMsg.embeds[0]] }).catch(() => null);
        state.archived[`aff-${prevMonth}`] = { archivedAt: Date.now(), from: prevId };
      } else {
        state.archived[`aff-${prevMonth}`] = { archivedAt: Date.now(), note: "no_source_or_no_archive_channel" };
      }

      await safeUnpin(affMain, prevId);
      await safeDelete(affMain, prevId);

      state.affiliate.prevMessageId = null;
      state.affiliate.prevMonthKey = null;
    }
  } catch {}

  // Reset rollover marker so we don’t repeat
  state.rolloverAtMs = null;
  await writeState(state);

  console.log("✅ LEADERBOARDS_ARCHIVED_AND_CLEANED_MAIN");
}

// -------------------- Public API --------------------

async function refreshLeaderboards(client) {
  console.log("TGT_LB_TICK");

  const refChanId = String(process.env.REF_LEADERBOARD_CHANNEL_ID || "").trim();
  const affChanId = String(process.env.AFF_LEADERBOARD_CHANNEL_ID || "").trim();
  if (!refChanId || !affChanId) {
    console.log("LEADERBOARD_SKIP: missing REF_LEADERBOARD_CHANNEL_ID / AFF_LEADERBOARD_CHANNEL_ID");
    return { ok: false, reason: "missing_channel_ids" };
  }

  const state = await readState();
  const monthKey = monthKeyUTC(nowMs());

  // Detect month rollover
  if (state.currentMonthKey && state.currentMonthKey !== monthKey) {
    state.referral.prevMessageId = state.referral.messageId || null;
    state.referral.prevMonthKey = state.currentMonthKey;

    state.affiliate.prevMessageId = state.affiliate.messageId || null;
    state.affiliate.prevMonthKey = state.currentMonthKey;

    state.referral.messageId = null;
    state.affiliate.messageId = null;

    state.currentMonthKey = monthKey;
    state.rolloverAtMs = nowMs();

    await writeState(state);
    console.log("✅ LEADERBOARD_MONTH_ROLLOVER:", state.referral.prevMonthKey, "->", monthKey);
  } else if (!state.currentMonthKey) {
    state.currentMonthKey = monthKey;
    await writeState(state);
  }

  // Archive after 7 days
  await archiveIfDue(client, state);

  const stats = referrals.getStats(monthKey);

  const refRows = topNFromStats(stats, "joins", "sales", 10);
  const affRows = topNFromStats(stats, "sales", "joins", 10);

  const refEmbed = buildReferralEmbed({ monthKey, rows: refRows });
  const affEmbed = buildAffiliateEmbed({ monthKey, rows: affRows });

  const refChannel =
    client.channels.cache.get(refChanId) || (await client.channels.fetch(refChanId).catch(() => null));
  const affChannel =
    client.channels.cache.get(affChanId) || (await client.channels.fetch(affChanId).catch(() => null));

  if (!refChannel || !affChannel) {
    console.log("LEADERBOARD_SKIP: could not fetch leaderboard channels");
    return { ok: false, reason: "channel_fetch_failed" };
  }

  await upsertPinnedEmbed(refChannel, "referral", refEmbed, state);
  await upsertPinnedEmbed(affChannel, "affiliate", affEmbed, state);

  console.log("✅ LEADERBOARDS_REFRESHED:", monthKey);
  return { ok: true, monthKey };
}

let _timer = null;

function startLeaderboardDashboards(client, opts = {}) {
  const everyMs = Number(opts.everyMs || 30_000);

  if (_timer) clearInterval(_timer);

  refreshLeaderboards(client).catch(() => null);

  _timer = setInterval(() => {
    refreshLeaderboards(client).catch(() => null);
    console.log("TGT_LB_TIMER_RUNNING");
  }, everyMs);

  console.log("✅ Leaderboard dashboards: ACTIVE (auto-refresh)");
}

module.exports = {
  refreshLeaderboards,
  startLeaderboardDashboards,
};
