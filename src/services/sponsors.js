"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const SPONSORS_PATH = path.join(DATA_DIR, "sponsors.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(SPONSORS_PATH)) {
    return {
      enabled: false,
      rotation: "round_robin", // future-proof
      pointer: 0,
      sponsors: [],
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const raw = fs.readFileSync(SPONSORS_PATH, "utf8");
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj.sponsors)) obj.sponsors = [];
    if (typeof obj.pointer !== "number") obj.pointer = 0;
    if (typeof obj.enabled !== "boolean") obj.enabled = false;
    if (!obj.rotation) obj.rotation = "round_robin";
    return obj;
  } catch {
    return {
      enabled: false,
      rotation: "round_robin",
      pointer: 0,
      sponsors: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

function save(state) {
  ensureDir();
  state.updatedAt = new Date().toISOString();
  const tmp = `${SPONSORS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, SPONSORS_PATH);
}

function normalizeSponsor(s) {
  return {
    id: String(s.id || "").trim() || `sp_${Date.now()}`,
    name: String(s.name || "").trim(),
    tagline: String(s.tagline || "").trim(), // short
    url: String(s.url || "").trim(), // optional
    active: s.active !== false,
  };
}

function listSponsors() {
  const st = load();
  return st;
}

function setEnabled(enabled) {
  const st = load();
  st.enabled = !!enabled;
  save(st);
  return st;
}

function addSponsor({ name, tagline, url }) {
  const st = load();
  const sponsor = normalizeSponsor({ id: `sp_${Date.now()}`, name, tagline, url, active: true });
  st.sponsors.push(sponsor);
  save(st);
  return sponsor;
}

function removeSponsor(id) {
  const st = load();
  const before = st.sponsors.length;
  st.sponsors = st.sponsors.filter((x) => x.id !== id);
  if (st.pointer >= st.sponsors.length) st.pointer = 0;
  save(st);
  return { removed: before !== st.sponsors.length };
}

function setActive(id, active) {
  const st = load();
  const s = st.sponsors.find((x) => x.id === id);
  if (!s) return null;
  s.active = !!active;
  save(st);
  return s;
}

function pickNextSponsor() {
  const st = load();
  if (!st.enabled) return null;

  const active = st.sponsors.filter((x) => x.active);
  if (!active.length) return null;

  // round robin pointer over active list
  const idx = st.pointer % active.length;
  const chosen = active[idx];

  st.pointer = (idx + 1) % active.length;
  save(st);

  return chosen;
}

function formatSponsorLine(s) {
  if (!s) return null;
  const name = s.name || "Sponsor";
  const tag = s.tagline ? ` — ${s.tagline}` : "";
  // Do not render markdown links if URL missing
  if (s.url) return `Sponsored by **${name}**${tag} • ${s.url}`;
  return `Sponsored by **${name}**${tag}`;
}

module.exports = {
  listSponsors,
  setEnabled,
  addSponsor,
  removeSponsor,
  setActive,
  pickNextSponsor,
  formatSponsorLine,
};
