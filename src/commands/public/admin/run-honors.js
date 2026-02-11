const { SlashCommandBuilder } = require("discord.js");
const { runMonthlyCeremony } = require("../../../jobs/monthlyCeremony");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("run-honors")
    .setDescription("Admin only: Run the TGT Monthly Honors ceremony now"),

  async execute(interaction) {
    // 🔒 Admin check (keep this first)
    const isAdmin = interaction.member.permissions.has("Administrator");
    if (!isAdmin) {
      return interaction.reply({
        content: "❌ You are not authorized to run the honors ceremony.",
        ephemeral: true,
      });
    }

    // ✅ Always defer early so Discord never times out
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      const client = interaction.client;

      await runMonthlyCeremony({ client, dryRun: false, reason: "MANUAL_RUN" });

      // ✅ Safe response even if defer failed
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply("🏛️ **TGT Honors ceremony executed successfully.**");
      }
      return interaction.reply({
        content: "🏛️ **TGT Honors ceremony executed successfully.**",
        ephemeral: true,
      });
    } catch (e) {
      console.error("run-honors error:", e);

      const msg =
        e?.code === "ENOTFOUND"
          ? "⚠️ Ceremony ran into a network/DNS issue reaching Discord. Please retry when internet is stable."
          : "❌ Ceremony failed. Check server logs.";

      // ✅ Never throw InteractionNotReplied again
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(msg);
      }
      return interaction.reply({ content: msg, ephemeral: true });
    }
  },
};
