// src/commands/public/admin/affleaderboard.js
const { SlashCommandBuilder } = require("discord.js");
const { getStats } = require("../../../services/referrals");

const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;

function isStaff(member) {
  if (!member) return false;
  return (
    (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) ||
    (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID))
  );
}

function monthKeyUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("affleaderboard")
    .setDescription("Admin: affiliate (paid sales) leaderboard (sales only)"),

  async execute(interaction) {
    const staff = await interaction.guild.members.fetch(interaction.user.id);
    if (!isStaff(staff)) {
      return interaction.reply({ content: "⛔ Staff only.", ephemeral: true });
    }

    const monthKey = monthKeyUTC();
    const stats = getStats(monthKey);

    const rows = Object.entries(stats)
      .map(([id, s]) => ({
        id,
        sales: Number(s.sales || 0),
      }))
      .filter((r) => r.sales > 0)
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 10);

    if (!rows.length) {
      return interaction.reply({ content: "No affiliate sales yet.", ephemeral: true });
    }

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.id}> — **${r.sales}** sales`);

    return interaction.reply({
      content: `💎 **Affiliate Sales Leaderboard** (Cycle: ${monthKey})\n${lines.join("\n")}`,
      ephemeral: true,
    });
  },
};
