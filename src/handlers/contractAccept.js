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

/* -------------------- Bucket helpers (storage-only) -------------------- */

function getS3Config() {
  const endpoint = String(process.env.AWS_ENDPOINT_URL || "").trim();
  const bucket = String(process.env.AWS_S3_BUCKET_NAME || "").trim();
  const region = String(process.env.AWS_DEFAULT_REGION || "auto").trim();
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || "").trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Bucket env vars missing. Required: AWS_ENDPOINT_URL, AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (and AWS_DEFAULT_REGION optional)."
    );
  }

  return { endpoint, bucket, region, accessKeyId, secretAccessKey };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadPdfFromBucketByKey(key) {
  const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
  const { endpoint, bucket, region, accessKeyId, secretAccessKey } = getS3Config();

  const s3 = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  if (!res || !res.Body) throw new Error("Bucket download failed (empty body)");
  const buf = await streamToBuffer(res.Body);
  if (!buf || !buf.length) throw new Error("Bucket download failed (empty buffer)");
  return buf;
}

function parseS3Locator(outPath) {
  // expects: s3://bucket/key...
  const s = String(outPath || "").trim();
  if (!s.startsWith("s3://")) return null;
  const rest = s.slice("s3://".length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0) return null;
  const bucket = rest.slice(0, firstSlash);
  const key = rest.slice(firstSlash + 1);
  if (!bucket || !key) return null;
  return { bucket, key };
}

/* -------------------- main handler -------------------- */

async function handleContractAccept(interaction) {
  const member = interaction.member;
  const user = interaction.user;

  // ✅ HARD STOP: already accepted => NO new PDF, NO DM, NO log
  try {
    const already = await hasAccepted(user.id);
    if (already) {
      return interaction.reply({
        content: "✅ Contract already accepted. Access is already unlocked.",
        ephemeral: true,
      });
    }
  } catch {
    // If ledger read fails, we still proceed cautiously; lock + record below will protect.
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
    try {
      const already = await hasAccepted(user.id);
      if (already) {
        interaction.client._locks.delete(key);
        return interaction.editReply({
          content: "✅ Contract already accepted. Access is already unlocked.",
        });
      }
    } catch {}

    const tier = detectTier(member);
    const acceptedAtUtc = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
    const username = user.username;

    // Generate PDF (now uploads to bucket)
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

    // Determine bucket key for download (prefer explicit bucketKey if present)
    const locator = parseS3Locator(pdf?.outPath);
    const bucketKey = pdf?.bucketKey || locator?.key || null;
    if (!bucketKey) {
      interaction.client._locks.delete(key);
      return interaction.editReply("❌ Contract generated but bucket key missing. Check server logs.");
    }

    // Record acceptance (Postgres)
    const rec = await recordAcceptance({
      userId: user.id,
      username,
      tier,
      acceptedAtUtc,
      pdfPath: pdf.outPath, // store locator string (s3://...)
    });

    if (!rec?.ok) {
      interaction.client._locks.delete(key);
      return interaction.editReply("❌ Could not record contract acceptance. Try again.");
    }

    // ✅ STEP 2: Count REFERRAL JOIN ONLY on contract acceptance (NOT on server join)
    try {
      const memberId = String(user.id);

      // ✅ Postgres referrals: async lookup
      const referrerId = await refs.getReferrerByInvite(memberId);

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
          // ✅ Postgres referrals: async bump
          const r = await refs.bump("join", { referrerId, memberId });

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

    // Download the PDF from bucket once, reuse buffer for DM + log
    let pdfBuffer = null;
    try {
      pdfBuffer = await downloadPdfFromBucketByKey(bucketKey);
    } catch (e) {
      console.log("CONTRACT_BUCKET_DOWNLOAD_FAIL:", e?.message || e);
      // We do NOT fail acceptance if DM/log copy fails. Access still unlocks.
    }

    // DM user (ONE copy only)
    try {
      if (pdfBuffer) {
        const userCopy = new AttachmentBuilder(pdfBuffer, { name: pdf.fileName });
        await user.send({
          content: "✅ Contract accepted. Here is your personalized signed copy.\nProject: The Ghana Trader Desk",
          files: [userCopy],
        });
      } else {
        await user.send({
          content:
            "✅ Contract accepted. Your signed copy was generated and stored securely.\nProject: The Ghana Trader Desk",
        });
      }
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

        await logChannel.send({ embeds: [embed] }).catch(() => {});

        try {
          if (pdfBuffer) {
            const tgtCopy = new AttachmentBuilder(pdfBuffer, { name: pdf.fileName });
            await logChannel.send({ files: [tgtCopy] }).catch(() => {});
          }
        } catch {}
      }
    }

    // ✅ cleanup temp file (storage-only hygiene)
    try { require("fs").unlinkSync(pdf.filePath); } catch {}

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
