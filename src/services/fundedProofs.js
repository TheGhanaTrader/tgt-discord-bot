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
const crypto = require("crypto");
const { logFunded } = require("./propLedger");
const { Pool } = require("pg");

// ✅ ADD: hard-require DATABASE_URL so Railway never falls back to localhost
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  console.error("[FUNDED_DASHBOARD] FATAL: DATABASE_URL is missing in env");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

const FUNDED_CHANNEL_ID = String(
  process.env.FUNDED_CERT_CHANNEL_ID || ""
).trim();
const REVIEW_QUEUE_ID = String(
  process.env.PROOF_REVIEW_QUEUE_CHANNEL_ID || ""
).trim();
const LOGO_URL = String(process.env.TGT_LOGO_URL || "").trim();

const DASH_MARKER = "TGT_FUNDED_DASHBOARD";
const GENERAL_CHAT_ID = String(process.env.GENERAL_CHAT_CHANNEL_ID || "").trim();
const VERIFIED_FUNDED_ARCHIVE_ID = String(process.env.VERIFIED_FUNDED_ACCOUNTS_CHANNEL_ID || "").trim();

function monthKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function yearKeyUTC(d = new Date()) {
  return String(d.getUTCFullYear());
}
function prevMonthKeyUTC() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthKeyUTC(d);
}
function fmtMoneyUSD(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

async function computeFundedTotals() {
  const mkThis = monthKeyUTC();
  const mkPrev = prevMonthKeyUTC();
  const yk = yearKeyUTC();

  const qSum = async (whereSql, params) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(account_size),0) AS s FROM prop_funded ${whereSql}`,
      params
    );
    return Number(rows?.[0]?.s || 0);
  };
  const qCount = async (whereSql, params) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM prop_funded ${whereSql}`,
      params
    );
    return Number(rows?.[0]?.c || 0);
  };

  const prevMonth = await qSum("WHERE month_key = $1", [mkPrev]);
  const ytd = await qSum("WHERE year_key = $1", [yk]);
  const all = await qSum("", []);
  const liveCapital = await qSum("WHERE status = 'live'", []);
  const liveAccounts = await qCount("WHERE status = 'live'", []);

  const thisMonth = await qSum("WHERE month_key = $1", [mkThis]);

  return {
    mkThis,
    mkPrev,
    yk,
    prevMonth,
    thisMonth,
    ytd,
    all,
    liveCapital,
    liveAccounts,
  };
}

function dashboardEmbed(t) {
  const e = new EmbedBuilder()
    .setTitle("💼 Funded Certificates Dashboard")
    .setDescription(
      "Verified funded accounts submitted by members and approved by staff."
    )
    .addFields(
      {
        name: "💼 Funded Capital (Verified)",
        value:
          `• **Previous Month:** ${fmtMoneyUSD(t.prevMonth)}\n` +
          `• **This Month:** ${fmtMoneyUSD(t.thisMonth)}\n` +
          `• **Year-to-Date:** ${fmtMoneyUSD(t.ytd)}\n` +
          `• **All-Time:** ${fmtMoneyUSD(t.all)}`,
      },
      {
        name: "🟢 Live Funded Capital",
        value:
          `• **Active Capital:** ${fmtMoneyUSD(t.liveCapital)}\n` +
          `• **Active Accounts:** **${t.liveAccounts}**`,
      }
    )
    .setFooter({
      text: `The Ghana Trader Desk • Staff-Verified Proof • ${DASH_MARKER}`,
    })
    .setColor(0xc9a24d)
    .setTimestamp(new Date());

  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  return e;
}

function dashboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("funded_submit")
        .setLabel("➕ Submit Funded Certificate")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

async function findPinnedDashboardMessage(channel) {
  // STEP 1: Look ONLY at pinned messages
const pinned = await channel.messages.fetchPinned();

// STEP 2: Find existing dashboard by marker
const existing = pinned.find(
  m => m.author.id === client.user.id &&
       m.embeds?.[0]?.footer?.text?.includes("TGT_FUNDED_DASHBOARD")
);

// STEP 3: If exists → EDIT ONLY
if (existing) {
  await existing.edit({ embeds: [embed], components: [row] });
  console.log("[FUNDED_DASHBOARD] updated existing dashboard");
  return;
}

// STEP 4: If not exists → POST ONCE
const msg = await channel.send({ embeds: [embed], components: [row] });
await msg.pin();
console.log("[FUNDED_DASHBOARD] created and pinned dashboard");

  const pickFrom = strict.size ? strict : legacy;
  const keeper =
    pickFrom.sort((a, b) => b.createdTimestamp - a.createdTimestamp).first() ||
    null;

  // unpin duplicates of this dashboard
  if (keeper) {
    for (const p of pins.values()) {
      if (p.id === keeper.id) continue;
      const title = p.embeds?.[0]?.title || "";
      if (title !== "💼 Funded Certificates Dashboard") continue;
      try {
        await p.unpin();
      } catch {}
    }
  }

  return keeper;
}

