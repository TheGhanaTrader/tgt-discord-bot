"use strict";

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { Pool } = require("pg");
const crypto = require("crypto");

// ✅ Certificate ledger is the source of truth for claim eligibility + owner
const {
  findCertificateByCode,
  findLegacyByCode,
  markCertificateClaimed,
} = require("./certificatesLedger");

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
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, ""); // removes dashes/spaces/etc
}

function monthKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function yearKeyUTC(d = new Date()) {
  return String(d.getUTCFullYear());
}

function fmtMoneyUSD(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
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
  // ledger functions are async
  const c = await findCertificateByCode(code).catch(() => null);
  if (c) return c;

  // legacy is optional; legacy entries are not claimable (no userId)
  const legacy = await findLegacyByCode(code).catch(() => null);
  if (legacy) return { legacy: true, code: legacy.code };

  return null;
}

// ---------------- Totals ----------------
// NOTE: prop_giveaway_issued may be empty (by design now).
// We still show pending count from claims, and keep totals for approved claims.
async function computeGiveawayTotals() {
  const mkThis = monthKeyUTC();
  const yk = yearKeyUTC();

  const q = async (sql, params) => {
    const { rows } = await pool.query(sql, params);
    return rows?.[0] || {};
  };

  // Approved count only (value is unknown without issued table; show 0 value)
  const lifetime = await q(
    `SELECT COUNT(*)::int AS cnt
     FROM public.prop_giveaway_claims
     WHERE status='approved'`,
    []
  );

  const ytd = await q(
    `SELECT COUNT(*)::int AS cnt
     FROM public.prop_giveaway_claims
     WHERE status='approved' AND EXTRACT(YEAR FROM created_at) = $1`,
    [Number(yk)]
  );

  const thisMonth = await q(
    `SELECT COUNT(*)::int AS cnt
     FROM public.prop_giveaway_claims
     WHERE status='approved' AND TO_CHAR(created_at AT TIME ZONE 'UTC','YYYY-MM') = $1`,
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
    lifetimeSum: 0,
    ytdCnt: Number(ytd.cnt || 0),
    ytdSum: 0,
    monthCnt: Number(thisMonth.cnt || 0),
    monthSum: 0,
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
        "Staff approvals are logged for auditability.",
      ].join("\n")
    )
    .addFields(
      {
        name: "📅 This Month",
        value: `• **Approved Claims:** **${t.monthCnt}**`,
        inline: true,
      },
      {
        name: "📈 Year-to-Date",
        value: `• **Approved Claims:** **${t.ytdCnt}**`,
        inline: true,
      },
      {
        name: "🏛️ Lifetime",
        value: `• **Approved Claims:** **${t.lifetimeCnt}**`,
        inline: true,
      },
      {
        name: "🛡️ Operations",
        value: `• **Pending Claims:** **${t.pendingCnt}**`,
        inline: false,
      }
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

  // Email is OPTIONAL; required only for funded/prop rewards
  const email = new TextInputBuilder()
    .setCustomId("email")
    .setLabel("Email (required only for funded/prop account rewards)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  m.addComponents(
    new ActionRowBuilder().addComponents(serial),
    new ActionRowBuilder().addComponents(email)
  );

  return m;
}

