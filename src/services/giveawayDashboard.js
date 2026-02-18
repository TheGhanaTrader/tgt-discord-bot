"use strict";

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");
const { Pool } = require("pg");
const crypto = require("crypto");
const fs = require("fs");

// ✅ Certificate ledger is the source of truth for claim eligibility + owner (READ-ONLY)
const { findCertificateByCode, findLegacyByCode } = require("./certificatesLedger");

// ---------------- ENV / PG ----------------
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  console.error("[GIVEAWAY_DASHBOARD] FATAL: DATABASE_URL is missing in env");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// Where the ONE pinned dashboard lives
const GIVEAWAY_DASHBOARD_CHANNEL_ID = String(process.env.GIVEAWAY_DASHBOARD_CHANNEL_ID || "").trim();

// Uses your existing staff queue (same as funded/payout)
const REVIEW_QUEUE_ID = String(process.env.PROOF_REVIEW_QUEUE_CHANNEL_ID || "").trim();

// ✅ Where delivered claims + certificate copy must be posted
const VERIFIED_GIVEAWAYS_CHANNEL_ID = String(process.env.VERIFIED_GIVEAWAYS_CHANNEL_ID || "").trim();

// Marker to identify the right pinned message
const DASH_MARKER = "TGT_GIVEAWAY_DASHBOARD";

// Optional branding
const LOGO_URL = String(process.env.TGT_LOGO_URL || "").trim();

// IMPORTANT: title must match exactly everywhere
const DASH_TITLE = "🎁 Prop Firm Giveaways Dashboard";

// Premium role IDs (must exist in env for role granting on approve)
const ROLE_SILVER_ID = String(process.env.ROLE_SILVER_ID || process.env.ROLE_SILVER || "").trim();
const ROLE_GOLD_ID = String(process.env.ROLE_GOLD_ID || process.env.ROLE_GOLD || "").trim();
const ROLE_DIAMOND_ID = String(process.env.ROLE_DIAMOND_ID || process.env.ROLE_DIAMOND || "").trim();

// ---------------- Helpers ----------------
function normalizeSerial(input) {
  return String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function monthKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function yearKeyUTC(d = new Date()) {
  return String(d.getUTCFullYear());
}

function isFundedReward(label) {
  const s = String(label || "");
  return /funded\s*account/i.test(s) || /\bprop\b/i.test(s);
}

function parsePremiumTier(label) {
  const s = String(label || "").toLowerCase();
  if (/\bdiamond\b/.test(s)) return "DIAMOND";
  if (/\bgold\b/.test(s)) return "GOLD";
  if (/\bsilver\b/.test(s)) return "SILVER";
  return null;
}

function tierRank(tier) {
  if (tier === "SILVER") return 1;
  if (tier === "GOLD") return 2;
  if (tier === "DIAMOND") return 3;
  return 0;
}

function roleIdForTier(tier) {
  if (tier === "SILVER") return ROLE_SILVER_ID || null;
  if (tier === "GOLD") return ROLE_GOLD_ID || null;
  if (tier === "DIAMOND") return ROLE_DIAMOND_ID || null;
  return null;
}

function memberHighestTier(member) {
  if (!member) return null;
  if (ROLE_DIAMOND_ID && member.roles.cache.has(ROLE_DIAMOND_ID)) return "DIAMOND";
  if (ROLE_GOLD_ID && member.roles.cache.has(ROLE_GOLD_ID)) return "GOLD";
  if (ROLE_SILVER_ID && member.roles.cache.has(ROLE_SILVER_ID)) return "SILVER";
  return null;
}

async function safeFetchCertByCode(code) {
  const c = await findCertificateByCode(code).catch(() => null);
  if (c) return c;

  const legacy = await findLegacyByCode(code).catch(() => null);
  if (legacy) return { legacy: true, code: legacy.code };

  return null;
}

function staffRow(claimId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_claim_approve:${claimId}`)
      .setLabel("✅ Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`giveaway_claim_reject:${claimId}`)
      .setLabel("❌ Reject")
      .setStyle(ButtonStyle.Danger)
  );
}

function staffDeliveredRow(claimId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_claim_delivered:${claimId}`)
      .setLabel("📦 Mark Delivered")
      .setStyle(ButtonStyle.Primary)
  );
}

