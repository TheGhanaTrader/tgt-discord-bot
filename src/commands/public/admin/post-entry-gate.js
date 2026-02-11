const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require("discord.js");

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const VERIFIED_ROLE_ID =
  process.env.ROLE_VERIFIED_ID || process.env.ROLE_VERIFIED || process.env.VERIFIED_ROLE_ID;
const START_HERE_CHANNEL_ID = process.env.START_HERE_CHANNEL_ID;

function buildUpgradeButtons() {
  // ✅ Use customIds so we can generate the correct URL for the CLICKING user
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tgt_gate_buy_silver").setLabel("Silver").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("tgt_gate_buy_gold").setLabel("Gold").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("tgt_gate_buy_diamond").setLabel("Diamond").setStyle(ButtonStyle.Secondary)
  );
}

function buildGateEmbed({ tiers }) {
  return new EmbedBuilder()
    .setTitle("🏛️ The Ghana Trader — Entry Gate")
    .setDescription(
      [
        "**Choose your access path to enter the desk.**",
        "",
        "✅ **Option A — Verify (Free)**",
        "• Read-only + limited community access",
        "• You can upgrade anytime",
        "",
        "👑 **Option B — Premium Access (Instant)**",
        "• Full premium channels + live trading + institutional commentary",
        "• Role updates automatically after payment",
        "",
        "—",
        `🥈 **SILVER** — GHS ${tiers.silver.priceGhs} / ${tiers.silver.periodLabel}`,
        `🥇 **GOLD** — GHS ${tiers.gold.priceGhs} / ${tiers.gold.periodLabel}`,
        `💎 **DIAMOND** — GHS ${tiers.diamond.priceGhs} / ${tiers.diamond.periodLabel}`,
        "",
        "⚠️ **No revenue is posted publicly.**",
      ].join("\n")
    )
    .setColor(0xC9A24D)
    .setFooter({ text: "Verify free or upgrade — then you’re in." });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("post-entry-gate")
    .setDescription("Admin: post/refresh the Welcome entry gate embed.")
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName("channel_id")
        .setDescription("Optional: channel id to post into (overrides START_HERE_CHANNEL_ID).")
        .setRequired(false)
    ),

  async execute(interaction) {
    const isAdmin =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

    if (!isAdmin) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    const TIERS = interaction?.tgt?.TIERS;
    if (!TIERS?.silver || !TIERS?.gold || !TIERS?.diamond) {
      return interaction.reply({
        content: "Server config error: TIERS missing (interaction.tgt.TIERS).",
        ephemeral: true,
      });
    }

    if (!PUBLIC_BASE_URL) {
      return interaction.reply({ content: "Missing env: PUBLIC_BASE_URL", ephemeral: true });
    }

    const channelId = interaction.options.getString("channel_id") || START_HERE_CHANNEL_ID;
    if (!channelId) {
      return interaction.reply({
        content: "Missing env: START_HERE_CHANNEL_ID (or pass channel_id).",
        ephemeral: true,
      });
    }

    if (!VERIFIED_ROLE_ID) {
      return interaction.reply({
        content: "Missing env: ROLE_VERIFIED_ID (Verified role id).",
        ephemeral: true,
      });
    }

    const ch = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) {
      return interaction.reply({ content: "Channel not found or not text-based.", ephemeral: true });
    }

    const embed = buildGateEmbed({ tiers: TIERS });

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tgt_gate_verify_free")
        .setLabel("✅ Verify (Free)")
        .setStyle(ButtonStyle.Success)
    );

    const row2 = buildUpgradeButtons();

    await ch.send({ embeds: [embed], components: [row1, row2] });

    return interaction.reply({ content: "✅ Entry gate posted.", ephemeral: true });
  },
};
