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
  const chId = String(ev?.channelId || "").trim();
  return chId ? `🔊 <#${chId}>` : "";
}

function getEventUrl(ev) {
  const u = String(ev?.url || "").trim();
  return u || "";
}

function shouldMirror(ev) {
  const t = Number(ev?.entityType);
  return t === 1 || t === 2 || t === 3;
}

function getPingText() {
  const mode = String(process.env.EVENTS_PING_MODE || "off").trim().toLowerCase();

  if (mode === "everyone" || mode === "@everyone") return "@everyone";

  if (mode === "verified") {
    const roleId = String(
      process.env.ROLE_VERIFIED_ID ||
        process.env.ROLE_VERIFIED ||
        process.env.VERIFIED_ROLE_ID ||
        ""
    ).trim();
    return roleId ? `<@&${roleId}>` : "";
  }

  return "";
}

async function loadState() {
  const row = await getJob(JOB_KEY).catch(() => null);
  const st = row?.state || {};
  return {
    events: st.events && typeof st.events === "object" ? st.events : {},
  };
}

async function saveState(state) {
  const events = state.events || {};
  const keys = Object.keys(events);

  if (keys.length > 300) {
    const sorted = keys
      .map((k) => ({ k, ts: Number(events[k]?.lastPostedAtMs || 0) }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 300);

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

  await ch
    .send({ content: text, allowedMentions: { parse: ["everyone", "roles"] } })
    .catch((e) => console.log("❌ EVENTS_MIRROR_SEND_FAILED:", e?.message || e));

  return { ok: true };
}

function buildCreatedMsg(ev) {
  const ping = getPingText();
  const title = safeTrim(ev?.name || "Discord Event", 180);
  const type = getEventTypeLabel(ev);
  const when = fmtTs(ev?.scheduledStartTimestamp);
  const where = getEventLocation(ev);
  const desc = safeTrim(ev?.description || "", 700);
  const url = getEventUrl(ev);

  const parts = [
    ping || "",
    `📅 **Discord Event Created** (${type})`,
    `**${title}**`,
    when ? `🗓️ ${when}` : "",
    where,
    desc ? `📝 ${desc}` : "",
    url,
  ].filter(Boolean);

  return parts.join("\n");
}

function buildLiveMsg(ev) {
  const ping = getPingText();
  const title = safeTrim(ev?.name || "Live Event", 180);
  const type = getEventTypeLabel(ev);
  const where = getEventLocation(ev);
  const url = getEventUrl(ev);

  const parts = [ping || "", `🔴 **Event is LIVE** (${type})`, `**${title}**`, where, url].filter(
    Boolean
  );

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

async function mirrorIfNew(client, ev, reason = "unknown") {
  try {
    if (!shouldMirror(ev)) return;
    const id = String(ev?.id || "").trim();
    if (!id) return;

    const st = await loadState();
    if (st.events?.[id]?.lastStatus === "created") return;

    console.log("🔎 EVENTS_MIRROR_SEEN:", {
      reason,
      id,
      entityType: ev?.entityType,
      name: safeTrim(ev?.name, 80),
      url: getEventUrl(ev),
    });

    await sendAnnouncement(client, buildCreatedMsg(ev));

    st.events[id] = { lastStatus: "created", lastPostedAtMs: Date.now() };
    await saveState(st);

    console.log("✅ EVENTS_MIRROR_POSTED_CREATED:", id);
  } catch (e) {
    console.log("❌ EVENTS_MIRROR_MIRRORIFNEW_ERR:", e?.message || e);
  }
}

async function pollScheduledEvents(client) {
  try {
    for (const [, guild] of client.guilds.cache) {
      // Fetch scheduled events from API (works even if gateway events are flaky)
      const events = await guild.scheduledEvents.fetch().catch(() => null);
      if (!events) continue;

      // Only consider "SCHEDULED" (Discord enum 1) + future events
      const upcoming = [...events.values()]
        .filter((ev) => Number(ev?.status) === 1)
        .sort((a, b) => Number(b?.createdTimestamp || 0) - Number(a?.createdTimestamp || 0))
        .slice(0, 5);

      for (const ev of upcoming) {
        await mirrorIfNew(client, ev, "poll");
      }
    }
  } catch (e) {
    console.log("❌ EVENTS_MIRROR_POLL_ERR:", e?.message || e);
  }
}

/**
 * Enable by:
 *   DISCORD_EVENTS_MIRROR_ENABLED=true
 * Requires:
 *   ANNOUNCEMENTS_CHANNEL_ID
 *
 * Optional:
 *   EVENTS_PING_MODE=everyone|verified|off
 *   ROLE_VERIFIED_ID (only if EVENTS_PING_MODE=verified)
 */
function startDiscordEventsMirror(client) {
  const enabled = getBoolEnv("DISCORD_EVENTS_MIRROR_ENABLED", false);

  console.log("✅ DISCORD_EVENTS_MIRROR_BOOT", {
    enabled,
    announcementsSet: Boolean(String(process.env.ANNOUNCEMENTS_CHANNEL_ID || "").trim()),
    pingMode: String(process.env.EVENTS_PING_MODE || "off"),
  });

  if (!enabled) return;

  // Gateway handlers (best case)
  client.on(Events.GuildScheduledEventCreate, async (ev) => {
  try {
    console.log("🔎 EVENTS_MIRROR_CREATE_FIRED", {
      id: ev?.id,
      name: ev?.name,
      status: ev?.status,
      entityType: ev?.entityType,
      scheduledStartTimestamp: ev?.scheduledStartTimestamp,
      url: ev?.url,
    });

    const pingMode = String(process.env.EVENTS_PING_MODE || "off").toLowerCase();
    const ping =
      pingMode === "everyone"
        ? "@everyone\n"
        : pingMode === "verified"
        ? "<@&" + String(process.env.ROLE_VERIFIED_ID || "").trim() + ">\n"
        : "";

    const msg = ping + buildScheduledMsg(ev);

    const r = await sendAnnouncement(client, msg);
    console.log("✅ EVENTS_MIRROR_CREATE_SENT", r);
  } catch (e) {
    console.log("❌ EVENTS_MIRROR_CREATE_ERR:", e?.message || e);
  }
});

  client.on(Events.GuildScheduledEventUpdate, async (oldEv, newEv) => {
    try {
      const prevN = Number(oldEv?.status);
      const curN = Number(newEv?.status);
      if (Number.isFinite(prevN) && Number.isFinite(curN) && prevN === curN) return;

      // 2 = ACTIVE, 3 = COMPLETED, 4 = CANCELED
      if (curN === 2) await sendAnnouncement(client, buildLiveMsg(newEv));
      if (curN === 3) await sendAnnouncement(client, buildEndedMsg(newEv, false));
      if (curN === 4) await sendAnnouncement(client, buildEndedMsg(newEv, true));
    } catch (e) {
      console.log("❌ EVENTS_MIRROR_UPDATE_ERR:", e?.message || e);
    }
  });

  // Poll fallback (reliable case)
  setTimeout(() => pollScheduledEvents(client).catch(() => null), 15_000);
  setInterval(() => pollScheduledEvents(client).catch(() => null), 60_000);

  console.log("✅ Discord Events mirror: ACTIVE (gateway + poll fallback)");
}

module.exports = { startDiscordEventsMirror };