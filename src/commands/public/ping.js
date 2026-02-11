const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  access: "public",
  data: new SlashCommandBuilder().setName("ping").setDescription("Replies with Pong!"),
  async execute(interaction) {
    await interaction.reply("🏓 Pong! Bot is online.");
  },
};
