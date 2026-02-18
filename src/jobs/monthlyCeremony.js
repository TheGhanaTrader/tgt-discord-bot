// src/jobs/monthlyCeremony.js
const crypto = require("crypto");
const { EmbedBuilder, AttachmentBuilder } = require("discord.js");

const { getMonthKey, getStats } = require("../services/referrals");
const { saveMonthWinners } = require("../services/rewardsLedger");
const { enqueue } = require("../services/fulfillmentQueue");
const { generateCertificatePNG } = require("../utils/certificateGenerator");
const { recordCertificate, getUserCertificates } = require("../services/certificatesLedger");
const { pickNextSponsor, formatSponsorLine } = require("../services/sponsors");

// Channels
const HONORS_CHANNEL_ID = process.env.HONORS_CHANNEL_ID;
const GENERAL_CHAT_CHANNEL_ID = process.env.GENERAL_CHAT_CHANNEL_ID;

// Tier roles (kept for your revenue reward logic)
const ROLE_SILVER_ID = process.env.ROLE_SILVER_ID;
const ROLE_GOLD_ID = process.env.ROLE_GOLD_ID;

// Optional guild id
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

/* -------------------- helpers -------------------- */

function genVerificationCode16() {
  return crypto.randomBytes(8).toString("hex").toUpperCase();
}

function isValidYYYYMM(x) {
  return typeof x === "string" && /^\d{4}-\d{2}$/.test(x);
}

function nyDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

async function postEmbed(client, channelId, embed, dryRun) {
  if (dryRun || !channelId) return;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] }).catch(() => null);
}

function topNFromSorted(sortedEntries, n) {
  return sortedEntries.slice(0, n).map(([id], idx) => ({ userId: id, rank: idx + 1 }));
}

function safeUsernameFromGuild(guild, userId) {
  try {
    const m = guild?.members?.cache?.get(userId);
    return m?.user?.username || m?.displayName || "member";
  } catch {
    return "member";
  }
}

async function alreadyIssuedFor({ userId, monthKey, category, rankLabel }) {
  const certs = (await getUserCertificates(String(userId), String(monthKey))) || [];
  return certs.some(
    (c) =>
      c.monthKey === String(monthKey) &&
      c.category === category &&
      c.rankLabel === rankLabel
  );
}

async function dmCertificate(client, userId, monthKey, rankLabel, code, filePath, dryRun) {
  console.log("CERT_DM_DEBUG:", { userId, dryRun });

  if (dryRun) return true;
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return false;

    const embed = new EmbedBuilder()
      .setTitle("🏛️ The Ghana Trader Desk — Certificate Issued")
      .setDescription(
        [
          `Cycle: **${monthKey}**`,
          `Award: **${rankLabel}**`,
          `Verification Code: \`${code}\``,
          "",
          "✅ Keep this certificate safe.",
          "✅ Redemption is validated by the code to prevent fraud.",
        ].join("\n")
      )
      .setColor(0xC9A24D)
      .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." });

    const file = new AttachmentBuilder(filePath);
    await user.send({ embeds: [embed], files: [file] });

    return true;
  } catch (err) {
    console.log("CERT_DM_FAIL:", err?.message || err);
    return false;
  }
}

/* -------------------- rewards -------------------- */

function rewardByRevenue(totalRevenue) {
  if (totalRevenue >= 65000)
    return {
      first: "100K Funded Account",
      second: "50K Funded Account",
      referral: "25K Funded Account",
    };
  if (totalRevenue >= 50000)
    return {
      first: "100K Funded Account",
      second: "50K Funded Account",
      referral: null,
      referralRoleId: ROLE_GOLD_ID,
    };
  if (totalRevenue >= 37000)
    return {
      first: "50K Funded Account",
      second: "25K Funded Account",
      referral: "10K Funded Account",
      referralRoleId: ROLE_GOLD_ID,
    };
  if (totalRevenue >= 27000)
    return {
      first: "50K Funded Account",
      second: "25K Funded Account",
      referral: null,
      referralRoleId: ROLE_GOLD_ID,
    };
  if (totalRevenue >= 20000)
    return {
      first: "25K Funded Account",
      second: "10K Funded Account",
      referral: null,
      referralRoleId: ROLE_SILVER_ID,
    };
  if (totalRevenue >= 15000)
    return {
      first: "25K Funded Account",
      second: null,
      referral: null,
      referralRoleId: ROLE_SILVER_ID,
    };
  return { first: null, second: null, referral: null };
}

