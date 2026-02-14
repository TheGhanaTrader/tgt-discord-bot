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
const { Pool } = require("pg");

// ---------------- ENV / PG ----------------
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  console.error("[PAYOUT_DASHBOARD] FATAL: DATABASE_URL is missing in env");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const PAYOUT_PARENT_CHANNEL_ID = String(process.env.PAYOUT_DASHBOARD_CHANNEL_ID || "").trim(); // parent channel (same as payout dashboard)
const REVIEW_QUEUE_ID = String(process.env.PROOF_REVIEW_QUEUE_CHANNEL_ID || "").trim(); // shared review queue
const GENERAL_CHAT_ID = String(process.env.GENERAL_CHAT_CHANNEL_ID || "").trim();
const VERIFIED_PAYOUTS_ARCHIVE_ID = String(process.env.VERIFIED_PAYOUTS_CHANNEL_ID || "").trim();
const LOGO_URL = String(process.env.TGT_LOGO_URL || "").trim();

const DASH_MARKER = "TGT_PAYOUT_DASHBOARD";

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

async function computePayoutTotals() {
  const mkThis = monthKeyUTC();
  const mkPrev = prevMonthKeyUTC();
  const yk = yearKeyUTC();

  const qSum = async (whereSql, params) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(payout_amount),0) AS s FROM prop_payouts ${whereSql}`,
      params
    );
    return Number(rows?.[0]?.s || 0);
  };

  const qCount = async (whereSql, params) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM prop_payouts ${whereSql}`,
      params
    );
    return Number(rows?.[0]?.c || 0);
  };

  const prevMonth = await qSum("WHERE month_key = $1", [mkPrev]);
  const thisMonth = await qSum("WHERE month_key = $1", [mkThis]);
  const ytd = await qSum("WHERE year_key = $1", [yk]);
  const all = await qSum("", []);

  const totalPayouts = await qCount("", []);
  const stillFundedCount = await qCount("WHERE status_after = 'still_funded'", []);
  const lostAfterCount = await qCount("WHERE status_after = 'lost_after'", []);

  return {
    mkThis,
    mkPrev,
    yk,
    prevMonth,
    thisMonth,
    ytd,
    all,
    totalPayouts,
    stillFundedCount,
    lostAfterCount,
  };
}

function dashboardEmbed(t) {
  const e = new EmbedBuilder()
    .setTitle("💸 Payout Dashboard")
    .setDescription("Verified payouts submitted by members and approved by staff.")
    .addFields(
      {
        name: "💸 Total Payouts (Verified)",
        value:
          `• **Previous Month:** ${fmtMoneyUSD(t.prevMonth)}\n` +
          `• **This Month:** ${fmtMoneyUSD(t.thisMonth)}\n` +
          `• **Year-to-Date:** ${fmtMoneyUSD(t.ytd)}\n` +
          `• **All-Time:** ${fmtMoneyUSD(t.all)}`,
      },
      {
        name: "📌 Payout Records",
        value:
          `• **Total Payout Posts:** **${t.totalPayouts}**\n` +
          `• **Still Funded After Payout:** **${t.stillFundedCount}**\n` +
          `• **Lost After Payout:** **${t.lostAfterCount}**`,
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
        .setCustomId("payout_submit")
        .setLabel("➕ Submit Payout Proof")
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
    if (title !== "💸 Payout Dashboard") return false;
    const footer = m.embeds?.[0]?.footer?.text || "";
    return footer.includes(DASH_MARKER);
  });

  const pick = strict.sort((a, b) => b.createdTimestamp - a.createdTimestamp).first() || null;
  return pick;
}

