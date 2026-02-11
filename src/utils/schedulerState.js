"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "scheduler-state.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeReadJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function atomicWriteJSON(filePath, obj) {
  ensureDir();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function nowISO() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    jobs: {},
    updatedAt: nowISO(),
  };
}

function loadState() {
  ensureDir();
  const s = safeReadJSON(STATE_PATH);
  if (!s || typeof s !== "object") return defaultState();
  if (!s.jobs || typeof s.jobs !== "object") s.jobs = {};
  return s;
}

function saveState(state) {
  state.updatedAt = nowISO();
  atomicWriteJSON(STATE_PATH, state);
}

/**
 * Acquire a persistent lock for a job.
 */
function acquireLock({ jobKey, runKey, holder, ttlMs }) {
  const state = loadState();
  if (!state.jobs[jobKey]) state.jobs[jobKey] = {};

  const job = state.jobs[jobKey];
  const now = Date.now();

  if (job.lock && job.lock.expiresAt && now < job.lock.expiresAt) {
    if (job.lock.runKey === runKey) {
      return {
        ok: false,
        reason: `LOCKED: job already running for ${runKey} (holder=${job.lock.holder})`,
        lock: job.lock,
        state,
      };
    }
    return {
      ok: false,
      reason: `LOCKED: job already running (holder=${job.lock.holder}, runKey=${job.lock.runKey})`,
      lock: job.lock,
      state,
    };
  }

  const lock = {
    holder,
    runKey,
    acquiredAt: now,
    acquiredAtISO: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
    expiresAtISO: new Date(now + ttlMs).toISOString(),
  };

  job.lock = lock;
  job.lastAttempt = {
    runKey,
    holder,
    at: now,
    atISO: new Date(now).toISOString(),
  };

  saveState(state);
  return { ok: true, lock, state };
}

function releaseLock({ jobKey, runKey, holder }) {
  const state = loadState();
  if (!state.jobs[jobKey]) state.jobs[jobKey] = {};
  const job = state.jobs[jobKey];

  if (job.lock && job.lock.runKey === runKey && job.lock.holder === holder) {
    delete job.lock;
    saveState(state);
    return { ok: true };
  }

  return {
    ok: false,
    reason: "LOCK_MISMATCH_OR_MISSING",
    currentLock: job.lock || null,
  };
}

function markSuccess({ jobKey, runKey, meta }) {
  const state = loadState();
  if (!state.jobs[jobKey]) state.jobs[jobKey] = {};
  const job = state.jobs[jobKey];

  job.lastSuccess = {
    runKey,
    at: Date.now(),
    atISO: nowISO(),
    meta: meta || {},
  };

  // Clear any lock (safety) if it somehow persisted
  if (job.lock && job.lock.runKey === runKey) delete job.lock;

  saveState(state);
}

function markFailure({ jobKey, runKey, error }) {
  const state = loadState();
  if (!state.jobs[jobKey]) state.jobs[jobKey] = {};
  const job = state.jobs[jobKey];

  job.lastFailure = {
    runKey,
    at: Date.now(),
    atISO: nowISO(),
    error: typeof error === "string" ? error : (error?.message || "Unknown error"),
  };

  saveState(state);
}

function getJobStatus(jobKey) {
  const state = loadState();
  const job = state.jobs[jobKey] || {};
  return {
    jobKey,
    lock: job.lock || null,
    lastAttempt: job.lastAttempt || null,
    lastSuccess: job.lastSuccess || null,
    lastFailure: job.lastFailure || null,
    updatedAt: state.updatedAt,
  };
}

/**
 * Admin unlock:
 * - clears lock if expired
 * - OR clears lock if force=true
 */
function clearLock({ jobKey, force = false, requestedBy = "unknown" }) {
  const state = loadState();
  if (!state.jobs[jobKey]) state.jobs[jobKey] = {};
  const job = state.jobs[jobKey];

  const lock = job.lock || null;
  if (!lock) {
    return { ok: true, cleared: false, reason: "NO_LOCK_PRESENT", lock: null };
  }

  const now = Date.now();
  const expired = lock.expiresAt ? now >= lock.expiresAt : true;

  if (!force && !expired) {
    return {
      ok: false,
      cleared: false,
      reason: "LOCK_ACTIVE_NOT_EXPIRED",
      lock,
    };
  }

  job.lastUnlock = {
    at: now,
    atISO: new Date(now).toISOString(),
    requestedBy,
    force: !!force,
    expired,
    clearedRunKey: lock.runKey,
    clearedHolder: lock.holder,
  };

  delete job.lock;
  saveState(state);

  return { ok: true, cleared: true, expired, priorLock: lock };
}

module.exports = {
  acquireLock,
  releaseLock,
  markSuccess,
  markFailure,
  getJobStatus,
  clearLock,
};
