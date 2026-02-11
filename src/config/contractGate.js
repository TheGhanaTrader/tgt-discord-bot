// src/config/contractGate.js
module.exports = {
  templatePdfPath:
    "assets/contracts/The Ghana Trader Desk — Trading Risk & Liability Disclaimer Agreement.pdf",

  // Where to log the TGT copy (private contracts channel)
  contractsLogChannelId: process.env.CONTRACTS_LOG_CHANNEL_ID,

  // Role IDs (set these in .env or paste directly if you prefer)
  roles: {
    verified: process.env.ROLE_VERIFIED_ID,
    silver: process.env.ROLE_SILVER_ID,
    gold: process.env.ROLE_GOLD_ID,
    diamond: process.env.ROLE_DIAMOND_ID,
  },

  // Optional: also add Verified to premium members after acceptance
  addVerifiedEvenIfPremium: true,
};
