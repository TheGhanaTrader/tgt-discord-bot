// src/jobs/xRssPoster.js
"use strict";

const fs = require("fs");
const path = require("path");
const { postToX } = require("../services/xClient");
const { getLatestTweetByUsername } = require("../services/xClient");

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "x-feed.json");

function ensureState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ initialized: false, lastGuid: null }, null, 2));
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
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function parseLatestItem(xml) {
  const items =
  xml.match(/<item>[\s\S]*?<\/item>/g) ||
  xml.match(/<entry>[\s\S]*?<\/entry>/g) ||
  [];
  if (!items.length) return null;

  const item = items[0];

  const title = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
  const link = decode(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "");
  const guid = decode(item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] || "");

  if (!guid || !link) return null;
  return { guid, title: title || "New post", link };
}

async function tick(client) {
  const channelId = String(process.env.X_FEED_CHANNEL_ID || "").trim();
  const username = String(process.env.X_USERNAME || "").trim();
  if (!channelId || !username) return;

  const ch =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch(() => null));
  if (!ch || !ch.isTextBased()) return;

  const state = readState();

  const latest = await getLatestTweetByUsername(username).catch(() => null);
  if (!latest) return;

  if (!state.initialized) {
    state.initialized = true;
    state.lastGuid = latest.id;
    writeState(state);
    console.log("✅ X_FEED_INITIALIZED:", latest.id);
    return;
  }

  if (state.lastGuid === latest.id) return;

  const msg = `📊 **New X post**:\n${latest.text}`;
  await ch.send(msg).catch(() => null);

  state.lastGuid = latest.id;
  writeState(state);

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