// EDIT ONLY — never create / never pin
async function ensurePayoutDashboard(client) {
  console.log("[PAYOUT_DASHBOARD] start", {
    ts: new Date().toISOString(),
    PAYOUT_DASHBOARD_CHANNEL_ID: PAYOUT_PARENT_CHANNEL_ID ? "set" : "MISSING",
    PROOF_REVIEW_QUEUE_CHANNEL_ID: REVIEW_QUEUE_ID ? "set" : "MISSING",
    NODE_ENV: process.env.NODE_ENV || null,
    DATABASE_URL: DATABASE_URL ? "set" : "MISSING",
  });

  if (!DATABASE_URL) {
    console.error("[PAYOUT_DASHBOARD] abort: DATABASE_URL missing");
    return;
  }
  if (!PAYOUT_PARENT_CHANNEL_ID) {
    console.error("[PAYOUT_DASHBOARD] abort: PAYOUT_DASHBOARD_CHANNEL_ID missing");
    return;
  }

  const ch = await client.channels.fetch(PAYOUT_PARENT_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    console.error("[PAYOUT_DASHBOARD] abort: payout channel missing or not text-based");
    return;
  }

  const totals = await computePayoutTotals().catch((e) => {
    console.error("[PAYOUT_DASHBOARD] abort: computePayoutTotals failed", e);
    return null;
  });
  if (!totals) return;

  let msg = await findPinnedDashboardMessage(ch, client).catch(() => null);
  if (!msg) {
  console.warn("[PAYOUT_DASHBOARD] No pinned dashboard found — creating one-time pinned dashboard.");

  msg = await ch
    .send({ embeds: [dashboardEmbed(totals)], components: dashboardComponents() })
    .catch((e) => {
      console.error("[PAYOUT_DASHBOARD] send failed", String(e?.message || e));
      return null;
    });

  if (!msg) return;

  await msg.pin().catch((e) =>
  console.error("[PAYOUT_DASHBOARD] pin failed", String(e?.message || e))
);

  console.log("[PAYOUT_DASHBOARD] created and pinned");
  return; // IMPORTANT: stop here (don’t fall through)
}

  await msg
    .edit({ embeds: [dashboardEmbed(totals)], components: dashboardComponents() })
    .catch((e) => console.error("[PAYOUT_DASHBOARD] edit failed", String(e?.message || e)));

  console.log("[PAYOUT_DASHBOARD] done");
}

