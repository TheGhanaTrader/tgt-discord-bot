"use strict";

/**
 * Pins `msg` and (optionally) unpins older BOT pins in the same channel.
 * Never touches pins from humans.
 */
async function pinBotMessage(channel, msg, { unpinOlderBotPins = true } = {}) {
  try {
    if (!channel || !msg) return;
    if (!msg.pinnable) return;

    // Pin target message
    await msg.pin().catch(() => null);

    if (!unpinOlderBotPins) return;

    // Fetch pinned messages (v14+)
    const pins = await channel.messages.fetchPins().catch(() => null);
    if (!pins) return;

    // pins should be a Collection; if not, bail safely
    if (typeof pins.filter !== "function") return;

    const botPins = pins.filter((m) => m.author?.id === msg.client.user.id);

    for (const m of botPins.values()) {
      if (m.id !== msg.id) await m.unpin().catch(() => null);
    }
  } catch (_) {
    // never crash the bot for pin ops
  }
}

module.exports = { pinBotMessage };