async function postDeliveredToVerifiedGiveawaysChannel(client, { claim, cert, code }) {
  if (!VERIFIED_GIVEAWAYS_CHANNEL_ID) return;

  const ch = await client.channels.fetch(VERIFIED_GIVEAWAYS_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const rewardLabel = String(cert?.rewardLabel || "—").trim();
  const firm = String(claim?.firm_name || "—").trim();
  const method = String(claim?.fulfillment_method || "—").trim();
  const voucherOrLink = String(claim?.voucher_code || "—").trim();
  const instructions = String(claim?.staff_instructions || "—").trim();
  const winnerEmail = String(claim?.fulfillment_email || claim?.email || "—").trim();

  const e = new EmbedBuilder()
    .setTitle("✅ Giveaway Delivered — Verified")
    .setDescription(`Certificate Code: \`${code}\``)
    .addFields(
      { name: "Member", value: `<@${String(claim.claimant_user_id)}>` , inline: true },
      { name: "Reward", value: rewardLabel || "—", inline: true },
      { name: "Firm", value: firm || "—", inline: true },
      { name: "Method", value: method || "—", inline: true },
      { name: "Voucher / Link", value: voucherOrLink ? voucherOrLink.slice(0, 900) : "—", inline: false },
      { name: "Instructions", value: instructions ? instructions.slice(0, 900) : "—", inline: false },
      { name: "Winner Email", value: winnerEmail || "—", inline: false }
    )
    .setColor(0x2ecc71)
    .setTimestamp(new Date());

  if (LOGO_URL) e.setThumbnail(LOGO_URL);

  // Best-effort attach certificate copy:
  // - If cert.filePath is a URL, set it as image
  // - If it’s a local path and exists, attach file
  const fp = cert?.filePath ? String(cert.filePath) : "";
  const isUrl = /^https?:\/\//i.test(fp);

  if (isUrl) {
    e.setImage(fp);
    await ch.send({ embeds: [e] }).catch(() => null);
    return;
  }

  if (fp && fs.existsSync(fp)) {
    const att = new AttachmentBuilder(fp);
    await ch.send({ embeds: [e], files: [att] }).catch(() => null);
    return;
  }

  // If we can’t attach, still log the record (no crashes)
  await ch.send({ embeds: [e] }).catch(() => null);
}

// ---------------- Totals ----------------
// ✅ Counts are now COMPLETED (delivered), because you want dashboard to update after completion.
async function computeGiveawayTotals() {
  const mkThis = monthKeyUTC();
  const yk = yearKeyUTC();

  const q = async (sql, params) => {
    const { rows } = await pool.query(sql, params);
    return rows?.[0] || {};
  };

  const lifetime = await q(
    `SELECT COUNT(*)::int AS cnt
     FROM public.prop_giveaway_claims
     WHERE delivered_at IS NOT NULL`,
    []
  );

  const ytd = await q(
    `SELECT COUNT(*)::int AS cnt
     FROM public.prop_giveaway_claims
     WHERE delivered_at IS NOT NULL
       AND EXTRACT(YEAR FROM delivered_at) = $1`,
    [Number(yk)]
  );

  const thisMonth = await q(
    `SELECT COUNT(*)::int AS cnt
     FROM public.prop_giveaway_claims
     WHERE delivered_at IS NOT NULL
       AND TO_CHAR(delivered_at AT TIME ZONE 'UTC','YYYY-MM') = $1`,
    [mkThis]
  );

  const pending = await q(
    `SELECT COUNT(*)::int AS cnt
     FROM public.prop_giveaway_claims
     WHERE status='pending'`,
    []
  );

  return {
    mkThis,
    yk,
    lifetimeCnt: Number(lifetime.cnt || 0),
    ytdCnt: Number(ytd.cnt || 0),
    monthCnt: Number(thisMonth.cnt || 0),
    pendingCnt: Number(pending.cnt || 0),
  };
}

// ---------------- Embed / Components ----------------
function giveawayDashboardEmbed(t) {
  const e = new EmbedBuilder()
    .setTitle(DASH_TITLE)
    .setDescription(
      [
        "Claims are verified using **certificate verification codes** (same as `/verifycert`).",
        "Dashboard totals update after **delivery is confirmed**.",
      ].join("\n")
    )
    .addFields(
      { name: "📅 This Month", value: `• **Delivered Claims:** **${t.monthCnt}**`, inline: true },
      { name: "📈 Year-to-Date", value: `• **Delivered Claims:** **${t.ytdCnt}**`, inline: true },
      { name: "🏛️ Lifetime", value: `• **Delivered Claims:** **${t.lifetimeCnt}**`, inline: true },
      { name: "🛡️ Operations", value: `• **Pending Claims:** **${t.pendingCnt}**`, inline: false }
    )
    .setFooter({ text: `The Ghana Trader Desk • Audited Impact • ${DASH_MARKER}` })
    .setColor(0xc9a24d)
    .setTimestamp(new Date());

  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  return e;
}

function giveawayDashboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("giveaway_claim")
        .setLabel("🧾 Claim Reward / Giveaway")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

// ---------------- Dashboard Finders ----------------
async function findPinnedDashboardMessage(channel, client) {
  const pins = await channel.messages.fetchPins().catch(() => null);
  if (!pins) return null;

  const strict = pins.filter((m) => {
    if (!m.author?.bot) return false;
    if (client?.user?.id && m.author.id !== client.user.id) return false;

    const title = m.embeds?.[0]?.title || "";
    if (title !== DASH_TITLE) return false;

    const footer = m.embeds?.[0]?.footer?.text || "";
    return footer.includes(DASH_MARKER);
  });

  return strict.size
    ? strict.sort((a, b) => b.createdTimestamp - a.createdTimestamp).first()
    : null;
}

async function findRecentDashboardMessage(channel, client) {
  const msgs = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!msgs) return null;

  const found = msgs.find((m) => {
    if (!m.author?.bot) return false;
    if (client?.user?.id && m.author.id !== client.user.id) return false;

    const title = m.embeds?.[0]?.title || "";
    const footer = m.embeds?.[0]?.footer?.text || "";
    return title === DASH_TITLE && footer.includes(DASH_MARKER);
  });

  return found || null;
}

