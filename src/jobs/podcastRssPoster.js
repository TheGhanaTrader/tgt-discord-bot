// src/jobs/podcastRssPoster.js
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "podcast-feed.json");

function ensureState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ initialized: false, lastGuid: null }, null, 2)
    );
  }
}

function readState() {
  ensureState();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { initialized: false, lastGuid: null };
  }
}

function writeState(s) {
  ensureState();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function parseLatestItem(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (!items.length) return null;

  const item = items[0];

  const title =
    (item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "")
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .trim();

  const link =
    (item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "")
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .trim();

  const guid =
    (item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] || "")
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .trim();

  if (!guid || !link) return null;

  return { guid, title: title || "New Podcast Episode", link };
}

async function tick(client) {
  const channelId = String(process.env.PODCAST_FEED_CHANNEL_ID || "").trim();
  const rssUrl = String(process.env.PODCAST_RSS_URL || "").trim();

  if (!channelId || !rssUrl) return;

  const ch =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch(() => null));

  if (!ch || !ch.isTextBased()) return;

  const state = readState();

  let xml;
  try {
    xml = await fetchText(rssUrl);
  } catch (e) {
    console.log("PODCAST_RSS_FETCH_ERR:", e?.message || e);
    return;
  }

  const latest = parseLatestItem(xml);
  if (!latest) return;

  if (!state.initialized) {
    state.initialized = true;
    state.lastGuid = latest.guid;
    writeState(state);
    console.log("✅ PODCAST_FEED_INITIALIZED:", latest.guid);
    return;
  }

  if (state.lastGuid === latest.guid) return;

  const msg = `🎙️ **New Podcast Episode**: ${latest.title}\n${latest.link}`;
  await ch.send(msg).catch(() => null);

  state.lastGuid = latest.guid;
  writeState(state);

  console.log("✅ PODCAST_FEED_POSTED:", latest.guid);
}

let _timer = null;

function startPodcastRssPoster(client, opts = {}) {
  const everyMs = Number(opts.everyMs || 180_000); // 3 minutes
  if (_timer) clearInterval(_timer);

  setTimeout(() => tick(client).catch(() => null), 5_000);

  _timer = setInterval(() => {
    tick(client).catch(() => null);
  }, everyMs);

  console.log("✅ Podcast RSS poster: ACTIVE");
}

module.exports = { startPodcastRssPoster };