/* -------------------- embeds -------------------- */

function buildHallOfFameEmbed({ monthKey, top3Sales, top3Referrals }) {
  const medal = (n) => (n === 1 ? "🥇" : n === 2 ? "🥈" : "🥉");
  return new EmbedBuilder()
    .setTitle("🏛️ TGT Hall of Fame — Monthly Top 3")
    .setDescription(
      `Cycle: **${monthKey}**\n\n` +
        `**Top 3 — Sales**\n${
          top3Sales.map((x) => `${medal(x.rank)} <@${x.userId}>`).join("\n") || "—"
        }\n\n` +
        `**Top 3 — Referrals**\n${
          top3Referrals.map((x) => `${medal(x.rank)} <@${x.userId}>`).join("\n") || "—"
        }`
    )
    .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
    .setColor(0xC9A24D);
}

function buildPrestigeWinnersEmbed({ monthKey, winners }) {
  const hasWinners = winners.length > 0;

  const body = hasWinners
    ? winners
        .map((w) => `• <@${w.userId}> — **${w.rank}**\n  Reward: **${w.reward}**`)
        .join("\n\n")
    : "No winners for this cycle.";

  const note = hasWinners
    ? ""
    : `\n\n⚠️ **Note**\n• This cycle did not meet the minimum performance thresholds for public winners.\n• Top 10 performers have been recognized privately.\n`;

  return new EmbedBuilder()
    .setTitle("🏛️ THE GHANA TRADER — MONTHLY HONORS")
    .setDescription(
      `Cycle: **${monthKey}**\n` +
        `A new cycle is now live. Last month’s results are officially locked.\n\n` +
        `**Winners & Rewards**\n${body}${note}\n\n` +
        `**Next Steps**\n• Leaderboards reset & tracking continues.\n• Winners are issued certificates privately (DM).\n`
    )
    .setFooter({ text: "The Ghana Trader • Prestige. Proof. Performance." })
    .setColor(0xC9A24D);
}

/* -------------------- main runner -------------------- */

