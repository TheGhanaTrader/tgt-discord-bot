import express from "express";
import crypto from "crypto";
import fetch from "node-fetch"; // if you're Node < 18. Node 18+ can use global fetch.

import { upsertSubscriptionFromPaystack, markSubscriptionCancelled } from "./subscriptionStore.js";
import { grantRole, revokePremiumRoles } from "./discordRoles.js";

const app = express();

// Paystack signature verification needs RAW body
app.use("/webhooks/paystack", express.raw({ type: "*/*" }));

function verifyPaystackSignature(req) {
  const signature = req.headers["x-paystack-signature"];
  if (!signature) return false;

  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET)
    .update(req.body)
    .digest("hex");

  return hash === signature;
}

async function fetchTransaction(reference) {
  const res = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Paystack verify failed: ${res.status}`);
  const json = await res.json();
  return json?.data;
}

app.post("/webhooks/paystack", async (req, res) => {
  try {
    // 1) Verify signature
    if (!verifyPaystackSignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    // 2) Parse event
    const event = JSON.parse(req.body.toString("utf8"));
console.log("✅ Paystack event received:", event.event);

if (event.event === "charge.success") {
  const discordUserId = event?.data?.metadata?.discordUserId;
  const tier = String(event?.data?.metadata?.tier || "").toUpperCase();

  if (!discordUserId || !ROLE_MAP[tier]) {
    console.log("⚠️ Missing or invalid metadata:", event?.data?.metadata);
    return res.status(200).send("ok");
  }

  try {
    await assignTierRole(client, discordUserId, tier);
    console.log(`✅ Role assigned: ${tier} → ${discordUserId}`);
  } catch (err) {
    console.error("❌ Failed to assign role:", err);
  }
}

return res.status(200).send("ok");


    // Always ACK quickly (Paystack retries on timeouts)
    res.status(200).send("ok");

    // 3) Handle events you care about
    // Recommended minimal set:
    // - charge.success (payment completed)
    // - subscription.create / subscription.disable (if you use Paystack subscriptions)
    // - invoice.payment_failed (optional)
    if (eventType === "charge.success") {
      const reference = data?.reference;
      if (!reference) return;

      // 4) Verify with Paystack API (prevents spoofed payloads)
      const tx = await fetchTransaction(reference);

      // 5) Extract YOUR metadata (discord user id + tier)
      // You MUST have added these when initiating payment:
      // metadata: { discordUserId, tier }
      const discordUserId = tx?.metadata?.discordUserId;
      const tier = tx?.metadata?.tier; // "SILVER" | "GOLD" | "DIAMOND"
      if (!discordUserId || !tier) return;

      // 6) Persist subscription status
      await upsertSubscriptionFromPaystack({
        discordUserId,
        tier,
        reference,
        paidAt: tx?.paid_at || new Date().toISOString(),
        status: "active",
      });

      // 7) Apply Discord roles
      await revokePremiumRoles(discordUserId); // remove old tier roles first
      await grantRole(discordUserId, tier);
      return;
    }

    if (eventType === "subscription.disable" || eventType === "subscription.disable") {
      const subCode = data?.subscription_code;
      const discordUserId = data?.metadata?.discordUserId;
      if (!discordUserId) return;

      await markSubscriptionCancelled({ discordUserId, subCode });
      await revokePremiumRoles(discordUserId);
      return;
    }
  } catch (err) {
    // We already responded 200, but log for debugging
    console.error("Paystack webhook error:", err);
  }
});

export function startWebhookServer(port = 3001) {
  app.listen(port, () => {
    console.log(`Webhook server listening on :${port}`);
  });
}
