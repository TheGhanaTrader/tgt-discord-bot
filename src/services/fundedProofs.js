"use strict";

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} = require("discord.js");

const crypto = require("crypto");
const { logFunded } = require("./propLedger");
const { Pool } = require("pg");

// ---------------- ENV / PG ----------------
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  console.error("[FUNDED_DASHBOARD] FATAL: DATABASE_URL is missing in env");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const FUNDED_CHANNEL_ID = String(process.env.FUNDED_CERT_CHANNEL_ID || "").trim(); // parent channel (funded-account-submission)
const REVIEW_QUEUE_ID = String(process.env.PROOF_REVIEW_QUEUE_CHANNEL_ID || "").trim();
const GENERAL_CHAT_ID = String(process.env.GENERAL_CHAT_CHANNEL_ID || "").trim();
const VERIFIED_FUNDED_ARCHIVE_ID = String(process.env.VERIFIED_FUNDED_ACCOUNTS_CHANNEL_ID || "").trim();
const LOGO_URL = String(process.env.TGT_LOGO_URL || "").trim();

const DASH_MARKER = "TGT_FUNDED_DASHBOARD";

// ---------------- Helpers ----------------
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
  const thisMonth = await qSum("WHERE month_key = $1", [mkThis]);
  const ytd = await qSum("WHERE year_key = $1", [yk]);
  const all = await qSum("", []);
  const liveCapital = await qSum("WHERE status = 'live'", []);
  const liveAccounts = await qCount("WHERE status = 'live'", []);

  return { mkThis, mkPrev, yk, prevMonth, thisMonth, ytd, all, liveCapital, liveAccounts };
}

function dashboardEmbed(t) {
  const e = new EmbedBuilder()
    .setTitle("💼 Funded Certificates Dashboard")
    .setDescription("Verified funded accounts submitted by members and approved by staff.")
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
    .setFooter({ text: `The Ghana Trader Desk • Staff-Verified Proof • ${DASH_MARKER}` })
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

// PINS: find ONLY (no unpin, no posting)
async function findPinnedDashboardMessage(channel, client) {
  const pins = await channel.messages.fetchPinned().catch(() => null);
  if (!pins) return null;

  const strict = pins.filter((m) => {
    if (!m.author?.bot) return false;
    if (client?.user?.id && m.author.id !== client.user.id) return false;
    const title = m.embeds?.[0]?.title || "";
    if (title !== "💼 Funded Certificates Dashboard") return false;
    const footer = m.embeds?.[0]?.footer?.text || "";
    return footer.includes(DASH_MARKER);
  });

  const pick = strict.sort((a, b) => b.createdTimestamp - a.createdTimestamp).first() || null;
  return pick;
}

// EDIT ONLY — never create / never pin
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

  const ch = await client.channels.fetch(FUNDED_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    console.error("[FUNDED_DASHBOARD] abort: funded channel missing or not text-based");
    return;
  }

  const totals = await computeFundedTotals().catch((e) => {
    console.error("[FUNDED_DASHBOARD] abort: computeFundedTotals failed", e);
    return null;
  });
  if (!totals) return;

  const msg = await findPinnedDashboardMessage(ch, client).catch(() => null);
  if (!msg) {
    console.warn("[FUNDED_DASHBOARD] No pinned dashboard found — edit-only mode (no repost).");
    return;
  }

  await msg
    .edit({ embeds: [dashboardEmbed(totals)], components: dashboardComponents() })
    .catch((e) => console.error("[FUNDED_DASHBOARD] edit failed", String(e?.message || e)));

  console.log("[FUNDED_DASHBOARD] done");
}

// ---------------- Embeds / UI ----------------
function buildFundedSubmitModal() {
  const m = new ModalBuilder().setCustomId("funded_modal").setTitle("Submit Funded Certificate");

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

  m.addComponents(
    new ActionRowBuilder().addComponents(firm),
    new ActionRowBuilder().addComponents(amount),
    new ActionRowBuilder().addComponents(status),
    new ActionRowBuilder().addComponents(fundedDate)
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
      { name: "Funded Amount", value: fmtMoneyUSD(payload.accountSize), inline: true },
      { name: "Status", value: String(payload.status).toUpperCase(), inline: true },
      { name: "Funded Date", value: payload.fundedDate || "—", inline: true },
      { name: "Proof (image)", value: payload.proofLink || "—", inline: false }
    )
    .setColor(0xc9a24d)
    .setTimestamp(new Date());

  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  if (payload?.proofLink) e.setImage(payload.proofLink);
  return e;
}

