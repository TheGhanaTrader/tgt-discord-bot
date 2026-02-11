const { SlashCommandBuilder } = require("discord.js");
const { getSubscription } = require("../../../services/subscriptions");

const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;

function isStaff(member) {
  if (!member) return false;
  return (
    (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) ||
    (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID))
  );
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toUTCString().replace("GMT", "UTC");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sub")
    .setDescription("Admin: check a member's tier + expiry")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Select a user").setRequired(true)
    ),

  async execute(interaction) {
    const staff = await interaction.guild.members.fetch(interaction.user.id);

    if (!isStaff(staff)) {
      return interaction.reply({ content: "⛔ Staff only.", ephemeral: true });
    }

    const target = interaction.options.getUser("user", true);
    const sub = getSubscription(target.id);

    if (!sub) {
      return interaction.reply({
        content: `No subscription record for <@${target.id}>.`,
        ephemeral: true,
      });
    }

    return interaction.reply({
      content:
        `👤 **Subscription Check**\n` +
        `• User: <@${target.id}>\n` +
        `• Tier: **${String(sub.tier || "—")}**\n` +
        `• Status: **${String(sub.status || "—")}**\n` +
        `• Expires: **${formatDate(sub.expires_at)}**`,
      ephemeral: true,
    });
  },
};
