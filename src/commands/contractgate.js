"use strict";

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("contractgate")
    .setDescription("Post the Contract Gate message (View + Accept)."),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has("Administrator")) {
      return interaction.reply({ content: "Admin only.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle("📜 Contract Gate — Mandatory Acceptance")
      .setDescription(
        [
          "**Rules are visible but NOT mandatory.**",
          "",
          "**Mandatory:** You must accept the contract to unlock access.",
          "",
          "📄 **View Contract** = preview the full agreement inside Discord.",
          "✅ **I Agree & Accept Contract** = generate your signed copy + unlock access.",
          "",
          "**Project:** The Ghana Trader Desk",
          "**Public Brand:** The Ghana Trader",
        ].join("\n")
      )
      .setColor(0xC9A24D);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("contract_view")
        .setLabel("View Contract")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("contract_accept")
        .setLabel("I Agree & Accept Contract")
        .setStyle(ButtonStyle.Success)
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });

    return interaction.reply({ content: "✅ Contract gate posted. Pin it in #contract-gate.", ephemeral: true });
  },
};
