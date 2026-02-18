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

// -------------------- Helpers --------------------
function cleanUsername(username) {
  return String(username || "").replace(/^@/, "").trim();
}

function stripHtml(input) {
  const s = String(input || "");
  // remove tags
  const noTags = s.replace(/<[^>]*>/g, " ");
  // collapse whitespace
  return noTags.replace(/\s+/g, " ").trim();
}

function decodeEntities(input) {
  // minimal decode (enough for tweets)
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function extractFirstTag(xml, tag) {
  // very small RSS parser (good enough for Nitter RSS)
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function extractFirstCdataOrText(xml, tag) {
  const block = extractFirstTag(xml, tag);
  if (!block) return "";
  const c = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  return (c ? c[1] : block).trim();
}

function parseFirstItem(xml) {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) return null;

  const itemXml = itemMatch[1];

  const link = extractFirstCdataOrText(itemXml, "link");
  const guid = extractFirstCdataOrText(itemXml, "guid") || link;

  // Nitter uses <title> + <description> (description often contains HTML)
  const titleRaw = extractFirstCdataOrText(itemXml, "title");
  const descRaw = extractFirstCdataOrText(itemXml, "description");

  const title = decodeEntities(stripHtml(titleRaw));
  const desc = decodeEntities(stripHtml(descRaw));

  // Choose best text: description usually contains full tweet text
  const text = (desc && desc.length >= title.length ? desc : title).trim();

  // Try to extract a numeric tweet id from link/guid
  const idMatch = String(link || guid || "").match(/status\/(\d+)/i);
  const id = idMatch ? idMatch[1] : (guid || link || "").slice(0, 80);

  return {
    id,
    text,
    url: link || null,
  };
}

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: {
        // Avoid basic blocks
        "user-agent":
          "Mozilla/5.0 (compatible; TheGhanaTraderDeskBot/1.0; +https://example.invalid)",
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      },
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

function getNitterInstances() {
  // Optional override: comma-separated
  const env = String(process.env.NITTER_INSTANCES || "").trim();
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("http") ? s : `https://${s}`))
      .map((s) => s.replace(/\/+$/, ""));
  }

  // Small rotating list (instances change; we try a few)
  return [
    "https://nitter.net",
    "https://nitter.cz",
    "https://nitter.privacydev.net",
    "https://nitter.fdn.fr",
  ];
}

async function getLatestViaNitterRss(username) {
  const u = cleanUsername(username);
  if (!u) return null;

  const instances = getNitterInstances();
  for (const base of instances) {
    const url = `${base}/${encodeURIComponent(u)}/rss`;
    try {
      const r = await fetchWithTimeout(url, 9000);
      if (!r.ok || !r.text) {
        // try next instance
        continue;
      }
      const parsed = parseFirstItem(r.text);
      if (parsed && parsed.id) return parsed;
    } catch {
      // try next instance
    }
  }
  return null;
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

  // 1) Try official X API first (may be blocked with 402)
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
    // Minimal signal for upstream (xRssPoster) logs
    // We do NOT throw; we fall back.
    const msg = e?.message || String(e);
    console.log("⚠️ X_API_READ_FAILED (fallback to RSS):", msg);
  }

  // 2) Fallback: Nitter RSS (free)
  const rss = await getLatestViaNitterRss(u);
  if (rss?.id) return rss;

  return null;
}

module.exports = { postToX, getLatestTweetByUsername };
