"use strict";

require("dotenv").config();
console.log("[BOOT] src/index.js loaded", { ts: new Date().toISOString() });

process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

const { setDiscordClient } = require("./discordRoles");
const { startPaystackWebhookServer } = require("./server/paystackWebhook");
const { startSubscriptionMonitor } = require("./jobs/subscriptionMonitor");
const referrals = require("./services/referrals");
const {
  ensureGiveawayDashboard,
  handleGiveawayDashboardInteractions,
} = require("./services/giveawayDashboard");
const { ensureFundedDashboard, handleFundedInteractions } = require("./services/fundedProofs");
const { ensurePayoutDashboard, handlePayoutInteractions } = require("./services/payoutProofs");
const { ensureContractGateMessage } = require("./services/contractGatePoster");

const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ✅ Scheduler hardening (keep)
const { startMonthlyScheduler } = require("./scheduler/monthlyHonorsScheduler");

// ✅ Contract handlers
const { handleContractAccept } = require("./handlers/contractAccept");
const { handleContractView } = require("./handlers/contractView");

// ===== ENV CHECKS =====
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID in .env");
if (!GUILD_ID) throw new Error("Missing DISCORD_GUILD_ID in .env");

// ===== CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client._inviteCache = new Map(); // guildId -> Map(code -> uses)
client.commands = new Collection();

// ===== TGT RUNTIME CONTEXT (RESTORE) =====
let _cachedTiers = null;

function loadTiersFromPlans() {
  try {
    const plansPath = path.join(__dirname, "config", "plans.js");
    if (!fs.existsSync(plansPath)) throw new Error("plans.js not found");

    delete require.cache[require.resolve(plansPath)];
    const plans = require(plansPath);

    const toGhs = (pesewas) => {
      const n = Number(pesewas);
      if (Number.isNaN(n)) return "—";
      return (n / 100).toFixed(2);
    };

    if (plans?.silver && plans?.gold && plans?.diamond) {
      return {
        silver: { priceGhs: toGhs(plans.silver.amountPesewas), periodLabel: "monthly" },
        gold: { priceGhs: toGhs(plans.gold.amountPesewas), periodLabel: "quarterly" },
        diamond: { priceGhs: toGhs(plans.diamond.amountPesewas), periodLabel: "yearly" },
      };
    }
  } catch (e) {
    console.error("⚠️ Could not load TIERS from config/plans.js:", e?.message || e);
  }

  return {
    silver: { priceGhs: "—", periodLabel: "monthly" },
    gold: { priceGhs: "—", periodLabel: "quarterly" },
    diamond: { priceGhs: "—", periodLabel: "yearly" },
  };
}

function getTiers() {
  if (_cachedTiers) return _cachedTiers;
  _cachedTiers = loadTiersFromPlans();
  return _cachedTiers;
}

function attachTgtContext(interaction) {
  if (!interaction.tgt) interaction.tgt = {};
  if (!interaction.tgt.TIERS) interaction.tgt.TIERS = getTiers();
}

// ===== COMMAND LOADER (RECURSIVE) =====
function walkJsFiles(dirPath) {
  const out = [];
  if (!fs.existsSync(dirPath)) return out;

  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const it of items) {
    const full = path.join(dirPath, it.name);
    if (it.isDirectory()) out.push(...walkJsFiles(full));
    else if (it.isFile() && it.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function loadCommands() {
  const commandsPath = path.join(__dirname, "commands");
  const commandFilePaths = walkJsFiles(commandsPath);

  const commandsJSON = [];

  for (const filePath of commandFilePaths) {
    delete require.cache[require.resolve(filePath)];
    const command = require(filePath);

    if (!command?.data?.name || typeof command.execute !== "function") continue;

    client.commands.set(command.data.name, command);
    commandsJSON.push(command.data.toJSON());
  }

  return commandsJSON;
}

async function registerCommands(commandsJSON) {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commandsJSON,
  });

  console.log(`✅ Registered ${commandsJSON.length} slash commands.`);
}

