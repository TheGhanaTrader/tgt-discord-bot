// src/services/xClient.js
"use strict";

const { TwitterApi } = require("twitter-api-v2");

// -------------------- X API client (primary) --------------------
const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

// Diagnostics
const _rsshubBase = String(process.env.RSSHUB_BASE_URL || "https://rsshub.app")
  .trim()
  .replace(/\/+$/, "");

const _ua =
  String(process.env.X_FEED_USER_AGENT || "").trim() ||
  // default: realistic browser UA
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

console.log("✅ X_CLIENT_BOOT", {
  RSSHUB_BASE_URL: _rsshubBase,
  X_FEED_USER_AGENT: process.env.X_FEED_USER_AGENT ? "custom" : "default",
});

// -------------------- Helpers --------------------
function cleanUsername(username) {
  return String(username || "").replace(/^@/, "").trim();
}

function stripHtml(input) {
  const s = String(input || "");
  const noTags = s.replace(/<[^>]*>/g, " ");
  return noTags.replace(/\s+/g, " ").trim();
}

function decodeEntities(input) {
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function extractFirstTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function extractFirstCdataOrText(xml, tag) {
  const block = extractFirstTag(xml, tag);
  if (!block) return "";
  const c = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  return (c ? c[1] : block).trim();
}

function parseFirstRssItem(xml) {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) return null;

  const itemXml = itemMatch[1];

  const link = extractFirstCdataOrText(itemXml, "link");
  const guid = extractFirstCdataOrText(itemXml, "guid") || link;

  const titleRaw = extractFirstCdataOrText(itemXml, "title");
  const descRaw = extractFirstCdataOrText(itemXml, "description");

  const title = decodeEntities(stripHtml(titleRaw));
  const desc = decodeEntities(stripHtml(descRaw));

  const text = (desc && desc.length >= title.length ? desc : title).trim();

  const idMatch = String(link || guid || "").match(/status\/(\d+)/i);
  const id = idMatch ? idMatch[1] : (guid || link || "").slice(0, 80);

  return { id, text, url: link || null };
}

function parseFirstAtomEntry(xml) {
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!entryMatch) return null;

  const entryXml = entryMatch[1];

  const idRaw = extractFirstCdataOrText(entryXml, "id");
  const titleRaw = extractFirstCdataOrText(entryXml, "title");
  const contentRaw =
    extractFirstCdataOrText(entryXml, "content") ||
    extractFirstCdataOrText(entryXml, "summary");

  const hrefMatch = entryXml.match(/<link[^>]+href="([^"]+)"/i);
  const link = hrefMatch ? hrefMatch[1] : "";

  const title = decodeEntities(stripHtml(titleRaw));
  const content = decodeEntities(stripHtml(contentRaw));

  const text = (content && content.length >= title.length ? content : title).trim();

  const idMatch = String(link || idRaw || "").match(/status\/(\d+)/i);
  const id = idMatch
    ? idMatch[1]
    : (String(idRaw || link || "").trim() || "").slice(0, 80);

  return { id, text, url: link || null };
}

function parseFeed(xml) {
  return parseFirstRssItem(xml) || parseFirstAtomEntry(xml) || null;
}

async function fetchWithTimeout(url, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": _ua,
        "accept-language": "en-US,en;q=0.9",
        accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      },
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

// -------------------- Fallback sources --------------------

// A) RSSHub (keep, but often broken for Twitter)
function rsshubCandidateUrls(base, username) {
  const u = encodeURIComponent(username);
  return [
    `${base}/twitter/user/${u}`,
    `${base}/x/user/${u}`,
    `${base}/twitter/profile/${u}`,
    `${base}/twitter/status/user/${u}`,
  ];
}

async function getLatestViaRssHub(username) {
  const u = cleanUsername(username);
  if (!u) return null;

  for (const url of rsshubCandidateUrls(_rsshubBase, u)) {
    console.log("🔎 X_RSSHUB_FETCH:", url);
    try {
      const r = await fetchWithTimeout(url, 10000);
      if (!r.ok || !r.text) {
        console.log("⚠️ X_RSSHUB_BAD_RESPONSE:", r.status, url);
        continue;
      }
      const parsed = parseFeed(r.text);
      if (parsed?.id) return parsed;
      console.log("⚠️ X_RSSHUB_PARSE_FAILED:", url);
    } catch (e) {
      console.log("⚠️ X_RSSHUB_FETCH_FAILED:", e?.message || e, url);
    }
  }
  return null;
}

