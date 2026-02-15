// src/commands/myref.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

function cleanBase(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("myref")
    .setDescription("Get your personal referral link."),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    console.log("[MYREF] PUBLIC_BASE_URL =", JSON.stringify(process.env.PUBLIC_BASE_URL || ""));

    const base = cleanBase(process.env.PUBLIC_BASE_URL);
    if (!base) {
      return interaction.editReply(
        "PUBLIC_BASE_URL is missing in .env (required for referral links)."
      );
    }

    const link = `${base}/r?ref=${interaction.user.id}`;

    const e = new EmbedBuilder()
      .setTitle("🔗 Your Referral Link")
      .setDescription(
        "Share this link. Join-first. Referral binds after the user authorizes and/or proceeds via the Desk gates. Only the first paid conversion counts."
      )
      .addFields({ name: "Your link", value: link });

    return interaction.editReply({ embeds: [e] });
  },
};
