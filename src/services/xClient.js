// src/services/xClient.js
"use strict";

const { TwitterApi } = require("twitter-api-v2");

const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

async function postToX(text) {
  const tweet = String(text || "");
  const safe = tweet.length > 280 ? tweet.slice(0, 277) + "…" : tweet;
  await client.v2.tweet(safe);
  console.log("✅ X_POST_SUCCESS");
}

async function getLatestTweetByUsername(username) {
  const u = String(username || "").replace(/^@/, "").trim();
  if (!u) return null;

  const user = await client.v2.userByUsername(u);
  const userId = user?.data?.id;
  if (!userId) return null;

  const timeline = await client.v2.userTimeline(userId, {
    max_results: 5,
    "tweet.fields": ["created_at"],
    exclude: ["replies", "retweets"],
  });

  const t = timeline?.data?.data?.[0];
  if (!t?.id || !t?.text) return null;

  return { id: t.id, text: t.text };
}

module.exports = { postToX, getLatestTweetByUsername };
