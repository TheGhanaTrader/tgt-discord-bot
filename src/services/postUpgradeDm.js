"use strict";

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

function contractGateLink() {
  const guildId = process.env.DISCORD_GUILD_ID;
  const chId = process.env.CONTRACT_GATE_CHANNEL_ID;
  if (!guildId || !chId) return null;
  return `https://discord.com/channels/${guildId}/${chId}`;
}

function buildPostUpgradeEmbed({ tier, amountGhs, reference, utc }) {
  return new EmbedBuilder()
    .setTitle("🏛️ Welcome to The Ghana Trader Desk")
    .setDescription(
      [
        `☑️ **Payment Confirmed — Tier: ${tier}**`,
        "",
        `**Receipt:** ${reference}`,
        `**Time (UTC):** ${utc}`,
        "",
        "**Proceed to the Contract Gate to review and accept the Desk Agreement.**",
      ].join("\n")
    )
    .setColor(0xC9A24D)
    .setFooter({ text: "The Ghana Trader Desk" });
}

function buildContractGateButton() {
  const link = contractGateLink();
  if (!link) return null;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Contract Gate")
      .setURL(link)
  );
  return row;
}

async function sendPostUpgradeDm(user, { tier, amountGhs, reference, utc }) {
  const embed = buildPostUpgradeEmbed({ tier, amountGhs, reference, utc });
  const row = buildContractGateButton();

  if (row) return user.send({ embeds: [embed], components: [row] });
  return user.send({ embeds: [embed] });
}

module.exports = { sendPostUpgradeDm };
