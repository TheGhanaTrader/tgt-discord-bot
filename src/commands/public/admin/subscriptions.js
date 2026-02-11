const { SlashCommandBuilder } = require("discord.js");
const { listAllSubscriptions } = require("../../../services/subscriptions");

const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;

function isStaff(member) {
  if (!member) return false;
  return (
    (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) ||
    (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID))
  );
}

function hoursLeft(expiresAtIso) {
  const now = Date.now();
  const exp = new Date(expiresAtIso).getTime();
  if (Number.isNaN(exp)) return null;
  return (exp - now) / (1000 * 60 * 60);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("subscriptions")
    .setDescription("Admin: overview of active/expiring/expired subscriptions"),

  async execute(interaction) {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (!isStaff(member)) {
      return interaction.reply({ content: "⛔ Staff only.", ephemeral: true });
    }

    const all = listAllSubscriptions();

    const active = all.filter((s) => s?.status === "active" && s?.expires_at);
    const expired = all.filter((s) => s?.status === "expired" || (s?.expires_at && hoursLeft(s.expires_at) <= 0));

    const exp24 = active.filter((s) => {
      const h = hoursLeft(s.expires_at);
      return h !== null && h > 0 && h <= 24;
    });

    const exp72 = active.filter((s) => {
      const h = hoursLeft(s.expires_at);
      return h !== null && h > 0 && h <= 72;
    });

    return interaction.reply({
      content:
        `📊 **Subscriptions Overview**\n` +
        `• Active: **${active.length}**\n` +
        `• Expiring ≤ 24h: **${exp24.length}**\n` +
        `• Expiring ≤ 3 days: **${exp72.length}**\n` +
        `• Expired: **${expired.length}**\n\n` +
        `Tip: use **/sub user:@member** to check someone.`,
      ephemeral: true,
    });
  },
};
