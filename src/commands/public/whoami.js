const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { getSubscription } = require("../../services/subscriptions");

function formatDate(v) {
  if (!v) return "—";
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n) : new Date(String(v));
  return isNaN(d.getTime()) ? "—" : d.toUTCString().replace("GMT", "UTC");
}

// Detect tier by checking the member's roles against TIERS[*].roleId
function getTierKeyFromMember(member, TIERS) {
  const envMap = {
  diamond: process.env.ROLE_DIAMOND_ID,
  gold: process.env.ROLE_GOLD_ID,
  silver: process.env.ROLE_SILVER_ID,
};

for (const k of Object.keys(envMap)) {
  const rid = String(envMap[k] || "").trim();
  if (rid && member.roles.cache.has(rid)) return k;
}

  if (!member || !member.roles || !member.roles.cache || !TIERS) return null;

  for (const key of Object.keys(TIERS)) {
    const t = TIERS[key] || {};
    const roleId = t.roleId || t.role_id || t.role || t.roleID;
    if (roleId && member.roles.cache.has(roleId)) return key;
  }
  return null;
}

function getRenewUrl(tierKey) {
  if (tierKey === "silver") return process.env.RENEW_SILVER_URL;
  if (tierKey === "gold") return process.env.RENEW_GOLD_URL;
  if (tierKey === "diamond") return process.env.RENEW_DIAMOND_URL;
  return null;
}

function tierButtonsRow(interaction) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Renew Silver")
      .setStyle(ButtonStyle.Link)
      .setURL(buildUpgradeUrl(interaction, "silver")),
    new ButtonBuilder()
      .setLabel("Renew Gold")
      .setStyle(ButtonStyle.Link)
      .setURL(buildUpgradeUrl(interaction, "gold")),
    new ButtonBuilder()
      .setLabel("Renew Diamond")
      .setStyle(ButtonStyle.Link)
      .setURL(buildUpgradeUrl(interaction, "diamond"))
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("whoami")
    .setDescription("Shows your membership tier and expiry"),

  async execute(interaction) {
    const { TIERS } = interaction.tgt || {};
    const member = await interaction.guild.members.fetch(interaction.user.id);

    const tierKey = getTierKeyFromMember(member, TIERS);
    const sub = await getSubscription(interaction.user.id);

    // Case 1: No role + no subscription record
    if (!tierKey && !sub) {
      return interaction.reply({
        content: "You don’t have an active membership. Use **/upgrade** to join.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Case 2: Subscription exists but role missing (expired / edge case)
    if (!tierKey && sub) {
      const expiredText = sub.expires_at
        ? `⛔ **Expired:** ${formatDate(sub.expires_at)}`
        : "⛔ Membership inactive";

      return interaction.reply({
        content:
          `⚠️ Membership record found but no active role.\n` +
          `${expiredText}\n\n` +
          `Renew instantly using the buttons below:`,
          components: [
            new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("Renew Silver").setStyle(ButtonStyle.Link).setURL(process.env.RENEW_SILVER_URL),
            new ButtonBuilder().setLabel("Renew Gold").setStyle(ButtonStyle.Link).setURL(process.env.RENEW_GOLD_URL),
            new ButtonBuilder().setLabel("Renew Diamond").setStyle(ButtonStyle.Link).setURL(process.env.RENEW_DIAMOND_URL),
          )
        ],

        flags: MessageFlags.Ephemeral,
      });
    }

    // Case 3: Active role
    const expiryText = sub?.expires_at
      ? formatDate(sub.expires_at)
      : "Unknown (expiry not recorded yet)";

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(`Renew ${TIERS?.[tierKey]?.name || String(tierKey).toUpperCase()}`)
        .setStyle(ButtonStyle.Link)
        .setURL(getRenewUrl(tierKey))
    );

    return interaction.reply({
      content:
        `👤 **Membership Status**\n` +
        `• Tier: **${String(tierKey).toUpperCase()}**\n` +
        `• Expires: **${expiryText}**`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  },
};
