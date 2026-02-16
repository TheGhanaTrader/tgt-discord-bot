// src/commands/myreferrals.js
const { SlashCommandBuilder } = require("discord.js");
const { getAffiliateStats } = require("../services/referrals");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("myreferrals")
    .setDescription("View your referral + affiliate stats (private)."),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        return interaction.reply({ content: "Use this inside the server.", ephemeral: true });
      }

      const userId = interaction.user.id;

      // ✅ Postgres-backed referrals is async now
      const stats = await getAffiliateStats(userId);

      const m = stats.monthly;
      const life = stats.lifetime;

      const fmtGhs = (n) => {
        const v = Number(n || 0);
        if (!Number.isFinite(v)) return "0";
        return v.toLocaleString("en-GH");
      };

      const msg =
        `📌 **Your Referral & Affiliate Stats**\n` +
        `🗓 **Month:** ${stats.monthKey}\n\n` +
        `**This Month**\n` +
        `• Joins: **${m.joins}**\n` +
        `• Paid Conversions: **${m.sales}**\n` +
        `• Revenue (private): **GHS ${fmtGhs(m.revenue)}**\n\n` +
        `**Lifetime**\n` +
        `• Joins: **${life.joins}**\n` +
        `• Paid Conversions: **${life.sales}**\n` +
        `• Revenue (private): **GHS ${fmtGhs(life.revenue)}**\n\n` +
        `🔗 Referrals are tracked via **Discord invite links**.`;

      return interaction.reply({ content: msg, ephemeral: true });
    } catch (e) {
      console.error("myreferrals error:", e);
      return interaction.reply({ content: "❌ Something went wrong.", ephemeral: true }).catch(() => null);
    }
  },
};
