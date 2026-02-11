const { SlashCommandBuilder } = require("discord.js");
const {
  updateReferralLeaderboard,
  updateAffiliateLeaderboard,
} = require("../../../services/leaderboards");

function isStaff(member) {
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const modRoleId = process.env.MOD_ROLE_ID;

  // If roles exist, use them
  if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
  if (modRoleId && member.roles.cache.has(modRoleId)) return true;

  // Fallback: Discord admin permission
  return member.permissions?.has?.("Administrator");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("refresh-leaderboards")
    .setDescription("Admin only: refresh referral + affiliate leaderboards now."),

  async execute(interaction) {
    try {
      // must be in a server
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "This command can only be used inside the server.",
          ephemeral: true,
        });
      }

      const member = interaction.member;
      if (!member || !isStaff(member)) {
        return interaction.reply({
          content: "🚫 Admin/Moderator only.",
          ephemeral: true,
        });
      }

      await interaction.reply({
        content: "🔄 Refreshing leaderboards…",
        ephemeral: true,
      });

      await updateReferralLeaderboard(interaction.client);
      await updateAffiliateLeaderboard(interaction.client);

      return interaction.editReply("✅ Leaderboards refreshed.");
    } catch (e) {
      console.error("refresh-leaderboards error:", e);
      try {
        if (interaction.deferred) return interaction.editReply("❌ Failed to refresh.");
        if (!interaction.replied)
          return interaction.reply({ content: "❌ Failed to refresh.", ephemeral: true });
      } catch {}
    }
  },
};
