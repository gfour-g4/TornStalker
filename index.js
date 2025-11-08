require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder
} = require('discord.js');

const {
  DISCORD_TOKEN,
  OWNER_DISCORD_ID,
  TORN_API_KEY,
  USER_IDS,
  WATCH_FIELDS,
  REQUEST_INTERVAL_MS,
  SELF_PING_URL,
  GUILD_ID,
  PORT,
  PERSIST_PATH
} = process.env;

// ---------- Env checks ----------
function assertEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
assertEnv('DISCORD_TOKEN', DISCORD_TOKEN);
assertEnv('OWNER_DISCORD_ID', OWNER_DISCORD_ID);
assertEnv('TORN_API_KEY', TORN_API_KEY);

// ---------- Constants ----------
const DEFAULT_FIELDS = (WATCH_FIELDS || 'description,state')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_FIELDS = [
  'description',
  'state',
  'details',
  'color',
  'until',
  'travel_type',
  'plane_image_type'
];

const SELF_PING_MS = 12 * 60 * 1000; // every 12 min
const STORE_PATH = path.resolve(PERSIST_PATH || './store.json');

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel] // needed for DMs
});

// ---------- Web server (health + keepalive) ----------
const app = express();
app.get('/', (_req, res) => res.status(200).send(`OK ${new Date().toISOString()}`));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));
const listenPort = Number(PORT || 3000);
app.listen(listenPort, () => console.log(`[web] Listening on :${listenPort}`));

// Self-ping for Render free
if (SELF_PING_URL) {
  setInterval(async () => {
    try {
      await axios.get(SELF_PING_URL, { timeout: 8000 });
      console.log(`[keepalive] Pinged ${SELF_PING_URL}`);
    } catch (e) {
      console.warn('[keepalive] Self-ping failed:', e?.response?.status || e.message);
    }
  }, SELF_PING_MS);
} else {
  console.log('SELF_PING_URL not set; self-ping disabled.');
}

// ---------- Torn API ----------
const torn = axios.create({
  baseURL: 'https://api.torn.com/v2',
  timeout: 12000
});

async function fetchTornProfile(userId) {
  const url = `/user/${encodeURIComponent(userId)}/basic`;
  const params = { striptags: true, key: TORN_API_KEY };
  const { data } = await torn.get(url, { params });
  if (!data?.profile) throw new Error(`Malformed response for user ${userId}`);
  return data.profile; // { id, name, level, gender, status: {...} }
}

// ---------- Persistence ----------
let store = {
  requestMs: Number(REQUEST_INTERVAL_MS || 5000),
  watchers: {
    // [userId]: {
    //   fields: string[],
    //   enabled: boolean,
    //   baselineSig: string | undefined,
    //   baselineObj: object | undefined,
    //   name: string | undefined
    // }
  }
};

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const json = JSON.parse(raw);
      if (json && typeof json === 'object') {
        store = Object.assign(store, json);
        // sanitize
        if (!store.watchers || typeof store.watchers !== 'object') store.watchers = {};
        if (!Number.isFinite(store.requestMs) || store.requestMs < 1000) store.requestMs = 5000;
      }
      console.log(`[store] Loaded from ${STORE_PATH}`);
    } else {
      console.log('[store] No existing store; will seed from env if provided.');
    }
  } catch (e) {
    console.warn('[store] Failed to load store:', e.message);
  }
}

let saveTimer = null;
function saveStoreDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
      // eslint-disable-next-line no-empty
    } catch (e) {
      console.warn('[store] Failed to save store:', e.message);
    }
  }, 300);
}

// ---------- Helpers ----------
function pickWatchedFields(status, fields) {
  const picked = {};
  for (const f of fields) {
    picked[f] = status?.[f] ?? null;
  }
  return picked;
}

function statusSignature(pickedObj) {
  return JSON.stringify(pickedObj);
}

function computeDiff(oldObj, newObj, fields) {
  const diffs = [];
  for (const f of fields) {
    const oldVal = oldObj?.[f] ?? null;
    const newVal = newObj?.[f] ?? null;
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffs.push({ field: f, from: oldVal, to: newVal });
    }
  }
  return diffs;
}

function formatStatusSummary(s) {
  if (!s) return 'No status data.';
  const parts = [];
  if (s.state) parts.push(`state: ${s.state}`);
  if (s.description) parts.push(`description: ${s.description}`);
  if (s.details) parts.push(`details: ${s.details}`);
  if (s.color) parts.push(`color: ${s.color}`);
  if (s.travel_type) parts.push(`travel_type: ${s.travel_type}`);
  if (s.plane_image_type) parts.push(`plane: ${s.plane_image_type}`);
  if (s.until) parts.push(`until: ${s.until}`);
  return parts.join(' | ');
}