// ---------------- Ensure Dashboard ----------------
async function ensureGiveawayDashboard(client) {
  console.log("[GIVEAWAY_DASHBOARD] start", {
    ts: new Date().toISOString(),
    GIVEAWAY_DASHBOARD_CHANNEL_ID: GIVEAWAY_DASHBOARD_CHANNEL_ID ? "set" : "MISSING",
    NODE_ENV: process.env.NODE_ENV || null,
    DATABASE_URL: DATABASE_URL ? "set" : "MISSING",
  });

  if (!DATABASE_URL) return;
  if (!GIVEAWAY_DASHBOARD_CHANNEL_ID) {
    console.error("[GIVEAWAY_DASHBOARD] abort: GIVEAWAY_DASHBOARD_CHANNEL_ID missing");
    return;
  }

  const ch = await client.channels.fetch(GIVEAWAY_DASHBOARD_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    console.error("[GIVEAWAY_DASHBOARD] abort: dashboard channel missing or not text-based");
    return;
  }

  const totals = await computeGiveawayTotals().catch((e) => {
    console.error("[GIVEAWAY_DASHBOARD] computeGiveawayTotals failed", String(e?.message || e));
    return null;
  });
  if (!totals) return;

  let msg = await findPinnedDashboardMessage(ch, client).catch(() => null);

  if (!msg) {
    const recent = await findRecentDashboardMessage(ch, client).catch(() => null);
    if (recent) {
      await recent.pin().catch(() => null);
      msg = recent;
      console.log("[GIVEAWAY_DASHBOARD] re-pinned existing dashboard (no repost)");
    }
  }

  if (!msg) {
    console.warn("[GIVEAWAY_DASHBOARD] No dashboard found — creating one-time pinned dashboard.");
    msg = await ch
      .send({ embeds: [giveawayDashboardEmbed(totals)], components: giveawayDashboardComponents() })
      .catch((e) => {
        console.error("[GIVEAWAY_DASHBOARD] send failed", String(e?.message || e));
        return null;
      });

    if (!msg) return;

    await msg.pin().catch((e) => {
      console.error("[GIVEAWAY_DASHBOARD] pin failed", String(e?.message || e));
    });

    console.log("[GIVEAWAY_DASHBOARD] created and pinned");
    return;
  }

  await msg
    .edit({ embeds: [giveawayDashboardEmbed(totals)], components: giveawayDashboardComponents() })
    .catch((e) => console.error("[GIVEAWAY_DASHBOARD] edit failed", String(e?.message || e)));

  console.log("[GIVEAWAY_DASHBOARD] done");
}

