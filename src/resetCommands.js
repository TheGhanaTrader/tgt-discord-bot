require("dotenv").config();
const { REST, Routes } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!CLIENT_ID) throw new Error("Missing CLIENT_ID in .env");
if (!GUILD_ID) throw new Error("Missing GUILD_ID in .env");

async function main() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  console.log("🧹 Clearing GLOBAL commands...");
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log("✅ Global commands cleared.");

  console.log("🧹 Clearing GUILD commands...");
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
  console.log("✅ Guild commands cleared.");

  console.log("✅ Done. Now restart bot to re-register commands.");
}

main().catch((err) => console.error("❌ Reset failed:", err));
