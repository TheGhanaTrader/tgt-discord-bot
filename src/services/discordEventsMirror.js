// src/services/discordEventsMirror.js
"use strict";

const { Events } = require("discord.js");
const { getJob, setState } = require("../utils/schedulerState");

const JOB_KEY = "discord_events_mirror";

function getBoolEnv(name, fallback = false) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function safeTrim(s, max = 900) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

function fmtTs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const sec = Math.floor(n / 1000);
  return `<t:${sec}:F> • <t:${sec}:R>`;
}

function getEventTypeLabel(ev) {
  // Discord.js scheduled event entity types:
  // 1 = stage, 2 = voice, 3 = external (per Discord API)
  const t = Number(ev?.entityType);
  if (t === 3) return "External";
  if (t === 2) return "Voice";
  if (t === 1) return "Stage";
  return "Event";
}

function getEventLocation(ev) {
  const t = Number(ev?.entityType);
  if (t === 3) {
    const loc = ev?.entityMetadata?.location;
    return loc ? `📍 ${safeTrim(loc, 140)}` : "";
  }

  // Voice/Stage: channelId exists
  const chId = String(ev?.channelId || "").trim();
  return chId ? `🔊 <#${chId}>` : "";
}

function getEventUrl(ev) {
  // scheduled event has .url in discord.js
  const u = String(ev?.url || "").trim();
  return u || "";
}

function getStatusLabel(status) {
  // statuses: SCHEDULED, ACTIVE, COMPLETED, CANCELED
  const s = String(status || "").toUpperCase();
  if (s === "SCHEDULED") return "scheduled";
  if (s === "ACTIVE") return "live";
  if (s === "COMPLETED") return "ended";
  if (s === "CANCELED" || s === "CANCELLED") return "canceled";
  return s.toLowerCase() || "unknown";
}

function shouldMirror(ev) {
  // User asked: mirror both voice + external. We allow stage too as “voice-like”.
  const t = Number(ev?.entityType);
  return t === 1 || t === 2 || t === 3;
}

async function loadState() {
  const row = await getJob(JOB_KEY).catch(() => null);
  const st = row?.state || {};
  return {
    // eventId -> { lastStatus, lastPostedAtMs }
    events: st.events && typeof st.events === "object" ? st.events : {},
  };
}

