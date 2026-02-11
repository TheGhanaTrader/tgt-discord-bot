"use strict";

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  listSponsors,
  setEnabled,
  addSponsor,
  removeSponsor,
  setActive,
} = require("../services/sponsors");

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function clip(s, n = 80) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sponsor")
    .setDescription("Admin sponsor controls (honors-only).")
    .addSubcommand((sub) => sub.setName("status").setDescription("Show sponsor rotation status."))
    .addSubcommand((sub) =>
      sub
        .setName("enable")
        .setDescription("Enable sponsor footer on honors embeds.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Disable sponsor footer on honors embeds.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a sponsor to rotation.")
        .addStringOption((opt) => opt.setName("name").setDescription("Sponsor name").setRequired(true))
        .addStringOption((opt) => opt.setName("tagline").setDescription("Short tagline").setRequired(false))
        .addStringOption((opt) => opt.setName("url").setDescription("Optional URL (plain text)").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a sponsor by id.")
        .addStringOption((opt) => opt.setName("id").setDescription("Sponsor id from /sponsor status").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("setactive")
        .setDescription("Activate/deactivate a sponsor by id.")
        .addStringOption((opt) => opt.setName("id").setDescription("Sponsor id").setRequired(true))
        .addBooleanOption((opt) => opt.setName("active").setDescription("true=active, false=inactive").setRequired(true))
    ),

  async execute(interaction) {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "status") {
      const st = listSponsors();
      const activeCount = st.sponsors.filter((x) => x.active).length;

      const lines = st.sponsors.length
        ? st.sponsors
            .map((s) => `• id:${s.id} | ${s.active ? "✅" : "—"} ${clip(s.name, 32)} ${s.url ? `| ${clip(s.url, 40)}` : ""}`)
            .join("\n")
        : "• None";

      return interaction.reply({
        content:
          `📣 Sponsor Rotation\n` +
          `• enabled: **${st.enabled}**\n` +
          `• sponsors: **${st.sponsors.length}** (active: **${activeCount}**)\n` +
          `• pointer: **${st.pointer}**\n\n` +
          `Sponsors:\n${lines}`,
        ephemeral: true,
      });
    }

    if (sub === "enable") {
      const st = setEnabled(true);
      return interaction.reply({ content: `✅ Sponsors enabled (honors-only). total: ${st.sponsors.length}`, ephemeral: true });
    }

    if (sub === "disable") {
      const st = setEnabled(false);
      return interaction.reply({ content: `✅ Sponsors disabled.`, ephemeral: true });
    }

    if (sub === "add") {
      const name = interaction.options.getString("name");
      const tagline = interaction.options.getString("tagline") || "";
      const url = interaction.options.getString("url") || "";

      const s = addSponsor({ name, tagline, url });
      return interaction.reply({ content: `✅ Added sponsor: id=${s.id} name=${s.name}`, ephemeral: true });
    }

    if (sub === "remove") {
      const id = interaction.options.getString("id");
      const r = removeSponsor(id);
      if (!r.removed) return interaction.reply({ content: `❌ Not found: ${id}`, ephemeral: true });
      return interaction.reply({ content: `✅ Removed sponsor: ${id}`, ephemeral: true });
    }

    if (sub === "setactive") {
      const id = interaction.options.getString("id");
      const active = interaction.options.getBoolean("active");
      const s = setActive(id, active);
      if (!s) return interaction.reply({ content: `❌ Not found: ${id}`, ephemeral: true });
      return interaction.reply({ content: `✅ Updated: ${id} active=${s.active}`, ephemeral: true });
    }
  },
};
