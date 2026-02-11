// src/utils/renewalDm.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { renewalLinks } = require("../config/renewalLinks");

function fmtUTC(ms) {
  try {
    const d = new Date(ms);
    return isNaN(d.getTime()) ? "Unknown" : d.toUTCString();
  } catch {
    return "Unknown";
  }
}

function tierLabel(tier) {
  const t = String(tier || "").toLowerCase();
  if (t === "diamond") return "DIAMOND";
  if (t === "gold") return "GOLD";
  return "SILVER";
}

// This builds a prestige renewal DM + Link button.
// It does NOT send anything by itself.
function buildRenewalReminderDM({
  tier,
  expiresAtMs,
  windowLabel, // e.g. "3 DAYS" or "24 HOURS" or "EXPIRED"
  memberName = "Trader",
}) {
  const t = String(tier || "").toLowerCase();
  const label = tierLabel(t);
  const renewUrl = renewalLinks[t];

  const isExpired = String(windowLabel || "").toUpperCase() === "EXPIRED";
  const expiryUtcLine = fmtUTC(expiresAtMs);

  const title = isExpired
    ? `⛔ Access Expired — ${label}`
    : `⏳ Renewal Notice — ${label}`;

  const description = isExpired
    ? [
        `**${memberName}**, your **${label} access** has **expired**.`,
        ``,
        `**Expiry (UTC):** ${expiryUtcLine}`,
        ``,
        `Renew now to restore uninterrupted, premium-grade access inside **The Ghana Trader Desk**.`,
        ``,
        `> If you’ve already renewed, you can safely ignore this message.`,
      ].join("\n")
    : [
        `**${memberName}**, your **${label} access** is approaching expiry.`,
        ``,
        `**Window:** ${windowLabel}`,
        `**Expiry (UTC):** ${expiryUtcLine}`,
        ``,
        `Renew now to keep your seat active inside **The Ghana Trader Desk** — uninterrupted, premium-grade access.`,
        ``,
        `> If you already renewed, you can ignore this message.`,
      ].join("\n");

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "The Ghana Trader Desk • Subscription Protection" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(`Renew ${label}`)
      .setStyle(ButtonStyle.Link)
      .setURL(renewUrl),
    new ButtonBuilder()
      .setLabel("Support / Help")
      .setStyle(ButtonStyle.Link)
      .setURL(
        process.env.RENEW_SUPPORT_URL
          ? process.env.RENEW_SUPPORT_URL.trim()
          : renewUrl
      )
  );

  return { embed, row };
}

module.exports = { buildRenewalReminderDM };
