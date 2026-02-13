// src/services/propLedger.js
"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

function monthKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function yearKeyUTC(d = new Date()) {
  return String(d.getUTCFullYear());
}

// ---------------- Funded ----------------
async function logFunded({ userId, firm, accountSize, status, fundedDate }) {
  const mk = monthKeyUTC();
  const yk = yearKeyUTC();

  const q = `
    INSERT INTO prop_funded
      (user_id, firm, account_size, status, funded_date, month_key, year_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id
  `;
  const vals = [userId, firm, accountSize, status, fundedDate || null, mk, yk];
  const { rows } = await pool.query(q, vals);
  return rows[0];
}

// ---------------- Payouts ----------------
async function logPayout({ userId, firm, payoutAmount, statusAfter, payoutDate }) {
  const mk = monthKeyUTC();
  const yk = yearKeyUTC();

  const q = `
    INSERT INTO prop_payouts
      (user_id, firm, payout_amount, status_after, payout_date, month_key, year_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id
  `;
  const vals = [userId, firm, payoutAmount, statusAfter, payoutDate || null, mk, yk];
  const { rows } = await pool.query(q, vals);
  return rows[0];
}

// ---------------- Losses ----------------
async function logLoss({ userId, firm, accountSizeLost, reason, lessons }) {
  const mk = monthKeyUTC();
  const yk = yearKeyUTC();

  const q = `
    INSERT INTO prop_losses
      (user_id, firm, account_size_lost, reason, lessons, month_key, year_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id
  `;
  const vals = [userId, firm, accountSizeLost, reason, lessons || null, mk, yk];
  const { rows } = await pool.query(q, vals);
  return rows[0];
}

// ---------------- Denials ----------------
async function logDenial({ userId, firm, payoutAmountRequested, reason }) {
  const mk = monthKeyUTC();
  const yk = yearKeyUTC();

  const q = `
    INSERT INTO prop_denials
      (user_id, firm, payout_amount_requested, reason, month_key, year_key)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id
  `;
  const vals = [userId, firm, payoutAmountRequested, reason, mk, yk];
  const { rows } = await pool.query(q, vals);
  return rows[0];
}

module.exports = {
  logFunded,
  logPayout,
  logLoss,
  logDenial,
};
