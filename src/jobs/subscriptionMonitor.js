const { upsertSubscription, listAllSubscriptions } = require("../services/subscriptions");
const { buildRenewalReminderDM } = require("../utils/renewalDm");

// ---------------------------
// DATE HELPERS (UTC-safe)
// ---------------------------
function addMonthsUTC(date, months) {
  const d = new Date(date);

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds()
    )
  );
}

function computeExpiryFrom(tierKey, baseDate) {
  if (tierKey === "silver") return addMonthsUTC(baseDate, 1);
  if (tierKey === "gold") return addMonthsUTC(baseDate, 3);
  if (tierKey === "diamond") return addMonthsUTC(baseDate, 12);
  return addMonthsUTC(baseDate, 1);
}

function renewalUrlForTier(tier) {
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;

  const t = String(tier || "").trim().toUpperCase();
  const u = new URL(`${base}/auth/discord/start`);
  u.searchParams.set("tier", t);
  return u.toString();
}

// ---------------------------
// DM HELPERS
// ---------------------------
async function safeDM(member, payload) {
  await member.send(payload).catch(() => null);
}

// ---------------------------
// MAIN MONITOR
// ---------------------------
function startSubscriptionMonitor(client, { TIERS, LOG_CHANNEL_ID, DISCORD_GUILD_ID }) {
  async function log(message) {
    if (!LOG_CHANNEL_ID) return;
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send(message).catch(() => null);
  }

  async function tick() {
    try {
      console.log("SUB_MONITOR_TICK:", new Date().toISOString());
      const subs = listAllSubscriptions();
      console.log("SUB_MONITOR_USERS:", subs.length);

      const now = new Date();
      
      if (!subs.length) return;

      const guild =
        (DISCORD_GUILD_ID && client.guilds.cache.get(DISCORD_GUILD_ID)) ||
        client.guilds.cache.first();
      if (!guild) return;

      // ===========================
      // EXPIRY + REMINDERS
      // ===========================
      for (const sub of subs) {
        if (!sub?.expires_at) continue;

        const expires = new Date(sub.expires_at);
        if (Number.isNaN(expires.getTime())) continue;

        const msLeft = expires.getTime() - now.getTime();
        const hoursLeft = msLeft / (1000 * 60 * 60);

       // 🔴 EXPIRED (always enforce)
if (msLeft <= 0) {

  const member = await guild.members.fetch(sub.discord_id).catch(() => null);
  if (member) {

    const { revokePremiumRoles } = require("../discordRoles");
    await revokePremiumRoles(sub.discord_id).catch((e) =>
      console.log("REVOKE_ERROR:", e?.message || e)
    );

    // 🧾 LOG EXPIRY ONLY ONCE
    if (!sub.expired_logged_at) {
      await log(`⛔ Expired: <@${sub.discord_id}> (${String(sub.tier || "").toUpperCase()})`);
      upsertSubscription(sub.discord_id, { expired_logged_at: Date.now() });
    }

    // 🔒 SEND EXPIRED DM ONLY ONCE
    if (!sub.expired_notified_at) {
        const { embed, row } = buildRenewalReminderDM({
        tier: sub.tier,
        expiresAtMs: sub.expires_at,
        windowLabel: "EXPIRED",
        memberName: member.user.username,
      });

      await safeDM(member, { embeds: [embed], components: [row] });

      upsertSubscription(sub.discord_id, {
        status: "expired",
        expired_notified_at: Date.now(),
        reminders: { d3: true, h24: true },
      });
    }

  }

  continue;
}

        // 🟡 3-DAY REMINDER
        if (hoursLeft <= 72 && hoursLeft > 24 && !sub?.reminders?.d3) {
          const member = await guild.members.fetch(sub.discord_id).catch(() => null);
          if (member) {
            const { embed, row } = buildRenewalReminderDM({
              tier: sub.tier,
              expiresAtMs: sub.expires_at,
              windowLabel: "3 DAYS",
              memberName: member.user.username,
            });

            await safeDM(member, { embeds: [embed], components: [row] });
            await log(`⏳ 3-day reminder: <@${sub.discord_id}>`);
          }

          upsertSubscription(sub.discord_id, { reminders: { d3: true } });
        }

        // 🔶 24-HOUR REMINDER
        if (hoursLeft <= 24 && msLeft > 0 && !sub?.reminders?.h24) {
          const member = await guild.members.fetch(sub.discord_id).catch(() => null);
          if (member) {
            const { embed, row } = buildRenewalReminderDM({
              tier: sub.tier,
              expiresAtMs: sub.expires_at,
              windowLabel: "24 HOURS",
              memberName: member.user.username,
            });

            await safeDM(member, { embeds: [embed], components: [row] });
            await log(`⚠️ 24-hour reminder: <@${sub.discord_id}>`);
          }

          upsertSubscription(sub.discord_id, { reminders: { h24: true } });
        }
      }

      // ===========================
      // 🏆 MONTHLY CEREMONY (NY TIME)
      // ===========================
      const nyNow = new Date(
        new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
      );

      const isFirstDay = nyNow.getDate() === 1;
      const isMidnight = nyNow.getHours() === 0 && nyNow.getMinutes() === 0;

      global.__tgt_lastCeremony = global.__tgt_lastCeremony || null;
      const monthKey = `${nyNow.getFullYear()}-${String(nyNow.getMonth() + 1).padStart(2, "0")}`;

      if (isFirstDay && isMidnight && global.__tgt_lastCeremony !== monthKey) {
        global.__tgt_lastCeremony = monthKey;

        try {
          const { runMonthlyCeremony } = require("./monthlyCeremony");
          await runMonthlyCeremony(client);
          console.log("🏆 Monthly ceremony executed:", monthKey);
        } catch (e) {
          console.error("Monthly ceremony error:", e?.message);
        }
      }
    } catch (e) {
      console.log("SUB_MONITOR_TICK_ERROR:", e?.stack || e?.message || e);
    }
  }

  tick().catch(() => null);
  setInterval(() => tick().catch(() => null), 60 * 1000);
}

module.exports = {
  startSubscriptionMonitor,
  computeExpiryFrom,
};
