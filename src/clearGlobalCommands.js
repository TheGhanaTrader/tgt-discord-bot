require("dotenv").config();
const { REST, Routes } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!CLIENT_ID) throw new Error("Missing CLIENT_ID in .env");

async function main() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  console.log("🧹 Clearing GLOBAL slash commands...");
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log("✅ Global commands cleared.");
}

main().catch((err) => {
  console.error("❌ Failed to clear global commands:", err);
});