async function ensureFundedDashboard(client) {
  console.log("[FUNDED_DASHBOARD] start", {
    ts: new Date().toISOString(),
    FUNDED_CERT_CHANNEL_ID: FUNDED_CHANNEL_ID ? "set" : "MISSING",
    PROOF_REVIEW_QUEUE_CHANNEL_ID: REVIEW_QUEUE_ID ? "set" : "MISSING",
    NODE_ENV: process.env.NODE_ENV || null,
    DATABASE_URL: DATABASE_URL ? "set" : "MISSING",
  });

  if (!DATABASE_URL) {
    console.error("[FUNDED_DASHBOARD] abort: DATABASE_URL missing");
    return;
  }

  if (!FUNDED_CHANNEL_ID) {
    console.error("[FUNDED_DASHBOARD] abort: FUNDED_CERT_CHANNEL_ID missing");
    return;
  }

  const ch = await client.channels.fetch(FUNDED_CHANNEL_ID).catch((e) => {
    console.error(
      "[FUNDED_DASHBOARD] abort: channel fetch failed",
      String(e?.message || e)
    );
    return null;
  });

  if (!ch) return;
  if (!ch.isTextBased()) {
    console.error("[FUNDED_DASHBOARD] abort: channel is not text-based");
    return;
  }

  const totals = await computeFundedTotals().catch((e) => {
    console.error("[FUNDED_DASHBOARD] abort: computeFundedTotals failed", e);

    // If pg throws AggregateError, surface inner causes
    if (e && Array.isArray(e.errors)) {
      for (const inner of e.errors) {
        console.error("[FUNDED_DASHBOARD] inner", inner);
      }
    }

    return null;
  });

  if (!totals) return;

  let msg = await findPinnedDashboardMessage(ch).catch(() => null);

if (!msg) {
  console.warn("[FUNDED_DASHBOARD] No pinned dashboard found — edit-only mode (no repost).");
  return;
}

// EDIT ONLY — NEVER POST AGAIN
await msg
  .edit({ embeds: [dashboardEmbed(totals)], components: dashboardComponents() })
  .catch((e) => console.error("[FUNDED_DASHBOARD] edit failed", String(e?.message || e)));

console.log("[FUNDED_DASHBOARD] done");
}

