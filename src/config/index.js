require('dotenv').config();

const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    ownerId: process.env.OWNER_DISCORD_ID,
    guildId: process.env.GUILD_ID || null,
  },
  
  torn: {
    apiKey: process.env.TORN_API_KEY,
    userIds: process.env.USER_IDS || '',
    factionIds: process.env.FACTION_IDS || '',
  },
  
  timing: {
    requestMs: Number(process.env.REQUEST_INTERVAL_MS) || 5000,
    factionMs: Number(process.env.FACTION_INTERVAL_MS) || 30000,
    barsMs: 60000,
    chainMs: 10000,
    iconsMs: 30000,    // Icons polling interval
    companyMs: 60000,  // Company polling interval
  },
  
  persist: process.env.PERSIST_PATH || './data/store.json',
  port: Number(process.env.PORT) || 3000,
  
  defaults: {
    offlineHours: Number(process.env.FACTION_OFFLINE_HOURS) || 24,
    addictionThreshold: Number(process.env.ADDICTION_THRESHOLD) || -5,
  },
};

// Validation
const required = [
  ['discord.token', config.discord.token],
  ['discord.ownerId', config.discord.ownerId],
  ['torn.apiKey', config.torn.apiKey],
];

for (const [name, value] of required) {
  if (!value) {
    throw new Error(`Missing required config: ${name}`);
  }
}

module.exports = config;