// src/jobs/youtubeRssPoster.js
"use strict";

const { getJob, setState } = require("../utils/schedulerState");

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
    https
      .get(url, (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function parseLatestEntry(atomXml) {
  // Atom feed: multiple <entry>...</entry>
  const entries = atomXml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  if (!entries.length) return null;

  // Newest is usually first
  const e = entries[0];

  const videoId = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || "").trim();

  const title = (e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();

  const link = (e.match(/<link[^>]+href="([^"]+)"[^>]*\/>/)?.[1] || "").trim();

  const published = (e.match(/<published>([^<]+)<\/published>/)?.[1] || "").trim();

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

  const row = await getJob("rss_youtube");
  const state = row?.state || { initialized: false, lastVideoId: null };

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
    await setState("rss_youtube", {
      initialized: true,
      lastVideoId: latest.videoId,
    });
    console.log("✅ YOUTUBE_FEED_INITIALIZED:", latest.videoId);
    return;
  }

  // Dedupe
  if (state.lastVideoId === latest.videoId) return;

  // Post
  const msg = `▶️ **New YouTube upload**: ${latest.title}\n${latest.link}`;
  await ch.send(msg).catch(() => null);

  await setState("rss_youtube", { lastVideoId: latest.videoId });

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