// ===== READY =====
client.once(Events.ClientReady, async (c) => {
  try {
  for (const [guildId, guild] of client.guilds.cache) {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) continue;

    const m = new Map();
    invites.forEach((inv) => m.set(inv.code, inv.uses ?? 0));
    client._inviteCache.set(guildId, m);
  }
  console.log("✅ Invite cache primed.");
} catch (e) {
  console.log("INVITE_CACHE_PRIME_ERR:", e?.message || e);
}

  setDiscordClient(client);
  await ensureFundedDashboard(client).catch((e) => console.error("FUNDED_DASHBOARD_BOOT_ERR", e));
  await ensurePayoutDashboard(client).catch((e) => console.error("PAYOUT_DASHBOARD_BOOT_ERR", e));
  await ensureGiveawayDashboard(client);
  await ensureContractGateMessage(client).catch((e) =>
  console.error("CONTRACT_GATE_BOOT_ERR", e)
);

  console.log(`✅ Logged in as ${c.user.tag}`);

  // ✅ Start hardened scheduler (keep)
  startMonthlyScheduler(client);
  console.log("🛡️ Monthly scheduler hardening: ACTIVE");

  const { startYouTubeRssPoster } = require("./jobs/youtubeRssPoster");
startYouTubeRssPoster(client);

const { startXRssPoster } = require("./jobs/xRssPoster");
startXRssPoster(client);

const { startPodcastRssPoster } = require("./jobs/podcastRssPoster");
startPodcastRssPoster(client);

  const { upsertWelcomeGateMessage } = require("./gates/welcomeGate");
await upsertWelcomeGateMessage(client);
console.log("✅ Welcome Gate posted/updated.");

const { upsertUpgradeGateMessage } = require("./gates/upgradeGate");
await upsertUpgradeGateMessage(client);
console.log("✅ Upgrade Gate posted/updated.");

const { upsertRulesMessage } = require("./gates/rulesGate");
const { upsertOperateMessage } = require("./gates/operateGate");

if (process.env.RULES_CHANNEL_ID) await upsertRulesMessage(client);
if (process.env.OPERATE_CHANNEL_ID) await upsertOperateMessage(client);
console.log("✅ Pins managed: welcome/upgrade/rules/operate");

// ✅ Leaderboard dashboards (auto-post + auto-pin + auto-refresh)
const { startLeaderboardDashboards } = require("./services/leaderboards");
startLeaderboardDashboards(client, { everyMs: 60_000 }); // 60s refresh

// 🔁 Start subscription expiry + reminder monitor
startSubscriptionMonitor(client, {
  TIERS: getTiers(),
  LOG_CHANNEL_ID: process.env.BILLING_LOG_CHANNEL_ID || process.env.LOG_CHANNEL_ID,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
});
});

client.on("guildMemberAdd", async (member) => {
  try {
    const guild = member.guild;

    // ✅ Keep invite cache updated (for accuracy), but DO NOT map referrals from invite creator.
    // Referral ownership must come from /r?ref=... → OAuth bind (paystackWebhook.js),
    // otherwise DISCORD_INVITE_URL (admin-created) will steal all credit.
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return;

    const after = new Map();
    invites.forEach((inv) => after.set(inv.code, inv.uses ?? 0));
    client._inviteCache.set(guild.id, after);

    console.log("✅ Invite cache updated for join:", member.id);
  } catch (e) {
    console.log("GUILD_MEMBER_ADD_ERR:", e?.message || e);
  }
});

