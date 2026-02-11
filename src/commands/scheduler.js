"use strict";

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const { schedulerStatus, runMonthlyIfDue } = require("../scheduler/monthlyHonorsScheduler");
const { runMonthlyCeremony } = require("../jobs/monthlyCeremony");
const { clearLock } = require("../utils/schedulerState");

function isAdminMember(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function guessHonorsRunKeyFromNY(nowISO) {
  const d = new Date(nowISO);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  let yy = y;
  let mm = m - 1;
  if (mm === 0) {
    mm = 12;
    yy = y - 1;
  }
  return `${yy}-${String(mm).padStart(2, "0")}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("scheduler")
    .setDescription("Admin tools for the monthly scheduler (hardening controls).")
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show scheduler lock + last success/failure + due decision.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("run")
        .setDescription("Force-run the monthly honors ceremony (lock-protected).")
        .addBooleanOption((opt) => opt.setName("force").setDescription("If true, runs even if not due.").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("dryrun")
        .setDescription("Preview outcomes WITHOUT posting/DM/roles/ledgers (safe).")
        .addStringOption((opt) =>
          opt.setName("month").setDescription('Optional target honors month "YYYY-MM" (example: 2026-01).').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("unlock")
        .setDescription("Clear a scheduler lock (expired only unless force=true).")
        .addBooleanOption((opt) =>
          opt.setName("force").setDescription("Force unlock even if lock is still active.").setRequired(false)
        )
    ),

  async execute(interaction) {
    if (!isAdminMember(interaction)) {
      return interaction.reply({ content: "⛔ You don't have permission to use this command.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "status") {
      const s = schedulerStatus();

      const lockLine = s.status.lock
        ? `✅ **LOCK**: active\n• holder: ${s.status.lock.holder}\n• runKey: ${s.status.lock.runKey}\n• expires: ${s.status.lock.expiresAtISO}`
        : "🟦 **LOCK**: none";

      const lastSuccess = s.status.lastSuccess
        ? `✅ **LAST SUCCESS**: ${s.status.lastSuccess.runKey}\n• at: ${s.status.lastSuccess.atISO}`
        : "— **LAST SUCCESS**: none";

      const lastFailure = s.status.lastFailure
        ? `⚠️ **LAST FAILURE**: ${s.status.lastFailure.runKey}\n• at: ${s.status.lastFailure.atISO}\n• error: ${s.status.lastFailure.error}`
        : "— **LAST FAILURE**: none";

      const decision = s.decision;
      const decisionLine =
        `🧠 **DUE CHECK**\n` +
        `• nowNY: ${s.nowNY}\n` +
        `• scheduledAt: ${decision.scheduledAtISO}\n` +
        `• runKey: ${decision.runKey}\n` +
        `• afterSched: ${decision.isAfterSched}\n` +
        `• withinCatchup: ${decision.isWithinCatchup}\n` +
        `• alreadySucceeded: ${decision.alreadySucceeded}\n` +
        `• shouldRun: ${decision.should}`;

      return interaction.reply({
        content: `${lockLine}\n\n${lastSuccess}\n\n${lastFailure}\n\n${decisionLine}`,
        ephemeral: true,
      });
    }

    if (sub === "run") {
      await interaction.reply({ content: "⏳ Running scheduler (lock-protected)…", ephemeral: true });

      const force = interaction.options.getBoolean("force") ?? true;

      const res = await runMonthlyIfDue({
        client: interaction.client,
        force,
        invokedBy: interaction.user.id,
      });

      if (!res.ok) {
        return interaction.editReply({
          content: `❌ Scheduler run failed.\n• error: ${res.error}\n• runKey: ${res.runKey || res?.decision?.runKey || "n/a"}`,
        });
      }

      if (res.skipped) {
        return interaction.editReply({
          content: `✅ Scheduler check completed (skipped — not due).\n• runKey: ${res.decision?.runKey}\n• shouldRun: ${res.decision?.should}`,
        });
      }

      return interaction.editReply({ content: `✅ Scheduler run completed.\n• runKey: ${res.runKey}` });
    }

    if (sub === "dryrun") {
      await interaction.reply({ content: "🧪 Running DRY RUN preview (no posts, no DMs, no writes)…", ephemeral: true });

      const monthOpt = interaction.options.getString("month");
      let targetMonthISO = null;

      if (monthOpt && /^\d{4}-\d{2}$/.test(monthOpt)) {
        targetMonthISO = monthOpt;
      } else {
        const s = schedulerStatus();
        targetMonthISO = s?.decision?.runKey || guessHonorsRunKeyFromNY(s.nowNY);
      }

      const out = await runMonthlyCeremony({
        client: interaction.client,
        targetMonthISO,
        reason: "ADMIN_DRY_RUN",
        dryRun: true,
      });

      const winnerLines = (out.winners || []).length
        ? out.winners.map((w) => `• <@${w.userId}> — ${w.rank} — ${w.reward}`).join("\n")
        : "• None (no public winners)";

      const msg =
        `🧪 **DRY RUN PREVIEW**\n` +
        `• month: **${out.monthKey}**\n` +
        `• entries: **${out.counts?.entries ?? "n/a"}**\n` +
        `• top10Sales: **${out.counts?.top10Sales ?? "n/a"}**\n` +
        `• top10Referrals: **${out.counts?.top10Referrals ?? "n/a"}**\n` +
        `• public winners: **${out.winners?.length ?? 0}**\n\n` +
        `**Public Winners (if any):**\n${winnerLines}\n\n` +
        `✅ No messages were posted. No DMs sent. No roles assigned. No ledgers updated.`;

      return interaction.editReply({ content: msg });
    }

    if (sub === "unlock") {
      await interaction.reply({ content: "🔓 Checking lock…", ephemeral: true });

      const force = interaction.options.getBoolean("force") ?? false;

      // This key must match your scheduler file constant:
      const JOB_KEY = "monthly_honors_scheduler";

      const res = clearLock({
        jobKey: JOB_KEY,
        force,
        requestedBy: interaction.user.id,
      });

      if (!res.ok) {
        return interaction.editReply({
          content:
            `❌ Unlock refused.\n` +
            `• reason: ${res.reason}\n` +
            `• current lock: holder=${res.lock?.holder} runKey=${res.lock?.runKey} expires=${res.lock?.expiresAtISO}\n` +
            `Tip: Use \`/scheduler unlock force:true\` if you are certain it is stale.`,
        });
      }

      if (!res.cleared) {
        return interaction.editReply({ content: `✅ No lock present — nothing to clear.` });
      }

      return interaction.editReply({
        content:
          `✅ Lock cleared.\n` +
          `• expired: ${res.expired}\n` +
          `• prior: holder=${res.priorLock?.holder} runKey=${res.priorLock?.runKey} expires=${res.priorLock?.expiresAtISO}`,
      });
    }
  },
};
