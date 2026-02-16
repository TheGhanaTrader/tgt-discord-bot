"use strict";

const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

const JOB_KEY = "sponsors_state";

let _pool = null;

function pool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (sponsors state in Postgres)");

  _pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return _pool;
}

function defaultState() {
  return {
    enabled: false,
    rotation: "round_robin", // future-proof
    pointer: 0,
    sponsors: [],
    updatedAt: new Date().toISOString(),
  };
}

async function load() {
  try {
    const p = pool();
    const q = `SELECT state_json FROM public.job_state WHERE job_key = $1 LIMIT 1`;
    const { rows } = await p.query(q, [JOB_KEY]);
    const raw = rows?.[0]?.state_json;

    const obj = raw && typeof raw === "object" ? raw : defaultState();

    if (!Array.isArray(obj.sponsors)) obj.sponsors = [];
    if (typeof obj.pointer !== "number") obj.pointer = 0;
    if (typeof obj.enabled !== "boolean") obj.enabled = false;
    if (!obj.rotation) obj.rotation = "round_robin";
    if (!obj.updatedAt) obj.updatedAt = new Date().toISOString();

    return obj;
  } catch {
    return defaultState();
  }
}

async function save(state) {
  const p = pool();
  const st = state && typeof state === "object" ? state : defaultState();
  st.updatedAt = new Date().toISOString();

  const q = `
    INSERT INTO public.job_state (job_key, state_json, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()
  `;
  await p.query(q, [JOB_KEY, JSON.stringify(st)]);
}

// Best-effort lock to avoid double pointer increments in multi-instance Railway
async function withLock(fn, ttlSeconds = 10) {
  const p = pool();
  const lockBy = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

  const q = `
    INSERT INTO public.job_state (job_key, state_json, locked_until, locked_by, updated_at)
    VALUES ($1, '{}'::jsonb, NOW() + ($2 || ' seconds')::interval, $3, NOW())
    ON CONFLICT (job_key)
    DO UPDATE SET
      locked_until = CASE
        WHEN public.job_state.locked_until IS NULL OR public.job_state.locked_until < NOW()
        THEN NOW() + ($2 || ' seconds')::interval
        ELSE public.job_state.locked_until
      END,
      locked_by = CASE
        WHEN public.job_state.locked_until IS NULL OR public.job_state.locked_until < NOW()
        THEN $3
        ELSE public.job_state.locked_by
      END,
      updated_at = NOW()
    RETURNING locked_by
  `;

  const { rows } = await p.query(q, [JOB_KEY, String(ttlSeconds), lockBy]);
  const owner = rows?.[0]?.locked_by;

  if (owner !== lockBy) {
    return fn({ locked: false, lockBy });
  }

  try {
    return await fn({ locked: true, lockBy });
  } finally {
    await p
      .query(
        `UPDATE public.job_state SET locked_until = NULL, locked_by = NULL, updated_at = NOW() WHERE job_key = $1 AND locked_by = $2`,
        [JOB_KEY, lockBy]
      )
      .catch(() => null);
  }
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

async function listSponsors() {
  const st = await load();
  return st;
}

async function setEnabled(enabled) {
  const st = await load();
  st.enabled = !!enabled;
  await save(st);
  return st;
}

async function addSponsor({ name, tagline, url }) {
  const st = await load();
  const sponsor = normalizeSponsor({
    id: `sp_${Date.now()}`,
    name,
    tagline,
    url,
    active: true,
  });
  st.sponsors.push(sponsor);
  await save(st);
  return sponsor;
}

async function removeSponsor(id) {
  const st = await load();
  const before = st.sponsors.length;
  st.sponsors = st.sponsors.filter((x) => x.id !== id);
  if (st.pointer >= st.sponsors.length) st.pointer = 0;
  await save(st);
  return { removed: before !== st.sponsors.length };
}

async function setActive(id, active) {
  const st = await load();
  const s = st.sponsors.find((x) => x.id === id);
  if (!s) return null;
  s.active = !!active;
  await save(st);
  return s;
}

async function pickNextSponsor() {
  return withLock(async ({ locked }) => {
    if (!locked) return null;

    const st = await load();
    if (!st.enabled) return null;

    const active = st.sponsors.filter((x) => x.active);
    if (!active.length) return null;

    // round robin pointer over active list
    const idx = st.pointer % active.length;
    const chosen = active[idx];

    st.pointer = (idx + 1) % active.length;
    await save(st);

    return chosen;
  });
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
