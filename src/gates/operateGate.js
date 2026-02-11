"use strict";

const { EmbedBuilder } = require("discord.js");
const { pinBotMessage } = require("../utils/pinManager");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function buildOperateEmbed() {
  return new EmbedBuilder()
    .setTitle("🏛️ The Ghana Trader Desk — How We Operate")
    .setDescription(
      [
        "This is a professional trading environment built for process, structure, and longevity.",
        "",
        "🧠 Operating Philosophy",
        "• HTF structure, liquidity, and time-based execution",
        "• Risk defined before reward",
        "• Capital preservation first",
        "",
        "🧭 Conduct",
        "• No spam or hype",
        "• Stay on-topic in structured channels",
        "• No redistribution of Desk content",
        "",
        "✨ Clarity. Patience. Execution.",
      ].join("\n")
    )
    .setColor(0xC9A24D)
    .setFooter({ text: "The Ghana Trader Desk" });
}

async function upsertOperateMessage(client) {
  const channelId = mustEnv("OPERATE_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);

  const embed = buildOperateEmbed();

  const msgs = await channel.messages.fetch({ limit: 20 });
  const lastBotMsg = msgs.find(
  (m) => m.author?.id === client.user.id && m.type === 0
);

  if (lastBotMsg) {
    await lastBotMsg.edit({ embeds: [embed], components: [] });
    await pinBotMessage(channel, lastBotMsg);
    return lastBotMsg;
  }

  const sent = await channel.send({ embeds: [embed] });
  await pinBotMessage(channel, sent);
  return sent;
}

module.exports = { upsertOperateMessage };
