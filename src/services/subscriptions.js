const fs = require("fs");
const path = require("path");

// Persistent JSON store (simple + reliable for Stage 1)
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const FILE_PATH = path.join(DATA_DIR, "subscriptions.json");

// Windows hardening: tiny sync sleep for retry backoff (EPERM/EACCES/EBUSY)
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    Atomics.wait(ia, 0, 0, ms);
  } catch {
    // fallback: do nothing (still safe)
  }
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify({ users: {} }, null, 2), "utf8");
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.users) parsed.users = {};
    return parsed;
  } catch {
    return { users: {} };
  }
  
}

let _isWriting = false;

function writeStore(store) {
  ensureStore();
  if (!store.users) store.users = {};

  // Prevent overlapping writes (Windows EPERM fix)
  const MAX_WAIT_LOOPS = 50; // ~1s max wait
  let loops = 0;
  while (_isWriting && loops < MAX_WAIT_LOOPS) {
    sleepSync(20);
    loops++;
  }

  _isWriting = true;

  try {
    // atomic write (avoids corrupted JSON)
    const tmp = `${FILE_PATH}.tmp`;

    const MAX_RETRIES = 6;
    let lastErr = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");

        try {
          fs.renameSync(tmp, FILE_PATH);
        } catch (e) {
          if (e && (e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY")) {
            try { fs.unlinkSync(FILE_PATH); } catch (_) {}
            fs.renameSync(tmp, FILE_PATH);
          } else {
            throw e;
          }
        }

        return; // ✅ success
      } catch (err) {
        lastErr = err;
        const code = err && err.code;

        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") break;

        sleepSync(30 * (i + 1));
      }
    }

    console.error("SUBSCRIPTIONS_WRITE_FAILED:", lastErr && lastErr.code, lastErr && lastErr.message);
    throw lastErr;

  } finally {
    _isWriting = false;
    try { fs.unlinkSync(`${FILE_PATH}.tmp`); } catch (_) {}
  }
}


function getSubscription(discordId) {
  const store = readStore();
  return store.users[String(discordId)] || null;
}

function upsertSubscription(discordId, patch) {
  const store = readStore();
  const id = String(discordId);

  const current = store.users[id] || {
    discord_id: id,
    tier: null,
    status: "inactive",
    expires_at: null,
    last_paystack_ref: null,
    expired_notified_at: null,
    reminders: { d3: false, h24: false },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const next = {
    ...current,
    ...patch,
    discord_id: current.discord_id || id,
    reminders: {
      ...current.reminders,
      ...(patch.reminders || {}),
    },
    updated_at: new Date().toISOString(),
  };

  store.users[id] = next;
  writeStore(store);
  return next;
}

function listAllSubscriptions() {
  const store = readStore();
  return Object.entries(store.users || {}).map(([id, sub]) => ({
    discord_id: sub.discord_id || id,
    ...sub,
  }));
}

module.exports = {
  getSubscription,
  upsertSubscription,
  listAllSubscriptions,
};
