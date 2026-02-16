// src/jobs/xRssPoster.js
"use strict";

const { getJob, setState } = require("../utils/schedulerState");
const { getLatestTweetByUsername } = require("../services/xClient");

// NOTE: fetchText / decode / parseLatestItem were from the old RSS approach.
// They are no longer used, but keeping them doesn't break anything.
// To keep this file clean + production-grade, I removed them.

const JOB_KEY = "rss_x";

async function tick(client) {
  const channelId = String(process.env.X_FEED_CHANNEL_ID || "").trim();
  const username = String(process.env.X_USERNAME || "").trim();
  if (!channelId || !username) return;

  const ch =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch(() => null));
  if (!ch || !ch.isTextBased()) return;

  const row = await getJob(JOB_KEY);
  const state = row?.state || { initialized: false, lastGuid: null };

  const latest = await getLatestTweetByUsername(username).catch(() => null);
  if (!latest || !latest.id) return;

  if (!state.initialized) {
    await setState(JOB_KEY, {
      initialized: true,
      lastGuid: latest.id,
    });
    console.log("✅ X_FEED_INITIALIZED:", latest.id);
    return;
  }

  if (state.lastGuid === latest.id) return;

  const text = String(latest.text || "").trim();
  const msg = text
    ? `📊 **New X post**:\n${text}`
    : `📊 **New X post** (no text)`;

  await ch.send(msg).catch(() => null);

  await setState(JOB_KEY, { lastGuid: latest.id });

  console.log("✅ X_FEED_POSTED:", latest.id);
}

let _timer = null;

function startXRssPoster(client, opts = {}) {
  const everyMs = Number(opts.everyMs || 120_000); // 2 min
  if (_timer) clearInterval(_timer);

  setTimeout(() => tick(client).catch(() => null), 5_000);

  _timer = setInterval(() => {
    tick(client).catch(() => null);
  }, everyMs);

  console.log("✅ X RSS poster: ACTIVE");
}

module.exports = { startXRssPoster };
