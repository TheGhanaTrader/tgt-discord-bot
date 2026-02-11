// src/commands/claimreward.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const { markCertificateClaimed } = require("../services/certificatesLedger");

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
    .setName("claimreward")
    .setDescription("ADMIN: Mark a reward-bearing certificate as claimed")
    .addStringOption((opt) =>
      opt.setName("code").setDescription("Verification code").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("ref")
        .setDescription("Claim reference (ticket/provider/tx id)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("note")
        .setDescription("Optional note (short)")
        .setRequired(false)
    ),

  async execute(interaction) {
    const isAdmin = interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator
    );
    if (!isAdmin) {
      return interaction.reply({
        content: "❌ Only an Administrator can use this command.",
        ephemeral: true,
      });
    }

    const raw = interaction.options.getString("code", true);
    const code = normalizeCode(raw);
    const ref = interaction.options.getString("ref") || null;
    const note = interaction.options.getString("note") || null;

    const res = markCertificateClaimed(code, {
      adminId: interaction.user.id,
      ref,
      note,
    });

    if (!res.ok && res.reason === "not_found") {
      const embed = new EmbedBuilder()
        .setTitle("❌ Claim Failed")
        .setDescription(`Code \`${code}\` was not found in the issued registry.`)
        .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
        .setColor(0xff3b3b);

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (!res.ok) {
      return interaction.reply({
        content: "❌ Claim failed due to invalid code.",
        ephemeral: true,
      });
    }

    const cert = res.cert;

    // If it's not claimable, still allow mark-claimed? We’ll block it to keep it clean.
    if (!cert.rewardClaimable) {
      const embed = new EmbedBuilder()
        .setTitle("⚠️ Not Claimable")
        .setDescription(
          `This certificate is **recognition-only** and does not require claiming.\n` +
            `Code: \`${cert.code}\``
        )
        .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
        .setColor(0xffc107);

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle(res.already ? "✅ Already Claimed" : "✅ Reward Marked as Claimed")
      .setDescription("Claim state has been recorded in the certificate registry.")
      .addFields(
        { name: "Verification Code", value: `\`${cert.code}\``, inline: false },
        { name: "Issued To", value: cert.userId ? `<@${cert.userId}>` : (cert.username || "Unknown"), inline: false },
        { name: "Cycle", value: cert.monthKey || "Unknown", inline: true },
        { name: "Category", value: cert.category || "Unknown", inline: true },
        { name: "Reward Label", value: cert.rewardLabel || "—", inline: false },
        { name: "Claimed At (UTC)", value: fmtDate(cert.claimedAt), inline: false },
        { name: "Claim Reference", value: cert.claimRef ? `\`${cert.claimRef}\`` : "—", inline: false }
      )
      .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
      .setColor(0xc9a24d);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
