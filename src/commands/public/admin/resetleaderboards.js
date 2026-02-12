"use strict";

const { SlashCommandBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "leaderboards.json");

async function purgeLeaderboardChannel(client, channelId) {
  if (!channelId) return { ok: false, reason: "missing_channel_id" };

  const ch =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch(() => null));
  if (!ch || !ch.isTextBased()) return { ok: false, reason: "channel_not_found" };

  // Delete bot’s pinned leaderboard messages first
  const pins = await ch.messages.fetchPins().catch(() => []);
  for (const m of pins || []) {
    const isBot = m?.author?.bot;
    const title = m?.embeds?.[0]?.title || "";
    const isLeaderboard =
      title.includes("Referral Leaderboard") || title.includes("Affiliate Sales Leaderboard");

    if (isBot && isLeaderboard) {
      await m.unpin().catch(() => null);
      await m.delete().catch(() => null);
    }
  }

  // Also delete recent bot leaderboard messages (cleanup duplicates)
  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent) {
    for (const m of recent.values()) {
      const isBot = m?.author?.bot;
      const title = m?.embeds?.[0]?.title || "";
      const isLeaderboard =
        title.includes("Referral Leaderboard") || title.includes("Affiliate Sales Leaderboard");

      if (isBot && isLeaderboard) {
        await m.delete().catch(() => null);
      }
    }
  }

  return { ok: true };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("resetleaderboards")
    .setDescription("ADMIN: Hard reset leaderboards (delete messages + clear state)."),
  async execute(interaction) {
    if (!interaction.memberPermissions?.has("Administrator")) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    await interaction.reply({ content: "⏳ Reset running…", ephemeral: true });

    const refId = String(process.env.REF_LEADERBOARD_CHANNEL_ID || "").trim();
    const affId = String(process.env.AFF_LEADERBOARD_CHANNEL_ID || "").trim();

    // 1) Delete messages in both leaderboard channels
    await purgeLeaderboardChannel(interaction.client, refId).catch(() => null);
    await purgeLeaderboardChannel(interaction.client, affId).catch(() => null);

    // 2) Clear saved state
    try {
      if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    } catch {}

    return interaction.editReply({
      content: "✅ Done. Old leaderboard messages deleted + state cleared. Bot will rebuild a single clean pinned dashboard.",
    });
  },
};