function reviewButtons(submissionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`funded_approve:${submissionId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`funded_reject:${submissionId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
    ),
  ];
}

function verifiedPublicEmbed(payload, userId, totalsAfter, proofImageUrl) {
  const e = new EmbedBuilder()
    .setTitle("✅ Verified Funded Account")
    .setDescription(
      `Congratulations <@${userId}> — **${fmtMoneyUSD(payload.accountSize)} funded** with **${payload.firm}**.`
    )
    .addFields(
      { name: "Status", value: String(payload.status).toUpperCase(), inline: true },
      { name: "Funded Date", value: payload.fundedDate || "—", inline: true },
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
  const m = new ModalBuilder().setCustomId(`funded_reject_modal:${submissionId}`).setTitle("Reject Submission");

  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Rejection reason (clear + actionable)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  m.addComponents(new ActionRowBuilder().addComponents(reason));
  return m;
}

function doneButtons(submissionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`funded_done:${submissionId}`)
        .setLabel("✅ Done (Submit for Approval)")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

// ---------------- DB helpers ----------------
async function insertSubmission(id, userId, payload) {
  await pool.query(
    "INSERT INTO proof_submissions (id, type, user_id, status, payload) VALUES ($1,$2,$3,'pending',$4::jsonb)",
    [id, "funded", userId, JSON.stringify(payload)]
  );
}
async function getSubmission(id) {
  const { rows } = await pool.query("SELECT * FROM proof_submissions WHERE id = $1", [id]);
  return rows?.[0] || null;
}
async function updatePayload(id, payload) {
  await pool.query(
    "UPDATE proof_submissions SET payload = $2::jsonb WHERE id = $1",
    [id, JSON.stringify(payload)]
  );
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

// Find latest attachment image URL from a thread, by submitter
async function findLatestAttachmentUrl(thread, userId) {
  const msgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
  if (!msgs) return null;

  const latest = msgs
    .filter((m) => m.author?.id === userId && m.attachments?.size)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .first();

  const att = latest?.attachments?.first?.() || null;
  return att?.url || null;
}

// Delete thread safely (ignore failures)
async function deleteThreadById(client, threadId) {
  if (!threadId) return;
  const ch = await client.channels.fetch(threadId).catch(() => null);
  if (!ch) return;
  // Only threads support delete; discord.js will throw if no perms
  await ch.delete("Funded submission closed (approved/rejected)").catch(() => null);
}

// ---------------- Interaction handler ----------------
async function handleFundedInteractions(client, interaction) {
    async function cleanupSubmissionThread(sub) {
    const payload = sub?.payload || {};
    const threadId = payload.threadId;
    if (!threadId) return;

    const th = await client.channels.fetch(threadId).catch(() => null);
    if (!th) return;

    await th.setLocked(true).catch(() => null);
    await th.setArchived(true).catch(() => null);
    await th.delete("Funded proof handled (approved/rejected)").catch(() => null);
  }

  // 1) Dashboard button -> open modal
  if (interaction.isButton() && interaction.customId === "funded_submit") {
    await interaction.showModal(buildFundedSubmitModal());
    return true;
  }

  // 2) Modal submit -> create submission + create private thread + instruct upload + Done button
  if (interaction.isModalSubmit() && interaction.customId === "funded_modal") {
    const firm = interaction.fields.getTextInputValue("firm")?.trim();
    const accountSizeRaw = interaction.fields.getTextInputValue("accountSize")?.trim();
    const statusRaw = interaction.fields.getTextInputValue("status")?.trim().toLowerCase();
    const fundedDate = interaction.fields.getTextInputValue("fundedDate")?.trim();

    const accountSize = Number(accountSizeRaw);
    const status = statusRaw === "live" || statusRaw === "lost" ? statusRaw : null;

    if (!firm || !Number.isFinite(accountSize) || accountSize <= 0 || !status) {
      await interaction.reply({
        content: "❌ Invalid submission. Please ensure firm, amount (number), and status (live/lost) are correct.",
        ephemeral: true,
      });
      return true;
    }

    if (!FUNDED_CHANNEL_ID) {
      await interaction.reply({ content: "❌ Server misconfigured: FUNDED_CERT_CHANNEL_ID missing.", ephemeral: true });
      return true;
    }

    const parent = await client.channels.fetch(FUNDED_CHANNEL_ID).catch(() => null);
    if (!parent || !parent.isTextBased()) {
      await interaction.reply({ content: "❌ Funded channel not found or not text-based.", ephemeral: true });
      return true;
    }

    const submissionId = crypto.randomUUID();

    // Draft payload (proofLink comes from thread upload)
    const payload = {
      firm,
      accountSize,
      status,
      fundedDate: fundedDate || null,
      proofLink: null,
      threadId: null,
    };

    await insertSubmission(submissionId, interaction.user.id, payload).catch((e) => {
      console.error("[FUNDED] insertSubmission failed", e);
    });

    // Starter message -> create private thread under funded-account-submission
    const starter = await parent
      .send({
        content: `📁 Funded proof thread for <@${interaction.user.id}> (Submission: \`${submissionId}\`)`,
      })
      .catch(() => null);

    if (!starter) {
      await interaction.reply({
        content: "❌ Could not create the proof thread starter message. Try again.",
        ephemeral: true,
      });
      return true;
    }

    const thread = await starter
      .startThread({
        name: `funded-proof-${interaction.user.username}`.slice(0, 90),
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
        reason: "Funded proof upload",
      })
      .catch(() => null);

    const openRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("📂 Upload Certificate (Open Thread)")
    .setURL(`https://discord.com/channels/${interaction.guildId}/${thread.id}`)
);

    // ✅ keep dashboard clean: remove the starter message (thread remains)
    if (!thread) {
      await interaction.reply({
        content: "❌ Could not create the private proof thread. Try again.",
        ephemeral: true,
      });
      return true;
    }

    await starter.delete().catch(() => null);

    await thread.members.add(interaction.user.id).catch(() => null);

    payload.threadId = thread.id;
    await updatePayload(submissionId, payload).catch(() => null);

    await thread
      .send({
        content:
          "✅ **Upload your funded certificate image here** (attach the image).\n\nWhen done, click **✅ Done (Submit for Approval)**.",
        components: doneButtons(submissionId),
      })
      .catch(() => null);

    await interaction.reply({
      content: `✅ Proof thread created: <#${thread.id}>\nUpload the certificate image there, then click **Done**.`,
      ephemeral: true,
    });

    return true;
  }

  // 3) Done button inside thread -> validate image exists -> submit to review queue
  if (interaction.isButton() && interaction.customId.startsWith("funded_done:")) {
    const submissionId = interaction.customId.split(":")[1];

    const sub = await getSubmission(submissionId).catch(() => null);
    if (!sub) {
      await interaction.reply({ content: "❌ Submission not found.", ephemeral: true });
      return true;
    }
    if (sub.user_id !== interaction.user.id) {
      await interaction.reply({ content: "❌ Only the submitter can submit this proof.", ephemeral: true });
      return true;
    }

    const thread = interaction.channel;
    if (!thread || !thread.isTextBased()) {
      await interaction.reply({ content: "❌ Use Done inside the proof thread.", ephemeral: true });
      return true;
    }

    const proofUrl = await findLatestAttachmentUrl(thread, interaction.user.id).catch(() => null);
    if (!proofUrl) {
      await interaction.reply({
        content: "❌ Please upload the certificate image (as an attachment) first, then click Done.",
        ephemeral: true,
      });
      return true;
    }

    const payload = sub.payload || {};
    payload.proofLink = proofUrl;
    payload.threadId = payload.threadId || thread.id;

    await updatePayload(submissionId, payload).catch(() => null);

    const q = await client.channels.fetch(REVIEW_QUEUE_ID).catch(() => null);
    if (q && q.isTextBased()) {
      await q
        .send({
          embeds: [reviewEmbed(payload, submissionId, interaction.user.id)],
          components: reviewButtons(submissionId),
        })
        .catch(() => null);
    }

    // Member confirmation
    await interaction.reply({
      content: "✅ Submitted for staff review. You’ll be notified after approval or rejection.",
      ephemeral: true,
    });
    await interaction.user
      .send(`✅ Your funded submission is now under staff review.\nSubmission ID: ${submissionId}`)
      .catch(() => null);

    // Lock + archive thread (kept until approve/reject, then deleted)
    await thread.setLocked(true).catch(() => null);
    await thread.setArchived(true).catch(() => null);

    return true;
  }

  // 4) Approve
  if (interaction.isButton() && interaction.customId.startsWith("funded_approve:")) {
    const submissionId = interaction.customId.split(":")[1];
    const sub = await getSubmission(submissionId).catch(() => null);

    if (!sub || sub.status !== "pending") {
      await interaction.reply({ content: "❌ This submission is not pending (already handled or missing).", ephemeral: true });
      return true;
    }

    const payload = sub.payload || {};
    await markApproved(submissionId, interaction.user.id).catch(() => null);

    // Insert into prop_funded for dashboard totals
    await pool
      .query(
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
      )
      .catch(() => null);

    // Optional log (no harm)
    await logFunded({
      userId: sub.user_id,
      firm: payload.firm,
      accountSize: payload.accountSize,
      status: payload.status,
      fundedDate: payload.fundedDate,
    }).catch(() => null);

    const totalsAfter = await computeFundedTotals().catch(() => null);
    if (totalsAfter) await ensureFundedDashboard(client).catch(() => null);

    const proofImageUrl = payload.proofLink || null;
    const congratsEmbed = totalsAfter
      ? verifiedPublicEmbed(payload, sub.user_id, totalsAfter, proofImageUrl)
      : verifiedPublicEmbed(payload, sub.user_id, { prevMonth: 0, thisMonth: 0, ytd: 0, all: 0, liveCapital: 0, liveAccounts: 0 }, proofImageUrl);

    // Post to General + Verified (with image)
    const targets = [GENERAL_CHAT_ID, VERIFIED_FUNDED_ARCHIVE_ID].filter(Boolean);
    for (const channelId of targets) {
      const c = await client.channels.fetch(channelId).catch(() => null);
      if (c && c.isTextBased()) {
        await c.send({ embeds: [congratsEmbed] }).catch(() => null);
      }
    }

    // Verified channel: thread link only (Option A)
    if (VERIFIED_FUNDED_ARCHIVE_ID && payload.threadId) {
      const vc = await client.channels.fetch(VERIFIED_FUNDED_ARCHIVE_ID).catch(() => null);
      if (vc && vc.isTextBased()) {
        await vc
          .send({
            content: `🧾 Proof Thread (archived): <#${payload.threadId}>`,
          })
          .catch(() => null);
      }
    }

    // DM member
    const user = await client.users.fetch(sub.user_id).catch(() => null);
    if (user) {
      await user.send("✅ Approved! Your funded certificate has been verified and posted publicly.").catch(() => null);
    }

    // Disable review buttons on staff message
    await cleanupSubmissionThread(sub);

    await interaction.update({ content: "✅ Approved and posted publicly.", components: [] }).catch(() => null);

    // Delete proof thread AFTER posting (so image is preserved in Verified/General)
    await deleteThreadById(client, payload.threadId).catch(() => null);

    return true;
  }

  // 5) Reject -> open reject reason modal
  if (interaction.isButton() && interaction.customId === "funded_submit") {
  await interaction.showModal(buildFundedSubmitModal());
  return true;
}

  // 6) Reject modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith("funded_reject_modal:")) {
    const submissionId = interaction.customId.split(":")[1];
    const reason = interaction.fields.getTextInputValue("reason")?.trim();

    const sub = await getSubmission(submissionId).catch(() => null);
    if (!sub || sub.status !== "pending") {
      await interaction.reply({ content: "❌ This submission is not pending (already handled or missing).", ephemeral: true });
      return true;
    }

    await markRejected(submissionId, interaction.user.id, reason).catch(() => null);

    // DM member
    const user = await client.users.fetch(sub.user_id).catch(() => null);
    if (user) {
      await user
        .send(`❌ Your funded submission was rejected.\n\nReason:\n${reason}\n\nFix the issue and resubmit.`)
        .catch(() => null);
    }

    await cleanupSubmissionThread(sub);

    await interaction.reply({ content: "❌ Rejected. The member has been notified by DM.", ephemeral: true });

    // Delete proof thread immediately (safe; image already in thread but not public since rejected)
    const payload = sub.payload || {};
    await deleteThreadById(client, payload.threadId).catch(() => null);

    return true;
  }

  return false;
}

module.exports = {
  ensureFundedDashboard,
  handleFundedInteractions,
};
