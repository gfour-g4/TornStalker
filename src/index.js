require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const store = require('./services/store');
const api = require('./services/api');
const { setClient } = require('./services/notify');
const { handleInteraction, setPollerStarter } = require('./discord/handlers');
const commands = require('./discord/commands');
const { startPollers, stopPollers, scheduleDailyDigest, scheduleAddictionCheck, scheduleRefillReminder } = require('./pollers');
const { createTravelInfo } = require('./utils/travel');
const { sleep } = require('./utils/format');
const { STATES } = require('./config/constants');

// ═══════════════════════════════════════════════════════════════
// EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════

const app = express();

app.get('/', (req, res) => res.send('Torn Tracker Online'));

app.get('/healthz', (req, res) => {
  const stats = store.getStats();
  res.json({
    ok: true,
    uptime: process.uptime(),
    stats,
  });
});

app.get('/stats', (req, res) => {
  res.json(store.getStats());
});

app.listen(config.port, () => {
  console.log(`[web] Listening on port ${config.port}`);
});

// ═══════════════════════════════════════════════════════════════
// DISCORD CLIENT
// ═══════════════════════════════════════════════════════════════

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Set client for notifications
setClient(client);

// Set poller starter for handlers
setPollerStarter(startPollers);

// Handle interactions
client.on('interactionCreate', handleInteraction);

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════

async function initialize() {
  // Load stored data
  store.load();
  
  // Seed from environment if empty
  seedFromEnv();
  
  // Validate API key
  const keyCheck = await api.validateKey();
  if (!keyCheck.valid) {
    console.error('[api] Invalid API key:', keyCheck.error);
    process.exit(1);
  }
  console.log(`[api] Connected as ${keyCheck.name} (Level ${keyCheck.level})`);
}

function seedFromEnv() {
  // Seed users from env
  if (!Object.keys(store.watchers).length && config.torn.userIds) {
    const ids = config.torn.userIds.split(',').filter(Boolean);
    
    for (const id of ids) {
      const trimmed = id.trim();
      store.watchers[trimmed] = {
        name: `User ${trimmed}`,
        states: [...STATES],
        enabled: true,
        lastState: null,
        preFired: {},
      };
    }
    
    if (ids.length) {
      console.log(`[seed] Added ${ids.length} users from env`);
      store.save('seed-users');
    }
  }
  
  // Seed factions from env
  if (!Object.keys(store.factions.items).length && config.torn.factionIds) {
    const ids = config.torn.factionIds.split(',').filter(Boolean);
    
    for (const id of ids) {
      const trimmed = id.trim();
      store.factions.items[trimmed] = {
        id: trimmed,
        name: `Faction ${trimmed}`,
        states: [...STATES],
        enabled: true,
        members: {},
        offline: { enabled: true, hours: config.defaults.offlineHours },
        daily: { enabled: true },
      };
    }
    
    if (ids.length) {
      console.log(`[seed] Added ${ids.length} factions from env`);
      store.save('seed-factions');
    }
  }
}

async function primeBaselines() {
  console.log('[prime] Establishing baselines...');
  
  for (const [id, cfg] of Object.entries(store.watchers)) {
    if (cfg.lastState) continue;
    
    try {
      const profile = await api.getProfile(id);
      
      cfg.name = profile.name;
      cfg.lastState = profile.status?.state || 'Okay';
      
      if (profile.status?.state === 'Traveling') {
        cfg.travel = createTravelInfo(profile.status);
      }
      
      console.log(`[prime] ${cfg.name}: ${cfg.lastState}`);
      await sleep(500);
    } catch (error) {
      console.warn(`[prime] Failed for ${id}: ${error.message}`);
    }
  }
  
  store.save('primed');
}

async function registerCommands() {
  try {
    // Guild commands (instant)
    if (config.discord.guildId) {
      const guild = await client.guilds.fetch(config.discord.guildId);
      await guild.commands.set(commands);
      console.log(`[cmd] Registered ${commands.length} guild commands`);
    }
    
    // Global commands (may take up to an hour to propagate)
    await client.application.commands.set(commands);
    console.log(`[cmd] Registered ${commands.length} global commands`);
  } catch (error) {
    console.warn('[cmd] Failed to register commands:', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// CLIENT READY
// ═══════════════════════════════════════════════════════════════

client.once('ready', async () => {
  console.log(`[discord] Logged in as ${client.user.tag}`);
  
  await registerCommands();
  await primeBaselines();
  
  // Start all pollers
  startPollers();
  
  // Schedule daily faction digest
  scheduleDailyDigest();
  
  // Schedule daily addiction check
  scheduleAddictionCheck();
  
  // Schedule energy refill reminders
  scheduleRefillReminder();
  
  // Status summary
  const stats = store.getStats();
  console.log(
    `[ready] Tracking ${stats.users.active} users, ` +
    `${stats.factions.active} factions (${stats.factions.members} members)`
  );
});

// ═══════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

client.on('error', error => {
  console.error('[discord] Error:', error.message);
});

process.on('unhandledRejection', error => {
  console.error('[unhandled]', error);
});

// ═══════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════

async function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down...`);
  
  stopPollers();
  store.saveSync();
  
  client.destroy();
  
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

(async () => {
  try {
    await initialize();
    await client.login(config.discord.token);
  } catch (error) {
    console.error('[fatal]', error);
    process.exit(1);
  }
})();
