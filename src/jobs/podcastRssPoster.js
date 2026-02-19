// src/jobs/podcastRssPoster.js
"use strict";

const { getJob, setState } = require("../utils/schedulerState");

const JOB_KEY = "rss_podcast";

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
  const target = String(url || "").trim();
  if (!target) throw new Error("Missing URL");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);

  try {
    const res = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // Many podcast hosts block empty/unknown UA
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseLatestItem(xml) {
  const text = String(xml || "");
  const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (!items.length) return null;

  // Newest is usually first
  const item = items[0];

  const title = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");

  // Podcast feeds are inconsistent: link can be missing.
  const linkRaw = item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "";
  const guidRaw = item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] || "";

  // enclosure often holds the audio file URL
  const enclosureUrl =
    item.match(/<enclosure[^>]*url="([^"]+)"/i)?.[1] ||
    item.match(/<enclosure[^>]*url='([^']+)'/i)?.[1] ||
    "";

  const link = decode(linkRaw);
  const guid = decode(guidRaw);

  // Prefer stable identifier:
  // - guid if present
  // - else link
  // - else enclosure url
  const stableId = guid || link || decode(enclosureUrl);

  // Prefer a human link for posting:
  // - link if present
  // - else guid if it looks like a URL
  // - else enclosure url
  const postUrl =
    link ||
    (guid && /^https?:\/\//i.test(guid) ? guid : "") ||
    decode(enclosureUrl);

  if (!stableId) return null;

  return {
    guid: stableId,
    title: title || "New Podcast Episode",
    link: postUrl || "",
  };
}

async function tick(client) {
  const channelId = String(process.env.PODCAST_FEED_CHANNEL_ID || "").trim();
  const rssUrl = String(process.env.PODCAST_RSS_URL || "").trim();

  // Proof tick is running + env present
  console.log("🔎 PODCAST_FEED_TICK", {
    channelIdSet: Boolean(channelId),
    rssUrlSet: Boolean(rssUrl),
    rssUrlPreview: rssUrl ? rssUrl.slice(0, 70) + "..." : "",
  });

  if (!channelId || !rssUrl) {
    console.log("⚠️ PODCAST_FEED_SKIPPED: missing env");
    return;
  }

  const ch =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch((e) => {
      console.log("❌ PODCAST_FEED_CHANNEL_FETCH_FAILED:", e?.message || e);
      return null;
    }));
  if (!ch || !ch.isTextBased()) {
    console.log("⚠️ PODCAST_FEED_SKIPPED: channel not found or not text-based", {
      channelId,
    });
    return;
  }

  const row = await getJob(JOB_KEY).catch((e) => {
    console.log("❌ PODCAST_FEED_STATE_READ_FAILED:", e?.message || e);
    return null;
  });
  const state = row?.state || { initialized: false, lastGuid: null };

  let xml;
  try {
    xml = await fetchText(rssUrl);
  } catch (e) {
    console.log("❌ PODCAST_RSS_FETCH_ERR:", e?.message || e);
    return;
  }

  const latest = parseLatestItem(xml);
  if (!latest) {
    console.log("⚠️ PODCAST_RSS_PARSE_EMPTY: no <item> found");
    return;
  }

  // First boot: initialize without spamming
  if (!state.initialized) {
    await setState(JOB_KEY, { initialized: true, lastGuid: latest.guid }).catch(
      (e) => console.log("❌ PODCAST_FEED_STATE_WRITE_FAILED (init):", e?.message || e)
    );
    console.log("✅ PODCAST_FEED_INITIALIZED:", latest.guid);
    return;
  }

  // Dedupe
  if (state.lastGuid === latest.guid) {
    console.log("ℹ️ PODCAST_FEED_NO_CHANGE:", latest.guid);
    return;
  }

  const urlLine = latest.link ? `\n${latest.link}` : "";
  const msg = `🎙️ **New Podcast Episode**: ${latest.title}${urlLine}`;

  await ch.send(msg).catch((e) => {
    console.log("❌ PODCAST_FEED_DISCORD_SEND_FAILED:", e?.message || e);
  });

  // IMPORTANT: keep initialized=true (avoid wiping state if setState replaces)
  await setState(JOB_KEY, { initialized: true, lastGuid: latest.guid }).catch(
    (e) => console.log("❌ PODCAST_FEED_STATE_WRITE_FAILED (post):", e?.message || e)
  );

  console.log("✅ PODCAST_FEED_POSTED:", latest.guid);
}

let _timer = null;

function startPodcastRssPoster(client, opts = {}) {
  const everyMs = Number(opts.everyMs || 180_000); // 3 minutes
  if (_timer) clearInterval(_timer);

  console.log("✅ PODCAST_FEED_BOOT", {
    everyMs,
    PODCAST_FEED_CHANNEL_ID: Boolean(String(process.env.PODCAST_FEED_CHANNEL_ID || "").trim()),
    PODCAST_RSS_URL: String(process.env.PODCAST_RSS_URL || "").trim() || "(missing)",
  });

  setTimeout(() => tick(client).catch((e) => console.log("❌ PODCAST_FEED_TICK_ERR:", e?.message || e)), 5_000);

  _timer = setInterval(() => {
    tick(client).catch((e) => console.log("❌ PODCAST_FEED_TICK_ERR:", e?.message || e));
  }, everyMs);

  console.log("✅ Podcast RSS poster: ACTIVE", { everyMs });
}

module.exports = { startPodcastRssPoster };
