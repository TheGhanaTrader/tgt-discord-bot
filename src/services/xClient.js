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

// One-time boot signal so we can confirm the deployed code version
const _rsshubBase = String(process.env.RSSHUB_BASE_URL || "https://rsshub.app")
  .trim()
  .replace(/\/+$/, "");
console.log("✅ X_CLIENT_BOOT: RSSHub enabled", { RSSHUB_BASE_URL: _rsshubBase });

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

async function fetchWithTimeout(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; TheGhanaTraderDeskBot/1.0; +https://example.invalid)",
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

// -------------------- RSS/Atom fallback sources --------------------

// 1) RSSHub (best fallback)
async function getLatestViaRssHub(username) {
  const u = cleanUsername(username);
  if (!u) return null;

  const base = _rsshubBase;
  const url = `${base}/twitter/user/${encodeURIComponent(u)}`;

  // log only when we actually attempt RSSHub
  console.log("🔎 X_RSSHUB_FETCH:", url);

  try {
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok || !r.text) {
      console.log("⚠️ X_RSSHUB_BAD_RESPONSE:", r.status);
      return null;
    }
    const parsed = parseFeed(r.text);
    if (parsed && parsed.id) return parsed;

    console.log("⚠️ X_RSSHUB_PARSE_FAILED");
    return null;
  } catch (e) {
    console.log("⚠️ X_RSSHUB_FETCH_FAILED:", e?.message || e);
    return null;
  }
}

// 2) Twiiit (backup only)
async function getLatestViaTwiiit(username) {
  const u = cleanUsername(username);
  if (!u) return null;

  const url = `https://twiiit.com/${encodeURIComponent(u)}/rss`;
  try {
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok || !r.text) {
      console.log("⚠️ X_RSS_TWIIIT_BAD_RESPONSE:", r.status);
      return null;
    }

    const parsed = parseFeed(r.text);
    if (parsed && parsed.id) return parsed;

    console.log("⚠️ X_RSS_TWIIIT_PARSE_FAILED");
    return null;
  } catch (e) {
    console.log("⚠️ X_RSS_TWIIIT_FETCH_FAILED:", e?.message || e);
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

  // 2) RSSHub fallback (we must see logs now)
  const rh = await getLatestViaRssHub(u);
  if (rh?.id) return rh;

  // 3) Twiiit fallback (backup)
  const tw = await getLatestViaTwiiit(u);
  if (tw?.id) return tw;

  return null;
}

module.exports = { postToX, getLatestTweetByUsername };