// ---------------- Core Interaction Handler ----------------
async function handleGiveawayInteractions(client, interaction) {
  // Button: open modal
  if (interaction.isButton() && interaction.customId === "giveaway_claim") {
    await interaction.showModal(buildClaimModal());
    return true;
  }

  // Modal submit: strict owner check + create pending claim
  if (interaction.isModalSubmit() && interaction.customId === "giveaway_claim_modal") {
    const serialRaw = String(interaction.fields.getTextInputValue("serial") || "").trim();
    const code = normalizeSerial(serialRaw);

    const email = String(interaction.fields.getTextInputValue("email") || "").trim();

    if (!code) {
      await interaction.reply({ content: "❌ Certificate code is required.", ephemeral: true });
      return true;
    }

    console.log("[GIVEAWAY_CLAIM] submit", { serialRaw, code, userId: interaction.user.id });

    const cert = await safeFetchCertByCode(code);

    // Legacy certs are not claimable (no userId)
    if (cert && cert.legacy) {
      await interaction.reply({
        content: "❌ This is a legacy certificate code and cannot be claimed via the dashboard. Please contact staff.",
        ephemeral: true,
      });
      return true;
    }

    if (!cert) {
      await interaction.reply({
        content: "❌ Invalid certificate code. Please check the code on your certificate and try again.",
        ephemeral: true,
      });
      return true;
    }

    // Strict: only the winner can claim
    if (String(cert.userId || "") !== String(interaction.user.id || "")) {
      await interaction.reply({
        content:
          "❌ Claim rejected. This certificate was issued to **another member**.\nOnly the original winner can submit this claim.",
        ephemeral: true,
      });
      return true;
    }

    // Reject if already claimed in ledger
    if (cert.claimed) {
      await interaction.reply({
        content:
          "⚠️ Already claimed. This certificate reward has already been processed.\nIf you believe this is an error, contact staff.",
        ephemeral: true,
      });
      return true;
    }

    const rewardLabel = String(cert.rewardLabel || "").trim();
    const funded = isFundedReward(rewardLabel);
    const premiumTier = parsePremiumTier(rewardLabel);

    if (funded && !email) {
      await interaction.reply({
        content: "❌ Email is required for funded/prop account rewards. Please submit again with your email.",
        ephemeral: true,
      });
      return true;
    }

    const claimId = crypto.randomUUID();

    // Insert pending claim (idempotent on serial_code if unique constraint exists)
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
        if (msg.includes("duplicate key") || msg.includes("uq_giveaway_claims_serial_code")) return false;
        console.error("[GIVEAWAY_CLAIM] insert failed", msg);
        return null;
      });

    if (ok === false) {
      await interaction.reply({
        content:
          "⚠️ Already submitted. This certificate code has already been submitted/processed.\nIf you believe this is an error, contact staff.",
        ephemeral: true,
      });
      return true;
    }
    if (ok === null) {
      await interaction.reply({ content: "❌ Could not create claim. Try again.", ephemeral: true });
      return true;
    }

    // Staff review post
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
          { name: "Reward Type", value: funded ? "Funded/Prop Account" : premiumTier ? `Premium Role (${premiumTier})` : "Other", inline: true }
        )
        .setColor(0xc9a24d)
        .setTimestamp(new Date());

      if (LOGO_URL) e.setThumbnail(LOGO_URL);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`giveaway_claim_approve:${claimId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`giveaway_claim_reject:${claimId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
      );

      await q.send({ embeds: [e], components: [row] }).catch(() => null);
    }

    await interaction.reply({
      content: "✅ Claim submitted for staff review. You will be notified after approval or rejection.",
      ephemeral: true,
    });

    await interaction.user
      .send(
        `✅ Claim received.\nCertificate Code: ${code}\nReward: ${rewardLabel || "—"}\nYou will be notified after staff review.`
      )
      .catch(() => null);

    return true;
  }

  // Staff approve/reject buttons
  if (interaction.isButton() && typeof interaction.customId === "string") {
    const id = interaction.customId;

    const approvePrefix = "giveaway_claim_approve:";
    const rejectPrefix = "giveaway_claim_reject:";

    const isApprove = id.startsWith(approvePrefix);
    const isReject = id.startsWith(rejectPrefix);
    if (!isApprove && !isReject) return false;

    const claimId = id.split(":")[1];
    if (!claimId) return false;

    // Load claim row
    const claim = await pool
      .query(
        `SELECT id, serial_code, claimant_user_id, email, status
         FROM public.prop_giveaway_claims
         WHERE id=$1
         LIMIT 1`,
        [claimId]
      )
      .then((r) => r.rows?.[0] || null)
      .catch(() => null);

    if (!claim) {
      await interaction.reply({ content: "❌ Claim not found.", ephemeral: true });
      return true;
    }

    if (String(claim.status) !== "pending") {
      await interaction.reply({ content: "⚠️ This claim has already been processed.", ephemeral: true });
      return true;
    }

    const code = normalizeSerial(claim.serial_code);

    const cert = await safeFetchCertByCode(code);
    if (!cert || cert.legacy) {
      await interaction.reply({ content: "❌ Certificate not found or legacy. Cannot approve.", ephemeral: true });
      return true;
    }

    // Strict owner re-check
    if (String(cert.userId || "") !== String(claim.claimant_user_id || "")) {
      await pool.query(`UPDATE public.prop_giveaway_claims SET status='rejected' WHERE id=$1`, [claimId]).catch(() => null);
      await interaction.reply({
        content: "❌ Owner mismatch detected. Claim rejected and logged.",
        ephemeral: true,
      });
      return true;
    }

    // Already claimed in ledger
    if (cert.claimed) {
      await pool.query(`UPDATE public.prop_giveaway_claims SET status='rejected' WHERE id=$1`, [claimId]).catch(() => null);
      await interaction.reply({
        content: "⚠️ Certificate already claimed previously. Claim rejected.",
        ephemeral: true,
      });
      return true;
    }

    if (isReject) {
      await pool.query(`UPDATE public.prop_giveaway_claims SET status='rejected' WHERE id=$1`, [claimId]).catch(() => null);

      await interaction.reply({ content: "✅ Rejected.", ephemeral: true });

      const user = await client.users.fetch(String(claim.claimant_user_id)).catch(() => null);
      if (user) {
        await user.send(`❌ Your claim was rejected by staff.\nCertificate Code: ${code}`).catch(() => null);
      }

      return true;
    }

    // Approve path
    const rewardLabel = String(cert.rewardLabel || "").trim();
    const funded = isFundedReward(rewardLabel);
    const premiumTier = parsePremiumTier(rewardLabel);

    // If funded reward, email should exist (but don't hard-fail approval)
    // Staff can still proceed if needed.

    // Premium role grant (upgrade-only, otherwise skip)
    let roleAction = "none";
    if (premiumTier) {
      const targetRoleId = roleIdForTier(premiumTier);

      if (!targetRoleId) {
        roleAction = "missing_role_env";
      } else {
        const guild = interaction.guild || (await client.guilds.fetch(String(process.env.DISCORD_GUILD_ID || "")).catch(() => null));
        const member = guild ? await guild.members.fetch(String(claim.claimant_user_id)).catch(() => null) : null;

        if (!member) {
          roleAction = "member_not_found";
        } else {
          const currentTier = memberHighestTier(member);
          const currentRank = tierRank(currentTier);
          const targetRank = tierRank(premiumTier);

          if (currentRank >= targetRank) {
            // ✅ approved behavior: skip if higher/equal
            roleAction = `skipped_already_${currentTier || "higher"}`;
          } else {
            await member.roles.add(targetRoleId).catch(() => null);
            roleAction = `granted_${premiumTier}`;
          }
        }
      }
    }

    // Mark certificate claimed in ledger (forever memory)
    const marked = await markCertificateClaimed(code, {
      adminId: interaction.user.id,
      ref: claimId,
      note: funded ? `funded_claim:${String(claim.email || "").slice(0, 120)}` : `claim_approved:${rewardLabel.slice(0, 120)}`,
    }).catch(() => null);

    if (!marked || !marked.ok) {
      await interaction.reply({ content: "❌ Could not mark certificate claimed. Approval aborted.", ephemeral: true });
      return true;
    }

    await pool.query(`UPDATE public.prop_giveaway_claims SET status='approved' WHERE id=$1`, [claimId]).catch(() => null);

    await interaction.reply({ content: "✅ Approved.", ephemeral: true });

    // DM winner
    const user = await client.users.fetch(String(claim.claimant_user_id)).catch(() => null);
    if (user) {
      const extra =
        premiumTier
          ? `\nRole: ${roleAction.replace(/_/g, " ")}`
          : funded
          ? `\nStaff will proceed with account setup.`
          : ``;

      await user
        .send(`✅ Your claim was approved.\nCertificate Code: ${code}\nReward: ${rewardLabel || "—"}${extra}`)
        .catch(() => null);
    }

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
