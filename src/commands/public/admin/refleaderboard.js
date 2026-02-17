const { SlashCommandBuilder } = require("discord.js");
const { getStats } = require("../../../services/referrals");
const { PermissionFlagsBits } = require("discord.js");

const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;

function isStaff(member) {
  if (!member) return false;

  // Allow server admins
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;

  // Allow bot-defined staff roles (Railway Variables)
  const adminRoleId = String(process.env.ROLE_ADMIN_ID || "").trim();
  const modRoleId = String(process.env.ROLE_MOD_ID || "").trim();

  if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
  if (modRoleId && member.roles.cache.has(modRoleId)) return true;

  return false;
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
