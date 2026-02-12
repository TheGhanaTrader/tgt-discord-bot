"use strict";

const { SlashCommandBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "leaderboards.json");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("resetleaderboards")
    .setDescription("ADMIN: Hard reset leaderboard state (safe)."),
  async execute(interaction) {
    // safety: admin only
    if (!interaction.memberPermissions?.has("Administrator")) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    try {
      if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
      return interaction.reply({ content: "✅ Leaderboard state cleared. Redeploy/restart will rebuild clean.", ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `❌ Failed: ${e?.message || e}`, ephemeral: true });
    }
  },
};
