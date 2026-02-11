const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  access: "premium",

  data: new SlashCommandBuilder()
    .setName("premiumtest")
    .setDescription("Premium-only command test"),

  async execute(interaction) {
    await interaction.reply({ content: "✅ Premium access confirmed.", ephemeral: true });
  },
};
