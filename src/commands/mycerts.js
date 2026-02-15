// src/commands/mycerts.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getUserCertificates } = require("../services/certificatesLedger");

function fmtDate(ms) {
  try {
    const d = new Date(ms);
    return isNaN(d.getTime()) ? "Unknown" : d.toUTCString();
  } catch {
    return "Unknown";
  }
}

// Backward compatible claimable inference (for older entries)
function inferClaimable(c) {
  if (typeof c?.rewardClaimable === "boolean") return c.rewardClaimable;
  const rl = String(c?.rewardLabel || "").trim().toLowerCase();
  if (!rl) return false;
  return rl !== "top 10 recognition";
}

function statusLabel(c) {
  const claimable = inferClaimable(c);
  if (!claimable) return "🆓 Recognition";
  return c.claimed ? "🟢 Claimed" : "🔵 Unclaimed";
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("mycerts")
    .setDescription("View certificates issued to your account"),

  async execute(interaction) {
    // ✅ IMPORTANT: acknowledge immediately
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;

    let certs;
    try {
      certs = getUserCertificates(userId);
    } catch (err) {
      return interaction.editReply("❌ Failed to load your certificates.");
    }

    if (!certs || !certs.length) {
      return interaction.editReply("No certificates found for your account yet.");
    }

    const recent = [...certs]
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 10);

    const lines = recent.map((c) => {
      const cycle = c.monthKey || "Unknown";
      const title = c.rankLabel || c.category || "Certificate";
      const status = statusLabel(c);

      return (
        `• **${cycle}** — ${title}\n` +
        `  Code: \`${c.code}\` • Status: ${status}`
      );
    });

    const embed = new EmbedBuilder()
      .setTitle("🏛️ Your TGT Certificates")
      .setDescription(lines.join("\n\n"))
      .addFields({
        name: "Total Certificates",
        value: String(certs.length),
        inline: true,
      })
      .setFooter({ text: `Updated: ${fmtDate(Date.now())}` })
      .setColor(0xc9a24d);

    return interaction.editReply({ embeds: [embed] });
  },
};
