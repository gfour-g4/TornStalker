require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');

const {
  DISCORD_TOKEN,
  OWNER_DISCORD_ID,
  TORN_API_KEY,
  USER_IDS,
  DEFAULT_STATES,
  REQUEST_INTERVAL_MS,
  SELF_PING_URL,
  GUILD_ID,
  PORT,
  PERSIST_PATH
} = process.env;

// ========= Consts =========
const ALLOWED_STATES = ['Traveling', 'Abroad', 'Jail', 'Hospital', 'Okay'];
const STATE_EMOJI = {
  Traveling: '✈️',
  Abroad: '🗺️',
  Jail: '🚔',
  Hospital: '🏥',
  Okay: '✅'
};
const STATE_COLORS = {
  Traveling: 0x2b8aeb,
  Abroad: 0xffc107,
  Jail: 0x6c757d,
  Hospital: 0xdc3545,
  Okay: 0x28a745
};

const SELF_PING_MS = 12 * 60 * 1000;

// Travel durations (seconds) — using 'UAE' as requested
const TRAVEL_SECONDS = {
  standard_economy: {
    'Mexico': 26 * 60,
    'Cayman Islands': 35 * 60,
    'Canada': 41 * 60,
    'Hawaii': (2 * 60 + 14) * 60,
    'United Kingdom': (2 * 60 + 39) * 60,
    'Argentina': (2 * 60 + 47) * 60,
    'Switzerland': (2 * 60 + 55) * 60,
    'Japan': (3 * 60 + 45) * 60,
    'China': (4 * 60 + 2) * 60,
    'UAE': (4 * 60 + 31) * 60,
    'South Africa': (4 * 60 + 57) * 60
  },
  standard_business: {
    'Mexico': 8 * 60,
    'Cayman Islands': 11 * 60,
    'Canada': 12 * 60,
    'Hawaii': 40 * 60,
    'United Kingdom': 48 * 60,
    'Argentina': 50 * 60,
    'Switzerland': 53 * 60,
    'Japan': (1 * 60 + 8) * 60,
    'China': (1 * 60 + 12) * 60,
    'UAE': (1 * 60 + 21) * 60,
    'South Africa': (1 * 60 + 29) * 60
  },
  airstrip: {
    'Mexico': 18 * 60,
    'Cayman Islands': 25 * 60,
    'Canada': 29 * 60,
    'Hawaii': (1 * 60 + 34) * 60,
    'United Kingdom': (1 * 60 + 51) * 60,
    'Argentina': (1 * 60 + 57) * 60,
    'Switzerland': (2 * 60 + 3) * 60,
    'Japan': (2 * 60 + 38) * 60,
    'China': (2 * 60 + 49) * 60,
    'UAE': (3 * 60 + 10) * 60,
    'South Africa': (3 * 60 + 28) * 60
  },
  private: {
    'Mexico': 13 * 60,
    'Cayman Islands': 18 * 60,
    'Canada': 20 * 60,
    'Hawaii': (1 * 60 + 7) * 60,
    'United Kingdom': (1 * 60 + 20) * 60,
    'Argentina': (1 * 60 + 23) * 60,
    'Switzerland': (1 * 60 + 28) * 60,
    'Japan': (1 * 60 + 53) * 60,
    'China': (2 * 60 + 1) * 60,
    'UAE': (2 * 60 + 15) * 60,
    'South Africa': (2 * 60 + 29) * 60
  }
};

const DEFAULT_STATES_LIST = parseStatesInput(DEFAULT_STATES || 'Traveling,Jail,Hospital');

// ========= Env checks =========
function assertEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
assertEnv('DISCORD_TOKEN', DISCORD_TOKEN);
assertEnv('OWNER_DISCORD_ID', OWNER_DISCORD_ID);
assertEnv('TORN_API_KEY', TORN_API_KEY);

// ========= Store path (writable) =========
let STORE_PATH = path.resolve(PERSIST_PATH || './store.json');

