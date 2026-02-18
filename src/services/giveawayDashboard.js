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

// ---------------- Totals ----------------
async function computeGiveawayTotals() {
  const mkThis = monthKeyUTC();
  const yk = yearKeyUTC();

  const q = async (sql, params) => {
    const { rows } = await pool.query(sql, params);
    return rows?.[0] || {};
  };

  const lifetime = await q(
    `SELECT
        COUNT(*)::int AS cnt,
        COALESCE(SUM(i.account_size),0) AS sum
     FROM public.prop_giveaway_claims c
     JOIN public.prop_giveaway_issued i ON i.serial_code = c.serial_code
     WHERE c.status='approved'`,
    []
  );

  const ytd = await q(
    `SELECT
        COUNT(*)::int AS cnt,
        COALESCE(SUM(i.account_size),0) AS sum
     FROM public.prop_giveaway_claims c
     JOIN public.prop_giveaway_issued i ON i.serial_code = c.serial_code
     WHERE c.status='approved' AND i.year_key = $1`,
    [yk]
  );

  const thisMonth = await q(
    `SELECT
        COUNT(*)::int AS cnt,
        COALESCE(SUM(i.account_size),0) AS sum
     FROM public.prop_giveaway_claims c
     JOIN public.prop_giveaway_issued i ON i.serial_code = c.serial_code
     WHERE c.status='approved' AND i.month_key = $1`,
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
    lifetimeSum: Number(lifetime.sum || 0),
    ytdCnt: Number(ytd.cnt || 0),
    ytdSum: Number(ytd.sum || 0),
    monthCnt: Number(thisMonth.cnt || 0),
    monthSum: Number(thisMonth.sum || 0),
    pendingCnt: Number(pending.cnt || 0),
  };
}

