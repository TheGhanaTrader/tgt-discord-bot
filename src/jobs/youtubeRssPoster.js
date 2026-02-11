// src/jobs/youtubeRssPoster.js
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "youtube-feed.json");

function ensureState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ initialized: false, lastVideoId: null }, null, 2));
  }
}

function readState() {
  ensureState();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { initialized: false, lastVideoId: null };
  }
}

function writeState(s) {
  ensureState();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function fetchText(url) {
  // Node 18+ has fetch; fallback keeps it safe
  if (typeof fetch === "function") {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  // Fallback (rare)
  const https = require("https");
  return await new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let data = "";
      r.on("data", (c) => (data += c));
      r.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function parseLatestEntry(atomXml) {
  // Atom feed: multiple <entry>...</entry>
  const entries = atomXml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  if (!entries.length) return null;

  // Newest is usually first, but we’ll still read first safely
  const e = entries[0];

  const videoId =
    (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || "").trim();

  const title =
    (e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();

  const link =
    (e.match(/<link[^>]+href="([^"]+)"[^>]*\/>/)?.[1] || "").trim();

  const published =
    (e.match(/<published>([^<]+)<\/published>/)?.[1] || "").trim();

  if (!videoId || !link) return null;

  return { videoId, title: title || "New YouTube upload", link, published };
}

async function tick(client) {
  const channelId = String(process.env.YOUTUBE_FEED_CHANNEL_ID || "").trim();
  const rssUrl = String(process.env.YOUTUBE_RSS_URL || "").trim();

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
    console.log("YOUTUBE_RSS_FETCH_ERR:", e?.message || e);
    return;
  }

  const latest = parseLatestEntry(xml);
  if (!latest) return;

  // First boot: initialize without spamming backlog
  if (!state.initialized) {
    state.initialized = true;
    state.lastVideoId = latest.videoId;
    writeState(state);
    console.log("✅ YOUTUBE_FEED_INITIALIZED:", latest.videoId);
    return;
  }

  // Dedupe
  if (state.lastVideoId === latest.videoId) return;

  // Post
  const msg = `▶️ **New YouTube upload**: ${latest.title}\n${latest.link}`;
  await ch.send(msg).catch(() => null);

  state.lastVideoId = latest.videoId;
  writeState(state);

  console.log("✅ YOUTUBE_FEED_POSTED:", latest.videoId);
}

let _timer = null;

function startYouTubeRssPoster(client, opts = {}) {
  const everyMs = Number(opts.everyMs || 120_000); // 2 min
  if (_timer) clearInterval(_timer);

  // run once shortly after start
  setTimeout(() => tick(client).catch(() => null), 5_000);

  _timer = setInterval(() => {
    tick(client).catch(() => null);
  }, everyMs);

  console.log("✅ YouTube RSS poster: ACTIVE");
}

module.exports = { startYouTubeRssPoster };
