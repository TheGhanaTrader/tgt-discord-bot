const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

function buildUpgradeButtons(discordId) {
  const makeUrl = (tier) => {
    const u = new URL(`${PUBLIC_BASE_URL}/pay/subscribe`);
    u.searchParams.set("tier", String(tier).toUpperCase());
    u.searchParams.set("discordUserId", String(discordId));
    return u.toString();
  };

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Silver")
      .setStyle(ButtonStyle.Link)
      .setURL(makeUrl("SILVER")),
    new ButtonBuilder()
      .setLabel("Gold")
      .setStyle(ButtonStyle.Link)
      .setURL(makeUrl("GOLD")),
    new ButtonBuilder()
      .setLabel("Diamond")
      .setStyle(ButtonStyle.Link)
      .setURL(makeUrl("DIAMOND"))
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("upgrade")
    .setDescription("Upgrade to premium (Silver / Gold / Diamond)"),

  async execute(interaction) {
    const { TIERS } = interaction.tgt;

    if (!PUBLIC_BASE_URL) {
      return interaction.reply({
        content: "Missing env: PUBLIC_BASE_URL",
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("👑 The Ghana Trader — Premium Access")
      .setDescription(
        [
          "**A serious trading desk, not a noisy community.**",
          "Execution-focused access built for committed traders, mentors, and investors.",
          "",
          "✅ **What you get (ALL tiers):**",
          "• **All premium channels** (FX, Metals, Indices, Macro, Setups)",
          "• **Live trading discussions** + high-quality market commentary",
          "• **Institutional-style market intelligence** (macro drivers, flows, key levels)",
          "• **Mentorship mindset** + **priority Q&A** (signal-to-noise discipline)",
          "• **Institutional discussions** (risk, execution, frameworks, funding paths)",
          "",
          "—",
          `🥈 **SILVER** — GHS ${TIERS.silver.priceGhs} / ${TIERS.silver.periodLabel}`,
          `🥇 **GOLD** — GHS ${TIERS.gold.priceGhs} / ${TIERS.gold.periodLabel}`,
          `💎 **DIAMOND** — GHS ${TIERS.diamond.priceGhs} / ${TIERS.diamond.periodLabel}`,
          "",
          "✅ **Same full access across all tiers.**",
          "The only difference is **commitment period** (monthly vs quarterly vs yearly).",
          "",
          "⭐ **Recommended:** 🥇 **Gold** (best balance of value + commitment)",
          "✅ After payment, your role updates automatically.",
        ].join("\n")
      )
      .setColor(0x111827)
      .setFooter({ text: "Secure payments via Paystack" });

    const row = buildUpgradeButtons(interaction.user.id);

    return interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true,
    });
  },
};