// ---------------- Embed / Components ----------------
function giveawayDashboardEmbed(t) {
  const e = new EmbedBuilder()
    .setTitle(DASH_TITLE)
    .setDescription(
      [
        "Staff-verified giveaway impact for **The Ghana Trader Desk**.",
        "Approved claims update these totals automatically.",
      ].join("\n")
    )
    .addFields(
      {
        name: "📅 This Month",
        value: `• **Accounts Given:** **${t.monthCnt}**\n• **Total Value:** ${fmtMoneyUSD(t.monthSum)}`,
        inline: true,
      },
      {
        name: "📈 Year-to-Date",
        value: `• **Accounts Given:** **${t.ytdCnt}**\n• **Total Value:** ${fmtMoneyUSD(t.ytdSum)}`,
        inline: true,
      },
      {
        name: "🏛️ Lifetime",
        value: `• **Accounts Given:** **${t.lifetimeCnt}**\n• **Total Value:** ${fmtMoneyUSD(t.lifetimeSum)}`,
        inline: true,
      },
      {
        name: "🛡️ Operations",
        value: `• **Pending Claims:** **${t.pendingCnt}**`,
        inline: false,
      }
    )
    // ✅ marker must be here so we can find the dashboard reliably
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
        .setLabel("🧾 Claim Giveaway Account")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

// ---------------- Dashboard Finders ----------------
async function findPinnedDashboardMessage(channel, client) {
  const pins = await channel.messages.fetchPins().catch(() => null);
  if (!pins) return null;

  // Strict: marker-based
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

// If nothing pinned, try to find the dashboard message in recent history and pin it.
// This prevents duplicates after someone unpins by mistake.
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

  // If not pinned, try to find an existing dashboard message and pin it (no repost)
  if (!msg) {
    const recent = await findRecentDashboardMessage(ch, client).catch(() => null);
    if (recent) {
      await recent.pin().catch(() => null);
      msg = recent;
      console.log("[GIVEAWAY_DASHBOARD] re-pinned existing dashboard (no repost)");
    }
  }

  // Only create if nothing exists at all
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

  // Edit forever
  await msg
    .edit({ embeds: [giveawayDashboardEmbed(totals)], components: giveawayDashboardComponents() })
    .catch((e) => console.error("[GIVEAWAY_DASHBOARD] edit failed", String(e?.message || e)));

  console.log("[GIVEAWAY_DASHBOARD] done");
}

// ---------------- Claim UI (fixes “Interaction failed”) ----------------
function buildClaimModal() {
  const m = new ModalBuilder().setCustomId("giveaway_claim_modal").setTitle("Claim Giveaway Account");

  const serial = new TextInputBuilder()
    .setCustomId("serial")
    .setLabel("Giveaway Certificate Serial Code")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const email = new TextInputBuilder()
    .setCustomId("email")
    .setLabel("Email for the Prop Firm Account")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  m.addComponents(
    new ActionRowBuilder().addComponents(serial),
    new ActionRowBuilder().addComponents(email)
  );

  return m;
}

async function handleGiveawayInteractions(client, interaction) {
  // Button: open modal
  if (interaction.isButton() && interaction.customId === "giveaway_claim") {
    await interaction.showModal(buildClaimModal());
    return true;
  }

  // Modal: create pending claim + post to staff review queue
  if (interaction.isModalSubmit() && interaction.customId === "giveaway_claim_modal") {
    const serialRaw = String(interaction.fields.getTextInputValue("serial") || "").trim();
    const serialNorm = normalizeSerial(serialRaw);
    console.log("[GIVEAWAY_CLAIM] submit", { serialRaw, serialNorm, userId: interaction.user.id });
    const email = String(interaction.fields.getTextInputValue("email") || "").trim();

    if (!serial || !email) {
      await interaction.reply({ content: "❌ Serial code and email are required.", ephemeral: true });
      return true;
    }

    // Validate serial exists in issued table
    const issued = await pool
  .query(
    `SELECT serial_code, firm, account_size, month_key, year_key
     FROM public.prop_giveaway_issued
     WHERE UPPER(REGEXP_REPLACE(serial_code, '[^A-Za-z0-9]', '', 'g')) = $1
     LIMIT 1`,
    [serialNorm]
  )
  .then((r) => r.rows?.[0] || null)
  .catch(() => null);

    if (!issued) {
      await interaction.reply({ content: "❌ Invalid serial code. Please check your certificate and try again.", ephemeral: true });
      return true;
    }

    const claimId = crypto.randomUUID();

    // Insert pending claim (your unique index on serial_code prevents duplicates)
    const ok = await pool
      .query(
        `INSERT INTO public.prop_giveaway_claims
         (id, serial_code, claimant_user_id, email, status, created_at)
         VALUES ($1,$2,$3,$4,'pending',NOW())`,
        [claimId, issued.serial_code, interaction.user.id, email]
      )
      .then(() => true)
      .catch((e) => {
        const msg = String(e?.message || e);
        if (msg.includes("duplicate key") || msg.includes("uq_giveaway_claims_serial_code")) return false;
        console.error("[GIVEAWAY_CLAIM] insert failed", msg);
        return null;
      });

    if (ok === false) {
      await interaction.reply({ content: "❌ This giveaway serial has already been claimed.", ephemeral: true });
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
        .setTitle("🎁 Giveaway Claim — Pending Review")
        .setDescription(`Claim ID: \`${claimId}\`\nSerial: \`${serial}\``)
        .addFields(
          { name: "Member", value: `<@${interaction.user.id}>`, inline: true },
          { name: "Email", value: email, inline: true },
          { name: "Firm", value: String(issued.firm), inline: true },
          { name: "Account Size", value: fmtMoneyUSD(issued.account_size), inline: true },
          { name: "Month", value: String(issued.month_key), inline: true },
          { name: "Year", value: String(issued.year_key), inline: true }
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
      content: "✅ Claim submitted for staff review. You’ll receive a DM after approval or rejection.",
      ephemeral: true,
    });

    await interaction.user.send(
      `✅ Giveaway claim received.\nSerial: ${issued.serial_code}\nYou will be notified after staff review.`
    ).catch(() => null);

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
