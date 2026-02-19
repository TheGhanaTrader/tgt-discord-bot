// src/jobs/youtubeRssPoster.js
"use strict";

const { getJob, setState } = require("../utils/schedulerState");

const JOB_KEY = "rss_youtube";

async function fetchText(url) {
  const target = String(url || "").trim();
  if (!target) throw new Error("Missing URL");

  if (typeof fetch === "function") {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);

    try {
      const res = await fetch(target, {
        method: "GET",
        redirect: "follow",
        signal: ctrl.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          accept:
            "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  // Fallback (rare)
  const https = require("https");
  return await new Promise((resolve, reject) => {
    const req = https.get(
      target,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          accept:
            "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
        },
      },
      (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => {
          if (r.statusCode && r.statusCode >= 400) {
            reject(new Error(`HTTP ${r.statusCode}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12_000, () => req.destroy(new Error("Timeout")));
  });
}

function decodeXml(input) {
  return String(input || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function parseLatestEntry(atomXml) {
  const xml = String(atomXml || "");
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  if (!entries.length) return null;

  const e = entries[0];

  const videoId = (
    e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || ""
  ).trim();

  const title = decodeXml(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
  const link = (
    e.match(/<link[^>]+href="([^"]+)"[^>]*\/>/)?.[1] || ""
  ).trim();
  const published = (
    e.match(/<published>([^<]+)<\/published>/)?.[1] || ""
  ).trim();

  if (!videoId || !link) return null;
  return { videoId, title: title || "New YouTube upload", link, published };
}

async function tick(client) {
  const channelId = String(process.env.YOUTUBE_FEED_CHANNEL_ID || "").trim();
  const rssUrl = String(process.env.YOUTUBE_RSS_URL || "").trim();

  // 🔎 hard proof the tick is running
  console.log("🔎 YOUTUBE_FEED_TICK", {
    channelIdSet: Boolean(channelId),
    rssUrlSet: Boolean(rssUrl),
    rssUrlPreview: rssUrl ? rssUrl.slice(0, 60) + "..." : "",
  });

  if (!channelId || !rssUrl) {
    console.log("⚠️ YOUTUBE_FEED_SKIPPED: missing env");
    return;
  }

  const ch =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch((e) => {
      console.log("❌ YOUTUBE_FEED_CHANNEL_FETCH_FAILED:", e?.message || e);
      return null;
    }));

  if (!ch || !ch.isTextBased()) {
    console.log("⚠️ YOUTUBE_FEED_SKIPPED: channel not found or not text-based", {
      channelId,
    });
    return;
  }

  const row = await getJob(JOB_KEY).catch((e) => {
    console.log("❌ YOUTUBE_FEED_STATE_READ_FAILED:", e?.message || e);
    return null;
  });

  const state = row?.state || { initialized: false, lastVideoId: null };

  let xml;
  try {
    xml = await fetchText(rssUrl);
  } catch (e) {
    console.log("❌ YOUTUBE_RSS_FETCH_ERR:", e?.message || e);
    return;
  }

  const latest = parseLatestEntry(xml);
  if (!latest) {
    console.log("⚠️ YOUTUBE_RSS_PARSE_EMPTY: no <entry> found");
    return;
  }

  if (!state.initialized) {
    await setState(JOB_KEY, {
      initialized: true,
      lastVideoId: latest.videoId,
    }).catch((e) => {
      console.log("❌ YOUTUBE_FEED_STATE_WRITE_FAILED (init):", e?.message || e);
    });

    console.log("✅ YOUTUBE_FEED_INITIALIZED:", latest.videoId);
    return;
  }

  if (state.lastVideoId === latest.videoId) {
    console.log("ℹ️ YOUTUBE_FEED_NO_CHANGE:", latest.videoId);
    return;
  }

  const msg = `▶️ **New YouTube upload**: ${latest.title}\n${latest.link}`;
  await ch.send(msg).catch((e) => {
    console.log("❌ YOUTUBE_FEED_DISCORD_SEND_FAILED:", e?.message || e);
  });

  // IMPORTANT: keep initialized=true (avoid wiping state if setState replaces)
  await setState(JOB_KEY, {
    initialized: true,
    lastVideoId: latest.videoId,
  }).catch((e) => {
    console.log("❌ YOUTUBE_FEED_STATE_WRITE_FAILED (post):", e?.message || e);
  });

  console.log("✅ YOUTUBE_FEED_POSTED:", latest.videoId);
}

let _timer = null;

function startYouTubeRssPoster(client, opts = {}) {
  const everyMs = Number(opts.everyMs || 120_000); // 2 min
  if (_timer) clearInterval(_timer);

  // ✅ boot proof (shows env at startup)
  console.log("✅ YOUTUBE_FEED_BOOT", {
    everyMs,
    YOUTUBE_FEED_CHANNEL_ID: Boolean(String(process.env.YOUTUBE_FEED_CHANNEL_ID || "").trim()),
    YOUTUBE_RSS_URL: String(process.env.YOUTUBE_RSS_URL || "").trim() || "(missing)",
  });

  setTimeout(() => tick(client).catch((e) => console.log("❌ YOUTUBE_FEED_TICK_ERR:", e?.message || e)), 5_000);

  _timer = setInterval(() => {
    tick(client).catch((e) => console.log("❌ YOUTUBE_FEED_TICK_ERR:", e?.message || e));
  }, everyMs);

  console.log("✅ YouTube RSS poster: ACTIVE", { everyMs });
}

module.exports = { startYouTubeRssPoster };
