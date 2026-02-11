"use strict";

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { pinBotMessage } = require("../utils/pinManager");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function buildUpgradeEmbed() {
  return new EmbedBuilder()
    .setTitle("👑 THE GHANA TRADER — PREMIUM ACCESS")
    .setDescription(
      [
        "Upgrade to unlock premium market intelligence, live trade discussions,",
        "and institutional-level insights.",
        "",
        "Choose your tier below 👇",
        "",
        "🥈 **SILVER — GHS 299 / month**",
        "• Premium channels access",
        "• Market insights & discussions",
        "• Community trading room",
        "",
        "🥇 **GOLD — GHS 849 / quarter**",
        "• Everything in Silver",
        "• Higher-level analysis & discussions",
        "• Priority access to insights",
        "",
        "💎 **DIAMOND — GHS 3199 / year**",
        "• Full institutional access",
        "• Top-tier discussions & strategy rooms",
        "• Direct exposure to premium content",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━",
        "✅ Payment is handled securely via Paystack",
        "✅ Your role updates automatically after payment",
      ].join("\n")
    )
    .setColor(0xC9A24D)
    .setFooter({ text: "The Ghana Trader Desk • Institutional Access" });
}

function buildButtons() {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("Missing env: PUBLIC_BASE_URL");

  const makeUrl = (tier) => {
    const u = new URL(`${base}/auth/discord/start`);
    u.searchParams.set("tier", String(tier).toUpperCase());
    return u.toString();
  };

  const rowPremium = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Silver").setStyle(ButtonStyle.Link).setURL(makeUrl("SILVER")),
    new ButtonBuilder().setLabel("Gold").setStyle(ButtonStyle.Link).setURL(makeUrl("GOLD")),
    new ButtonBuilder().setLabel("Diamond").setStyle(ButtonStyle.Link).setURL(makeUrl("DIAMOND"))
  );

  return [rowPremium];
}

function isUpgradeGateMessage(msg) {
  const emb = msg?.embeds?.[0];
  const title = emb?.title || "";
  const footer = emb?.footer?.text || "";
  return (
    title.includes("PREMIUM ACCESS") ||
    footer.includes("Institutional Access") ||
    footer.includes("The Ghana Trader Desk")
  );
}

async function upsertUpgradeGateMessage(client) {
  const channelId = mustEnv("UPGRADE_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);

  // Guard: ensure we can send messages here
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Upgrade channel is not a text channel or cannot send messages.");
  }

  const embed = buildUpgradeEmbed();
  const rows = buildButtons();

  // ✅ 1) Reuse existing pinned UpgradeGate message (prevents pin spam)
  try {
    const pinned = await channel.messages.fetchPinned();
    const existing = pinned.find(
      (m) => m?.author?.id === client.user.id && isUpgradeGateMessage(m)
    );

    if (existing) {
      await existing.edit({ embeds: [embed], components: rows });
      return existing;
    }
  } catch (_) {
    // If fetching pins fails (perms), we will fall back to send + pin once.
  }

  // ✅ 2) No pinned gate found → send new and pin once
  const sent = await channel.send({ embeds: [embed], components: rows });
  await pinBotMessage(channel, sent);
  return sent;
}

module.exports = { upsertUpgradeGateMessage };