function buildFundedSubmitModal() {
  const m = new ModalBuilder()
    .setCustomId("funded_modal")
    .setTitle("Submit Funded Certificate");

  const firm = new TextInputBuilder()
    .setCustomId("firm")
    .setLabel("Prop Firm Name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const amount = new TextInputBuilder()
    .setCustomId("accountSize")
    .setLabel("Funded Amount (USD) e.g. 50000")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const status = new TextInputBuilder()
    .setCustomId("status")
    .setLabel("Status: live or lost")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const fundedDate = new TextInputBuilder()
    .setCustomId("fundedDate")
    .setLabel("Date Funded (YYYY-MM-DD) optional")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const proof = new TextInputBuilder()
    .setCustomId("proofLink")
    .setLabel("Proof Link (attachment/message URL)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  m.addComponents(
    new ActionRowBuilder().addComponents(firm),
    new ActionRowBuilder().addComponents(amount),
    new ActionRowBuilder().addComponents(status),
    new ActionRowBuilder().addComponents(fundedDate),
    new ActionRowBuilder().addComponents(proof)
  );

  return m;
}

function reviewEmbed(payload, submissionId, userId) {
  const e = new EmbedBuilder()
    .setTitle("🧾 Funded Submission — Pending Review")
    .setDescription(`Submission ID: \`${submissionId}\``)
    .addFields(
      { name: "Member", value: `<@${userId}>`, inline: true },
      { name: "Firm", value: payload.firm, inline: true },
      {
        name: "Funded Amount",
        value: fmtMoneyUSD(payload.accountSize),
        inline: true,
      },
      { name: "Status", value: String(payload.status).toUpperCase(), inline: true },
      { name: "Funded Date", value: payload.fundedDate || "—", inline: true },
      { name: "Proof", value: payload.proofLink, inline: false }
    )
    .setColor(0xc9a24d)
    .setTimestamp(new Date());

  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  return e;
}

function reviewButtons(submissionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`funded_approve:${submissionId}`)
        .setLabel("✅ Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`funded_reject:${submissionId}`)
        .setLabel("❌ Reject")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function verifiedPublicEmbed(payload, userId, totalsAfter, proofImageUrl) {
  const e = new EmbedBuilder()
    .setTitle("✅ Verified Funded Account")
    .setDescription(
      `Congratulations <@${userId}> — **${fmtMoneyUSD(
        payload.accountSize
      )} funded** with **${payload.firm}**.`
    )
    .addFields(
      { name: "Status", value: String(payload.status).toUpperCase(), inline: true },
      { name: "Funded Date", value: payload.fundedDate || "—", inline: true },
      { name: "Proof", value: payload.proofLink, inline: false },
      {
        name: "📊 Updated Totals (after this approval)",
        value:
          `• **Previous Month:** ${fmtMoneyUSD(totalsAfter.prevMonth)}\n` +
          `• **This Month:** ${fmtMoneyUSD(totalsAfter.thisMonth)}\n` +
          `• **Year-to-Date:** ${fmtMoneyUSD(totalsAfter.ytd)}\n` +
          `• **All-Time:** ${fmtMoneyUSD(totalsAfter.all)}\n` +
          `• **Live Capital:** ${fmtMoneyUSD(totalsAfter.liveCapital)} (**${totalsAfter.liveAccounts}** active)`,
      }
    )
    .setFooter({ text: "The Ghana Trader Desk • Staff-Verified Proof" })
    .setColor(0xc9a24d)
    .setTimestamp(new Date());

  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  if (proofImageUrl) e.setImage(proofImageUrl);
  return e;
}

function buildRejectReasonModal(submissionId) {
  const m = new ModalBuilder()
    .setCustomId(`funded_reject_modal:${submissionId}`)
    .setTitle("Reject Submission");

  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Rejection reason (clear + actionable)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  m.addComponents(new ActionRowBuilder().addComponents(reason));
  return m;
}

// ---------------- DB helpers ----------------
async function createSubmission(type, userId, payload) {
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO proof_submissions (id, type, user_id, status, payload) VALUES ($1,$2,$3,'pending',$4)",
    [id, type, userId, payload]
  );
  return id;
}

async function getSubmission(id) {
  const { rows } = await pool.query("SELECT * FROM proof_submissions WHERE id = $1", [id]);
  return rows?.[0] || null;
}

async function markApproved(id, reviewerId) {
  await pool.query(
    "UPDATE proof_submissions SET status='approved', reviewer_id=$2, reviewed_at=NOW() WHERE id=$1",
    [id, reviewerId]
  );
}

async function markRejected(id, reviewerId, reason) {
  await pool.query(
    "UPDATE proof_submissions SET status='rejected', reviewer_id=$2, reviewed_at=NOW(), reject_reason=$3 WHERE id=$1",
    [id, reviewerId, reason]
  );
}

async function resolveProofImageUrl(client, proofLink) {
  const link = String(proofLink || "").trim();
  if (!link) return null;

  // If it's a direct image URL
  if (/^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(link)) return link;

  // If it's a Discord message link: /channels/guildId/channelId/messageId
  const m = link.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;

  const channelId = m[2];
  const messageId = m[3];

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return null;

  const msg = await ch.messages.fetch(messageId).catch(() => null);
  if (!msg) return null;

  const att = msg.attachments?.first?.() || null;
  if (!att) return null;

  // Prefer image attachments only
  const url = att.url || null;
  if (!url) return null;

  return url;
}

// ---------------- Interaction handler ----------------
async function handleFundedInteractions(client, interaction) {
  // Button: open modal
  if (interaction.isButton() && interaction.customId === "funded_submit") {
    await interaction.showModal(buildFundedSubmitModal());
    return true;
  }

  // Modal submit: create pending + post to review queue + DM user
  if (interaction.isModalSubmit() && interaction.customId === "funded_modal") {
    const firm = interaction.fields.getTextInputValue("firm")?.trim();
    const accountSizeRaw = interaction.fields.getTextInputValue("accountSize")?.trim();
    const statusRaw = interaction.fields.getTextInputValue("status")?.trim().toLowerCase();
    const fundedDate = interaction.fields.getTextInputValue("fundedDate")?.trim();
    const proofLink = interaction.fields.getTextInputValue("proofLink")?.trim();

    const accountSize = Number(accountSizeRaw);
    const status = statusRaw === "live" || statusRaw === "lost" ? statusRaw : null;

    if (!firm || !Number.isFinite(accountSize) || accountSize <= 0 || !status || !proofLink) {
      await interaction.reply({
        content:
          "❌ Invalid submission. Please ensure firm, amount (number), status (live/lost) and proof link are correct.",
        ephemeral: true,
      });
      return true;
    }

    const payload = { firm, accountSize, status, fundedDate: fundedDate || null, proofLink };
    const submissionId = await createSubmission("funded", interaction.user.id, payload);

    const q = await client.channels.fetch(REVIEW_QUEUE_ID).catch(() => null);
    if (q && q.isTextBased()) {
      await q
        .send({
          embeds: [reviewEmbed(payload, submissionId, interaction.user.id)],
          components: reviewButtons(submissionId),
        })
        .catch(() => null);
    }

    // Acknowledge member
    await interaction.reply({
      content: "✅ Submitted for staff review. You’ll be notified after approval or rejection.",
      ephemeral: true,
    });
    await interaction.user
      .send(`✅ Your funded submission was received and is pending staff review.\nSubmission ID: ${submissionId}`)
      .catch(() => null);

    return true;
  }

  // Approve button
  if (interaction.isButton() && interaction.customId.startsWith("funded_approve:")) {
    const submissionId = interaction.customId.split(":")[1];
    const sub = await getSubmission(submissionId).catch(() => null);

    if (!sub || sub.status !== "pending") {
      await interaction.reply({
        content: "❌ This submission is not pending (already handled or missing).",
        ephemeral: true,
      });
      return true;
    }

    const payload = sub.payload;
    await markApproved(submissionId, interaction.user.id).catch(() => null);

    // 1) Persist to Postgres (THIS is what makes dashboard totals update)
await pool.query(
  `INSERT INTO prop_funded (id, user_id, firm, account_size, status, funded_date, month_key, year_key, created_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
  [
    crypto.randomUUID(),
    sub.user_id,
    payload.firm,
    payload.accountSize,
    payload.status,
    payload.fundedDate || null,
    monthKeyUTC(),
    yearKeyUTC(),
  ]
).catch(() => null);

// Keep your existing log (optional / no harm)
await logFunded({
  userId: sub.user_id,
  firm: payload.firm,
  accountSize: payload.accountSize,
  status: payload.status,
  fundedDate: payload.fundedDate,
}).catch(() => null);

// 2) Recompute totals + refresh dashboard (EDIT ONLY)
const totalsAfter = await computeFundedTotals().catch(() => null);
await ensureFundedDashboard(client).catch(() => null);

// 3) Resolve proof image and post congrats to General + Archive (NOT the dashboard channel)
const proofImageUrl = await resolveProofImageUrl(client, payload.proofLink).catch(() => null);
const congratsEmbed = totalsAfter
  ? verifiedPublicEmbed(payload, sub.user_id, totalsAfter, proofImageUrl)
  : verifiedPublicEmbed(payload, sub.user_id, { prevMonth:0,thisMonth:0,ytd:0,all:0,liveCapital:0,liveAccounts:0 }, proofImageUrl);

const targets = [GENERAL_CHAT_ID, VERIFIED_FUNDED_ARCHIVE_ID].filter(Boolean);

for (const channelId of targets) {
  const c = await client.channels.fetch(channelId).catch(() => null);
  if (c && c.isTextBased()) {
    await c.send({ embeds: [congratsEmbed] }).catch(() => null);
  }
}

    // DM member approved
    const user = await client.users.fetch(sub.user_id).catch(() => null);
    if (user) {
      await user.send(
        `✅ Approved! Your funded certificate has been verified and posted publicly in #funded-certificates.`
      ).catch(() => null);
    }

    // Acknowledge staff action + disable buttons
    await interaction.update({ content: "✅ Approved and posted publicly.", components: [] }).catch(() => null);
    return true;
  }

  // Reject button -> open rejection reason modal
  if (interaction.isButton() && interaction.customId.startsWith("funded_reject:")) {
    const submissionId = interaction.customId.split(":")[1];
    await interaction.showModal(buildRejectReasonModal(submissionId));
    return true;
  }

  // Reject modal submit: store reason + DM user
  if (interaction.isModalSubmit() && interaction.customId.startsWith("funded_reject_modal:")) {
    const submissionId = interaction.customId.split(":")[1];
    const reason = interaction.fields.getTextInputValue("reason")?.trim();

    const sub = await getSubmission(submissionId).catch(() => null);
    if (!sub || sub.status !== "pending") {
      await interaction.reply({
        content: "❌ This submission is not pending (already handled or missing).",
        ephemeral: true,
      });
      return true;
    }

    await markRejected(submissionId, interaction.user.id, reason).catch(() => null);

    const user = await client.users.fetch(sub.user_id).catch(() => null);
    if (user) {
      await user
        .send(
          `❌ Your funded submission was rejected.\n\nReason:\n${reason}\n\nFix the issue and resubmit using the Submit button in #funded-certificates.`
        )
        .catch(() => null);
    }

    await interaction.reply({ content: "❌ Rejected. The member has been notified by DM.", ephemeral: true });
    return true;
  }

  return false;
}

module.exports = {
  ensureFundedDashboard,
  handleFundedInteractions,
};
