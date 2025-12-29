const config = require('../config');

let discordClient = null;

/**
 * Set the Discord client for notifications
 */
function setClient(client) {
  discordClient = client;
}

/**
 * Send DM notification to owner
 */
async function notify(embeds, components = []) {
  if (!discordClient) {
    console.warn('[notify] Discord client not set');
    return false;
  }
  
  try {
    const user = await discordClient.users.fetch(config.discord.ownerId);
    
    await user.send({
      embeds: Array.isArray(embeds) ? embeds : [embeds],
      components,
    });
    
    return true;
  } catch (e) {
    console.error('[notify] Failed to send DM:', e.message);
    return false;
  }
}

/**
 * Send notification with retry
 */
async function notifyWithRetry(embeds, components = [], maxRetries = 2) {
  for (let i = 0; i <= maxRetries; i++) {
    const success = await notify(embeds, components);
    if (success) return true;
    
    if (i < maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return false;
}

module.exports = {
  setClient,
  notify,
  notifyWithRetry,
};