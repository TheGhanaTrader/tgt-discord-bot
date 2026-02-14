"use strict";

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const CONTRACT_GATE_CHANNEL_ID = String(process.env.CONTRACT_GATE_CHANNEL_ID || "").trim();
const CONTRACT_GATE_MARKER = "TGT_CONTRACT_GATE_MARKER";
const CONTRACT_GATE_TITLE = "📜 Contract Gate — Mandatory Acceptance";

function contractGateEmbed() {
  return new EmbedBuilder()
    .setTitle(CONTRACT_GATE_TITLE)
    .setDescription(
      [
        "**Rules are visible but NOT mandatory.**",
        "",
        "**Mandatory:** You must accept the contract to unlock access.",
        "",
        "📄 **View Contract** = preview the full agreement inside Discord.",
        "✅ **I Agree & Accept Contract** = generate your signed copy + unlock access.",
        "",
        "**Project:** The Ghana Trader Desk",
        "**Public Brand:** The Ghana Trader",
      ].join("\n")
    )
    .setFooter({ text: `The Ghana Trader Desk • ${CONTRACT_GATE_MARKER}` })
    .setColor(0xC9A24D);
}

function contractGateComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("contract_view")
      .setLabel("View Contract")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("contract_accept")
      .setLabel("I Agree & Accept Contract")
      .setStyle(ButtonStyle.Success)
  );
  return [row];
}

async function findPinnedContractGate(channel, client) {
  const pins = await channel.messages.fetchPinned().catch(() => null);
  if (!pins) return null;

  const match = pins.filter((m) => {
    if (!m.author?.bot) return false;
    if (client?.user?.id && m.author.id !== client.user.id) return false;

    const title = m.embeds?.[0]?.title || "";
    if (title !== CONTRACT_GATE_TITLE) return false;

    const footer = m.embeds?.[0]?.footer?.text || "";
    return footer.includes(CONTRACT_GATE_MARKER);
  });

  return match.sort((a, b) => b.createdTimestamp - a.createdTimestamp).first() || null;
}

// ✅ Behavior:
// - If pinned exists -> EDIT ONLY
// - If missing -> CREATE + PIN ONCE
async function ensureContractGateMessage(client) {
  console.log("[CONTRACT_GATE] start", {
    ts: new Date().toISOString(),
    CONTRACT_GATE_CHANNEL_ID: CONTRACT_GATE_CHANNEL_ID ? "set" : "MISSING",
  });

  if (!CONTRACT_GATE_CHANNEL_ID) {
    console.error("[CONTRACT_GATE] abort: CONTRACT_GATE_CHANNEL_ID missing");
    return;
  }

  const ch = await client.channels.fetch(CONTRACT_GATE_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    console.error("[CONTRACT_GATE] abort: channel missing or not text-based");
    return;
  }

  let msg = await findPinnedContractGate(ch, client).catch(() => null);

  if (!msg) {
    console.warn("[CONTRACT_GATE] No pinned gate found — creating + pinning");
    msg = await ch
      .send({ embeds: [contractGateEmbed()], components: contractGateComponents() })
      .catch(() => null);
    if (!msg) return;

    await msg.pin().catch(() => null);
    console.log("[CONTRACT_GATE] created + pinned");
    return;
  }

  await msg
    .edit({ embeds: [contractGateEmbed()], components: contractGateComponents() })
    .catch(() => null);

  console.log("[CONTRACT_GATE] updated pinned");
}

module.exports = { ensureContractGateMessage };
