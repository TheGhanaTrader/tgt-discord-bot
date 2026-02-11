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

module.exports = {
  data: new SlashCommandBuilder()
    .setName("refleaderboard")
    .setDescription("Admin: referral joins leaderboard"),

  async execute(interaction) {
    const staff = await interaction.guild.members.fetch(interaction.user.id);
    if (!isStaff(staff)) {
      return interaction.reply({ content: "⛔ Staff only.", ephemeral: true });
    }

    const stats = getStats();
    const rows = Object.entries(stats)
      .map(([id, s]) => ({ id, joins: Number(s.joins || 0) }))
      .sort((a, b) => b.joins - a.joins)
      .slice(0, 10);

    if (!rows.length) {
      return interaction.reply({ content: "No referral data yet.", ephemeral: true });
    }

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.id}> — **${r.joins}** joins`);

    return interaction.reply({
      content: `🏆 **Referral Joins Leaderboard**\n${lines.join("\n")}`,
      ephemeral: true,
    });
  },
};