async function saveState(state) {
  // prune map to avoid unbounded growth
  const events = state.events || {};
  const keys = Object.keys(events);
  if (keys.length > 200) {
    // Keep most recent 200 by lastPostedAtMs
    const sorted = keys
      .map((k) => ({ k, ts: Number(events[k]?.lastPostedAtMs || 0) }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 200);

    const next = {};
    for (const x of sorted) next[x.k] = events[x.k];
    state.events = next;
  }

  await setState(JOB_KEY, state).catch(() => null);
}

async function sendAnnouncement(client, text) {
  const announceId = String(process.env.ANNOUNCEMENTS_CHANNEL_ID || "").trim();
  if (!announceId) return { ok: false, reason: "missing_announcements_channel_id" };

  const ch =
    client.channels.cache.get(announceId) ||
    (await client.channels.fetch(announceId).catch(() => null));

  if (!ch || !ch.isTextBased()) return { ok: false, reason: "announcements_channel_not_text" };

  await ch.send(text).catch((e) => {
    console.log("❌ EVENTS_MIRROR_SEND_FAILED:", e?.message || e);
  });

  return { ok: true };
}

function buildScheduledMsg(ev) {
  const title = safeTrim(ev?.name || "Scheduled Event", 180);
  const type = getEventTypeLabel(ev);
  const when = fmtTs(ev?.scheduledStartTimestamp);
  const where = getEventLocation(ev);
  const desc = safeTrim(ev?.description || "", 700);
  const url = getEventUrl(ev);

  const parts = [
    `⏰ **Event Scheduled** (${type})`,
    `**${title}**`,
    when ? `🗓️ ${when}` : "",
    where,
    desc ? `📝 ${desc}` : "",
    url,
  ].filter(Boolean);

  return parts.join("\n");
}

function buildLiveMsg(ev) {
  const title = safeTrim(ev?.name || "Live Event", 180);
  const type = getEventTypeLabel(ev);
  const where = getEventLocation(ev);
  const url = getEventUrl(ev);

  const parts = [
    `🔴 **Event is LIVE** (${type})`,
    `**${title}**`,
    where,
    url,
  ].filter(Boolean);

  return parts.join("\n");
}

function buildEndedMsg(ev, canceled = false) {
  const title = safeTrim(ev?.name || (canceled ? "Canceled Event" : "Ended Event"), 180);
  const type = getEventTypeLabel(ev);
  const url = getEventUrl(ev);

  const parts = [
    canceled ? `❌ **Event CANCELED** (${type})` : `✅ **Event Ended** (${type})`,
    `**${title}**`,
    url,
  ].filter(Boolean);

  return parts.join("\n");
}

/**
 * Start Discord Events -> Announcements mirroring (guarded).
 * OFF by default. Enable by setting:
 *   DISCORD_EVENTS_MIRROR_ENABLED=true
 * Requires:
 *   ANNOUNCEMENTS_CHANNEL_ID
 */
function startDiscordEventsMirror(client) {
  const enabled = getBoolEnv("DISCORD_EVENTS_MIRROR_ENABLED", false);

  console.log("✅ DISCORD_EVENTS_MIRROR_BOOT", {
    enabled,
    announcementsSet: Boolean(String(process.env.ANNOUNCEMENTS_CHANNEL_ID || "").trim()),
  });

  if (!enabled) return;

  const handlerCreate = async (ev) => {
    try {
      if (!shouldMirror(ev)) return;

      const st = await loadState();
      const id = String(ev?.id || "").trim();
      if (!id) return;

      const status = getStatusLabel(ev?.status);
      // On create we only post if status is scheduled/upcoming (Discord calls it SCHEDULED)
      if (status !== "scheduled") {
        // still record it so status transitions work later
        st.events[id] = {
          lastStatus: status,
          lastPostedAtMs: Number(st.events[id]?.lastPostedAtMs || 0),
        };
        await saveState(st);
        return;
      }

      // Dedupe: if we already posted scheduled for this event, skip
      const prev = st.events[id];
      if (prev?.lastStatus === "scheduled") return;

      await sendAnnouncement(client, buildScheduledMsg(ev));
      st.events[id] = { lastStatus: "scheduled", lastPostedAtMs: Date.now() };
      await saveState(st);

      console.log("✅ EVENTS_MIRROR_POSTED_SCHEDULED:", id);
    } catch (e) {
      console.log("❌ EVENTS_MIRROR_CREATE_ERR:", e?.message || e);
    }
  };

  const handlerUpdate = async (oldEv, newEv) => {
    try {
      const ev = newEv || oldEv;
      if (!shouldMirror(ev)) return;

      const st = await loadState();
      const id = String(ev?.id || "").trim();
      if (!id) return;

      const prevStatus = getStatusLabel(oldEv?.status);
      const curStatus = getStatusLabel(newEv?.status);

      // If status did not change, do nothing (prevents spam on minor edits)
      if (prevStatus === curStatus) return;

      if (curStatus === "scheduled") {
        await sendAnnouncement(client, buildScheduledMsg(newEv));
        st.events[id] = { lastStatus: "scheduled", lastPostedAtMs: Date.now() };
        await saveState(st);
        console.log("✅ EVENTS_MIRROR_POSTED_SCHEDULED(update):", id);
        return;
      }

      if (curStatus === "live") {
        await sendAnnouncement(client, buildLiveMsg(newEv));
        st.events[id] = { lastStatus: "live", lastPostedAtMs: Date.now() };
        await saveState(st);
        console.log("✅ EVENTS_MIRROR_POSTED_LIVE:", id);
        return;
      }

      if (curStatus === "ended") {
        await sendAnnouncement(client, buildEndedMsg(newEv, false));
        st.events[id] = { lastStatus: "ended", lastPostedAtMs: Date.now() };
        await saveState(st);
        console.log("✅ EVENTS_MIRROR_POSTED_ENDED:", id);
        return;
      }

      if (curStatus === "canceled") {
        await sendAnnouncement(client, buildEndedMsg(newEv, true));
        st.events[id] = { lastStatus: "canceled", lastPostedAtMs: Date.now() };
        await saveState(st);
        console.log("✅ EVENTS_MIRROR_POSTED_CANCELED:", id);
        return;
      }

      // Unknown status: record only
      st.events[id] = { lastStatus: curStatus, lastPostedAtMs: Date.now() };
      await saveState(st);
    } catch (e) {
      console.log("❌ EVENTS_MIRROR_UPDATE_ERR:", e?.message || e);
    }
  };

  client.on(Events.GuildScheduledEventCreate, handlerCreate);
  client.on(Events.GuildScheduledEventUpdate, handlerUpdate);

  console.log("✅ Discord Events mirror: ACTIVE");
}

module.exports = { startDiscordEventsMirror };