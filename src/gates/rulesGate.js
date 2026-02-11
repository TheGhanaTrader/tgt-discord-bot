"use strict";

const { EmbedBuilder } = require("discord.js");
const { pinBotMessage } = require("../utils/pinManager");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function buildRulesEmbed() {
  return new EmbedBuilder()
    .setTitle("📜 Server Rules — The Ghana Trader Desk")
    .setDescription(
      [
        "Professionalism is mandatory.",
        "",
        "• No spam, hype, or emotional posting",
        "• No off-topic in structured channels",
        "• No leaking / redistribution of Desk content",
        "• Respect members and staff at all times",
        "",
        "Failure to comply may result in removal without refund.",
      ].join("\n")
    )
    .setColor(0xC9A24D);
}

async function upsertRulesMessage(client) {
  const channelId = mustEnv("RULES_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);

  const embed = buildRulesEmbed();

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

module.exports = { upsertRulesMessage };
