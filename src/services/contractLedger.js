// src/services/contractLedger.js
const fs = require("fs");
const path = require("path");

const LEDGER_PATH = path.join(process.cwd(), "data", "contractsLedger.json");

function ensureLedger() {
  const dir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(LEDGER_PATH)) fs.writeFileSync(LEDGER_PATH, JSON.stringify({ users: {} }, null, 2));
}

function readLedger() {
  ensureLedger();
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return { users: {} };
  }
}

function writeLedger(data) {
  ensureLedger();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(data, null, 2));
}

function hasAccepted(userId) {
  const ledger = readLedger();
  return Boolean(ledger.users?.[String(userId)]?.acceptedAtUtc);
}

function getAcceptance(userId) {
  const ledger = readLedger();
  return ledger.users?.[String(userId)] || null;
}

function recordAcceptance({ userId, username, tier, acceptedAtUtc, pdfPath }) {
  const ledger = readLedger();

  // ✅ harden against old/corrupt ledger shapes
  ledger.users = ledger.users || {};

  const id = String(userId);

  // ✅ TRUE idempotency: if already accepted, do NOT overwrite
  if (ledger.users[id]?.acceptedAtUtc) {
    return { ok: false, already: true, existing: ledger.users[id] };
  }

  ledger.users[id] = {
    userId: id,
    username,
    tier,
    acceptedAtUtc,
    pdfPath,
  };

  writeLedger(ledger);
  return { ok: true, already: false, entry: ledger.users[id] };
}

module.exports = {
  hasAccepted,
  getAcceptance,
  recordAcceptance,
};
