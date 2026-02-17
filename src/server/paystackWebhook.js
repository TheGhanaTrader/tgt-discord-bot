// src/server/paystackWebhook.js
const express = require("express");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const { sendPostUpgradeDm } = require("../services/postUpgradeDm");
const { mapInvite } = require("../services/referrals");

// ✅ Public verify reads from the same certificate registry used by /verifycert
const {
  findCertificateByCode,
  findLegacyByCode,
} = require("../services/certificatesLedger");

// -------------------- Helpers --------------------
function normalizeCode(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function fmtUTC(ms) {
  try {
    const d = new Date(ms);
    return isNaN(d.getTime()) ? "Unknown" : d.toUTCString();
  } catch {
    return "Unknown";
  }
}

function safeText(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function maskDiscordId(id) {
  const s = String(id || "");
  if (s.length <= 8) return s || "—";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function rewardStatusLabel(cert) {
  if (!cert) return "Unknown";
  if (!cert.rewardClaimable) return "Not applicable";
  return cert.claimed ? `Claimed (${fmtUTC(cert.claimedAt)})` : "Unclaimed";
}

// -------------------- Simple in-memory rate limit --------------------
const RL_WINDOW_MS = 60 * 1000; // 60s
const RL_MAX = 25; // 25 req/min/IP
const rl = new Map();

function rateLimit(req, res, next) {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const now = Date.now();
    const rec = rl.get(ip) || { ts: now, count: 0 };

    if (now - rec.ts > RL_WINDOW_MS) {
      rec.ts = now;
      rec.count = 0;
    }

    rec.count += 1;
    rl.set(ip, rec);

    if (rec.count > RL_MAX) {
      return res.status(429).send("Too many requests. Try again soon.");
    }

    return next();
  } catch {
    return next();
  }
}

// -------------------- Public HTML --------------------
function verifyHTML() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>The Ghana Trader — Certificate Verification</title>
  <style>
    :root{
      --bg:#0b0b0b;
      --card:#121212;
      --gold:#C9A24D;
      --muted:rgba(255,255,255,.72);
      --text:rgba(255,255,255,.92);
      --border:rgba(201,162,77,.35);
      --danger:#ff3b3b;
      --ok:#28d17c;
    }
    body{
      margin:0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: radial-gradient(1200px 600px at 50% 0%, rgba(201,162,77,.12), transparent 60%), var(--bg);
      color:var(--text);
      display:flex;
      min-height:100vh;
      align-items:center;
      justify-content:center;
      padding:24px;
    }
    .wrap{ width:min(920px, 100%); }
    .brand{
      display:flex; align-items:center; gap:12px;
      margin-bottom:16px;
    }
    .badge{
      width:40px;height:40px;border-radius:12px;
      border:1px solid var(--border);
      display:flex;align-items:center;justify-content:center;
      color:var(--gold); font-weight:800;
      background: rgba(0,0,0,.35);
    }
    h1{ margin:0; font-size:20px; letter-spacing:.2px; }
    .sub{ margin:6px 0 0; color:var(--muted); font-size:13px; }
    .card{
      background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
      border:1px solid var(--border);
      border-radius:18px;
      padding:18px;
      box-shadow: 0 20px 60px rgba(0,0,0,.55);
    }
    .row{ display:flex; gap:10px; flex-wrap:wrap; }
    input{
      flex:1;
      min-width:240px;
      background: rgba(0,0,0,.55);
      border:1px solid rgba(255,255,255,.10);
      border-radius:12px;
      padding:12px 12px;
      color:var(--text);
      outline:none;
      font-size:14px;
    }
    button{
      background: rgba(201,162,77,.15);
      border:1px solid rgba(201,162,77,.45);
      color:var(--text);
      border-radius:12px;
      padding:12px 14px;
      font-weight:700;
      cursor:pointer;
    }
    button:hover{ background: rgba(201,162,77,.22); }
    .hint{ margin-top:10px; color:var(--muted); font-size:12px; }
    .result{
      margin-top:14px;
      padding:14px;
      border-radius:14px;
      border:1px solid rgba(255,255,255,.10);
      background: rgba(0,0,0,.35);
      display:none;
    }
    .ok{ border-color: rgba(40,209,124,.35); }
    .bad{ border-color: rgba(255,59,59,.35); }
    .title{
      font-weight:800; margin:0 0 10px;
      display:flex; gap:10px; align-items:center;
    }
    .dot{
      width:10px; height:10px; border-radius:99px;
      background: var(--ok);
    }
    .dot.bad{ background: var(--danger); }
    .grid{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap:10px 14px;
    }
    .kv b{ display:block; color:var(--muted); font-size:12px; margin-bottom:3px; }
    .kv span{ font-size:14px; }
    .footer{
      margin-top:12px;
      color:rgba(255,255,255,.55);
      font-size:12px;
      text-align:center;
    }
    @media (max-width: 700px){
      .grid{ grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="badge">TG</div>
      <div>
        <h1>Certificate Verification</h1>
        <p class="sub">The Ghana Trader — Prestige. Proof. Performance.</p>
      </div>
    </div>

    <div class="card">
      <div class="row">
        <input id="code" placeholder="Enter verification code (16 chars)" autocomplete="off" />
        <button id="btn">Verify</button>
      </div>
      <div class="hint">Tip: You can paste the code from the certificate, or scan the QR.</div>

      <div id="result" class="result">
        <p class="title">
          <span id="dot" class="dot"></span>
          <span id="headline">—</span>
        </p>
        <div class="grid" id="grid"></div>
      </div>
    </div>

    <div class="footer">If you believe a valid certificate is failing verification, confirm the code was copied exactly.</div>
  </div>

<script>
  const codeEl = document.getElementById("code");
  const btn = document.getElementById("btn");
  const result = document.getElementById("result");
  const grid = document.getElementById("grid");
  const dot = document.getElementById("dot");
  const headline = document.getElementById("headline");

  function kv(k, v){
    const div = document.createElement("div");
    div.className = "kv";
    div.innerHTML = "<b>" + k + "</b><span>" + (v ?? "—") + "</span>";
    return div;
  }

  async function run(){
    const raw = (codeEl.value || "").trim();
    if(!raw){ return; }

    btn.disabled = true;
    btn.textContent = "Verifying…";

    try{
      const res = await fetch("/api/verify?code=" + encodeURIComponent(raw), { method: "GET" });
      const data = await res.json();

      grid.innerHTML = "";
      result.style.display = "block";

      if(data.ok){
        result.classList.remove("bad");
        result.classList.add("ok");
        dot.classList.remove("bad");
        headline.textContent = "Certificate Verified";

        grid.appendChild(kv("Verification Code", data.code));
        grid.appendChild(kv("Status", data.status));
        grid.appendChild(kv("Cycle", data.cycle));
        grid.appendChild(kv("Category", data.category));
        grid.appendChild(kv("Issued To", data.issuedTo));
        grid.appendChild(kv("Rank / Title", data.rankLabel));
        grid.appendChild(kv("Reward Label", data.rewardLabel));
        grid.appendChild(kv("Reward Status", data.rewardStatus));
        grid.appendChild(kv("Claim Reference", data.claimRef));
        grid.appendChild(kv("Issued At (UTC)", data.issuedAtUTC));
      } else {
        result.classList.remove("ok");
        result.classList.add("bad");
        dot.classList.add("bad");
        headline.textContent = data.legacy ? "Legacy Certificate (Recorded)" : "Certificate Not Verified";

        grid.appendChild(kv("Verification Code", data.code));
        grid.appendChild(kv("Result", data.message));
      }
    } catch(e){
      result.style.display = "block";
      result.classList.remove("ok");
      result.classList.add("bad");
      dot.classList.add("bad");
      headline.textContent = "Error";
      grid.innerHTML = "";
      grid.appendChild(kv("Message", "Verification request failed. Try again."));
    } finally{
      btn.disabled = false;
      btn.textContent = "Verify";
    }
  }

  btn.addEventListener("click", run);
  codeEl.addEventListener("keydown", (e) => {
    if(e.key === "Enter"){ run(); }
  });

  const url = new URL(window.location.href);
  const c = url.searchParams.get("code");
  if(c){
    codeEl.value = c;
    run();
  }
</script>
</body>
</html>`;
}

// -------------------- Paystack Signature Verify (RAW body required) --------------------
function verifyPaystackSignature(req) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;

  const signature = req.headers["x-paystack-signature"];
  if (!signature) return false;

  const raw = req.rawBody;
  if (!raw || !(Buffer.isBuffer(raw) || typeof raw === "string")) return false;

  const hash = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  return hash === signature;
}

// -------------------- Main Server --------------------
function startPaystackWebhookServer() {
  const app = express();

  // ✅ Required behind ngrok / reverse proxies so IP + headers behave correctly
  app.set("trust proxy", 1);

  // ✅ Capture RAW body for webhook signature verification
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.use(cookieParser(process.env.OAUTH_SESSION_SECRET));

  function base64UrlEncode(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function signState(payloadB64) {
  const secret = process.env.OAUTH_STATE_SECRET || process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("Missing OAUTH_STATE_SECRET (or PAYSTACK_SECRET_KEY fallback).");
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
}

function makeOAuthState({ tier }) {
  const payload = {
  ...arguments[0], // keeps tier AND ref
  ts: Date.now(),
  nonce: crypto.randomBytes(12).toString("hex"),
};
  const b64 = base64UrlEncode(payload);
  const sig = signState(b64);
  return `${b64}.${sig}`;
}

function verifyOAuthState(state) {
  if (!state || !String(state).includes(".")) return null;
  const [b64, sig] = String(state).split(".");
  const expected = signState(b64);
  if (sig !== expected) return null;

  const payload = base64UrlDecode(b64);
  const ageMs = Date.now() - Number(payload.ts || 0);

  const isRefFlow = String(payload.flow || "") === "ref";

  // ✅ allow referral-only OAuth state without tier (bind-only)
  if ((!payload.tier && !isRefFlow) || ageMs < 0 || ageMs > 10 * 60 * 1000) return null; // 10 minutes

  return payload;
}

async function discordExchangeCodeForToken(code, redirectUri) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET");

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);

  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error_description || data?.error || "Discord token exchange failed");
  return data; // { access_token, token_type, ... }
}

async function discordFetchUser(accessToken) {
  const r = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Discord user fetch failed");
  return data; // { id, username, ... }
}

  // Health
  app.get("/", (req, res) => res.status(200).send("OK"));
  // ✅ Logout / cookie reset (for clean testing)
app.get("/auth/logout", rateLimit, (req, res) => {
  try {
    res.clearCookie("tgt_oauth");
    res.clearCookie("tgt_ref");
    return res.status(200).send("OK: cleared tgt_oauth + tgt_ref");
  } catch (e) {
    console.log("LOGOUT_ERR:", e?.message || e);
    return res.status(500).send("Logout failed");
  }
});

  // ✅ Public Verify Page
  app.get("/verify", rateLimit, (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(200).send(verifyHTML());
  });

  // ✅ Public Verify API (read-only)
  app.get("/api/verify", rateLimit, (req, res) => {
    const code = normalizeCode(req.query.code);
    if (!code) {
      return res.json({
        ok: false,
        legacy: false,
        code: "",
        message: "Missing verification code.",
      });
    }

    const cert = findCertificateByCode(code);
    if (cert) {
      const issuedTo =
        cert.username && cert.username.trim().length
          ? safeText(cert.username)
          : cert.userId
          ? `Discord ID: ${maskDiscordId(cert.userId)}`
          : "Unknown";

      return res.json({
        ok: true,
        code: cert.code,
        status: "Authentic",
        cycle: cert.monthKey || "Unknown",
        category: cert.category || "Unknown",
        issuedTo,
        rankLabel: cert.rankLabel || "—",
        rewardLabel: cert.rewardLabel || "—",
        rewardStatus: rewardStatusLabel(cert),
        claimRef: cert.claimRef ? String(cert.claimRef) : "—",
        issuedAtUTC: fmtUTC(cert.createdAt),
      });
    }

    const legacy = findLegacyByCode(code);
    if (legacy) {
      return res.json({
        ok: false,
        legacy: true,
        code: legacy.code,
        message: "Legacy certificate recorded (issued before verification system).",
      });
    }

    return res.json({
      ok: false,
      legacy: false,
      code,
      message: "Code not found in the TGT certificate registry.",
    });
  });

  // ✅ payment initialization endpoint (POST) — internal/testing
  app.post("/pay/initialize", rateLimit, async (req, res) => {
    try {
      const { email, amount, metadata } = req.body || {};

      if (!email || !amount) {
        return res.status(400).json({
          ok: false,
          message: "Missing required fields: email, amount",
        });
      }

      const { initializeTransaction } = require("../services/paystack");
      const result = await initializeTransaction({ email, amount, metadata });

      return res.status(200).json({ ok: true, data: result });
    } catch (err) {
      console.log("PAY_INIT_ERR:", err?.message || err);
      return res.status(500).json({
        ok: false,
        message: err?.message || "Pay initialize failed",
      });
    }
  });

  // ✅ Discord OAuth start: 1-click from public gate -> Discord identify -> auto-redirect to Paystack
app.get("/auth/discord/start", rateLimit, async (req, res) => {
  try {
    const tier = String(req.query.tier || "").toUpperCase();
    const isRefFlow = flow === "ref";
    const effectiveTier = tier || "SILVER"; // default when ?tier is missing (referral links)
    // 🔗 Optional referral id passed in URL: ?ref=REFERRER_DISCORD_ID
    const refRaw = String(req.query.ref || "").trim();
    const refQ = /^\d{17,20}$/.test(refRaw) ? refRaw : "";
    const refC = req.signedCookies?.tgt_ref?.ref;
    const ref = refQ || (/^\d{17,20}$/.test(String(refC || "")) ? String(refC) : "");

        const allowed = new Set(["SILVER", "GOLD", "DIAMOND"]);
    if (!isRefFlow) {
      if (!allowed.has(effectiveTier)) {
        return res.status(400).send("Invalid tier.");
      }
    }

    // 🔁 Silent OAuth reuse (skip Discord authorize if session exists)
    const sess = req.signedCookies?.tgt_oauth;
    if (sess?.discordUserId) {
      console.log("OAUTH_REUSE_HIT discordUserId=", String(sess.discordUserId));
      console.log("OAUTH_REUSE_REF=", ref);

      const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
      const payUrl = new URL(`${base}/pay/subscribe`);
      payUrl.searchParams.set("tier", effectiveTier);
      payUrl.searchParams.set("discordUserId", String(sess.discordUserId));
      // ✅ If referral link used but OAuth session exists, bind now
if (ref && String(sess.discordUserId) && ref !== String(sess.discordUserId)) {
  try {
    const bindRes = await mapInvite(String(sess.discordUserId), ref); // memberId first, inviterId second
    console.log("✅ OAUTH_REUSE_BIND_OK:", bindRes || "ok");
    res.clearCookie("tgt_ref");

  } catch (e) {
    console.log("REF_BIND_ERR(sess):", e?.message || e);
  }
        // ✅ Referral-only flow: redirect to Discord, NOT Paystack
      if (isRefFlow) {
        const invite = String(process.env.DISCORD_INVITE_URL || "").trim();
        if (!invite) return res.status(500).send("DISCORD_INVITE_URL missing.");
        return res.redirect(302, invite);
      }
}
      return res.redirect(302, payUrl.toString());
    }

    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    if (!base) return res.status(500).send("PUBLIC_BASE_URL missing.");

    const redirectUri = `${base}/auth/discord/callback`;

    // Extend existing OAuth state (do NOT break tier)
    const state = makeOAuthState({ tier: effectiveTier, ref });

    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) return res.status(500).send("DISCORD_CLIENT_ID missing.");

    const u = new URL("https://discord.com/api/oauth2/authorize");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "identify");
    u.searchParams.set("state", state);

    return res.redirect(302, u.toString());
  } catch (e) {
    console.log("OAUTH_START_ERR:", e?.message || e);
    return res.status(500).send("OAuth start failed.");
  }
});

// ✅ Discord OAuth callback: binds user id -> redirects to Paystack subscribe
app.get("/auth/discord/callback", rateLimit, async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    if (!code || !state) return res.status(400).send("Missing code/state.");

    const payload = verifyOAuthState(state);
    if (!payload) return res.status(400).send("Invalid or expired state.");

    const tier = String(payload.tier || "").toUpperCase();
    console.log("OAUTH_PAYLOAD:", payload);
    const referrerId = /^\d{17,20}$/.test(String(payload.ref || "")) ? String(payload.ref) : "";

    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const redirectUri = `${base}/auth/discord/callback`;

    const token = await discordExchangeCodeForToken(code, redirectUri);
    const user = await discordFetchUser(token.access_token);
    // 🧷 Bind referral once (immutable). Safe no-op if invalid/duplicate/self.
if (referrerId && user?.id && referrerId !== String(user.id)) {
  try {
    const bindRes = await mapInvite(String(user.id), referrerId); // memberId first, inviterId second
        // ✅ Referral-only flow: after binding, send user to Discord invite (no Paystack)
    const isRefFlow = String(payload.flow || "") === "ref";
    if (isRefFlow) {
      const invite = String(process.env.DISCORD_INVITE_URL || "").trim();
      if (!invite) return res.status(500).send("DISCORD_INVITE_URL missing.");
      return res.redirect(302, invite);
    }

    console.log("✅ REF_BIND_OK:", bindRes || "ok");
  } catch (e) {
    console.log("REF_BIND_ERR:", e?.message || e);
  }
}

    const payUrl = new URL(`${base}/pay/subscribe`);
    payUrl.searchParams.set("tier", tier);
    payUrl.searchParams.set("discordUserId", String(user.id));

    // 🔐 Store short-lived OAuth session (silent reuse)
    res.cookie("tgt_oauth", {
      discordUserId: String(user.id),
      issuedAt: Date.now(),
    }, {
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
   });

    return res.redirect(302, payUrl.toString());
  } catch (e) {
    console.log("OAUTH_CALLBACK_ERR:", e?.message || e);
    return res.status(500).send("OAuth callback failed.");
  }
});

  // ✅ Plan-based subscribe (GET)
  app.get("/pay/subscribe", rateLimit, async (req, res) => {
    try {
      const tier = String(req.query.tier || "").toUpperCase();
      const discordUserId = String(req.query.discordUserId || "");

      if (!tier || !discordUserId) {
        return res.status(400).send("Missing tier or discordUserId.");
      }

      const email = process.env.DEFAULT_PAYSTACK_EMAIL;
      if (!email) return res.status(500).send("DEFAULT_PAYSTACK_EMAIL missing in .env");

      const PLAN_BY_TIER = {
        SILVER: process.env.PAYSTACK_PLAN_SILVER,
        GOLD: process.env.PAYSTACK_PLAN_GOLD,
        DIAMOND: process.env.PAYSTACK_PLAN_DIAMOND,
      };

      const AMOUNT_BY_TIER = {
        SILVER: Number(process.env.PAYSTACK_AMOUNT_SILVER),
        GOLD: Number(process.env.PAYSTACK_AMOUNT_GOLD),
        DIAMOND: Number(process.env.PAYSTACK_AMOUNT_DIAMOND),
      };

      const plan = PLAN_BY_TIER[tier];
      const amount = AMOUNT_BY_TIER[tier];

      if (!plan) return res.status(500).send(`Missing PAYSTACK_PLAN_${tier} in .env`);
      if (!amount || Number.isNaN(amount))
        return res.status(500).send(`Missing or invalid PAYSTACK_AMOUNT_${tier} in .env`);

      const { initializePlanTransaction } = require("../services/paystack");
      const callback_url = `${process.env.PUBLIC_BASE_URL}/pay/complete`;

      const result = await initializePlanTransaction({
        email,
        plan,
        amount,
        metadata: { tier, discordUserId },
        callback_url,
      });

      const url = result?.authorization_url;
      if (!url) return res.status(500).send("No authorization_url from Paystack.");

      return res.redirect(302, url);
    } catch (err) {
      console.log("PAY_SUBSCRIBE_ERR:", err?.message || err);
      return res.status(500).send(err?.message || "Pay subscribe failed");
    }
  });

  // ✅ Paystack “payment complete” landing page
  app.get("/pay/complete", (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res
      .status(200)
      .send("<h2>✅ Payment confirmed.</h2><p>Check your Discord DM to activate access via the Desk Agreement.</p>");
  });

  // ---- Paystack webhook route ----
  app.post("/paystack/webhook", async (req, res) => {
    try {
      // ✅ Always ACK fast
      res.status(200).send("ok");

      // ✅ Verify signature using RAW body buffer
      if (!verifyPaystackSignature(req)) {
        console.log("PAYSTACK_WEBHOOK_BAD_SIG");
        return;
      }

      const event = req.body;
      const eventType = event?.event;
      const data = event?.data;

      console.log("✅ PAYSTACK EVENT:", eventType);

      if (eventType === "charge.success") {
        const paid = data || {};
        const meta = paid?.metadata || {};

        let tier = String(meta?.tier || "").toUpperCase();
        let discordUserId = String(meta?.discordUserId || "").trim();
        console.log("PAYSTACK_META_IDS:", {
          tier: meta?.tier,
          discordUserId: meta?.discordUserId,
          customer: paid?.customer?.customer_code,
          subscription: paid?.subscription?.subscription_code,
        });
        const reference = String(
          paid?.reference ||
          event?.data?.reference ||
          event?.data?.id ||
          "-"
        ).trim();

        if (!tier || !discordUserId) {
  // Fallback for subscription renewals where metadata may be missing:
  // try mapping by subscription_code we stored on first payment.
  const subCode =
    paid?.subscription?.subscription_code ||
    paid?.subscription_code ||
    paid?.plan?.subscription_code ||
    null;

  if (!subCode) {
    console.log("PAYSTACK_CHARGE_SUCCESS_MISSING_META_AND_SUBCODE:", meta);
    return;
  }

  try {
    const { listAllSubscriptions } = require("../services/subscriptions");
    const all = await listAllSubscriptions();

    const match = all.find(
      (s) => String(s.paystack_subscription_code || "") === String(subCode)
    );

    if (!match?.discord_id) {
      console.log("PAYSTACK_RENEWAL_NO_MATCH_FOR_SUBCODE:", subCode);
      return;
    }

    // Set discordUserId from matched record
    // ✅ IMPORTANT: only map for renewals when metadata discordUserId is missing
    if (discordUserId) {
      console.log("PAYSTACK_RENEWAL_SKIP_MAPPING_META_PRESENT:", discordUserId);
      return;
    }

    const mappedDiscordUserId = String(match.discord_id).trim();

    // If tier missing, fall back to stored tier
    const mappedTier = String(match.tier || "").toUpperCase();

    if (!mappedTier) {
      console.log("PAYSTACK_RENEWAL_MATCH_NO_TIER:", subCode, mappedDiscordUserId);
      return;
    }

    // overwrite locals safely
    // eslint-disable-next-line no-unused-vars
    // (we simply reassign via new vars then use them below)
    console.log("✅ PAYSTACK_RENEWAL_MAPPED:", subCode, mappedDiscordUserId, mappedTier);

    // IMPORTANT: replace the original variables by shadowing
    // (keep minimal change—use these for the rest of the handler)
    tier = mappedTier;
    discordUserId = mappedDiscordUserId;
  } catch (e) {
    console.log("PAYSTACK_RENEWAL_MAP_ERR:", e?.message || e);
    return;
  }
}

        // 1) Roles
        try {
          const rolesMod = require("../discordRoles");
          if (rolesMod?.revokePremiumRoles) await rolesMod.revokePremiumRoles(discordUserId);
          if (rolesMod?.grantRole) await rolesMod.grantRole(discordUserId, tier, reference);
          console.log(`✅ ROLE UPDATED: ${tier} -> ${discordUserId}`);
          // 1.5) Prestige DM: receipt + Contract Gate button


        } catch (e) {
          console.log("ROLE_ASSIGN_ERR:", e?.message || e);
        }

        // 2) Subscription ledger (safe even if sync)
try {
  const { upsertSubscription } = require("../services/subscriptions");

  const tierLc = String(tier || "").toLowerCase();

  const paidAtIso = paid?.paid_at || paid?.created_at || new Date().toISOString();

  // durations that match your tiers: Silver monthly, Gold quarterly, Diamond yearly
  const { computeExpiryFrom } = require("../jobs/subscriptionMonitor");
  const base = new Date(paidAtIso);
  const expiresAtMs = computeExpiryFrom(tierLc, base).getTime();

  const isFirstTime = false; // keep false for now (we’ll handle properly in Step 6)

  await upsertSubscription(discordUserId, {
    tier: tierLc,
    status: "active",
    expires_at: expiresAtMs,
    paystack_subscription_code: paid?.subscription?.subscription_code || paid?.subscription_code || null,
    expired_notified_at: null,
    reminders: { d3: false, h24: false },
    last_paystack_ref: reference || null,
  });

  // (Removed) enforcePremiumRole — not implemented. Roles are handled elsewhere.

  console.log("✅ SUBSCRIPTION UPSERT:", discordUserId, tierLc, expiresAtMs);
} catch (e) {
  console.log("SUB_UPSERT_ERR:", e?.message || e);
}

      // 3) Affiliate paid sale (first conversion only)
try {
  const refs = require("../services/referrals");

  const amountKobo = Number(paid?.amount || 0);
  const amountGhs = amountKobo ? amountKobo / 100 : 0;

  const referrerId = await refs.getReferrerByInvite(discordUserId);
  if (!referrerId) {
    console.log("ℹ️ No referrer for this buyer (affiliate skipped).");
    return;
  }

  const r = await refs.bump("sale", {
    referrerId,
    memberId: discordUserId,
    amountGhs,
  });
  
  console.log("AFF_BUMP_RESULT:", r);

  if (r?.ignored) {
    console.log("ℹ️ Affiliate sale ignored (already converted):", discordUserId);
  } else {
    console.log("✅ AFFILIATE SALE CREDITED:", referrerId, "member=", discordUserId, "amountGhs=", amountGhs);
  }
} catch (e) {
  console.log("AFFILIATE_CREDIT_ERR:", e?.message || e);
}  

        return;
      }
    } catch (err) {
      console.log("PAYSTACK_WEBHOOK_ERR:", err?.message || err);
      return;
    }
  });

  const port = Number(process.env.PORT || 3000);

  const server = app.listen(port, "0.0.0.0", () => {
    const actualPort = server.address()?.port;
    console.log(`🌐 Server running on :${actualPort}`);
  });

  server.on("error", (e) => {
    console.log("🌐 WEB_SERVER_ERR:", e?.message || e);
  });
}

module.exports = { startPaystackWebhookServer };
