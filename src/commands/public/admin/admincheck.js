const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  access: "admin",

  data: new SlashCommandBuilder()
    .setName("admincheck")
    .setDescription("Admin/Mod-only command test"),

  async execute(interaction) {
    await interaction.reply({ content: "✅ Admin access confirmed.", ephemeral: true });
  },
};
