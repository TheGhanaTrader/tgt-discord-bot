"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const HONORS_CHANNEL_ID = process.env.HONORS_CHANNEL_ID;

function isValidYYYYMM(x) {
  return typeof x === "string" && /^\d{4}-\d{2}$/.test(x);
}

function jumpLink(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function extractCycleFromEmbed(embed) {
  const desc = embed?.description || "";
  // Supports: "Cycle: **2026-01**" and "Cycle: 2026-01"
  const m = desc.match(/Cycle:\s*\*\*(\d{4}-\d{2})\*\*/i) || desc.match(/Cycle:\s*(\d{4}-\d{2})/i);
  return m ? m[1] : null;
}

function isHallOfFameEmbed(embed) {
  const t = (embed?.title || "").toLowerCase();
  return t.includes("hall of fame") && t.includes("top 3");
}

function isMonthlyHonorsEmbed(embed) {
  const t = (embed?.title || "").toLowerCase();
  return t.includes("monthly honors") && t.includes("ghana trader");
}

async function fetchHonorsMessages(channel, limit = 200) {
  const msgs = [];
  let lastId = null;

  while (msgs.length < limit) {
    const batch = await channel.messages
      .fetch({ limit: Math.min(100, limit - msgs.length), before: lastId || undefined })
      .catch(() => null);

    if (!batch || batch.size === 0) break;

    const arr = [...batch.values()];
    msgs.push(...arr);
    lastId = arr[arr.length - 1].id;
  }

  return msgs;
}

function indexCyclesFromMessages(messages) {
  // Map cycle -> { hof: {msgId, embed}, honors: {msgId, embed} }
  const map = new Map();

  for (const msg of messages) {
    if (!msg.embeds || msg.embeds.length === 0) continue;

    for (const e of msg.embeds) {
      const cycle = extractCycleFromEmbed(e);
      if (!cycle) continue;

      if (!map.has(cycle)) map.set(cycle, { hof: null, honors: null });

      const entry = map.get(cycle);

      if (isHallOfFameEmbed(e) && !entry.hof) {
        entry.hof = { msgId: msg.id, embed: e };
      }

      if (isMonthlyHonorsEmbed(e) && !entry.honors) {
        entry.honors = { msgId: msg.id, embed: e };
      }
    }
  }

  // Return cycles sorted newest -> oldest
  const cycles = [...map.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return { cycles, map };
}

function buildCycleSummaryEmbed({ cycle, entry, guildId, channelId }) {
  const out = new EmbedBuilder()
    .setTitle(`🏛️ TGT Honors — ${cycle}`)
    .setDescription(
      `Canonical record: <#${channelId}>\n` +
        `Revenue is never shown publicly.\n\n` +
        `Use the links below to jump to the official posts for this cycle.`
    )
    .setColor(0xC9A24D)
    .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." });

  const hofLink = entry?.hof?.msgId ? jumpLink(guildId, channelId, entry.hof.msgId) : null;
  const honorsLink = entry?.honors?.msgId ? jumpLink(guildId, channelId, entry.honors.msgId) : null;

  out.addFields(
    {
      name: "Hall of Fame (Top 3)",
      value: hofLink ? `[Open post](${hofLink})` : "Not found in recent history.",
      inline: true,
    },
    {
      name: "Monthly Honors (Winners)",
      value: honorsLink ? `[Open post](${honorsLink})` : "Not found in recent history.",
      inline: true,
    }
  );

  return out;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("honors")
    .setDescription("View historical TGT honors (canonical from tgt-honors).")
    .addSubcommand((sub) =>
      sub.setName("latest").setDescription("Show the latest honors cycle.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("month")
        .setDescription('Show honors for a specific month (YYYY-MM).')
        .addStringOption((opt) =>
          opt.setName("cycle").setDescription("Example: 2026-01").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List recent honors cycles (last 6 found in history).")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (!HONORS_CHANNEL_ID) {
      return interaction.reply({
        content: "❌ HONORS_CHANNEL_ID is missing in .env",
        ephemeral: true,
      });
    }

    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: "❌ This command must be used inside the server.", ephemeral: true });
    }

    const honorsChannel = await interaction.client.channels.fetch(HONORS_CHANNEL_ID).catch(() => null);
    if (!honorsChannel || !honorsChannel.isTextBased()) {
      return interaction.reply({
        content: "❌ Honors channel not found or not text-based. Check HONORS_CHANNEL_ID.",
        ephemeral: true,
      });
    }

    await interaction.reply({ content: "🔎 Scanning honors archive…", ephemeral: true });

    const msgs = await fetchHonorsMessages(honorsChannel, 200);
    const { cycles, map } = indexCyclesFromMessages(msgs);

    if (cycles.length === 0) {
      return interaction.editReply({
        content: "No honors cycles found in the last 200 messages of tgt-honors.",
      });
    }

    if (sub === "list") {
      const recent = cycles.slice(0, 6);
      const lines = recent.map((c) => `• **${c}**`).join("\n");

      const embed = new EmbedBuilder()
        .setTitle("🏛️ TGT Honors — Recent Cycles")
        .setDescription(lines)
        .setColor(0xC9A24D)
        .setFooter({ text: "Use /honors month to open a cycle." });

      return interaction.editReply({ content: "", embeds: [embed] });
    }

    if (sub === "latest") {
      const cycle = cycles[0];
      const entry = map.get(cycle);

      const embed = buildCycleSummaryEmbed({
        cycle,
        entry,
        guildId: interaction.guildId,
        channelId: HONORS_CHANNEL_ID,
      });

      return interaction.editReply({ content: "", embeds: [embed] });
    }

    if (sub === "month") {
      const cycle = interaction.options.getString("cycle")?.trim();

      if (!isValidYYYYMM(cycle)) {
        return interaction.editReply({ content: "❌ Invalid format. Use YYYY-MM (example: 2026-01)." });
      }

      const entry = map.get(cycle);
      if (!entry) {
        return interaction.editReply({
          content: `Not found in the last 200 messages for cycle **${cycle}**.\nTip: If the archive is older, we can increase scan depth safely.`,
        });
      }

      const embed = buildCycleSummaryEmbed({
        cycle,
        entry,
        guildId: interaction.guildId,
        channelId: HONORS_CHANNEL_ID,
      });

      return interaction.editReply({ content: "", embeds: [embed] });
    }
  },
};
