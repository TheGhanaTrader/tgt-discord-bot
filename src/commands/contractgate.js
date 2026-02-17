"use strict";

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { PermissionFlagsBits } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("contractgate")
    .setDescription("Post the Contract Gate message (View + Accept)."),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
  return interaction.reply({ content: "⛔ Staff only.", ephemeral: true });
}

    const embed = new EmbedBuilder()
      .setTitle("📜 Contract Gate — Mandatory Acceptance")
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
      .setColor(0xC9A24D);

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

        const CONTRACT_MARKER = "TGT_CONTRACT_GATE";

    // find existing pinned contract gate (bot only)
    const pins = await interaction.channel.messages.fetchPinned().catch(() => null);
    let msg = null;

    if (pins) {
      msg = pins.find((m) => {
        if (!m.author?.bot) return false;
        const title = m.embeds?.[0]?.title || "";
        if (title !== "📜 Contract Gate — Mandatory Acceptance") return false;
        const footer = m.embeds?.[0]?.footer?.text || "";
        return footer.includes(CONTRACT_MARKER);
      }) || null;
    }

    // ensure marker exists in embed footer (so we can reliably find it later)
    embed.setFooter({ text: `The Ghana Trader Desk • ${CONTRACT_MARKER}` });

    // create if missing
    if (!msg) {
      msg = await interaction.channel.send({ embeds: [embed], components: [row] });
      await msg.pin().catch(() => null);
      return interaction.reply({ content: "✅ Contract gate created + pinned.", ephemeral: true });
    }

    // edit if exists
    await msg.edit({ embeds: [embed], components: [row] }).catch(() => null);

    // unpin any duplicate pinned contract gate messages (same title)
    if (pins) {
      for (const p of pins.values()) {
        if (p.id === msg.id) continue;
        const t = p.embeds?.[0]?.title || "";
        if (t === "📜 Contract Gate — Mandatory Acceptance") {
          try { await p.unpin(); } catch {}
        }
      }
    }

    return interaction.reply({ content: "✅ Contract gate updated (pinned message).", ephemeral: true });
  }
};
