const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "fulfillmentQueue.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ items: [] }, null, 2));
}

function readDB() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { items: [] };
  }
}

function writeDB(db) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

function enqueue({ monthKey, userId, reward, provider = "FundedNext" }) {
  const db = readDB();
  const item = {
    id: `ff_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    monthKey,
    userId,
    reward,
    provider,
    status: "pending", // pending | delivered
    createdAt: Date.now(),
    deliveredAt: null,
  };
  db.items.push(item);
  writeDB(db);
  return item;
}

function listPending(monthKey = null) {
  const db = readDB();
  return db.items.filter((i) => i.status === "pending" && (!monthKey || i.monthKey === monthKey));
}

module.exports = {
  enqueue,
  listPending,
};
