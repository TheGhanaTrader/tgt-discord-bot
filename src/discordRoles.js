// src/discordRoles.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { hasAccepted } = require("./services/contractLedger");

// We store a reference to the live Discord client from src/index.js
let _client = null;

function setDiscordClient(client) {
  _client = client;
}

function getDiscordClient() {
  return _client;
}

function getClient() {
  if (_client) return _client;
  throw new Error("Discord client not set. Call setDiscordClient(client) in src/index.js.");
}

const ROLE_MAP = {
  SILVER: process.env.ROLE_SILVER_ID,
  GOLD: process.env.ROLE_GOLD_ID,
  DIAMOND: process.env.ROLE_DIAMOND_ID,
};

const ROLE_VERIFIED_ID = process.env.ROLE_VERIFIED_ID;

function nowUTC() {
  return new Date().toUTCString();
}

async function logPaymentEvent({ discordUserId, tier, reference }) {
  try {
    const client = getClient();
    const guildId = process.env.GUILD_ID;
    const logChannelId = process.env.BILLING_LOG_CHANNEL_ID; // ✅ set this in .env

    if (!guildId || !logChannelId) return;

    const guild = await client.guilds.fetch(guildId);
    const ch = await guild.channels.fetch(String(logChannelId)).catch(() => null);
    if (!ch || !ch.isTextBased?.()) return;

    const serverName = process.env.SERVER_NAME || "The Ghana Trader";

    const embed = new EmbedBuilder()
      .setTitle("✅ Premium Activated")
      .setDescription(`**Tier:** ${String(tier || "").toUpperCase()}`)
      .addFields(
        { name: "User", value: `<@${discordUserId}> (${discordUserId})`, inline: false },
        { name: "Reference", value: reference ? String(reference) : "—", inline: true },
        { name: "Time (UTC)", value: nowUTC(), inline: true },
        { name: "Server", value: serverName, inline: true }
      )
      .setTimestamp(Date.now());

    await ch.send({ embeds: [embed] }).catch(() => {});
  } catch {
    // never block payments flow on logging
  }
}

async function sendPaymentDM({ discordUserId, tier, reference }) {
  try {
    const client = getClient();
    const user = await client.users.fetch(String(discordUserId)).catch(() => null);
    if (!user) return;

    const accepted = hasAccepted(discordUserId);

    const serverName = process.env.SERVER_NAME || "The Ghana Trader";

    const embed = new EmbedBuilder()
      .setTitle("✅ Payment Confirmed — Premium Activated")
      .setDescription(
        `Welcome to **${serverName} Premium**.\n\n**Tier Activated:** ${String(tier || "").toUpperCase()}`
      )
      .addFields(
        { name: "Reference", value: reference ? String(reference) : "—", inline: true },
        { name: "Time (UTC)", value: nowUTC(), inline: true }
      )
      .setFooter({ text: "If you have any issues accessing channels, message a Moderator." })
      .setTimestamp(Date.now());

      const contractUrl =
  "https://discord.com/channels/1449315468694392844/1449315470133170308";

const row = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setStyle(ButtonStyle.Link) // ✅ MUST be Link to open URL
    .setLabel("Accept Contract")
    .setURL(contractUrl)
);

if (accepted) {
  await user.send({ embeds: [embed] }).catch(() => {});
} else {
  const contractUrl =
    "https://discord.com/channels/1449315468694392844/1449315470133170308";

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Accept Contract")
      .setURL(contractUrl)
  );

  await user.send({ embeds: [embed], components: [row] }).catch(() => {});
}


  } catch {
    // never block payments flow on DM
  }
}

async function revokePremiumRoles(discordUserId) {
  const client = getClient();

  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error("Missing GUILD_ID in .env");

  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(String(discordUserId));

  // Remove only premium roles (Silver/Gold/Diamond)
  const ids = Object.values(ROLE_MAP).filter(Boolean);
  for (const roleId of ids) {
    if (member.roles.cache.has(roleId)) {
     await member.roles.remove(roleId).catch(() => {});
    }
  }

  // Premium expired ⇒ keep/ensure Verified baseline
  if (ROLE_VERIFIED_ID && !member.roles.cache.has(ROLE_VERIFIED_ID)) {
    await member.roles.add(ROLE_VERIFIED_ID).catch(() => {});
  }
}


// ✅ Optional 3rd arg "reference" (webhook can pass it). Backward compatible.
async function grantRole(discordUserId, tier, reference = null) {
  const client = getClient();

  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error("Missing GUILD_ID in .env");

  const t = String(tier || "").toUpperCase();
  const roleId = ROLE_MAP[t];
  if (!roleId) throw new Error(`Missing ROLE id for tier ${t}`);

  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(String(discordUserId));

  // Ensure Verified baseline
  if (ROLE_VERIFIED_ID && !member.roles.cache.has(ROLE_VERIFIED_ID)) {
    await member.roles.add(ROLE_VERIFIED_ID).catch(() => {});
  }

  // Safety: make sure no other premium roles remain (in case webhook didn't call revoke)
  for (const rid of Object.values(ROLE_MAP).filter(Boolean)) {
    if (rid !== roleId && member.roles.cache.has(rid)) {
      await member.roles.remove(rid).catch(() => {});
    }
  }

  await member.roles.add(roleId).catch(() => {});


  // ✅ DM + Log (non-blocking)
  await Promise.allSettled([
    sendPaymentDM({ discordUserId, tier: t, reference }),
    logPaymentEvent({ discordUserId, tier: t, reference }),
  ]);
}

module.exports = {
  setDiscordClient,
  getDiscordClient,
  revokePremiumRoles,
  grantRole,
};
