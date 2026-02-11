"use strict";

const fs = require("fs");
const path = require("path");
const { AttachmentBuilder } = require("discord.js");

const TEMPLATE_REL_PATH =
  "assets/contracts/The Ghana Trader Desk — Trading Risk & Liability Disclaimer Agreement.pdf";

async function handleContractView(interaction) {
  try {
    // ✅ ACK immediately so Discord doesn't expire the interaction
    await interaction.deferReply({ ephemeral: true });

    const templatePath = path.join(process.cwd(), TEMPLATE_REL_PATH);

    if (!fs.existsSync(templatePath)) {
      return interaction.editReply({
        content:
          "❌ Contract template not found.\nExpected at:\n" +
          TEMPLATE_REL_PATH +
          "\n\nAdmin: place the approved PDF there.",
      });
    }

    const file = new AttachmentBuilder(templatePath, {
      name: "The Ghana Trader Desk — Contract.pdf",
    });

    return interaction.editReply({
      content:
        "📄 **View Contract (Preview)** — read below, then return to the gate message and click **I Agree & Accept Contract**.",
      files: [file],
    });
  } catch (err) {
    console.error("handleContractView error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: "❌ Could not show contract preview." });
      }
      return interaction.reply({ content: "❌ Could not show contract preview.", ephemeral: true });
    } catch (_) {}
  }
}

// ✅ THIS LINE IS MANDATORY:
module.exports = { handleContractView };
