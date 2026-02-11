const { requireAdmin, requirePremium } = require("./guards");

function enforceAccess(interaction, command) {
  const access = command.access || "public";

  if (access === "admin") {
    return requireAdmin(interaction);
  }

  if (access === "premium") {
    return requirePremium(interaction);
  }

  // public commands
  return true;
}

module.exports = { enforceAccess };
