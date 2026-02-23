
require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const store = require('./services/store');
const api = require('./services/api');
const { setClient } = require('./services/notify');
const { handleInteraction, setPollerStarter } = require('./discord/handlers');
const commands = require('./discord/commands');
const { startPollers, stopPollers, scheduleDailyDigest, scheduleAddictionCheck } = require('./pollers');
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