function ensureWritableStorePath(targetPath) {
  const dir = path.dirname(targetPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    const probe = path.join(dir, `.rwtest-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return targetPath;
  } catch (e) {
    const fallback = path.resolve('/tmp/store.json');
    console.warn(`[store] ${targetPath} not writable (${e.code || e.message}); using ${fallback}`);
    try {
      const fbDir = path.dirname(fallback);
      fs.mkdirSync(fbDir, { recursive: true });
    } catch {}
    return fallback;
  }
}
STORE_PATH = ensureWritableStorePath(STORE_PATH);

// ========= Discord client + web server =========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const app = express();
app.get('/', (_req, res) => res.status(200).send(`OK ${new Date().toISOString()}`));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));
const listenPort = Number(PORT || 3000);
app.listen(listenPort, () => console.log(`[web] Listening on :${listenPort}`));

if (SELF_PING_URL) {
  setInterval(async () => {
    try {
      await axios.get(SELF_PING_URL, { timeout: 8000 });
      console.log(`[keepalive] Pinged ${SELF_PING_URL}`);
    } catch (e) {
      console.warn('[keepalive] Self-ping failed:', e?.response?.status || e.message);
    }
  }, SELF_PING_MS);
}

// ========= Torn API =========
const torn = axios.create({
  baseURL: 'https://api.torn.com/v2',
  timeout: 12000
});

async function fetchTornProfile(userId) {
  const url = `/user/${encodeURIComponent(userId)}/basic`;
  const params = { striptags: true, key: TORN_API_KEY };
  const { data } = await torn.get(url, { params });
  if (!data?.profile) throw new Error(`Malformed response for user ${userId}`);
  return data.profile;
}

// ========= Persistence =========
let store = {
  requestMs: Number(REQUEST_INTERVAL_MS || 5000),
  watchers: {
    // [userId]: {
    //   states: string[],
    //   enabled: boolean,
    //   lastState: string | null,
    //   name: string,
    //   travel: {
    //     startedAt: number,
    //     type: string,
    //     dest: string | null,
    //     earliest: number, // unix seconds
    //     latest: number,   // unix seconds
    //     ambiguous: boolean
    //   } | null
    // }
  }
};

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      if (raw && raw.trim()) {
        const json = JSON.parse(raw);
        store = Object.assign(store, json);
        if (!store.watchers || typeof store.watchers !== 'object') store.watchers = {};
        if (!Number.isFinite(store.requestMs) || store.requestMs < 1000) store.requestMs = 5000;
        console.log(`[store] Loaded from ${STORE_PATH}`);
      } else {
        console.log(`[store] Existing file empty at ${STORE_PATH}; starting fresh`);
      }
    } else {
      console.log(`[store] No store at ${STORE_PATH}; will seed if env provided`);
    }
  } catch (e) {
    console.warn('[store] Failed to load store:', e.message);
  }
}

let saveTimer = null;
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
function saveStoreNow(reason = '') {
  try {
    atomicWrite(STORE_PATH, JSON.stringify(store, null, 2));
    console.log(`[store] Saved ${Object.keys(store.watchers).length} watcher(s) -> ${STORE_PATH}${reason ? ` (${reason})` : ''}`);
  } catch (e) {
    console.warn(`[store] Save failed: ${e.code || ''} ${e.message} (path: ${STORE_PATH})`);
  }
}
function saveStoreDebounced(reason = '') {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveStoreNow(reason), 250);
}

// ========= Helpers =========
function parseStatesInput(input) {
  if (!input) return null;
  const val = input.trim();
  if (!val) return null;
  if (['all', '*', 'everything'].includes(val.toLowerCase())) return [...ALLOWED_STATES];
  const parts = val.split(/[,\s|]+/).filter(Boolean).map(s => capitalize(s));
  const invalid = parts.filter(s => !ALLOWED_STATES.includes(s));
  if (invalid.length) throw new Error(`Invalid state(s): ${invalid.join(', ')}. Allowed: ${ALLOWED_STATES.join(', ')}`);
  return [...new Set(parts)];
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

function inGuildEphemeral(interaction) { return interaction.inGuild(); }

function profileUrl(userId) { return `https://www.torn.com/profiles.php?XID=${userId}`; }

function cleanDestName(s) {
  if (!s) return null;
  return s.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
}
function allDestKeys() {
  return [...new Set([
    ...Object.keys(TRAVEL_SECONDS.standard_economy),
    ...Object.keys(TRAVEL_SECONDS.standard_business),
    ...Object.keys(TRAVEL_SECONDS.airstrip),
    ...Object.keys(TRAVEL_SECONDS.private)
  ])];
}
function parseDestination(description) {
  if (!description) return null;
  const text = description.trim();
  const fromMatch = text.match(/from\s+([A-Za-z\s-]+)$/i);
  const toMatch = text.match(/to\s+([A-Za-z\s-]+)$/i);
  const dest = cleanDestName((fromMatch && fromMatch[1]) || (toMatch && toMatch[1]) || '');
  if (!dest) return null;
  const keys = allDestKeys();
  const found = keys.find(k => k.toLowerCase() === dest.toLowerCase());
  return found || dest;
}

function estimateTravelWindow(type, dest, startedAtMs) {
  // Returns { earliest: unixSec, latest: unixSec, ambiguous: boolean }
  const pad = 0.05; // ±5%
  const startedAtSec = Math.floor(startedAtMs / 1000);

  if (!dest) return { earliest: null, latest: null, ambiguous: false };

  const typeKey = (type || '').toLowerCase();
  if (typeKey === 'standard') {
    const econ = TRAVEL_SECONDS.standard_economy[dest];
    const bus = TRAVEL_SECONDS.standard_business[dest];
    if (!econ || !bus) return { earliest: null, latest: null, ambiguous: false };
    const minSec = Math.min(econ, bus);
    const maxSec = Math.max(econ, bus);
    const earliest = Math.floor(startedAtSec + minSec * (1 - pad));
    const latest = Math.floor(startedAtSec + maxSec * (1 + pad));
    return { earliest, latest, ambiguous: true };
  }

  const mapKey = ['airstrip', 'private', 'standard_economy', 'standard_business'].includes(typeKey) ? typeKey : null;
  if (!mapKey) return { earliest: null, latest: null, ambiguous: false };

  const sec = TRAVEL_SECONDS[mapKey]?.[dest];
  if (!sec) return { earliest: null, latest: null, ambiguous: false };

  const earliest = Math.floor(startedAtSec + sec * (1 - pad));
  const latest = Math.floor(startedAtSec + sec * (1 + pad));
  return { earliest, latest, ambiguous: false };
}

// Discord timestamp helper: style 't' = time, 'f' = date+time
const ts = (unix, style = 'f') => `<t:${unix}:${style}>`;

function buildStateEmbed({ userId, name, state, status, travel, titlePrefix = 'Status' }) {
  const color = STATE_COLORS[state] || 0x5865F2;
  const emoji = STATE_EMOJI[state] || 'ℹ️';

  const emb = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${name} (ID: ${userId})`, url: profileUrl(userId) })
    .setTitle(`${emoji} ${titlePrefix}: ${state}`)
    .setTimestamp(new Date());

  const lines = [];

  // Description/details if present
  if (status?.description) lines.push(`• ${status.description}`);

  // Travel block with exact-ish ETA
  if (state === 'Traveling') {
    if (travel?.earliest && travel?.latest) {
      const earliest = travel.earliest;
      const latest = travel.latest;
      const mid = Math.floor((earliest + latest) / 2);
      const plusMinusMin = Math.max(1, Math.round((latest - earliest) / 120)); // half-window in minutes

      const center = ts(mid, 'f'); // absolute local date+time
      const windowShort = `${ts(earliest, 't')}–${ts(latest, 't')}`;

      const typePretty = (travel?.type || status?.travel_type || 'unknown').replace(/_/g, ' ');
      if (travel?.dest) lines.push(`• Destination: ${travel.dest}`);
      lines.push(`• Travel type: ${typePretty}`);

      if (travel.ambiguous) {
        lines.push(`• ETA: ${center} (±${plusMinusMin}m)`);
        lines.push(`• Window: ${windowShort} (standard econ/business; ±5%)`);
      } else {
        lines.push(`• ETA: ${center} (±${plusMinusMin}m)`);
        lines.push(`• Window: ${windowShort} (±5%)`);
      }
    } else {
      const typePretty = (travel?.type || status?.travel_type || 'unknown').replace(/_/g, ' ');
      const dest = travel?.dest || parseDestination(status?.description) || null;
      if (dest) lines.push(`• Destination: ${dest}`);
      lines.push(`• Travel type: ${typePretty}`);
      lines.push(`• ETA: unknown`);
    }
  }

  // Jail/Hospital extra
  if (state === 'Jail' || state === 'Hospital') {
    if (status?.details) lines.push(`• Details: ${status.details}`);
  }

  emb.setDescription(lines.join('\n') || 'No extra info.');
  emb.addFields(
    { name: 'Profile', value: `[Open in Torn](${profileUrl(userId)})`, inline: true },
    { name: 'State', value: `${emoji} ${state}`, inline: true }
  );

  return emb;
}

async function notifyOwnerEmbed(embeds, components = []) {
  try {
    const user = await client.users.fetch(OWNER_DISCORD_ID, { force: true });
    await user.send({ embeds: Array.isArray(embeds) ? embeds : [embeds], components });
  } catch (e) {
    console.error('[dm] Failed to DM owner:', e.message);
  }
}

// ========= Poller =========
let pollOrder = [];
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
  console.log(`[watch] Interval per request: ${store.requestMs}ms (~${pollOrder.length ? (store.requestMs * pollOrder.length / 1000).toFixed(1) : '0'}s per cycle)`);
}

async function primeBaseline(userId) {
  try {
    const profile = await fetchTornProfile(userId);
    const state = profile?.status?.state || 'Okay';
    const name = profile?.name || `User ${userId}`;
    store.watchers[userId].name = name;
    store.watchers[userId].lastState = state;
    store.watchers[userId].travel = null;
    saveStoreDebounced('prime');
    console.log(`[prime] Baseline for ${name} (${userId}): ${state}`);
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
    const name = profile?.name || cfg.name || `User ${userId}`;
    cfg.name = name;

    const state = status.state || 'Okay';
    const prev = cfg.lastState;

    if (!prev) {
      cfg.lastState = state;
      cfg.travel = null;
      saveStoreDebounced('init');
      console.log(`[init] ${name} (${userId}) -> ${state}`);
      isTicking = false;
      return;
    }

    if (state !== prev) {
      // State changed
      cfg.lastState = state;

      // If we care about this state, notify
      const shouldAlert = Array.isArray(cfg.states) && cfg.states.includes(state);
      let travel = null;

      if (state === 'Traveling') {
        // Starting a travel session now
        const startedAt = Date.now();
        const dest = parseDestination(status.description);
        const type = status.travel_type || 'standard'; // sometimes "standard"
        const window = estimateTravelWindow(type, dest, startedAt);
        travel = {
          startedAt,
          type,
          dest: dest || null,
          earliest: window.earliest,
          latest: window.latest,
          ambiguous: window.ambiguous
        };
        cfg.travel = travel;
      } else {
        cfg.travel = null;
      }

      saveStoreDebounced('state-change');

      if (shouldAlert) {
        const embed = buildStateEmbed({
          userId,
          name,
          state,
          status,
          travel: cfg.travel
        });
        await notifyOwnerEmbed(embed);
        console.log(`[change] Notified: ${name} (${userId}) -> ${state}`);
      } else {
        console.log(`[change] ${name} (${userId}) -> ${state} (filtered)`);
      }
    } else if (state === 'Traveling' && cfg.travel && (!cfg.travel.earliest || !cfg.travel.latest)) {
      // Try to enrich when initial ETA unknown
      const dest = parseDestination(status.description) || cfg.travel.dest || null;
      const type = cfg.travel.type || status.travel_type || 'standard';
      const window = estimateTravelWindow(type, dest, cfg.travel.startedAt);
      cfg.travel.dest = dest;
      cfg.travel.earliest = window.earliest;
      cfg.travel.latest = window.latest;
      cfg.travel.ambiguous = window.ambiguous;
      saveStoreDebounced('enrich-travel');
    }
  } catch (e) {
    const status = e?.response?.status;
    if (status === 429) console.warn(`[rate] 429 Too Many Requests (user ${userId})`);
    else console.warn(`[poll] Failed for ${userId}:`, status || e.message);
  } finally {
    isTicking = false;
  }
}

// ========= Commands =========
const base = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Manage Torn state watches')
  .setDMPermission(true);

const commands = [
  base
    .addSubcommand(sc => sc
      .setName('add')
      .setDescription('Add a Torn user to the watch list')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
      .addStringOption(o => o.setName('states').setDescription('States to alert (comma-separated or "all")'))
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
      .setName('states')
      .setDescription('Set which states to alert for a user')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
      .addStringOption(o => o.setName('states').setDescription('States (comma-separated or "all")').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('menu')
      .setDescription('Open a UI to configure states for a user')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
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
      .setDescription('Show a user’s current state and travel ETA if traveling')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('test')
      .setDescription('Send a test DM with a pretty embed')
      .addStringOption(o => o.setName('message').setDescription('Optional message'))
    )
    .addSubcommand(sc => sc
      .setName('storage')
      .setDescription('Show storage path & watcher count')
    )
].map(c => c.toJSON());

async function registerCommands() {
  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
      console.log(`[cmd] Registered slash commands in guild: ${guild.name}`);
    }
    // Also register globally so they work in DMs everywhere
    await client.application.commands.set(commands);
    console.log('[cmd] Registered global slash commands (global may take up to ~1h to propagate)');
  } catch (e) {
    console.warn('[cmd] Failed to register commands:', e.message);
  }
}

function statesSelectRow(userId, currentStates) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`states:${userId}`)
      .setPlaceholder('Select states to alert')
      .setMinValues(0)
      .setMaxValues(ALLOWED_STATES.length)
      .addOptions(
        ALLOWED_STATES.map(s => ({
          label: s,
          value: s,
          emoji: STATE_EMOJI[s],
          default: currentStates.includes(s)
        }))
      )
  );
}

function enableButtonsRow(userId, enabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`toggle:${userId}`)
      .setLabel(enabled ? 'Disable' : 'Enable')
      .setStyle(enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`remove:${userId}`)
      .setLabel('Remove')
      .setStyle(ButtonStyle.Danger)
  );
}

client.on('interactionCreate', async (interaction) => {
  try {
    // Component interactions (menu/buttons)
    if (interaction.isStringSelectMenu()) {
      const [kind, userId] = interaction.customId.split(':');
      if (kind === 'states') {
        if (interaction.user.id !== OWNER_DISCORD_ID) {
          await interaction.reply({ content: 'Owner only.', ephemeral: inGuildEphemeral(interaction) });
          return;
        }
        const selected = interaction.values || [];
        const cfg = store.watchers[userId];
        if (!cfg) {
          await interaction.reply({ content: `ID ${userId} not found.`, ephemeral: inGuildEphemeral(interaction) });
          return;
        }
        cfg.states = selected;
        saveStoreDebounced('set-states');
        await interaction.update({
          content: `Updated states for ${cfg.name || userId}: ${selected.length ? selected.join(', ') : '(none)'}`,
          components: [statesSelectRow(userId, cfg.states), enableButtonsRow(userId, cfg.enabled !== false)]
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const [kind, userId] = interaction.customId.split(':');
      if (interaction.user.id !== OWNER_DISCORD_ID) {
        await interaction.reply({ content: 'Owner only.', ephemeral: inGuildEphemeral(interaction) });
        return;
      }
      const cfg = store.watchers[userId];
      if (!cfg) {
        await interaction.reply({ content: `ID ${userId} not found.`, ephemeral: inGuildEphemeral(interaction) });
        return;
      }

      if (kind === 'toggle') {
        cfg.enabled = cfg.enabled === false ? true : false;
        saveStoreDebounced('toggle');
        refreshPollOrder();
        await interaction.update({
          content: `${cfg.enabled !== false ? 'Enabled' : 'Disabled'} watching for ${cfg.name || userId}.`,
          components: [statesSelectRow(userId, cfg.states), enableButtonsRow(userId, cfg.enabled !== false)]
        });
        return;
      }

      if (kind === 'remove') {
        delete store.watchers[userId];
        saveStoreDebounced('remove');
        refreshPollOrder();
        await interaction.update({ content: `Removed watcher for ${userId}.`, components: [] });
        return;
      }
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'watch') return;

    if (interaction.user.id !== OWNER_DISCORD_ID) {
      await interaction.reply({ content: 'Nope. Owner-only command.', ephemeral: inGuildEphemeral(interaction) });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const isEph = inGuildEphemeral(interaction);

    // Acknowledge fast to avoid 10062 on cold starts
    try { await interaction.deferReply({ ephemeral: isEph }); } catch {}

    if (sub === 'add') {
      const userId = String(interaction.options.getInteger('user_id'));
      const statesInput = interaction.options.getString('states');
      let states = statesInput ? parseStatesInput(statesInput) : [...DEFAULT_STATES_LIST];

      if (store.watchers[userId]) {
        await interaction.editReply({ content: `Already watching ID ${userId}. Use /watch states or /watch menu.` });
        return;
      }

      store.watchers[userId] = {
        states,
        enabled: true,
        lastState: null,
        name: `User ${userId}`,
        travel: null
      };
      saveStoreDebounced('add');
      refreshPollOrder();

      await interaction.editReply({ content: `Adding watcher for ${userId} (${states.join(', ')}) — priming baseline...` });
      await primeBaseline(userId);
      await interaction.followUp({ content: `Watcher added for ${store.watchers[userId].name} (${userId}).`, ephemeral: isEph });
      return;
    }

    if (sub === 'remove') {
      const userId = String(interaction.options.getInteger('user_id'));
      if (!store.watchers[userId]) {
        await interaction.editReply({ content: `ID ${userId} is not watched.` });
        return;
      }
      delete store.watchers[userId];
      saveStoreDebounced('remove');
      refreshPollOrder();
      await interaction.editReply({ content: `Removed watcher for ID ${userId}.` });
      return;
    }

    if (sub === 'list') {
      const entries = Object.entries(store.watchers);
      if (!entries.length) {
        await interaction.editReply({ content: 'No watchers configured.' });
        return;
      }
      const lines = entries.map(([uid, cfg]) => {
        const st = cfg.enabled === false ? 'disabled' : 'enabled';
        return `• ${cfg.name || 'User'} (${uid}) — ${st} — states: ${cfg.states.join(', ')}`;
      });
      await interaction.editReply({ content: lines.join('\n') });
      return;
    }

    if (sub === 'states') {
      const userId = String(interaction.options.getInteger('user_id'));
      const statesInput = interaction.options.getString('states');
      if (!store.watchers[userId]) {
        await interaction.editReply({ content: `ID ${userId} is not watched. Use /watch add first.` });
        return;
      }
      let states;
      try {
        states = parseStatesInput(statesInput);
      } catch (e) {
        await interaction.editReply({ content: e.message });
        return;
      }
      store.watchers[userId].states = states;
      saveStoreDebounced('set-states');
      await interaction.editReply({ content: `Updated states for ${userId} -> ${states.join(', ')}` });
      return;
    }

    if (sub === 'menu') {
      const userId = String(interaction.options.getInteger('user_id'));
      const cfg = store.watchers[userId];
      if (!cfg) {
        await interaction.editReply({ content: `ID ${userId} is not watched. Use /watch add first.` });
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`Configure alerts for ${cfg.name || userId}`)
        .setDescription(`Choose which states should trigger a DM for this user.`)
        .addFields(
          { name: 'Current states', value: cfg.states.length ? cfg.states.map(s => `${STATE_EMOJI[s]} ${s}`).join(' • ') : '(none)' },
          { name: 'Status', value: cfg.enabled === false ? 'disabled' : 'enabled', inline: true },
          { name: 'User', value: `[Profile](${profileUrl(userId)})`, inline: true }
        );
      await interaction.editReply({
        embeds: [embed],
        components: [statesSelectRow(userId, cfg.states), enableButtonsRow(userId, cfg.enabled !== false)]
      });
      return;
    }

    if (sub === 'enable') {
      const userId = String(interaction.options.getInteger('user_id'));
      const on = interaction.options.getBoolean('on');
      if (!store.watchers[userId]) {
        await interaction.editReply({ content: `ID ${userId} is not watched.` });
        return;
      }
      store.watchers[userId].enabled = !!on;
      saveStoreDebounced('toggle');
      refreshPollOrder();
      await interaction.editReply({ content: `${on ? 'Enabled' : 'Disabled'} watching for ${userId}.` });
      return;
    }

    if (sub === 'interval') {
      const ms = interaction.options.getInteger('ms');
      if (!Number.isFinite(ms) || ms < 1000) {
        await interaction.editReply({ content: 'Interval must be >= 1000 ms.' });
        return;
      }
      store.requestMs = ms;
      saveStoreDebounced('interval');
      restartPollTimer();
      const perCycle = pollOrder.length ? ((ms * pollOrder.length) / 1000).toFixed(1) : '0';
      await interaction.editReply({ content: `Polling interval set to ${ms} ms (≈ ${perCycle}s per cycle).` });
      return;
    }

    if (sub === 'show') {
      const userId = String(interaction.options.getInteger('user_id'));
      const cfg = store.watchers[userId];
      if (!cfg) {
        await interaction.editReply({ content: `ID ${userId} is not watched.` });
        return;
      }
      try {
        const profile = await fetchTornProfile(userId);
        const status = profile?.status || {};
        const embed = buildStateEmbed({
          userId,
          name: profile?.name || cfg.name || `User ${userId}`,
          state: status.state || 'Okay',
          status,
          travel: cfg.travel
        });
        await interaction.editReply({ embeds: [embed] });
      } catch (e) {
        await interaction.editReply({ content: `Fetch failed: ${e?.response?.status || e.message}` });
      }
      return;
    }

    if (sub === 'test') {
      const msg = interaction.options.getString('message') || 'This is a pretty test embed from Torn status bot ✅';
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Test DM')
        .setDescription(msg)
        .setTimestamp(new Date());
      await notifyOwnerEmbed(embed);
      await interaction.editReply({ content: 'Sent you a DM. If you didn’t get it, check privacy settings.' });
      return;
    }

    if (sub === 'storage') {
      await interaction.editReply({
        content: `Path: ${STORE_PATH}\nWatchers: ${Object.keys(store.watchers).length}\nInterval: ${store.requestMs}ms`
      });
      return;
    }

  } catch (e) {
    console.error('[cmd] Error:', e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `Error: ${e.message}` });
      } else {
        await interaction.reply({ content: `Error: ${e.message}`, ephemeral: inGuildEphemeral(interaction) });
      }
    } catch {}
  }
});

// ========= Startup =========
loadStore();

// Seed from env if empty
(async () => {
  if (Object.keys(store.watchers).length === 0 && USER_IDS) {
    const ids = USER_IDS.split(',').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      store.watchers[id] = {
        states: [...DEFAULT_STATES_LIST],
        enabled: true,
        lastState: null,
        name: `User ${id}`,
        travel: null
      };
    }
    saveStoreDebounced('seed');
    console.log(`[seed] Seeded ${ids.length} watcher(s) from USER_IDS.`);
  }
})();

client.once('ready', async () => {
  console.log(`[discord] Logged in as ${client.user.tag}`);
  await registerCommands();

  // Prime baselines
  for (const [uid] of Object.entries(store.watchers)) {
    const cfg = store.watchers[uid];
    if (cfg && !cfg.lastState) {
      await primeBaseline(uid);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  refreshPollOrder();
  restartPollTimer();

  console.log(`[watch] Watching ${pollOrder.length} user(s). States available: ${ALLOWED_STATES.join(', ')}`);
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('SIGINT'); saveStoreNow('exit'); setTimeout(() => process.exit(0), 200); });
process.on('SIGTERM', () => { console.log('SIGTERM'); saveStoreNow('exit'); setTimeout(() => process.exit(0), 200); });