// B) XCancel RSS (often works when RSSHub doesn't)
async function getLatestViaXCancel(username) {
  const u = cleanUsername(username);
  if (!u) return null;

  const url = `https://xcancel.com/${encodeURIComponent(u)}/rss`;
  console.log("🔎 X_XCANCEL_FETCH:", url);

  try {
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok || !r.text) {
      console.log("⚠️ X_XCANCEL_BAD_RESPONSE:", r.status);
      return null;
    }

    const parsed = parseFeed(r.text);
    if (parsed?.id) return parsed;

    console.log("⚠️ X_XCANCEL_PARSE_FAILED");
    return null;
  } catch (e) {
    console.log("⚠️ X_XCANCEL_FETCH_FAILED:", e?.message || e);
    return null;
  }
}

// C) Direct Nitter instances (optional override)
function getNitterInstances() {
  const env = String(process.env.NITTER_INSTANCES || "").trim();
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("http") ? s : `https://${s}`))
      .map((s) => s.replace(/\/+$/, ""));
  }

  // small defaults; may be blocked/rate-limited
  return [
    "https://nitter.blahaj.land",
    "https://nitter.batsense.net",
    "https://nitter.buntcomm.com",
    "https://nitter.cabletemple.net",
    "https://nitter.asmallr.tech",
    "https://nitter.privacydev.net",
    "https://nitter.fdn.fr",
    "https://nitter.cz",
  ];
}

async function getLatestViaNitter(username) {
  const u = cleanUsername(username);
  if (!u) return null;

  for (const base of getNitterInstances()) {
    const url = `${base}/${encodeURIComponent(u)}/rss`;
    console.log("🔎 X_NITTER_FETCH:", url);

    try {
      const r = await fetchWithTimeout(url, 10000);
      if (!r.ok || !r.text) {
        console.log("⚠️ X_NITTER_BAD_RESPONSE:", r.status, base);
        continue;
      }

      const parsed = parseFeed(r.text);
      if (parsed?.id) return parsed;

      console.log("⚠️ X_NITTER_PARSE_FAILED:", base);
    } catch (e) {
      console.log("⚠️ X_NITTER_FETCH_FAILED:", e?.message || e, base);
    }
  }

  return null;
}

// D) Twiiit (backup only)
async function getLatestViaTwiiit(username) {
  const u = cleanUsername(username);
  if (!u) return null;

  const url = `https://twiiit.com/${encodeURIComponent(u)}/rss`;
  console.log("🔎 X_TWIIIT_FETCH:", url);

  try {
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok || !r.text) {
      console.log("⚠️ X_TWIIIT_BAD_RESPONSE:", r.status);
      return null;
    }

    const parsed = parseFeed(r.text);
    if (parsed?.id) return parsed;

    console.log("⚠️ X_TWIIIT_PARSE_FAILED");
    return null;
  } catch (e) {
    console.log("⚠️ X_TWIIIT_FETCH_FAILED:", e?.message || e);
    return null;
  }
}

// -------------------- Public API --------------------
async function postToX(text) {
  const tweet = String(text || "");
  const safe = tweet.length > 280 ? tweet.slice(0, 277) + "…" : tweet;
  await client.v2.tweet(safe);
  console.log("✅ X_POST_SUCCESS");
}

async function getLatestTweetByUsername(username) {
  const u = cleanUsername(username);
  if (!u) return null;

  // 1) Try official X API first
  try {
    const user = await client.v2.userByUsername(u);
    const userId = user?.data?.id;
    if (userId) {
      const timeline = await client.v2.userTimeline(userId, {
        max_results: 5,
        "tweet.fields": ["created_at"],
        exclude: ["replies", "retweets"],
      });

      const t = timeline?.data?.data?.[0];
      if (t?.id) {
        const text = String(t.text || "").trim();
        const url = `https://x.com/${encodeURIComponent(u)}/status/${encodeURIComponent(
          String(t.id)
        )}`;
        return { id: t.id, text, url };
      }
    }
  } catch (e) {
    console.log("⚠️ X_API_READ_FAILED (fallback to RSS):", e?.message || e);
  }

  // 2) XCancel RSS (best shot right now)
  const xc = await getLatestViaXCancel(u);
  if (xc?.id) return xc;

  // 3) RSSHub (often broken for Twitter)
  const rh = await getLatestViaRssHub(u);
  if (rh?.id) return rh;

  // 4) Nitter instances
  const ni = await getLatestViaNitter(u);
  if (ni?.id) return ni;

  // 5) Twiiit
  const tw = await getLatestViaTwiiit(u);
  if (tw?.id) return tw;

  return null;
}

module.exports = { postToX, getLatestTweetByUsername };
