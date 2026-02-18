// src/jobs/xRssPoster.js
"use strict";

const { getJob, setState } = require("../utils/schedulerState");
const { getLatestTweetByUsername } = require("../services/xClient");

const JOB_KEY = "rss_x";

async function tick(client) {
  const channelId = String(process.env.X_FEED_CHANNEL_ID || "").trim();
  const username = String(process.env.X_USERNAME || "").trim();

  if (!channelId || !username) {
    console.log(
      "⚠️ X_FEED_SKIPPED: missing env",
      JSON.stringify({
        X_FEED_CHANNEL_ID: Boolean(channelId),
        X_USERNAME: Boolean(username),
      })
    );
    return;
  }

  const ch =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch((e) => {
      console.log("❌ X_FEED_CHANNEL_FETCH_FAILED:", e?.message || e);
      return null;
    }));

  if (!ch || !ch.isTextBased()) {
    console.log("⚠️ X_FEED_SKIPPED: channel not found or not text-based", {
      channelId,
    });
    return;
  }

  const row = await getJob(JOB_KEY).catch((e) => {
    console.log("❌ X_FEED_STATE_READ_FAILED:", e?.message || e);
    return null;
  });

  const state = row?.state || { initialized: false, lastGuid: null };

  const latest = await getLatestTweetByUsername(username).catch((e) => {
    console.log("❌ X_FEED_FETCH_FAILED:", e?.message || e);
    return null;
  });

  if (!latest || !latest.id) {
    console.log("⚠️ X_FEED_NO_LATEST: empty response from xClient");
    return;
  }

  // First run: record last seen and exit (prevents spam on boot)
  if (!state.initialized) {
    await setState(JOB_KEY, {
      initialized: true,
      lastGuid: latest.id,
    }).catch((e) => {
      console.log("❌ X_FEED_STATE_WRITE_FAILED (init):", e?.message || e);
    });

    console.log("✅ X_FEED_INITIALIZED:", latest.id);
    return;
  }

  if (state.lastGuid === latest.id) return;

  const text = String(latest.text || "").trim();
  const url =
    latest.url ||
    (latest.id
      ? `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(
          String(latest.id)
        )}`
      : null);

  const msg =
    (text ? `📊 **New X post**:\n${text}` : `📊 **New X post** (no text)`) +
    (url ? `\n\n${url}` : "");

  await ch.send(msg).catch((e) => {
    console.log("❌ X_FEED_DISCORD_SEND_FAILED:", e?.message || e);
  });

  // IMPORTANT: always persist initialized=true (avoid state wipe if setState replaces)
  await setState(JOB_KEY, {
    initialized: true,
    lastGuid: latest.id,
  }).catch((e) => {
    console.log("❌ X_FEED_STATE_WRITE_FAILED (post):", e?.message || e);
  });

  console.log("✅ X_FEED_POSTED:", latest.id);
}

let _timer = null;

function startXRssPoster(client, opts = {}) {
  const everyMs = Number(opts.everyMs || 120_000); // 2 min
  if (_timer) clearInterval(_timer);

  setTimeout(() => tick(client).catch((e) => console.log("❌ X_FEED_TICK_ERR:", e?.message || e)), 5_000);

  _timer = setInterval(() => {
    tick(client).catch((e) => console.log("❌ X_FEED_TICK_ERR:", e?.message || e));
  }, everyMs);

  console.log("✅ X RSS poster: ACTIVE", { everyMs });
}

module.exports = { startXRssPoster };
