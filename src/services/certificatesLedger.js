// src/services/certificatesLedger.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "certificatesLedger.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(
      FILE,
      JSON.stringify({ issued: [], indexByCode: {} }, null, 2)
    );
  }
}

function readDB() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { issued: [], indexByCode: {} };
  }
}

function writeDB(db) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

/**
 * Record a certificate issuance (idempotent by code).
 * category examples:
 * - WINNER_TOP_SALES
 * - WINNER_2ND_SALES
 * - WINNER_TOP_REFERRER
 * - TOP10_SALES
 * - TOP10_REFERRALS
 */
function recordCertificate({
  monthKey,
  userId,
  username,
  category,
  rankLabel,
  rewardLabel,
  code,
  filePath,
}) {
  if (!code) return;

  const db = readDB();
  const normalized = String(code).trim().toUpperCase();

  // If code already exists, do nothing (idempotent)
  if (db.indexByCode?.[normalized]) return;

  const entry = {
    monthKey: String(monthKey || ""),
    userId: String(userId || ""),
    username: String(username || ""),
    category: String(category || ""),
    rankLabel: String(rankLabel || ""),
    rewardLabel: String(rewardLabel || ""),
    code: normalized,
    filePath: filePath || null,
    createdAt: Date.now(),
  };

  db.issued = Array.isArray(db.issued) ? db.issued : [];
  db.indexByCode = db.indexByCode || {};

  db.issued.push(entry);
  db.indexByCode[normalized] = entry;

  writeDB(db);
}

function findCertificateByCode(code) {
  const db = readDB();
  const normalized = String(code || "").trim().toUpperCase();
  return db.indexByCode?.[normalized] || null;
}

function getUserCertificates(userId, monthKey = null) {
  const db = readDB();
  const uid = String(userId || "");
  const list = Array.isArray(db.issued) ? db.issued : [];
  const filtered = list.filter((x) => x.userId === uid);
  if (!monthKey) return filtered;
  return filtered.filter((x) => x.monthKey === String(monthKey));
}

module.exports = {
  recordCertificate,
  findCertificateByCode,
  getUserCertificates,
};
