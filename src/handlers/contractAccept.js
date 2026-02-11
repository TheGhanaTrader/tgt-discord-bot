// src/handlers/contractAccept.js
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const { hasAccepted, recordAcceptance } = require("../services/contractLedger");
const { generatePersonalizedContractPdf } = require("../services/contractPdf");
const cfg = require("../config/contractGate");
const refs = require("../services/referrals");

// ✅ Staff skip (do NOT count staff referrals)
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;

function isStaffMember(member) {
  if (!member) return false;
  return (
    (ADMIN_ROLE_ID && member.roles?.cache?.has(ADMIN_ROLE_ID)) ||
    (MOD_ROLE_ID && member.roles?.cache?.has(MOD_ROLE_ID))
  );
}

function detectTier(member) {
  const { roles } = cfg;
  if (roles.diamond && member.roles.cache.has(roles.diamond)) return "Diamond";
  if (roles.gold && member.roles.cache.has(roles.gold)) return "Gold";
  if (roles.silver && member.roles.cache.has(roles.silver)) return "Silver";
  return "Verified";
}

async function unlockAfterAcceptance(member) {
  const { roles, addVerifiedEvenIfPremium } = cfg;

  const isPremium =
    (roles.diamond && member.roles.cache.has(roles.diamond)) ||
    (roles.gold && member.roles.cache.has(roles.gold)) ||
    (roles.silver && member.roles.cache.has(roles.silver));

  // If not premium, ensure verified (free access)
  if (!isPremium && roles.verified) {
    if (!member.roles.cache.has(roles.verified)) {
      await member.roles.add(roles.verified).catch(() => null);
    }
    return;
  }

  // If premium and you want verified alongside premium
  if (isPremium && addVerifiedEvenIfPremium && roles.verified) {
    if (!member.roles.cache.has(roles.verified)) {
      await member.roles.add(roles.verified).catch(() => null);
    }
  }
}

async function handleContractAccept(interaction) {
  const member = interaction.member;
  const user = interaction.user;

  // ✅ HARD STOP: already accepted => NO new PDF, NO DM, NO log
  if (hasAccepted(user.id)) {
    return interaction.reply({
      content: "✅ Contract already accepted. Access is already unlocked.",
      ephemeral: true,
    });
  }

  // ✅ LOCK (prevents double-click races)
  const key = `contract_accept:${user.id}`;
  interaction.client._locks = interaction.client._locks || new Set();
  if (interaction.client._locks.has(key)) {
    return interaction.reply({ content: "Processing…", ephemeral: true }).catch(() => null);
  }
  interaction.client._locks.add(key);

  try {
    // ✅ ACK immediately (prevents 10062)
    await interaction.deferReply({ ephemeral: true });

    // ✅ Re-check after defer (race safe)
    if (hasAccepted(user.id)) {
      interaction.client._locks.delete(key);
      return interaction.editReply({
        content: "✅ Contract already accepted. Access is already unlocked.",
      });
    }

    const tier = detectTier(member);
    const acceptedAtUtc = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
    const username = user.username;

    // Generate PDF
    let pdf;
    try {
      pdf = await generatePersonalizedContractPdf({
        username,
        userId: user.id,
        tier,
        acceptedAtUtc,
      });
    } catch (err) {
      interaction.client._locks.delete(key);
      return interaction.editReply({
        content: `❌ Failed to generate contract PDF.\nError: ${err?.message || err}`,
      });
    }

    // Record acceptance (idempotent enough because we guard above)
    const rec = recordAcceptance({
      userId: user.id,
      username,
      tier,
      acceptedAtUtc,
      pdfPath: pdf.outPath,
    });

    // ✅ STEP 2: Count REFERRAL JOIN ONLY on contract acceptance (NOT on server join)
    if (!rec?.ok) return;
    try {
      const memberId = String(user.id);
      const referrerId = refs.getReferrerByInvite(memberId);

      if (!referrerId) {
        // no mapping -> nothing to count
      } else if (referrerId === memberId) {
        // self-ref safe no-op
      } else {
        // Skip staff referrers (Admin/Mod)
        const refMember = interaction.guild
          ? await interaction.guild.members.fetch(referrerId).catch(() => null)
          : null;

        if (isStaffMember(refMember)) {
          console.log("ℹ️ REF JOIN skipped (referrer is staff):", referrerId);
        } else {
          const r = refs.bump("join", { referrerId, memberId });

          if (r?.ignored) {
            console.log("ℹ️ REF JOIN ignored (already counted):", memberId);
          } else if (r?.ok) {
            console.log("✅ REF JOIN COUNTED (CONTRACT):", memberId, "<-", referrerId);
          } else {
            console.log("ℹ️ REF JOIN not counted:", r?.reason || "unknown_reason");
          }
        }
      }
    } catch (e) {
      console.log("REF_JOIN_ON_CONTRACT_ERR:", e?.message || e);
    }

    // DM user (ONE copy only)
    try {
      const userCopy = new AttachmentBuilder(pdf.outPath, { name: pdf.fileName });
      await user.send({
        content: "✅ Contract accepted. Here is your personalized signed copy.\nProject: The Ghana Trader Desk",
        files: [userCopy],
      });
    } catch {}

    // Log to private channel (ONE embed + ONE file)
    const logChannelId = cfg.contractsLogChannelId;
    if (logChannelId) {
      const logChannel =
        interaction.client.channels.cache.get(logChannelId) ||
        (await interaction.client.channels.fetch(logChannelId).catch(() => null));

      if (logChannel) {
        const embed = new EmbedBuilder()
          .setTitle("📄 Contract Accepted (Logged Copy)")
          .setDescription(
            [
              `**User:** ${username} (${user.id})`,
              `**Tier:** ${tier}`,
              `**Accepted (UTC):** ${acceptedAtUtc}`,
              `**Project:** The Ghana Trader Desk`,
            ].join("\n")
          );

        const tgtCopy = new AttachmentBuilder(pdf.outPath, { name: pdf.fileName });

        await logChannel.send({ embeds: [embed] }).catch(() => {});
        await logChannel.send({ files: [tgtCopy] }).catch(() => {});
      }
    }

    // Unlock
    await unlockAfterAcceptance(member);

    interaction.client._locks.delete(key);
    return interaction.editReply("✅ Contract accepted. Access unlocked. Signed copy delivered.");
  } catch (err) {
    interaction.client._locks.delete(key);
    console.error("handleContractAccept error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply("❌ Contract acceptance failed.");
      }
      return interaction.reply({ content: "❌ Contract acceptance failed.", ephemeral: true });
    } catch {}
  }
}

module.exports = { handleContractAccept };