// ---------------- Claim UI ----------------
function buildClaimModal() {
  const m = new ModalBuilder().setCustomId("giveaway_claim_modal").setTitle("Claim Reward / Giveaway");

  const serial = new TextInputBuilder()
    .setCustomId("serial")
    .setLabel("Certificate Verification Code")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const email = new TextInputBuilder()
    .setCustomId("email")
    .setLabel("Email (required only for funded)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  m.addComponents(new ActionRowBuilder().addComponents(serial), new ActionRowBuilder().addComponents(email));
  return m;
}

// Staff approval modal: firm + method + voucher/link + instructions
function buildStaffApproveModal(claimId) {
  const m = new ModalBuilder()
    .setCustomId(`giveaway_staff_approve_modal:${claimId}`)
    .setTitle("Approve Claim — Fulfillment");

  const firm = new TextInputBuilder()
    .setCustomId("firm")
    .setLabel("Firm name (required)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const method = new TextInputBuilder()
    .setCustomId("method")
    .setLabel("Method: VOUCHER or CREDIT (required)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const voucher = new TextInputBuilder()
    .setCustomId("voucher")
    .setLabel("Voucher code OR affiliate link (required)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const instructions = new TextInputBuilder()
    .setCustomId("instructions")
    .setLabel("Instructions (short, required)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  m.addComponents(
    new ActionRowBuilder().addComponents(firm),
    new ActionRowBuilder().addComponents(method),
    new ActionRowBuilder().addComponents(voucher),
    new ActionRowBuilder().addComponents(instructions)
  );

  return m;
}

// Winner fulfillment email modal (stage 2)
function buildWinnerEmailModal(claimId) {
  const m = new ModalBuilder()
    .setCustomId(`giveaway_winner_email_modal:${claimId}`)
    .setTitle("Submit Firm Account Email");

  const email = new TextInputBuilder()
    .setCustomId("email")
    .setLabel("Email you used on the firm site (required)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  m.addComponents(new ActionRowBuilder().addComponents(email));
  return m;
}

// ---------------- Core Interaction Handler ----------------
async function handleGiveawayInteractions(client, interaction) {
  // Button: open claim modal
  if (interaction.isButton() && interaction.customId === "giveaway_claim") {
    await interaction.showModal(buildClaimModal());
    return true;
  }

  // Winner button: submit firm email
  if (interaction.isButton() && typeof interaction.customId === "string") {
    const id = interaction.customId;
    const prefix = "giveaway_submit_firm_email:";
    if (id.startsWith(prefix)) {
      const claimId = id.split(":")[1];
      if (!claimId) return false;
      await interaction.showModal(buildWinnerEmailModal(claimId));
      return true;
    }
  }

  // Winner modal: submit firm email (stage 2)
  if (interaction.isModalSubmit() && typeof interaction.customId === "string") {
    const id = interaction.customId;
    const prefix = "giveaway_winner_email_modal:";
    if (id.startsWith(prefix)) {
      const claimId = id.split(":")[1];
      const email = String(interaction.fields.getTextInputValue("email") || "").trim();

      if (!claimId || !email) {
        await interaction.reply({ content: "❌ Email is required.", ephemeral: true }).catch(() => null);
        return true;
      }

      const claim = await pool
        .query(
          `SELECT id, claimant_user_id, status, firm_name, fulfillment_method, voucher_code, staff_instructions, serial_code
           FROM public.prop_giveaway_claims
           WHERE id=$1
           LIMIT 1`,
          [claimId]
        )
        .then((r) => r.rows?.[0] || null)
        .catch(() => null);

      if (!claim) {
        await interaction.reply({ content: "❌ Claim not found.", ephemeral: true }).catch(() => null);
        return true;
      }

      if (String(claim.claimant_user_id) !== String(interaction.user.id)) {
        await interaction.reply({ content: "❌ This fulfillment link is not for your account.", ephemeral: true }).catch(() => null);
        return true;
      }

      if (String(claim.status) !== "approved") {
        await interaction.reply({ content: "⚠️ This claim is not approved yet.", ephemeral: true }).catch(() => null);
        return true;
      }

      await pool
        .query(
          `UPDATE public.prop_giveaway_claims
           SET fulfillment_email=$2
           WHERE id=$1`,
          [claimId, email]
        )
        .catch(() => null);

      const q = await client.channels.fetch(REVIEW_QUEUE_ID).catch(() => null);
      if (q && q.isTextBased()) {
        const e = new EmbedBuilder()
          .setTitle("📨 Fulfillment Ready — Winner Submitted Email")
          .setDescription(`Claim ID: \`${claimId}\``)
          .addFields(
            { name: "Member", value: `<@${interaction.user.id}>`, inline: true },
            { name: "Firm", value: String(claim.firm_name || "—"), inline: true },
            { name: "Method", value: String(claim.fulfillment_method || "—"), inline: true },
            { name: "Voucher / Link", value: String(claim.voucher_code || "—").slice(0, 900), inline: false },
            { name: "Instructions", value: String(claim.staff_instructions || "—").slice(0, 900), inline: false },
            { name: "Winner Email", value: email, inline: false },
            { name: "Certificate Code", value: `\`${normalizeSerial(claim.serial_code)}\``, inline: false }
          )
          .setColor(0xc9a24d)
          .setTimestamp(new Date());

        if (LOGO_URL) e.setThumbnail(LOGO_URL);

        await q.send({ embeds: [e], components: [staffDeliveredRow(claimId)] }).catch(() => null);
      }

      await interaction.reply({
        content: "✅ Submitted. Staff will complete fulfillment and confirm delivery.",
        ephemeral: true,
      }).catch(() => null);

      return true;
    }
  }

  // Claim modal submit (stage 0)
  if (interaction.isModalSubmit() && interaction.customId === "giveaway_claim_modal") {
    const serialRaw = String(interaction.fields.getTextInputValue("serial") || "").trim();
    const code = normalizeSerial(serialRaw);
    const email = String(interaction.fields.getTextInputValue("email") || "").trim();

    if (!code) {
      await interaction.reply({ content: "❌ Certificate code is required.", ephemeral: true }).catch(() => null);
      return true;
    }

    console.log("[GIVEAWAY_CLAIM] submit", { serialRaw, code, userId: interaction.user.id });

    const cert = await safeFetchCertByCode(code);

    if (cert && cert.legacy) {
      await interaction.reply({
        content: "❌ This is a legacy certificate code and cannot be claimed via the dashboard. Please contact staff.",
        ephemeral: true,
      }).catch(() => null);
      return true;
    }

    if (!cert) {
      await interaction.reply({
        content: "❌ Invalid certificate code. Please check the code on your certificate and try again.",
        ephemeral: true,
      }).catch(() => null);
      return true;
    }

    if (String(cert.userId || "") !== String(interaction.user.id || "")) {
      await interaction.reply({
        content:
          "❌ Claim rejected. This certificate was issued to **another member**.\nOnly the original winner can submit this claim.",
        ephemeral: true,
      }).catch(() => null);
      return true;
    }

    const rewardLabel = String(cert.rewardLabel || "").trim();
    const funded = isFundedReward(rewardLabel);
    const premiumTier = parsePremiumTier(rewardLabel);

    if (funded && !email) {
      await interaction.reply({
        content: "❌ Email is required for funded/prop account rewards. Please submit again with your email.",
        ephemeral: true,
      }).catch(() => null);
      return true;
    }

    const claimId = crypto.randomUUID();

    const ok = await pool
      .query(
        `INSERT INTO public.prop_giveaway_claims
         (id, serial_code, claimant_user_id, email, status, created_at)
         VALUES ($1,$2,$3,$4,'pending',NOW())`,
        [claimId, code, interaction.user.id, email || null]
      )
      .then(() => true)
      .catch((e) => {
        const msg = String(e?.message || e);
        if (msg.includes("duplicate key") || msg.includes("uq_prop_giveaway_claims_serial_code")) return false;
        console.error("[GIVEAWAY_CLAIM] insert failed", msg);
        return null;
      });

    if (ok === false) {
      await interaction.reply({
        content:
          "⚠️ Already submitted. This certificate code has already been submitted/processed.\nIf you believe this is an error, contact staff.",
        ephemeral: true,
      }).catch(() => null);
      return true;
    }
    if (ok === null) {
      await interaction.reply({ content: "❌ Could not create claim. Try again.", ephemeral: true }).catch(() => null);
      return true;
    }

    const q = await client.channels.fetch(REVIEW_QUEUE_ID).catch(() => null);
    if (q && q.isTextBased()) {
      const e = new EmbedBuilder()
        .setTitle("🎁 Claim — Pending Staff Review")
        .setDescription(`Claim ID: \`${claimId}\``)
        .addFields(
          { name: "Member", value: `<@${interaction.user.id}>`, inline: true },
          { name: "Certificate Code", value: `\`${code}\``, inline: true },
          { name: "Cycle", value: String(cert.monthKey || "—"), inline: true },
          { name: "Category", value: String(cert.category || "—"), inline: true },
          { name: "Reward", value: rewardLabel || "—", inline: false },
          { name: "Email", value: email || "—", inline: false },
          {
            name: "Reward Type",
            value: funded ? "Funded/Prop Account" : premiumTier ? `Premium Role (${premiumTier})` : "Other",
            inline: true,
          }
        )
        .setColor(0xc9a24d)
        .setTimestamp(new Date());

      if (LOGO_URL) e.setThumbnail(LOGO_URL);

      await q.send({ embeds: [e], components: [staffRow(claimId)] }).catch(() => null);
    }

    await interaction.reply({
      content: "✅ Claim submitted for staff review. You will be notified after approval or rejection.",
      ephemeral: true,
    }).catch(() => null);

    await interaction.user
      .send(
        `✅ Claim received.\nCertificate Code: ${code}\nReward: ${rewardLabel || "—"}\nYou will be notified after staff review.`
      )
      .catch(() => null);

    return true;
  }

  // Staff approve/reject/delivered
  if (interaction.isButton() && typeof interaction.customId === "string") {
    const id = interaction.customId;

    const approvePrefix = "giveaway_claim_approve:";
    const rejectPrefix = "giveaway_claim_reject:";
    const deliveredPrefix = "giveaway_claim_delivered:";

    const isApprove = id.startsWith(approvePrefix);
    const isReject = id.startsWith(rejectPrefix);
    const isDelivered = id.startsWith(deliveredPrefix);

    if (!isApprove && !isReject && !isDelivered) return false;

    const claimId = id.split(":")[1];
    if (!claimId) {
      if (isApprove) {
        await interaction.reply({ content: "❌ Invalid claim id.", ephemeral: true }).catch(() => null);
      } else {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);
        await interaction.editReply("❌ Invalid claim id.").catch(() => null);
      }
      return true;
    }

    // ✅ APPROVE: modal must be FIRST response (NO defer)
    if (isApprove) {
      await interaction.showModal(buildStaffApproveModal(claimId));
      return true;
    }

    // Reject / Delivered → safe to defer
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    // Delivered action
    if (isDelivered) {
      const claim = await pool
        .query(
          `SELECT id, serial_code, claimant_user_id, status, delivered_at, firm_name, fulfillment_method, voucher_code, staff_instructions, fulfillment_email, email
           FROM public.prop_giveaway_claims
           WHERE id=$1
           LIMIT 1`,
          [claimId]
        )
        .then((r) => r.rows?.[0] || null)
        .catch(() => null);

      if (!claim) {
        await interaction.editReply("❌ Claim not found.").catch(() => null);
        return true;
      }

      if (claim.delivered_at) {
        await interaction.editReply("⚠️ Already marked delivered.").catch(() => null);
        return true;
      }

      if (String(claim.status) !== "approved") {
        await interaction.editReply("⚠️ Claim must be approved before delivery.").catch(() => null);
        return true;
      }

      await pool
        .query(
          `UPDATE public.prop_giveaway_claims
           SET delivered_at=NOW(), delivered_by=$2
           WHERE id=$1`,
          [claimId, interaction.user.id]
        )
        .catch(() => null);

      // ✅ refresh dashboard counts AFTER completion
      await ensureGiveawayDashboard(client).catch(() => null);

      // ✅ log certificate copy + details to VERIFIED_GIVEAWAYS_CHANNEL_ID
      const code = normalizeSerial(claim.serial_code);
      const cert = await safeFetchCertByCode(code);
      if (cert && !cert.legacy) {
        await postDeliveredToVerifiedGiveawaysChannel(client, { claim, cert, code }).catch(() => null);
      }

      // ✅ DM winner delivered message
      const user = await client.users.fetch(String(claim.claimant_user_id)).catch(() => null);
      if (user) {
        const method = String(claim.fulfillment_method || "").toUpperCase();
        const firm = String(claim.firm_name || "the firm");
        const msg =
          method === "VOUCHER"
            ? `🎉 **Congratulations — Delivered!**\nYour giveaway reward has been delivered.\nFirm: **${firm}**\nIf a voucher/link was provided, follow the instructions you received and proceed.\n\n— The Ghana Trader Desk`
            : `🎉 **Congratulations — Delivered!**\nYour giveaway reward has been delivered.\nFirm: **${firm}**\nIf this was a CREDIT method, your account should be credited after staff processing.\n\n— The Ghana Trader Desk`;

        await user.send(msg).catch(() => null);
      }

      await interaction.editReply("✅ Marked delivered (dashboard updated + logged).").catch(() => null);
      return true;
    }

    // Load claim (for reject)
    const claim = await pool
      .query(
        `SELECT id, serial_code, claimant_user_id, status
         FROM public.prop_giveaway_claims
         WHERE id=$1
         LIMIT 1`,
        [claimId]
      )
      .then((r) => r.rows?.[0] || null)
      .catch(() => null);

    if (!claim) {
      await interaction.editReply("❌ Claim not found.").catch(() => null);
      return true;
    }

    if (String(claim.status) !== "pending") {
      await interaction.editReply("⚠️ This claim has already been processed.").catch(() => null);
      return true;
    }

    const code = normalizeSerial(claim.serial_code);
    const cert = await safeFetchCertByCode(code);

    if (!cert || cert.legacy) {
      await pool.query(`UPDATE public.prop_giveaway_claims SET status='rejected' WHERE id=$1`, [claimId]).catch(() => null);
      await interaction.editReply("❌ Certificate not found or legacy. Claim rejected.").catch(() => null);
      return true;
    }

    if (String(cert.userId || "") !== String(claim.claimant_user_id || "")) {
      await pool.query(`UPDATE public.prop_giveaway_claims SET status='rejected' WHERE id=$1`, [claimId]).catch(() => null);
      await interaction.editReply("❌ Owner mismatch detected. Claim rejected and logged.").catch(() => null);
      return true;
    }

    if (isReject) {
      await pool
        .query(
          `UPDATE public.prop_giveaway_claims
           SET status='rejected', decided_at=NOW(), decided_by=$2
           WHERE id=$1`,
          [claimId, interaction.user.id]
        )
        .catch(() => null);

      await interaction.editReply("✅ Rejected.").catch(() => null);

      const user = await client.users.fetch(String(claim.claimant_user_id)).catch(() => null);
      if (user) {
        await user.send(`❌ Your claim was rejected by staff.\nCertificate Code: ${code}`).catch(() => null);
      }

      return true;
    }

    return true;
  }

  // Staff approval modal submit (finalize approve + DM winner + stage2 button)
  if (interaction.isModalSubmit() && typeof interaction.customId === "string") {
    const id = interaction.customId;
    const prefix = "giveaway_staff_approve_modal:";
    if (!id.startsWith(prefix)) return false;

    const claimId = id.split(":")[1];
    if (!claimId) return false;

    const firm = String(interaction.fields.getTextInputValue("firm") || "").trim();
    const methodRaw = String(interaction.fields.getTextInputValue("method") || "").trim().toUpperCase();
    const voucher = String(interaction.fields.getTextInputValue("voucher") || "").trim();
    const instructions = String(interaction.fields.getTextInputValue("instructions") || "").trim();

    if (!firm || !methodRaw || !voucher || !instructions) {
      await interaction.reply({ content: "❌ All fields are required.", ephemeral: true }).catch(() => null);
      return true;
    }

    const method = methodRaw === "VOUCHER" ? "VOUCHER" : methodRaw === "CREDIT" ? "CREDIT" : null;
    if (!method) {
      await interaction.reply({ content: "❌ Method must be VOUCHER or CREDIT.", ephemeral: true }).catch(() => null);
      return true;
    }

    const claim = await pool
      .query(
        `SELECT id, serial_code, claimant_user_id, status
         FROM public.prop_giveaway_claims
         WHERE id=$1
         LIMIT 1`,
        [claimId]
      )
      .then((r) => r.rows?.[0] || null)
      .catch(() => null);

    if (!claim) {
      await interaction.reply({ content: "❌ Claim not found.", ephemeral: true }).catch(() => null);
      return true;
    }

    if (String(claim.status) !== "pending") {
      await interaction.reply({ content: "⚠️ This claim has already been processed.", ephemeral: true }).catch(() => null);
      return true;
    }

    const code = normalizeSerial(claim.serial_code);
    const cert = await safeFetchCertByCode(code);

    if (!cert || cert.legacy) {
      await pool.query(`UPDATE public.prop_giveaway_claims SET status='rejected' WHERE id=$1`, [claimId]).catch(() => null);
      await interaction.reply({ content: "❌ Certificate not found/legacy. Claim rejected.", ephemeral: true }).catch(() => null);
      return true;
    }

    if (String(cert.userId || "") !== String(claim.claimant_user_id || "")) {
      await pool.query(`UPDATE public.prop_giveaway_claims SET status='rejected' WHERE id=$1`, [claimId]).catch(() => null);
      await interaction.reply({ content: "❌ Owner mismatch detected. Claim rejected.", ephemeral: true }).catch(() => null);
      return true;
    }

    const rewardLabel = String(cert.rewardLabel || "").trim();
    const premiumTier = parsePremiumTier(rewardLabel);

    let roleAction = "none";
    if (premiumTier) {
      const targetRoleId = roleIdForTier(premiumTier);

      if (!targetRoleId) {
        roleAction = "missing_role_env";
      } else {
        const guild =
          interaction.guild ||
          (await client.guilds.fetch(String(process.env.DISCORD_GUILD_ID || "")).catch(() => null));

        const member = guild ? await guild.members.fetch(String(claim.claimant_user_id)).catch(() => null) : null;

        if (!member) {
          roleAction = "member_not_found";
        } else {
          const currentTier = memberHighestTier(member);
          const currentRank = tierRank(currentTier);
          const targetRank = tierRank(premiumTier);

          if (currentRank >= targetRank) {
            roleAction = `skipped_already_${currentTier || "higher"}`;
          } else {
            await member.roles.add(targetRoleId).catch(() => null);
            roleAction = `granted_${premiumTier}`;
          }
        }
      }
    }

    await pool
      .query(
        `UPDATE public.prop_giveaway_claims
         SET status='approved',
             decided_at=NOW(),
             decided_by=$2,
             firm_name=$3,
             fulfillment_method=$4,
             voucher_code=$5,
             staff_instructions=$6
         WHERE id=$1`,
        [claimId, interaction.user.id, firm, method, voucher, instructions]
      )
      .catch(() => null);

    const user = await client.users.fetch(String(claim.claimant_user_id)).catch(() => null);
    if (user) {
      const methodLine =
        method === "VOUCHER"
          ? `**Voucher/Link:** ${voucher}`
          : `**Affiliate Link / Tracking:** ${voucher}`;

      const extraRole = premiumTier ? `\n**Role:** ${roleAction.replace(/_/g, " ")}` : "";

      const msg = [
        "✅ **Claim Approved — Next Step Required**",
        "",
        `**Reward:** ${rewardLabel || "—"}`,
        `**Firm:** ${firm}`,
        `**Method:** ${method}`,
        methodLine,
        "",
        `**Instructions:** ${instructions}`,
        "",
        "Now create your account on the firm site (if required), then submit the email you used:",
        extraRole,
      ].filter(Boolean).join("\n");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`giveaway_submit_firm_email:${claimId}`)
          .setLabel("📩 Submit Firm Email")
          .setStyle(ButtonStyle.Primary)
      );

      await user.send({ content: msg, components: [row] }).catch(() => null);
    }

    await interaction.reply({ content: "✅ Approved + fulfillment assigned.", ephemeral: true }).catch(() => null);
    return true;
  }

  return false;
}

// ✅ Backward-compatible alias (keeps index.js imports stable)
async function handleGiveawayDashboardInteractions(client, interaction) {
  return handleGiveawayInteractions(client, interaction);
}

module.exports = {
  ensureGiveawayDashboard,
  handleGiveawayDashboardInteractions,
};
