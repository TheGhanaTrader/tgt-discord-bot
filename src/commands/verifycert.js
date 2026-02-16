// src/commands/verifycert.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const {
  findCertificateByCode,
  findLegacyByCode,
  markLegacyCertificate,
} = require("../services/certificatesLedger");

function normalizeCode(input) {
  return String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function fmtDate(ms) {
  try {
    const d = new Date(ms);
    return isNaN(d.getTime()) ? "Unknown" : d.toUTCString();
  } catch {
    return "Unknown";
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verifycert")
    .setDescription("Verify a TGT certificate verification code")
    .addStringOption((opt) =>
      opt.setName("code").setDescription("Verification code").setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("legacy")
        .setDescription(
          "ADMIN: Mark this code as legacy (issued before verification system)"
        )
        .setRequired(false)
    ),

  async execute(interaction) {
    const raw = interaction.options.getString("code", true);
    const legacy = interaction.options.getBoolean("legacy") || false;
    const code = normalizeCode(raw);

    // 1) Normal issued cert lookup
    const cert = await findCertificateByCode(code);
    if (cert) {
      const rewardStatus = cert.rewardClaimable
        ? cert.claimed
          ? `🟢 Claimed (${fmtDate(cert.claimedAt)})`
          : "🔵 Unclaimed"
        : "Not applicable";

      const verified = new EmbedBuilder()
        .setTitle("✅ Certificate Verified")
        .setDescription(
          "This certificate code is **authentic** and was issued by The Ghana Trader."
        )
        .addFields(
          { name: "Verification Code", value: `\`${cert.code}\``, inline: false },
          { name: "Cycle", value: `${cert.monthKey || "Unknown"}`, inline: true },
          { name: "Category", value: `${cert.category || "Unknown"}`, inline: true },
          {
            name: "Issued To",
            value: cert.userId ? `<@${cert.userId}>` : cert.username || "Unknown",
            inline: false,
          },
          { name: "Rank / Title", value: cert.rankLabel || "—", inline: false },
          { name: "Reward Label", value: cert.rewardLabel || "—", inline: false },
          { name: "Reward Status", value: rewardStatus, inline: false },
          {
            name: "Claim Reference",
            value: cert.claimRef ? `\`${cert.claimRef}\`` : "—",
            inline: false,
          },
          { name: "Issued At (UTC)", value: fmtDate(cert.createdAt), inline: false }
        )
        .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
        .setColor(0xc9a24d);

      return interaction.reply({ embeds: [verified], ephemeral: true });
    }

    // 2) Legacy lookup
    const legacyEntry = await findLegacyByCode(code);
    if (legacyEntry) {
      const legacyEmbed = new EmbedBuilder()
        .setTitle("🟨 Legacy Certificate (Recorded)")
        .setDescription(
          "This code is recorded as a **legacy certificate** (issued before the verification system)."
        )
        .addFields(
          { name: "Verification Code", value: `\`${legacyEntry.code}\``, inline: false },
          { name: "Status", value: "Legacy (no claim tracking)", inline: false },
          { name: "Recorded At (UTC)", value: fmtDate(legacyEntry.createdAt), inline: false }
        )
        .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
        .setColor(0xffc107);

      return interaction.reply({ embeds: [legacyEmbed], ephemeral: true });
    }

    // 3) Admin legacy mark
    if (legacy) {
      const isAdmin = interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      );
      if (!isAdmin) {
        return interaction.reply({
          content: "❌ Only an Administrator can mark a certificate code as legacy.",
          ephemeral: true,
        });
      }

      await markLegacyCertificate({
        code,
        markedByUserId: interaction.user.id,
        note: "Issued before verification system",
      });

      const marked = new EmbedBuilder()
        .setTitle("🟨 Legacy Certificate Marked")
        .setDescription("Code has been recorded as **legacy**.")
        .addFields(
          { name: "Verification Code", value: `\`${code}\``, inline: false },
          { name: "Recorded At (UTC)", value: fmtDate(Date.now()), inline: false }
        )
        .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
        .setColor(0xffc107);

      return interaction.reply({ embeds: [marked], ephemeral: true });
    }

    // 4) Not found
    const notFound = new EmbedBuilder()
      .setTitle("❌ Certificate Not Verified")
      .setDescription(
        `The code \`${code}\` was **not found** in the TGT certificate registry.\n\n` +
          `If this is an older certificate, an Admin can run:\n` +
          `\`/verifycert code:${code} legacy:true\``
      )
      .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
      .setColor(0xff3b3b);

    return interaction.reply({ embeds: [notFound], ephemeral: true });
  },
};