// ---------------- Embeds / UI ----------------
function buildPayoutSubmitModal() {
  const m = new ModalBuilder().setCustomId("payout_modal").setTitle("Submit Payout Proof");

  const firm = new TextInputBuilder()
    .setCustomId("firm")
    .setLabel("Prop Firm Name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const payoutAmount = new TextInputBuilder()
    .setCustomId("payoutAmount")
    .setLabel("Payout Amount (USD) e.g. 1200")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const statusAfter = new TextInputBuilder()
    .setCustomId("statusAfter")
    .setLabel("Status After: still_funded or lost_after")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const payoutDate = new TextInputBuilder()
    .setCustomId("payoutDate")
    .setLabel("Payout Date (YYYY-MM-DD) optional")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  m.addComponents(
    new ActionRowBuilder().addComponents(firm),
    new ActionRowBuilder().addComponents(payoutAmount),
    new ActionRowBuilder().addComponents(statusAfter),
    new ActionRowBuilder().addComponents(payoutDate)
  );

  return m;
}

function reviewEmbed(payload, submissionId, userId) {
  const e = new EmbedBuilder()
    .setTitle("🧾 Payout Submission — Pending Review")
    .setDescription(`Submission ID: \`${submissionId}\``)
    .addFields(
      { name: "Member", value: `<@${userId}>`, inline: true },
      { name: "Firm", value: payload.firm, inline: true },
      { name: "Payout Amount", value: fmtMoneyUSD(payload.payoutAmount), inline: true },
      { name: "Status After", value: String(payload.statusAfter).toUpperCase(), inline: true },
      { name: "Payout Date", value: payload.payoutDate || "—", inline: true },
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
      new ButtonBuilder().setCustomId(`payout_approve:${submissionId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`payout_reject:${submissionId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
    ),
  ];
}

function verifiedPublicEmbed(payload, userId, totalsAfter, proofImageUrl) {
  const e = new EmbedBuilder()
    .setTitle("✅ Verified Payout")
    .setDescription(
      `Congratulations <@${userId}> — **${fmtMoneyUSD(payload.payoutAmount)} payout** with **${payload.firm}**.`
    )
    .addFields(
      { name: "Status After", value: String(payload.statusAfter).toUpperCase(), inline: true },
      { name: "Payout Date", value: payload.payoutDate || "—", inline: true },
      {
        name: "📊 Updated Payout Totals (after this approval)",
        value:
          `• **Previous Month:** ${fmtMoneyUSD(totalsAfter.prevMonth)}\n` +
          `• **This Month:** ${fmtMoneyUSD(totalsAfter.thisMonth)}\n` +
          `• **Year-to-Date:** ${fmtMoneyUSD(totalsAfter.ytd)}\n` +
          `• **All-Time:** ${fmtMoneyUSD(totalsAfter.all)}`,
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
  const m = new ModalBuilder().setCustomId(`payout_reject_modal:${submissionId}`).setTitle("Reject Submission");

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
        .setCustomId(`payout_done:${submissionId}`)
        .setLabel("✅ Done (Submit for Approval)")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

// ---------------- DB helpers ----------------
async function insertSubmission(id, userId, payload) {
  await pool.query(
    "INSERT INTO proof_submissions (id, type, user_id, status, payload) VALUES ($1,$2,$3,'pending',$4::jsonb)",
    [id, "payout", userId, JSON.stringify(payload)]
  );
}
async function getSubmission(id) {
  const { rows } = await pool.query("SELECT * FROM proof_submissions WHERE id = $1", [id]);
  return rows?.[0] || null;
}
async function updatePayload(id, payload) {
  await pool.query("UPDATE proof_submissions SET payload = $2::jsonb WHERE id = $1", [
    id,
    JSON.stringify(payload),
  ]);
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
  await ch.delete("Payout submission closed (approved/rejected)").catch(() => null);
}

// ---------------- Interaction handler ----------------
async function handlePayoutInteractions(client, interaction) {
  async function cleanupSubmissionThread(sub) {
    const payload = sub?.payload || {};
    const threadId = payload.threadId;
    if (!threadId) return;

    const th = await client.channels.fetch(threadId).catch(() => null);
    if (!th) return;

    await th.setLocked(true).catch(() => null);
    await th.setArchived(true).catch(() => null);
    await th.delete("Payout proof handled (approved/rejected)").catch(() => null);
  }

  // 1) Dashboard button -> open modal
  if (interaction.isButton() && interaction.customId === "payout_submit") {
    await interaction.showModal(buildPayoutSubmitModal());
    return true;
  }

  // 2) Modal submit -> create submission + create private thread + instruct upload + Done button
  if (interaction.isModalSubmit() && interaction.customId === "payout_modal") {
    const firm = interaction.fields.getTextInputValue("firm")?.trim();
    const payoutAmountRaw = interaction.fields.getTextInputValue("payoutAmount")?.trim();
    const statusAfterRaw = interaction.fields.getTextInputValue("statusAfter")?.trim().toLowerCase();
    const payoutDate = interaction.fields.getTextInputValue("payoutDate")?.trim();

    const payoutAmount = Number(payoutAmountRaw);
    const statusAfter =
      statusAfterRaw === "still_funded" || statusAfterRaw === "lost_after" ? statusAfterRaw : null;

    if (!firm || !Number.isFinite(payoutAmount) || payoutAmount <= 0 || !statusAfter) {
      await interaction.reply({
        content:
          "❌ Invalid submission. Please ensure firm, payout amount (number), and statusAfter (still_funded/lost_after) are correct.",
        ephemeral: true,
      });
      return true;
    }

    if (!PAYOUT_PARENT_CHANNEL_ID) {
      await interaction.reply({
        content: "❌ Server misconfigured: PAYOUT_DASHBOARD_CHANNEL_ID missing.",
        ephemeral: true,
      });
      return true;
    }

    const parent = await client.channels.fetch(PAYOUT_PARENT_CHANNEL_ID).catch(() => null);
    if (!parent || !parent.isTextBased()) {
      await interaction.reply({ content: "❌ Payout channel not found or not text-based.", ephemeral: true });
      return true;
    }

    const submissionId = crypto.randomUUID();

    // Draft payload (proofLink comes from thread upload)
    const payload = {
      firm,
      payoutAmount,
      statusAfter,
      payoutDate: payoutDate || null,
      proofLink: null,
      threadId: null,
    };

    await insertSubmission(submissionId, interaction.user.id, payload).catch((e) => {
      console.error("[PAYOUT] insertSubmission failed", e);
    });

    // Starter message -> create private thread under payout channel
    const starter = await parent
      .send({
        content: `📁 Payout proof thread for <@${interaction.user.id}> (Submission: \`${submissionId}\`)`,
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
        name: `payout-proof-${interaction.user.username}`.slice(0, 90),
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
        reason: "Payout proof upload",
      })
      .catch(() => null);

    if (!thread) {
      await interaction.reply({
        content: "❌ Could not create the private proof thread. Try again.",
        ephemeral: true,
      });
      return true;
    }

    // keep channel clean: remove starter message (thread remains)
    await starter.delete().catch(() => null);

    await thread.members.add(interaction.user.id).catch(() => null);

    payload.threadId = thread.id;
    await updatePayload(submissionId, payload).catch(() => null);

    await thread
      .send({
        content:
          "✅ **Upload your payout proof image here** (attach the image).\n\nWhen done, click **✅ Done (Submit for Approval)**.",
        components: doneButtons(submissionId),
      })
      .catch(() => null);

    // Provide a link button to open the private thread (Discord cannot auto-open UI)
    const openRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("📂 Open Proof Thread")
        .setURL(`https://discord.com/channels/${interaction.guildId}/${thread.id}`)
    );

    await interaction.reply({
      content: `✅ Proof thread created: <#${thread.id}>\nUpload the image there, then click **Done** in the thread.`,
      components: [openRow],
      ephemeral: true,
    });

    return true;
  }

  // 3) Done button inside thread -> validate image exists -> submit to review queue
  if (interaction.isButton() && interaction.customId.startsWith("payout_done:")) {
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
        content: "❌ Please upload the proof image (as an attachment) first, then click Done.",
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

    await interaction.reply({
      content: "✅ Submitted for staff review. You’ll be notified after approval or rejection.",
      ephemeral: true,
    });

    await interaction.user
      .send(`✅ Your payout submission is now under staff review.\nSubmission ID: ${submissionId}`)
      .catch(() => null);

    await thread.setLocked(true).catch(() => null);
    await thread.setArchived(true).catch(() => null);

    return true;
  }

  // 4) Approve
  if (interaction.isButton() && interaction.customId.startsWith("payout_approve:")) {
    const submissionId = interaction.customId.split(":")[1];
    const sub = await getSubmission(submissionId).catch(() => null);

    if (!sub || sub.status !== "pending") {
      await interaction.reply({
        content: "❌ This submission is not pending (already handled or missing).",
        ephemeral: true,
      });
      return true;
    }

    const payload = sub.payload || {};
    await markApproved(submissionId, interaction.user.id).catch(() => null);

    // Insert into prop_payouts for dashboard totals
    await pool
      .query(
        `INSERT INTO prop_payouts (id, user_id, firm, payout_amount, status_after, payout_date, month_key, year_key, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
        [
          crypto.randomUUID(),
          sub.user_id,
          payload.firm,
          payload.payoutAmount,
          payload.statusAfter,
          payload.payoutDate || null,
          monthKeyUTC(),
          yearKeyUTC(),
        ]
      )
      .catch(() => null);

    const totalsAfter = await computePayoutTotals().catch(() => null);
    if (totalsAfter) await ensurePayoutDashboard(client).catch(() => null);

    const proofImageUrl = payload.proofLink || null;
    const congratsEmbed = totalsAfter
      ? verifiedPublicEmbed(payload, sub.user_id, totalsAfter, proofImageUrl)
      : verifiedPublicEmbed(
          payload,
          sub.user_id,
          { prevMonth: 0, thisMonth: 0, ytd: 0, all: 0, totalPayouts: 0, stillFundedCount: 0, lostAfterCount: 0 },
          proofImageUrl
        );

    // Post to General + Verified (with image)
    const targets = [GENERAL_CHAT_ID, VERIFIED_PAYOUTS_ARCHIVE_ID].filter(Boolean);
    for (const channelId of targets) {
      const c = await client.channels.fetch(channelId).catch(() => null);
      if (c && c.isTextBased()) {
        await c.send({ embeds: [congratsEmbed] }).catch(() => null);
      }
    }

    // Verified channel: thread link only (Option A)
    if (VERIFIED_PAYOUTS_ARCHIVE_ID && payload.threadId) {
      const vc = await client.channels.fetch(VERIFIED_PAYOUTS_ARCHIVE_ID).catch(() => null);
      if (vc && vc.isTextBased()) {
        await vc.send({ content: `🧾 Proof Thread (archived): <#${payload.threadId}>` }).catch(() => null);
      }
    }

    // DM member
    const user = await client.users.fetch(sub.user_id).catch(() => null);
    if (user) {
      await user.send("✅ Approved! Your payout proof has been verified and posted publicly.").catch(() => null);
    }

    await cleanupSubmissionThread(sub);

    await interaction.update({ content: "✅ Approved and posted publicly.", components: [] }).catch(() => null);

    // Delete proof thread AFTER posting (image preserved in Verified/General)
    await deleteThreadById(client, payload.threadId).catch(() => null);

    return true;
  }

  // 5) Reject -> open reject reason modal
  if (interaction.isButton() && interaction.customId.startsWith("payout_reject:")) {
    const submissionId = interaction.customId.split(":")[1];
    await interaction.showModal(buildRejectReasonModal(submissionId));
    return true;
  }

  // 6) Reject modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith("payout_reject_modal:")) {
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
        .send(`❌ Your payout submission was rejected.\n\nReason:\n${reason}\n\nFix the issue and resubmit.`)
        .catch(() => null);
    }

    await cleanupSubmissionThread(sub);

    await interaction.reply({
      content: "❌ Rejected. The member has been notified by DM.",
      ephemeral: true,
    });

    const payload = sub.payload || {};
    await deleteThreadById(client, payload.threadId).catch(() => null);

    return true;
  }

  return false;
}

module.exports = {
  ensurePayoutDashboard,
  handlePayoutInteractions,
};