function formatDiffLines(diffs) {
  if (!diffs?.length) return '- No changes detected';
  return diffs.map(d => `- ${d.field}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`).join('\n');
}

async function notifyOwner(content) {
  try {
    const user = await client.users.fetch(OWNER_DISCORD_ID, { force: true });
    await user.send(content);
  } catch (e) {
    console.error('[dm] Failed to DM owner:', e.message);
  }
}

function parseFieldsInput(input) {
  if (!input) return null;
  const lowered = input.trim().toLowerCase();
  if (['all', '*', 'everything'].includes(lowered)) return [...ALLOWED_FIELDS];
  if (['default', 'basic'].includes(lowered)) return [...DEFAULT_FIELDS];

  const arr = lowered.split(/[,\s|]+/).filter(Boolean);
  const unique = [...new Set(arr)];
  const invalid = unique.filter(f => !ALLOWED_FIELDS.includes(f));
  if (invalid.length) {
    throw new Error(`Invalid field(s): ${invalid.join(', ')}. Allowed: ${ALLOWED_FIELDS.join(', ')}`);
  }
  return unique;
}

function fieldsToString(fields) {
  return fields && fields.length ? fields.join(', ') : '(none)';
}

// ---------- Poller ----------
let pollOrder = []; // array of user IDs (strings)
let pollIndex = 0;
let isTicking = false;
let pollTimer = null;

function refreshPollOrder() {
  pollOrder = Object.keys(store.watchers).filter(uid => store.watchers[uid]?.enabled !== false);
  if (pollIndex >= pollOrder.length) pollIndex = 0;
  console.log(`[watch] Active watchers: ${pollOrder.length}`);
}

function restartPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollNextUser, store.requestMs);
  console.log(`[watch] Interval per request: ${store.requestMs}ms (~${pollOrder.length ? (store.requestMs * pollOrder.length / 1000).toFixed(1) : '0'}s per full cycle)`);
}

async function primeBaseline(userId, fields) {
  try {
    const profile = await fetchTornProfile(userId);
    const status = profile?.status || {};
    const picked = pickWatchedFields(status, fields);
    const sig = statusSignature(picked);

    store.watchers[userId].baselineObj = picked;
    store.watchers[userId].baselineSig = sig;
    store.watchers[userId].name = profile?.name || `User ${userId}`;
    saveStoreDebounced();
    console.log(`[prime] Baseline for ${store.watchers[userId].name} (${userId}).`);
  } catch (e) {
    console.warn(`[prime] Failed for ${userId}:`, e?.response?.status || e.message);
  }
}

async function pollNextUser() {
  if (isTicking) return;
  if (pollOrder.length === 0) return;

  isTicking = true;
  const userId = pollOrder[pollIndex];
  pollIndex = (pollIndex + 1) % pollOrder.length;

  const cfg = store.watchers[userId];
  if (!cfg || cfg.enabled === false) {
    isTicking = false;
    return;
  }

  try {
    const profile = await fetchTornProfile(userId);
    const status = profile?.status || {};
    cfg.name = profile?.name || `User ${userId}`;

    const picked = pickWatchedFields(status, cfg.fields);
    const sig = statusSignature(picked);

    if (!cfg.baselineSig) {
      cfg.baselineObj = picked;
      cfg.baselineSig = sig;
      saveStoreDebounced();
      console.log(`[init] Baseline set for ${cfg.name} (${userId}) -> ${formatStatusSummary(status)}`);
    } else if (cfg.baselineSig !== sig) {
      const diffs = computeDiff(cfg.baselineObj, picked, cfg.fields);
      const lines = formatDiffLines(diffs);
      const summary = formatStatusSummary(status);
      const profileUrl = `https://www.torn.com/profiles.php?XID=${userId}`;
      const msg = [
        `🛰️ Torn status updated`,
        `Name: ${cfg.name} (ID: ${userId})`,
        `Profile: ${profileUrl}`,
        ``,
        `Changed fields:`,
        `${lines}`,
        ``,
        `Current status: ${summary}`,
        `Time (UTC): ${new Date().toISOString()}`
      ].join('\n');

      await notifyOwner(msg);

      // Update baseline
      cfg.baselineObj = picked;
      cfg.baselineSig = sig;
      saveStoreDebounced();
      console.log(`[change] Notified for ${cfg.name} (${userId}).`);
    }
  } catch (e) {
    const status = e?.response?.status;
    if (status === 429) {
      console.warn(`[rate] 429 Too Many Requests (user ${userId}). Backing off temporarily.`);
    } else {
      console.warn(`[poll] Failed for user ${userId}:`, status || e.message);
    }
  } finally {
    isTicking = false;
  }
}

