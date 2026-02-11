// src/services/paystack.js
const PAYSTACK_BASE = "https://api.paystack.co";

function getSecret() {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("Missing PAYSTACK_SECRET_KEY in .env");
  return secret;
}

function getFetch() {
  // Node 18+ has global fetch
  if (typeof fetch === "function") return fetch;
  // If you're on Node < 18 and you installed node-fetch, this will work:
  // eslint-disable-next-line global-require
  return require("node-fetch");
}

async function paystackPost(path, body) {
  const secret = getSecret();
  const _fetch = getFetch();

  const res = await _fetch(`${PAYSTACK_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.message || `Paystack request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  // Paystack returns { status: true/false, message, data }
  if (data?.status === false) {
    throw new Error(data?.message || "Paystack error");
  }

  return data?.data;
}

// A) Transaction initialize with amount
async function initializeTransaction({ email, amount, metadata, callback_url }) {
  if (!email) throw new Error("Missing email");
  if (!amount) throw new Error("Missing amount");

  return paystackPost("/transaction/initialize", {
    email,
    amount,
    metadata: metadata || {},
    ...(callback_url ? { callback_url } : {}),
  });
}

// B) Transaction initialize using PLAN (Paystack owns the price)
async function initializePlanTransaction({ email, plan, amount, metadata, callback_url }) {
  if (!email) throw new Error("Missing email");
  if (!plan) throw new Error("Missing plan");
  if (!amount) throw new Error("Missing amount");

  return paystackPost("/transaction/initialize", {
    email,
    plan,
    amount,
    metadata: metadata || {},
    ...(callback_url ? { callback_url } : {}),
  });
}

module.exports = {
  initializeTransaction,
  initializePlanTransaction,
};
