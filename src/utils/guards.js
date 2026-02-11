function getMemberRoleIds(member) {
  if (!member) return [];

  // GuildMember (cached)
  if (member.roles && member.roles.cache) {
    return [...member.roles.cache.keys()];
  }

  // Interaction payload fallback
  if (Array.isArray(member.roles)) {
    return member.roles;
  }

  return [];
}

function deny(interaction, message) {
  const payload = { content: message, ephemeral: true };

  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }

  return interaction.reply(payload);
}

function hasAnyRole(member, roleIds) {
  const memberRoleIds = getMemberRoleIds(member);
  return roleIds.some((id) => memberRoleIds.includes(id));
}

function requireAdmin(interaction) {
  const { ADMIN_ROLE_ID, MOD_ROLE_ID } = process.env;

  if (!ADMIN_ROLE_ID || !MOD_ROLE_ID) {
    deny(interaction, "⚠️ Admin role IDs are not configured.");
    return false;
  }

  if (!hasAnyRole(interaction.member, [ADMIN_ROLE_ID, MOD_ROLE_ID])) {
    deny(interaction, "⛔ You don't have permission to use this command.");
    return false;
  }

  return true;
}

function requirePremium(interaction) {
  const { DIAMOND_ROLE_ID, GOLD_ROLE_ID, SILVER_ROLE_ID } = process.env;

  if (!DIAMOND_ROLE_ID || !GOLD_ROLE_ID || !SILVER_ROLE_ID) {
    deny(interaction, "⚠️ Premium role IDs are not configured.");
    return false;
  }

  if (
    !hasAnyRole(interaction.member, [
      DIAMOND_ROLE_ID,
      GOLD_ROLE_ID,
      SILVER_ROLE_ID,
    ])
  ) {
    deny(interaction, "🔒 Premium only. Upgrade to access this feature.");
    return false;
  }

  return true;
}

module.exports = {
  requireAdmin,
  requirePremium,
};
