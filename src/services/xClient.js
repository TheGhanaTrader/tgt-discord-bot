"use strict";

const { TwitterApi } = require("twitter-api-v2");

const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

async function postToX(text) {
  const tweet = text.length > 280 ? text.slice(0, 277) + "…" : text;
  await client.v2.tweet(tweet);
  console.log("✅ X_POST_SUCCESS");
}

module.exports = { postToX };
