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

async function fetchJson(url) {
  const txt = await fetchText(url);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error("Invalid JSON response");
  }
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

function getBoolEnv(name, fallback = false) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function resolveTextChannel(client, channelId, label) {
  const id = String(channelId || "").trim();
  if (!id) return null;

  const ch =
    client.channels.cache.get(id) ||
    (await client.channels.fetch(id).catch((e) => {
      console.log(`❌ ${label}_CHANNEL_FETCH_FAILED:`, e?.message || e);
      return null;
    }));

  if (!ch || !ch.isTextBased()) return null;
  return ch;
}

/**
 * Optional: YouTube Live State Mirroring (C)
 * - Uses YouTube Data API (API key) to detect:
 *   upcoming / live / ended transitions
 * - GUARDED: does nothing unless YOUTUBE_LIVE_MIRROR_ENABLED=true
 * - Does NOT affect the existing RSS upload poster
 */
async function detectLiveStateViaApi() {
  const enabled = getBoolEnv("YOUTUBE_LIVE_MIRROR_ENABLED", false);
  if (!enabled) return { enabled: false };

  const apiKey = String(process.env.YOUTUBE_API_KEY || "").trim();
  const channelId = String(process.env.YOUTUBE_CHANNEL_ID || "").trim();

  if (!apiKey || !channelId) {
    return {
      enabled: true,
      error: "missing_env",
      reason: "Set YOUTUBE_API_KEY and YOUTUBE_CHANNEL_ID for live mirroring.",
    };
  }

  const base = "https://www.googleapis.com/youtube/v3/search";
  const common = `part=snippet&channelId=${encodeURIComponent(
    channelId
  )}&type=video&order=date&maxResults=1&key=${encodeURIComponent(apiKey)}`;

  // A) LIVE
  const liveUrl = `${base}?${common}&eventType=live`;
  // B) UPCOMING (scheduled)
  const upcomingUrl = `${base}?${common}&eventType=upcoming`;

  let live = null;
  let upcoming = null;

  try {
    const j = await fetchJson(liveUrl);
    const it = (j?.items || [])[0];
    if (it?.id?.videoId) {
      live = {
        videoId: it.id.videoId,
        title: String(it?.snippet?.title || "").trim() || "YouTube Live",
      };
    }
  } catch (e) {
    return { enabled: true, error: "api_live_fetch", reason: e?.message || e };
  }

  try {
    const j = await fetchJson(upcomingUrl);
    const it = (j?.items || [])[0];
    if (it?.id?.videoId) {
      upcoming = {
        videoId: it.id.videoId,
        title:
          String(it?.snippet?.title || "").trim() || "Upcoming YouTube Live",
      };
    }
  } catch (e) {
    return { enabled: true, error: "api_upcoming_fetch", reason: e?.message || e };
  }

  return {
    enabled: true,
    live,
    upcoming,
  };
}

function ytWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(String(videoId || "").trim())}`;
}

async function tick(client) {
  const feedChannelId = String(process.env.YOUTUBE_FEED_CHANNEL_ID || "").trim();
  const rssUrl = String(process.env.YOUTUBE_RSS_URL || "").trim();

  // new: announcements channel for scheduled/live states (optional)
  const announceChannelId = String(process.env.ANNOUNCEMENTS_CHANNEL_ID || "").trim();

  // 🔎 hard proof the tick is running
  console.log("🔎 YOUTUBE_FEED_TICK", {
    feedChannelIdSet: Boolean(feedChannelId),
    announceChannelIdSet: Boolean(announceChannelId),
    rssUrlSet: Boolean(rssUrl),
    rssUrlPreview: rssUrl ? rssUrl.slice(0, 60) + "..." : "",
    liveMirrorEnabled: getBoolEnv("YOUTUBE_LIVE_MIRROR_ENABLED", false),
  });

  if (!feedChannelId || !rssUrl) {
    console.log("⚠️ YOUTUBE_FEED_SKIPPED: missing env");
    return;
  }

  const feedCh = await resolveTextChannel(client, feedChannelId, "YOUTUBE_FEED");
  if (!feedCh) {
    console.log("⚠️ YOUTUBE_FEED_SKIPPED: feed channel not found or not text-based", {
      feedChannelId,
    });
    return;
  }

  const announceCh = announceChannelId
    ? await resolveTextChannel(client, announceChannelId, "ANNOUNCEMENTS")
    : null;

  const row = await getJob(JOB_KEY).catch((e) => {
    console.log("❌ YOUTUBE_FEED_STATE_READ_FAILED:", e?.message || e);
    return null;
  });

  const state = row?.state || {
    initialized: false,
    lastVideoId: null,

    // live mirror state (optional)
    live: { status: "none", videoId: null }, // status: none|upcoming|live
    lastEndedVideoId: null, // for ended/replay post (dedupe)
  };

  // ---------------------------
  // A) Optional live-state mirroring (C)
  // ---------------------------
  try {
    const liveInfo = await detectLiveStateViaApi();

    if (liveInfo?.enabled) {
      if (liveInfo?.error) {
        console.log("⚠️ YOUTUBE_LIVE_MIRROR_SKIPPED:", liveInfo.reason || liveInfo.error);
      } else {
        // Determine current status
        const curStatus = liveInfo.live
          ? "live"
          : liveInfo.upcoming
            ? "upcoming"
            : "none";

        const curVideoId =
          (liveInfo.live && liveInfo.live.videoId) ||
          (liveInfo.upcoming && liveInfo.upcoming.videoId) ||
          null;

        const prevStatus = String(state?.live?.status || "none");
        const prevVideoId = String(state?.live?.videoId || "") || null;

        // Transition: UPCOMING
        if (curStatus === "upcoming" && curVideoId && (prevStatus !== "upcoming" || prevVideoId !== curVideoId)) {
          if (announceCh) {
            const msg = `⏰ **YouTube Live Scheduled**: ${liveInfo.upcoming.title}\n${ytWatchUrl(curVideoId)}`;
            await announceCh.send(msg).catch((e) => {
              console.log("❌ YOUTUBE_UPCOMING_ANNOUNCE_SEND_FAILED:", e?.message || e);
            });
            console.log("✅ YOUTUBE_UPCOMING_ANNOUNCED:", curVideoId);
          } else {
            console.log("ℹ️ YOUTUBE_UPCOMING_DETECTED_BUT_NO_ANNOUNCEMENTS_CHANNEL");
          }
        }

        // Transition: LIVE
        if (curStatus === "live" && curVideoId && (prevStatus !== "live" || prevVideoId !== curVideoId)) {
          if (announceCh) {
            const msg = `🔴 **LIVE NOW on YouTube**: ${liveInfo.live.title}\n${ytWatchUrl(curVideoId)}`;
            await announceCh.send(msg).catch((e) => {
              console.log("❌ YOUTUBE_LIVE_ANNOUNCE_SEND_FAILED:", e?.message || e);
            });
            console.log("✅ YOUTUBE_LIVE_ANNOUNCED:", curVideoId);
          } else {
            console.log("ℹ️ YOUTUBE_LIVE_DETECTED_BUT_NO_ANNOUNCEMENTS_CHANNEL");
          }
        }

        // Transition: ENDED (only if previously live and now none)
        if (prevStatus === "live" && curStatus === "none" && prevVideoId) {
          // Deduplicate ended posts
          if (String(state?.lastEndedVideoId || "") !== String(prevVideoId)) {
            const msg = `✅ **Stream ended — Replay available**\n${ytWatchUrl(prevVideoId)}`;
            await feedCh.send(msg).catch((e) => {
              console.log("❌ YOUTUBE_ENDED_FEED_SEND_FAILED:", e?.message || e);
            });
            console.log("✅ YOUTUBE_ENDED_POSTED:", prevVideoId);
            state.lastEndedVideoId = prevVideoId;
          } else {
            console.log("ℹ️ YOUTUBE_ENDED_ALREADY_POSTED:", prevVideoId);
          }
        }

        // Save live mirror state (additive; does not affect RSS behavior)
        state.live = { status: curStatus, videoId: curVideoId };
      }
    }
  } catch (e) {
    console.log("⚠️ YOUTUBE_LIVE_MIRROR_ERR:", e?.message || e);
  }

  // ---------------------------
  // B) Existing RSS “new upload” poster (UNCHANGED behavior)
  // ---------------------------
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

      // keep live mirror additions if present
      live: state.live || { status: "none", videoId: null },
      lastEndedVideoId: state.lastEndedVideoId || null,
    }).catch((e) => {
      console.log("❌ YOUTUBE_FEED_STATE_WRITE_FAILED (init):", e?.message || e);
    });

    console.log("✅ YOUTUBE_FEED_INITIALIZED:", latest.videoId);
    return;
  }

  if (state.lastVideoId === latest.videoId) {
    // Still persist live mirror state changes (if any) without affecting uploads behavior
    await setState(JOB_KEY, {
      initialized: true,
      lastVideoId: state.lastVideoId,
      live: state.live || { status: "none", videoId: null },
      lastEndedVideoId: state.lastEndedVideoId || null,
    }).catch(() => null);

    console.log("ℹ️ YOUTUBE_FEED_NO_CHANGE:", latest.videoId);
    return;
  }

  const msg = `▶️ **New YouTube upload**: ${latest.title}\n${latest.link}`;
  await feedCh.send(msg).catch((e) => {
    console.log("❌ YOUTUBE_FEED_DISCORD_SEND_FAILED:", e?.message || e);
  });

  // IMPORTANT: keep initialized=true (avoid wiping state if setState replaces)
  await setState(JOB_KEY, {
    initialized: true,
    lastVideoId: latest.videoId,

    // keep live mirror additions if present
    live: state.live || { status: "none", videoId: null },
    lastEndedVideoId: state.lastEndedVideoId || null,
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
    YOUTUBE_FEED_CHANNEL_ID: Boolean(
      String(process.env.YOUTUBE_FEED_CHANNEL_ID || "").trim()
    ),
    YOUTUBE_RSS_URL: String(process.env.YOUTUBE_RSS_URL || "").trim() || "(missing)",
    ANNOUNCEMENTS_CHANNEL_ID: Boolean(
      String(process.env.ANNOUNCEMENTS_CHANNEL_ID || "").trim()
    ),
    YOUTUBE_LIVE_MIRROR_ENABLED: getBoolEnv("YOUTUBE_LIVE_MIRROR_ENABLED", false),
    YOUTUBE_API_KEY: Boolean(String(process.env.YOUTUBE_API_KEY || "").trim()),
    YOUTUBE_CHANNEL_ID: Boolean(String(process.env.YOUTUBE_CHANNEL_ID || "").trim()),
  });

  setTimeout(
    () =>
      tick(client).catch((e) =>
        console.log("❌ YOUTUBE_FEED_TICK_ERR:", e?.message || e)
      ),
    5_000
  );

  _timer = setInterval(() => {
    tick(client).catch((e) =>
      console.log("❌ YOUTUBE_FEED_TICK_ERR:", e?.message || e)
    );
  }, everyMs);

  console.log("✅ YouTube RSS poster: ACTIVE", { everyMs });
}

module.exports = { startYouTubeRssPoster };