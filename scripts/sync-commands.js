/**
 * scripts/sync-commands.js
 * - Clears GLOBAL commands (removes duplicates)
 * - Clears GUILD commands
 * - Re-registers GUILD commands from src/commands
 *
 * Run: node scripts/sync-commands.js
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { REST, Routes } = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN) throw new Error("Missing env: DISCORD_TOKEN");
if (!DISCORD_CLIENT_ID) throw new Error("Missing env: DISCORD_CLIENT_ID");
if (!DISCORD_GUILD_ID) throw new Error("Missing env: DISCORD_GUILD_ID");

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(full));
    else if (e.isFile() && e.name.endsWith(".js")) files.push(full);
  }

  return files;
}

function loadCommands() {
  const commandsDir = path.join(process.cwd(), "src", "commands");
  if (!fs.existsSync(commandsDir)) {
    throw new Error(`Cannot find src/commands folder at: ${commandsDir}`);
  }

  const files = walk(commandsDir);
  const commands = [];

  for (const file of files) {
    try {
      // Clear require cache so you always get latest
      delete require.cache[require.resolve(file)];
      const mod = require(file);

      // Expect: module.exports = { data: SlashCommandBuilder, execute: fn }
      if (!mod || !mod.data) continue;

      if (typeof mod.data.toJSON === "function") {
        commands.push(mod.data.toJSON());
      } else if (typeof mod.data === "object") {
        commands.push(mod.data);
      }
    } catch (err) {
      console.error(`❌ Failed to load command file: ${file}`);
      console.error(err);
    }
  }

  // Remove duplicates by name (safety)
  const byName = new Map();
  for (const c of commands) {
    if (c?.name) byName.set(c.name, c);
  }
  return Array.from(byName.values());
}

async function main() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  const cmds = loadCommands();
  console.log(`Found ${cmds.length} command(s) in src/commands`);

  // 1) CLEAR GLOBAL commands
  console.log("🧹 Clearing GLOBAL commands...");
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [] });
  console.log("✅ Global commands cleared.");

  // 2) CLEAR GUILD commands
  console.log("🧹 Clearing GUILD commands...");
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: [] });
  console.log("✅ Guild commands cleared.");

  // 3) REGISTER fresh GUILD commands
  console.log("🚀 Registering GUILD commands...");
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
    body: cmds,
  });
  console.log("✅ Guild commands registered successfully.");

  console.log("\nDONE ✅ Now restart your bot with: npm run dev");
}

main().catch((e) => {
  console.error("❌ sync-commands failed:", e);
  process.exit(1);
});
