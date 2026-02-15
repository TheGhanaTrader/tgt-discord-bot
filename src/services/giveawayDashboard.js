"use strict";

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { Pool } = require("pg");

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

// Marker to identify the right pinned message
const DASH_MARKER = "TGT_GIVEAWAY_DASHBOARD";

// Optional branding
const LOGO_URL = String(process.env.TGT_LOGO_URL || "").trim();

// ---------------- Helpers ----------------
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

  // We count/value ONLY approved claims (issued joined by serial_code)
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

  // Optional: pending claims count (operational visibility)
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

// ---------------- Embed ----------------
function giveawayDashboardEmbed(t) {
  const e = new EmbedBuilder()
    .setTitle("🎁 Prop Firm Giveaways Dashboard")
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

// Find pinned dashboard; if missing, create+pin once; else edit forever.
async function findPinnedDashboardMessage(channel, client) {
  const pins = await channel.messages.fetchPins().catch(() => null);
  if (!pins) return null;

  const match = pins
    .filter((m) => {
      if (!m.author?.bot) return false;
      if (client?.user?.id && m.author.id !== client.user.id) return false;
      const title = m.embeds?.[0]?.title || "";
      if (title !== "🎁 Prop Firm Giveaways Dashboard") return false;
      const footer = m.embeds?.[0]?.footer?.text || "";
      return footer.includes(DASH_MARKER);
    })
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .first();

  return match || null;
}

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

  // Create+pin ONE TIME if missing
  if (!msg) {
    console.warn("[GIVEAWAY_DASHBOARD] No pinned dashboard found — creating one-time pinned dashboard.");

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

module.exports = {
  ensureGiveawayDashboard,
};
