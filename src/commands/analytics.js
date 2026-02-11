"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");

const HONORS_CHANNEL_ID = process.env.HONORS_CHANNEL_ID;

function isAdminOrMod(interaction) {
  // Tight gate: only users with Administrator can access by default.
  // If you have a Moderator role ID, we can add it later without changing the dashboard logic.
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function extractCycleFromEmbed(embed) {
  const desc = embed?.description || "";
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

function pullMentions(text) {
  // Collect unique <@123> user IDs
  const ids = new Set();
  const re = /<@(\d+)>/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

async function fetchMessages(channel, limit = 300) {
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

function indexCycles(messages) {
  // cycle -> { hofEmbed?, honorsEmbed? }
  const map = new Map();

  for (const msg of messages) {
    if (!msg.embeds || msg.embeds.length === 0) continue;

    for (const e of msg.embeds) {
      const cycle = extractCycleFromEmbed(e);
      if (!cycle) continue;

      if (!map.has(cycle)) map.set(cycle, { hof: null, honors: null });

      const entry = map.get(cycle);

      if (isHallOfFameEmbed(e) && !entry.hof) entry.hof = e;
      if (isMonthlyHonorsEmbed(e) && !entry.honors) entry.honors = e;
    }
  }

  const cycles = [...map.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return { cycles, map };
}

function computeCycleMetrics({ cycle, entry }) {
  const hofDesc = entry?.hof?.description || "";
  const honorsDesc = entry?.honors?.description || "";

  const hofMentions = pullMentions(hofDesc); // Top3 Sales + Top3 Referrals
  const honorsMentions = pullMentions(honorsDesc); // Winners mentions (if any)

  const hasPublicWinners = honorsMentions.length > 0;

  // We never calculate or expose revenue. Only counts.
  return {
    cycle,
    hallOfFameMentions: hofMentions.length,
    publicWinnersCount: honorsMentions.length,
    hasPublicWinners,
  };
}

function buildAnalyticsEmbed({ metrics, windowLabel }) {
  const totalCycles = metrics.length;
  const withWinners = metrics.filter((m) => m.hasPublicWinners).length;
  const noWinners = totalCycles - withWinners;

  const avgHof = totalCycles
    ? (metrics.reduce((s, m) => s + m.hallOfFameMentions, 0) / totalCycles).toFixed(2)
    : "0.00";

  const avgWinners = totalCycles
    ? (metrics.reduce((s, m) => s + m.publicWinnersCount, 0) / totalCycles).toFixed(2)
    : "0.00";

  const latest = metrics[0]?.cycle || "n/a";
  const oldest = metrics[metrics.length - 1]?.cycle || "n/a";

  const lines = metrics
    .slice(0, 8)
    .map((m) => {
      const flag = m.hasPublicWinners ? "✅" : "—";
      return `• **${m.cycle}**  ${flag} winners:${m.publicWinnersCount}  hof:${m.hallOfFameMentions}`;
    })
    .join("\n");

  return new EmbedBuilder()
    .setTitle("📊 TGT Analytics — Honors Overview (Staff)")
    .setDescription(
      `Window: **${windowLabel}**\n` +
        `Cycles scanned: **${totalCycles}** (latest **${latest}** → oldest **${oldest}**)\n\n` +
        `**Health Metrics (no revenue)**\n` +
        `• Cycles with public winners: **${withWinners}**\n` +
        `• Cycles with no public winners: **${noWinners}**\n` +
        `• Avg Hall-of-Fame mentions per cycle: **${avgHof}**\n` +
        `• Avg public winners per cycle: **${avgWinners}**\n\n` +
        `**Recent cycles (quick view)**\n${lines}`
    )
    .setColor(0xC9A24D)
    .setFooter({ text: "Staff-only. No revenue is shown. Canonical source: tgt-honors." });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("analytics")
    .setDescription("Staff-only analytics dashboard (no public revenue).")
    .addSubcommand((sub) =>
      sub
        .setName("honors")
        .setDescription("Analyze honors history from tgt-honors (counts only).")
        .addIntegerOption((opt) =>
          opt
            .setName("scan")
            .setDescription("How many messages to scan in tgt-honors (default 300).")
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    if (!isAdminOrMod(interaction)) {
      return interaction.reply({ content: "⛔ Staff only.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    if (sub !== "honors") {
      return interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
    }

    if (!HONORS_CHANNEL_ID) {
      return interaction.reply({ content: "❌ HONORS_CHANNEL_ID is missing in .env", ephemeral: true });
    }

    const honorsChannel = await interaction.client.channels.fetch(HONORS_CHANNEL_ID).catch(() => null);
    if (!honorsChannel || !honorsChannel.isTextBased()) {
      return interaction.reply({ content: "❌ Honors channel not found or not text-based.", ephemeral: true });
    }

    const scanLimit = interaction.options.getInteger("scan") ?? 300;

    await interaction.reply({ content: `🔎 Scanning ${scanLimit} honors messages…`, ephemeral: true });

    const msgs = await fetchMessages(honorsChannel, scanLimit);
    const { cycles, map } = indexCycles(msgs);

    if (!cycles.length) {
      return interaction.editReply({ content: "No cycles found in the scanned window." });
    }

    const metrics = cycles.map((c) => computeCycleMetrics({ cycle: c, entry: map.get(c) }));

    const embed = buildAnalyticsEmbed({
      metrics,
      windowLabel: `${scanLimit} messages`,
    });

    return interaction.editReply({ content: "", embeds: [embed] });
  },
};