async function runMonthlyCeremonyCore({ client, monthKeyOverride, reason, dryRun }) {
  const monthKey = isValidYYYYMM(monthKeyOverride) ? monthKeyOverride : getMonthKey(nyDate());
  const stats = await getStats(monthKey);
  const entries = Object.entries(stats);
  console.log("HONORS_DEBUG:", { monthKey, entries: entries.length, dryRun });

  if (!entries.length) return;

  const totalRevenue = entries.reduce((s, [, v]) => s + Number(v?.revenue || 0), 0);
  const rewards = rewardByRevenue(totalRevenue);

  const bySales = [...entries].sort((a, b) => Number(b[1]?.sales || 0) - Number(a[1]?.sales || 0));
  const byJoins = [...entries].sort((a, b) => Number(b[1]?.joins || 0) - Number(a[1]?.joins || 0));

  const guild = DISCORD_GUILD_ID
    ? await client.guilds.fetch(DISCORD_GUILD_ID).catch(() => null)
    : client.guilds.cache.first();

  const winners = [];

  if (bySales[0] && rewards.first) {
    winners.push({ userId: bySales[0][0], rank: "🥇 Top Sales", reward: rewards.first });
    if (!dryRun) await enqueue({ monthKey, userId: bySales[0][0], reward: rewards.first });
  }

  if (byJoins[0] && rewards.referral) {
    winners.push({ userId: byJoins[0][0], rank: "🎖 Top Referrer", reward: rewards.referral });
    if (!dryRun) await enqueue({ monthKey, userId: byJoins[0][0], reward: rewards.referral });
  }

  if (!dryRun) await saveMonthWinners(monthKey, winners);

    // Map winner rewards so Top 10 certs can show real prize when applicable
  const winnerRewardByUserId = Object.fromEntries(
    (winners || []).map((w) => [String(w.userId), String(w.reward || "")])
  );

  const top3Sales = topNFromSorted(bySales, 3);
  const top3Referrals = topNFromSorted(byJoins, 3);

  // ✅ Top 10 issuance (private certificates)
  const top10Sales = topNFromSorted(bySales, 10);
  const top10Referrals = topNFromSorted(byJoins, 10);
  console.log("HONORS_TOP10_DEBUG:", { top10Sales: top10Sales.length, top10Referrals: top10Referrals.length });

  for (const t of top10Sales) {
    console.log("HONORS_ISSUE_SALES_LOOP:", t);
    const rankLabel = `Top 10 Sales — Rank ${t.rank}`;
    const category = "TOP10_SALES";

    // if (await alreadyIssuedFor({ userId: t.userId, monthKey, category, rankLabel })) continue;

    const username = safeUsernameFromGuild(guild, t.userId);
    const code = genVerificationCode16();

    const rewardLabel = winnerRewardByUserId[String(t.userId)] || "Top 10 Recognition";

    const cert = await generateCertificatePNG({
      username,
      userId: t.userId,
      rank: rankLabel,
      reward: rewardLabel,
      month: monthKey,
      verificationCode: code,
    });

    const filePath = cert?.filePath;
    const finalCode = cert?.verificationCode || code;
    if (!filePath) continue;

    await recordCertificate({
      monthKey,
      userId: t.userId,
      username,
      category,
      rankLabel,
      rewardLabel,
      code: finalCode,
      filePath,
      rewardClaimable: false,
    });

    await dmCertificate(client, t.userId, monthKey, rankLabel, finalCode, filePath, dryRun);
  }

  for (const t of top10Referrals) {
    const rankLabel = `Top 10 Referrals — Rank ${t.rank}`;
    const category = "TOP10_REFERRALS";

    // if (await alreadyIssuedFor({ userId: t.userId, monthKey, category, rankLabel })) continue;

    const username = safeUsernameFromGuild(guild, t.userId);
    const code = genVerificationCode16();

    const rewardLabel = winnerRewardByUserId[String(t.userId)] || "Top 10 Recognition";

    const cert = await generateCertificatePNG({
      username,
      userId: t.userId,
      rank: rankLabel,
      reward: rewardLabel,
      month: monthKey,
      verificationCode: code,
    });

    const filePath = cert?.filePath;
    const finalCode = cert?.verificationCode || code;
    if (!filePath) continue;

    await recordCertificate({
      monthKey,
      userId: t.userId,
      username,
      category,
      rankLabel,
      rewardLabel,
      code: finalCode,
      filePath,
      rewardClaimable: false,
    });

    await dmCertificate(client, t.userId, monthKey, rankLabel, finalCode, filePath, dryRun);
  }

  await postEmbed(client, HONORS_CHANNEL_ID, buildHallOfFameEmbed({ monthKey, top3Sales, top3Referrals }), dryRun);

  const baseEmbed = buildPrestigeWinnersEmbed({ monthKey, winners });

  let honorsEmbed = baseEmbed;
  const sponsor = await pickNextSponsor();
  if (sponsor) {
    const sponsorLine = formatSponsorLine(sponsor);
    honorsEmbed = EmbedBuilder.from(baseEmbed).setFooter({ text: sponsorLine });
  }

  await postEmbed(client, HONORS_CHANNEL_ID, honorsEmbed, dryRun);
  await postEmbed(client, GENERAL_CHAT_CHANNEL_ID, baseEmbed, dryRun);

  console.log("🏛 Monthly ceremony complete:", monthKey, reason || "");
}

/* -------------------- exported API -------------------- */

async function runMonthlyCeremony(arg) {
  if (arg?.channels && arg?.users) {
    return runMonthlyCeremonyCore({ client: arg, dryRun: false });
  }

  if (!arg?.client) throw new Error("runMonthlyCeremony: missing client");

  return runMonthlyCeremonyCore({
    client: arg.client,
    monthKeyOverride: arg.targetMonthISO || null,
    reason: arg.reason || "SCHEDULED_RUN",
    dryRun: !!arg.dryRun,
  });
}

module.exports = { runMonthlyCeremony };
