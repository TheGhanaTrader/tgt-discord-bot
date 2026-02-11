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

function buildWelcomeEmbed() {
  return new EmbedBuilder()
    .setTitle("🏛️ Welcome to The Ghana Trader Desk")
    .setDescription(
      [
        "Choose your access path to enter the Desk.",
        "",
        "**Option A — Verify (Free)**",
        "• Read-only + limited community access",
        "• You can upgrade anytime",
        "",
        "**Option B — Premium Access (Instant)**",
        "• Full premium channels + live trading + institutional commentary",
        "• Role updates automatically after payment",
        "",
        "—",
        "**SILVER — GHS 299.00 / monthly**",
        "**GOLD — GHS 849.00 / quarterly**",
        "**DIAMOND — GHS 3199.00 / yearly**",
        "",
        "Click below to access your choice.",
      ].join("\n")
    )
    .setColor(0xC9A24D)
    .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." });
}

function buildButtons() {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("Missing env: PUBLIC_BASE_URL");

  const makeUrl = (tier) => {
    const u = new URL(`${base}/auth/discord/start`);
    u.searchParams.set("tier", tier);
    // discordUserId is added at click time in your existing flow for gate buttons,
    // but Link buttons cannot be personalized. That’s OK because your Paystack
    // OAuth reuse flow handles returning users. If you need personalization, keep
    // your existing premium button handlers instead of link buttons.
    return u.toString();
  };

  // Row 1: Premium split (Link buttons — same look as your screenshot)
  const rowPremium = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Silver").setStyle(ButtonStyle.Link).setURL(makeUrl("SILVER")),
    new ButtonBuilder().setLabel("Gold").setStyle(ButtonStyle.Link).setURL(makeUrl("GOLD")),
    new ButtonBuilder().setLabel("Diamond").setStyle(ButtonStyle.Link).setURL(makeUrl("DIAMOND"))
  );

  // Row 2: Verify (Green — same look as your screenshot)
  const rowVerify = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("tgt_gate_verify_free")
      .setLabel("Verify (Free)")
      .setStyle(ButtonStyle.Success)
  );

  return [rowPremium, rowVerify];
}

// Posts or updates ONE pinned “gate” message
async function upsertWelcomeGateMessage(client) {
  const channelId = mustEnv("WELCOME_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);

  const embed = buildWelcomeEmbed();
  const rows = buildButtons();

  // Find last bot message in channel
  const msgs = await channel.messages.fetch({ limit: 20 });
  const lastBotMsg = msgs.find(
  (m) => m.author?.id === client.user.id && m.type === 0 // type 0 = DEFAULT message (editable)
);

  if (lastBotMsg) {
    await lastBotMsg.edit({ embeds: [embed], components: rows });
    await pinBotMessage(channel, lastBotMsg);
    return lastBotMsg;
  }

  const sent = await channel.send({ embeds: [embed], components: rows });
  await pinBotMessage(channel, sent);
  return sent;
}

module.exports = { upsertWelcomeGateMessage };
