// src/config/renewalLinks.js
// Central place for renewal URLs (keeps expiry monitor clean + stable)

function mustGetEnv(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v.trim();
}

// These should be direct links to your checkout/upgrade page (recommended)
// Use ButtonStyle.Link so the button never needs an interaction handler.
const renewalLinks = {
  silver: mustGetEnv("RENEW_SILVER_URL"),
  gold: mustGetEnv("RENEW_GOLD_URL"),
  diamond: mustGetEnv("RENEW_DIAMOND_URL"),
};

module.exports = { renewalLinks };