// ===== INTERACTIONS =====
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // 🔹 GIVEAWAY / FUNDED / PAYOUT handlers (single pass)
    if (await handleGiveawayDashboardInteractions(client, interaction)) return;
    if (await handleFundedInteractions(client, interaction)) return;
    if (await handlePayoutInteractions(client, interaction)) return;

    // Inject TGT context for BOTH buttons and slash commands
    attachTgtContext(interaction);

    // =========================
    // ✅ BUTTONS
    // =========================
    if (interaction.isButton()) {
      const id = interaction.customId;

      // ---- Contract Gate buttons ----
      if (id === "contract_view") return handleContractView(interaction);
      if (id === "contract_accept") return handleContractAccept(interaction);

      // ---- Verify Free ----
      if (id === "tgt_gate_verify_free") {
        const VERIFIED_ROLE_ID =
          process.env.ROLE_VERIFIED_ID ||
          process.env.ROLE_VERIFIED ||
          process.env.VERIFIED_ROLE_ID;

        if (!VERIFIED_ROLE_ID) {
          return interaction.reply({
            content: "Server misconfigured: Verified role missing (ROLE_VERIFIED_ID).",
            ephemeral: true,
          });
        }

        const guild = interaction.guild;
        if (!guild) {
          return interaction.reply({ content: "Use this inside the server.", ephemeral: true });
        }

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) {
          return interaction.reply({ content: "Could not fetch member.", ephemeral: true });
        }

        const hasVerified = member.roles.cache.has(VERIFIED_ROLE_ID);
        if (!hasVerified) await member.roles.add(VERIFIED_ROLE_ID).catch(() => null);

        // Prestige DM (ONLY first-time verify)
        if (!hasVerified) {
          try {
            const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
            const TIERS = interaction?.tgt?.TIERS || getTiers();

            const safePrice = (v) => (v === undefined || v === null || v === "" ? "—" : String(v));
            const safePeriod = (v) => (v === undefined || v === null || v === "" ? "" : String(v));

            const dmEmbed = new EmbedBuilder()
              .setTitle("🏛️ Welcome to The Ghana Trader Desk")
              .setDescription(
                [
                  "✅ **Verification complete.** Your free access is now active.",
                  "",
                  "If you ever want **full desk access**, you can upgrade anytime:",
                  `🥈 **Silver** — GHS ${safePrice(TIERS.silver?.priceGhs)} / ${safePeriod(TIERS.silver?.periodLabel)}`,
                  `🥇 **Gold** — GHS ${safePrice(TIERS.gold?.priceGhs)} / ${safePeriod(TIERS.gold?.periodLabel)}`,
                  `💎 **Diamond** — GHS ${safePrice(TIERS.diamond?.priceGhs)} / ${safePeriod(TIERS.diamond?.periodLabel)}`,
                ].join("\n")
              )
              .setColor(0xC9A24D)
              .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." });

            if (PUBLIC_BASE_URL) {
              const makeUrl = (tier) => {
                const u = new URL(`${PUBLIC_BASE_URL}/auth/discord/start`);
                u.searchParams.set("tier", String(tier).toUpperCase());
                return u.toString();
              };

              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel("Silver").setStyle(ButtonStyle.Link).setURL(makeUrl("SILVER")),
                new ButtonBuilder().setLabel("Gold").setStyle(ButtonStyle.Link).setURL(makeUrl("GOLD")),
                new ButtonBuilder().setLabel("Diamond").setStyle(ButtonStyle.Link).setURL(makeUrl("DIAMOND"))
              );

              await interaction.user.send({ embeds: [dmEmbed], components: [row] }).catch(() => null);
            } else {
              await interaction.user.send({ embeds: [dmEmbed] }).catch(() => null);
            }
          } catch (_) {}
        }

        const contractUrl =
          "https://discord.com/channels/1449315468694392844/1449315470133170308";

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Open Contract Gate")
            .setURL(contractUrl)
        );

        return interaction.reply({
          content: hasVerified
            ? "✅ You’re already verified. Open Contract Gate to accept the contract."
            : "✅ Verified — free access granted. Open Contract Gate to accept the contract.",
          components: [row],
          ephemeral: true,
        });
      }

      // ---- Premium buttons on the gate ----
      const map = {
        tgt_gate_buy_silver: "SILVER",
        tgt_gate_buy_gold: "GOLD",
        tgt_gate_buy_diamond: "DIAMOND",
      };

      if (map[id]) {
        const tier = map[id];
        const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
        if (!base) return interaction.reply({ content: "Missing env: PUBLIC_BASE_URL", ephemeral: true });

        const url = new URL(`${base}/auth/discord/start`);
        url.searchParams.set("tier", tier);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(`Proceed to Paystack (${tier})`)
            .setURL(url.toString())
        );

        return interaction.reply({
          content: "✅ Click below to complete payment securely on Paystack:",
          components: [row],
          ephemeral: true,
        });
      }

      return; // stop here for buttons
    }

    // =========================
    // ✅ SLASH COMMANDS
    // =========================
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return interaction.reply({ content: "Unknown command.", ephemeral: true });

    await command.execute(interaction);
  } catch (e) {
    console.error("[INTERACTIONS] crash:", e?.message || e);
  }
});

// ===== BOOT =====
(async () => {
  // ✅ Start Paystack webhook server immediately for Railway health checks
  startPaystackWebhookServer();

  const commandsJSON = loadCommands();
  await registerCommands(commandsJSON);
  await client.login(TOKEN);
})();
