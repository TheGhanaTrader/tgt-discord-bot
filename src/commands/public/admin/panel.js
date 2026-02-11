const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

function buildUpgradePanel(base, userId) {
  const silver = `${base}/pay/initialize?tier=SILVER&uid=${userId}`;
  const gold = `${base}/pay/initialize?tier=GOLD&uid=${userId}`;
  const diamond = `${base}/pay/initialize?tier=DIAMOND&uid=${userId}`;

  const embed = new EmbedBuilder()
    .setTitle("👑 The Ghana Trader — Premium Upgrade")
    .setDescription(
      [
        "Click a tier below to upgrade instantly.",
        "",
        "🥈 **SILVER** — GHS 299 / month",
        "🥇 **GOLD** — GHS 849 / quarter",
        "💎 **DIAMOND** — GHS 3199 / year",
        "",
        "✅ Roles update automatically after payment.",
        "If you need a personal panel, run **/upgrade**.",
      ].join("\n")
    )
    .setFooter({ text: "Secure payments via Paystack" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Silver").setStyle(ButtonStyle.Link).setURL(silver),
    new ButtonBuilder().setLabel("Gold").setStyle(ButtonStyle.Link).setURL(gold),
    new ButtonBuilder().setLabel("Diamond").setStyle(ButtonStyle.Link).setURL(diamond)
  );

  return { embed, row };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Post the upgrade panel (admin)"),

  async execute(interaction) {
    const base = process.env.PUBLIC_BASE_URL;

    // IMPORTANT:
    // This panel is PUBLIC, so we cannot use the clicker’s ID in the URLs.
    // Instead, we link to a neutral panel that instructs users to use /upgrade for a personal link.
    //
    // But you still asked for buttons in the pinned message.
    // Best compromise: buttons open a page that asks for /upgrade OR we keep as-is with your ID is not correct for others.
    //
    // So: we’ll make the pinned panel buttons point to /upgrade instruction page later.
    // For now, we do a clean pinned panel without IDs (no broken role assignment).

    const embed = new EmbedBuilder()
      .setTitle("👑 The Ghana Trader — Premium Upgrade")
      .setDescription(
        [
          "Run **/upgrade** to get your personal buttons (auto role assignment).",
          "",
          "🥈 **SILVER** — GHS 299 / month",
          "🥇 **GOLD** — GHS 849 / quarter",
          "💎 **DIAMOND** — GHS 3199 / year",
          "",
          "✅ Roles update automatically after payment.",
        ].join("\n")
      );

    await interaction.reply({
      content: "✅ Panel posted. Pin it in this channel.",
      ephemeral: true,
    });

    await interaction.channel.send({ embeds: [embed] });
  },
};