// ---------- Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Manage Torn status watches')
    .addSubcommand(sc => sc
      .setName('add')
      .setDescription('Add a Torn user to the watch list')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
      .addStringOption(o => o.setName('fields').setDescription('Fields to watch (comma-separated or "all"/"default")'))
    )
    .addSubcommand(sc => sc
      .setName('remove')
      .setDescription('Remove a Torn user from the watch list')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('list')
      .setDescription('List current watches')
    )
    .addSubcommand(sc => sc
      .setName('set-fields')
      .setDescription('Update fields watched for a user')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
      .addStringOption(o => o.setName('fields').setDescription('Fields to watch (comma-separated or "all"/"default")').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('enable')
      .setDescription('Enable/disable watching a user')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
      .addBooleanOption(o => o.setName('on').setDescription('true = enable, false = disable').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('interval')
      .setDescription('Set polling interval per request (ms)')
      .addIntegerOption(o => o.setName('ms').setDescription('Milliseconds (>= 1000)').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('show')
      .setDescription('Show current status and baseline diff for a user')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('test')
      .setDescription('Send a test DM to confirm bot can reach you')
      .addStringOption(o => o.setName('message').setDescription('Optional message'))
    )
].map(c => c.toJSON());

async function registerCommands() {
  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
      console.log(`[cmd] Registered slash commands in guild: ${guild.name}`);
    } else {
      await client.application.commands.set(commands);
      console.log('[cmd] Registered global slash commands (may take up to ~1h to appear)');
    }
  } catch (e) {
    console.warn('[cmd] Failed to register commands:', e.message);
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'watch') return;

    // Owner-only
    if (interaction.user.id !== OWNER_DISCORD_ID) {
      await interaction.reply({ content: 'Nope. Owner-only command.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const userId = String(interaction.options.getInteger('user_id'));
      const fieldsInput = interaction.options.getString('fields');
      let fields = fieldsInput ? parseFieldsInput(fieldsInput) : [...DEFAULT_FIELDS];
      if (!fields.length) fields = [...DEFAULT_FIELDS];

      if (store.watchers[userId]) {
        await interaction.reply({ content: `Already watching ID ${userId}. Use /watch set-fields or /watch enable.`, ephemeral: true });
        return;
      }

      store.watchers[userId] = {
        fields,
        enabled: true,
        baselineSig: null,
        baselineObj: null,
        name: `User ${userId}`
      };
      saveStoreDebounced();
      refreshPollOrder();
      await interaction.reply({ content: `Adding watcher for ${userId} with fields: ${fieldsToString(fields)}. Priming baseline...`, ephemeral: true });
      await primeBaseline(userId, fields);
      await interaction.followUp({ content: `Watcher added for ${store.watchers[userId].name} (${userId}).`, ephemeral: true });
      return;
    }

    if (sub === 'remove') {
      const userId = String(interaction.options.getInteger('user_id'));
      if (!store.watchers[userId]) {
        await interaction.reply({ content: `ID ${userId} is not being watched.`, ephemeral: true });
        return;
      }
      delete store.watchers[userId];
      saveStoreDebounced();
      refreshPollOrder();
      await interaction.reply({ content: `Removed watcher for ID ${userId}.`, ephemeral: true });
      return;
    }

    if (sub === 'list') {
      const lines = Object.entries(store.watchers).map(([uid, cfg]) => {
        const status = cfg.enabled === false ? 'disabled' : 'enabled';
        return `• ${cfg.name || 'User'} (${uid}) — ${status} — fields: ${fieldsToString(cfg.fields)}`;
      });
      await interaction.reply({
        content: lines.length ? lines.join('\n') : 'No watchers configured.',
        ephemeral: true
      });
      return;
    }

    if (sub === 'set-fields') {
      const userId = String(interaction.options.getInteger('user_id'));
      const fieldsInput = interaction.options.getString('fields');
      if (!store.watchers[userId]) {
        await interaction.reply({ content: `ID ${userId} is not being watched. Use /watch add first.`, ephemeral: true });
        return;
      }
      let fields;
      try {
        fields = parseFieldsInput(fieldsInput);
        if (!fields.length) throw new Error('Empty field list');
      } catch (e) {
        await interaction.reply({ content: e.message, ephemeral: true });
        return;
      }

      store.watchers[userId].fields = fields;
      // Reset baseline to avoid first-change spam
      store.watchers[userId].baselineSig = null;
      store.watchers[userId].baselineObj = null;
      saveStoreDebounced();
      await interaction.reply({ content: `Updated fields for ${userId} -> ${fieldsToString(fields)}. Re-priming baseline...`, ephemeral: true });
      await primeBaseline(userId, fields);
      await interaction.followUp({ content: `Fields updated and baseline refreshed for ${store.watchers[userId].name} (${userId}).`, ephemeral: true });
      return;
    }

    if (sub === 'enable') {
      const userId = String(interaction.options.getInteger('user_id'));
      const on = interaction.options.getBoolean('on');
      if (!store.watchers[userId]) {
        await interaction.reply({ content: `ID ${userId} is not being watched.`, ephemeral: true });
        return;
      }
      store.watchers[userId].enabled = !!on;
      saveStoreDebounced();
      refreshPollOrder();
      await interaction.reply({ content: `${on ? 'Enabled' : 'Disabled'} watching for ${userId}.`, ephemeral: true });
      return;
    }

    if (sub === 'interval') {
      const ms = interaction.options.getInteger('ms');
      if (!Number.isFinite(ms) || ms < 1000) {
        await interaction.reply({ content: 'Interval must be an integer >= 1000 ms.', ephemeral: true });
        return;
      }
      store.requestMs = ms;
      saveStoreDebounced();
      restartPollTimer();
      const perCycle = pollOrder.length ? ((ms * pollOrder.length) / 1000).toFixed(1) : '0';
      await interaction.reply({ content: `Polling interval set to ${ms} ms (≈ ${perCycle}s per full cycle).`, ephemeral: true });
      return;
    }

    if (sub === 'show') {
      const userId = String(interaction.options.getInteger('user_id'));
      const cfg = store.watchers[userId];
      if (!cfg) {
        await interaction.reply({ content: `ID ${userId} is not being watched.`, ephemeral: true });
        return;
      }

      try {
        const profile = await fetchTornProfile(userId);
        const status = profile?.status || {};
        const picked = pickWatchedFields(status, cfg.fields);
        const diffs = computeDiff(cfg.baselineObj, picked, cfg.fields);
        const lines = formatDiffLines(diffs);
        const summary = formatStatusSummary(status);
        await interaction.reply({
          content: [
            `Name: ${profile?.name || cfg.name || 'User'} (ID: ${userId})`,
            `Fields: ${fieldsToString(cfg.fields)} | ${cfg.enabled === false ? 'disabled' : 'enabled'}`,
            `Current: ${summary}`,
            `Baseline diff:`,
            lines
          ].join('\n'),
          ephemeral: true
        });
      } catch (e) {
        await interaction.reply({ content: `Fetch failed: ${e?.response?.status || e.message}`, ephemeral: true });
      }
      return;
    }

    if (sub === 'test') {
      const msg = interaction.options.getString('message') || 'This is a test DM from Torn status bot ✅';
      await notifyOwner(msg);
      await interaction.reply({ content: 'Sent you a DM. If you didn’t get it, check your privacy settings.', ephemeral: true });
      return;
    }

  } catch (e) {
    console.error('[cmd] Error handling interaction:', e);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }); } catch {}
    }
  }
});

