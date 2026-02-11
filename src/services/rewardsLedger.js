// src/services/rewardsLedger.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "rewardsLedger.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ months: {} }, null, 2));
}

function readDB() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { months: {} };
  }
}

function writeDB(db) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

/**
 * Records winners and their verification codes for a month.
 * Structure:
 * months[monthKey] = { createdAt, winners: [{ userId, rank, reward, code, certPath, createdAt }] }
 */
function saveMonthWinners(monthKey, winners) {
  const db = readDB();
  db.months[monthKey] = {
    createdAt: Date.now(),
    winners: (winners || []).map((w) => ({
      userId: w.userId,
      rank: w.rank,
      reward: w.reward,
      code: w.code,
      certPath: w.certPath || null,
      createdAt: Date.now(),
    })),
  };
  writeDB(db);
}

function getMonthWinners(monthKey) {
  const db = readDB();
  return db.months?.[monthKey]?.winners || [];
}

// ✅ convenience guard: has this month already been locked/saved?
function hasMonthRecord(monthKey) {
  const db = readDB();
  return !!db.months?.[monthKey]; // lock even if winners is []
}

module.exports = {
  saveMonthWinners,
  getMonthWinners,
  hasMonthRecord,
};
