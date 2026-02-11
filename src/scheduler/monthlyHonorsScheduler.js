"use strict";

const { DateTime } = require("luxon");
const {
  acquireLock,
  releaseLock,
  markSuccess,
  markFailure,
  getJobStatus,
} = require("../utils/schedulerState");

// ✅ Hook into your existing engine (do NOT change your engine logic)
const { runMonthlyCeremony } = require("../jobs/monthlyCeremony");

const JOB_KEY = "monthly_honors_scheduler";

// Lock TTL: allow ceremony to run long, but never deadlock forever.
const LOCK_TTL_MS = 1000 * 60 * 30; // 30 minutes

// How late is still considered acceptable to "catch up" after restart:
const CATCHUP_WINDOW_DAYS = 5;

// internal in-memory guard (extra layer; persistent lock is the real protection)
let inProcess = false;
let nextTimer = null;

function nyNow() {
  return DateTime.now().setZone("America/New_York");
}

/**
 * Returns runKey like "2026-02" for the *month being honored*.
 * We honor the previous month when running on the 1st.
 * Example: on Feb 1, 2026 → honors Jan 2026 → runKey "2026-01"
 */
function honorsMonthRunKey(nowNY) {
  const prev = nowNY.minus({ months: 1 });
  return prev.toFormat("yyyy-LL");
}

/**
 * The scheduled run time: 1st day of current month, 00:05 NY time.
 * (5 minutes after midnight to avoid edge-case jitter.)
 */
function scheduledTimeForThisMonth(nowNY) {
  return nowNY.startOf("month").set({ hour: 0, minute: 5, second: 0, millisecond: 0 });
}

/**
 * Determine if we should run now (scheduled), or catch up after restart.
 */
function shouldRunNow(nowNY, status) {
  const sched = scheduledTimeForThisMonth(nowNY);
  const runKey = honorsMonthRunKey(nowNY);

  // Must be on/after scheduled time.
  const isAfterSched = nowNY >= sched;

  // Within catchup window.
  const isWithinCatchup = nowNY <= sched.plus({ days: CATCHUP_WINDOW_DAYS });

  // Already succeeded for this runKey?
  const alreadySucceeded = status?.lastSuccess?.runKey === runKey;

  return {
    runKey,
    scheduledAtISO: sched.toISO(),
    isAfterSched,
    isWithinCatchup,
    alreadySucceeded,
    should: isAfterSched && isWithinCatchup && !alreadySucceeded,
  };
}

async function runMonthlyIfDue({ client, force = false, invokedBy = "boot" } = {}) {
  const nowNY = nyNow();
  const status = getJobStatus(JOB_KEY);

  const decision = shouldRunNow(nowNY, status);

  // Decide target runKey (honors previous month)
  const runKey = decision.runKey;

  // If not due and not forced, exit safely
  if (!force && !decision.should) return { ok: true, skipped: true, decision };

  // Memory guard
  if (inProcess) {
    return { ok: false, error: "IN_MEMORY_GUARD_BLOCKED", decision };
  }

  inProcess = true;

  const holder = force ? `admin:${invokedBy}` : `auto:${invokedBy}`;

  // Persistent lock guard
  const lockRes = acquireLock({
    jobKey: JOB_KEY,
    runKey,
    holder,
    ttlMs: LOCK_TTL_MS,
  });

  if (!lockRes.ok) {
    inProcess = false;
    return { ok: false, error: lockRes.reason || "LOCKED", decision };
  }

  try {
    // ✅ Run your existing engine (canonical record = tgt-honors stays unchanged)
    // targetMonthISO: "YYYY-MM"
    await runMonthlyCeremony({
      client,
      targetMonthISO: runKey,
      reason: force ? "ADMIN_OVERRIDE" : "SCHEDULED_RUN",
      dryRun: false,
    });

    markSuccess({
      jobKey: JOB_KEY,
      runKey,
      meta: {
        holder,
        ranAtNY: nowNY.toISO(),
      },
    });

    return { ok: true, skipped: false, runKey, decision };
  } catch (err) {
    markFailure({
      jobKey: JOB_KEY,
      runKey,
      error: err,
    });

    return { ok: false, error: err?.message || String(err), runKey, decision };
  } finally {
    releaseLock({ jobKey: JOB_KEY, runKey, holder });
    inProcess = false;
  }
}

/**
 * Schedules the next check (every minute) and also aligns to next monthly boundary.
 * We keep it simple and robust: a 60s loop that checks "due" state + persistent lock.
 */
function startMonthlyScheduler(client) {
  if (nextTimer) clearInterval(nextTimer);

  // On boot: attempt catch-up if needed.
  runMonthlyIfDue({ client, force: false, invokedBy: "boot" }).catch(() => {});

  nextTimer = setInterval(() => {
    runMonthlyIfDue({ client, force: false, invokedBy: "interval" }).catch(() => {});
  }, 60 * 1000);

  return true;
}

function stopMonthlyScheduler() {
  if (nextTimer) clearInterval(nextTimer);
  nextTimer = null;
}

function schedulerStatus() {
  const status = getJobStatus(JOB_KEY);
  const nowNY = nyNow();
  const decision = shouldRunNow(nowNY, status);
  return { status, nowNY: nowNY.toISO(), decision };
}

module.exports = {
  startMonthlyScheduler,
  stopMonthlyScheduler,
  runMonthlyIfDue,
  schedulerStatus,
  JOB_KEY,
};