// ---------- Startup ----------
loadStore();

// Seed from USER_IDS if store is empty
(async () => {
  if (Object.keys(store.watchers).length === 0 && USER_IDS) {
    const ids = USER_IDS.split(',').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      store.watchers[id] = {
        fields: [...DEFAULT_FIELDS],
        enabled: true,
        baselineSig: null,
        baselineObj: null,
        name: `User ${id}`
      };
    }
    saveStoreDebounced();
    console.log(`[seed] Seeded ${ids.length} watcher(s) from USER_IDS.`);
  }
})();

client.once('ready', async () => {
  console.log(`[discord] Logged in as ${client.user.tag}`);

  // Register slash commands (guild: instant, global: may take ~1h)
  await registerCommands();

  // Prime baselines for any watchers missing them
  for (const [uid, cfg] of Object.entries(store.watchers)) {
    if (!cfg.baselineSig) {
      await primeBaseline(uid, cfg.fields);
      await new Promise(r => setTimeout(r, 600)); // small spacing
    }
  }

  // Build poll order and start timer
  refreshPollOrder();
  restartPollTimer();

  console.log(`[watch] Watching ${pollOrder.length} Torn user(s).`);
  console.log(`[watch] Default fields: ${fieldsToString(DEFAULT_FIELDS)}. Allowed: ${ALLOWED_FIELDS.join(', ')}`);
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('SIGINT'); saveStoreDebounced(); setTimeout(() => process.exit(0), 300); });
process.on('SIGTERM', () => { console.log('SIGTERM'); saveStoreDebounced(); setTimeout(() => process.exit(0), 300); });