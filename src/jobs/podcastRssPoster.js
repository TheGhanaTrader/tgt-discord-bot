// src/jobs/podcastRssPoster.js
"use strict";

const { getJob, setState } = require("../utils/schedulerState");

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

function parseLatestItem(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (!items.length) return null;

  const item = items[0];

  const title = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
  const link = decode(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "");
  const guid = decode(item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] || "");

  // Some feeds put URL in guid. Still fine as long as it’s stable.
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

  const row = await getJob("rss_podcast");
  const state = row?.state || { initialized: false, lastGuid: null };

  let xml;
  try {
    xml = await fetchText(rssUrl);
  } catch (e) {
    console.log("PODCAST_RSS_FETCH_ERR:", e?.message || e);
    return;
  }

  const latest = parseLatestItem(xml);
  if (!latest) return;

  // First boot: initialize without spamming
  if (!state.initialized) {
    await setState("rss_podcast", { initialized: true, lastGuid: latest.guid });
    console.log("✅ PODCAST_FEED_INITIALIZED:", latest.guid);
    return;
  }

  // Dedupe
  if (state.lastGuid === latest.guid) return;

  const msg = `🎙️ **New Podcast Episode**: ${latest.title}\n${latest.link}`;
  await ch.send(msg).catch(() => null);

  await setState("rss_podcast", { lastGuid: latest.guid });
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
