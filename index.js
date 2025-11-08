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

// Travel durations (seconds)
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
const STORE_PATH = path.resolve(PERSIST_PATH || './store.json');

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
      store = Object.assign(store, JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')));
      if (!store.watchers || typeof store.watchers !== 'object') store.watchers = {};
      if (!Number.isFinite(store.requestMs) || store.requestMs < 1000) store.requestMs = 5000;
      console.log(`[store] Loaded from ${STORE_PATH}`);
    } else {
      console.log('[store] No store.json; will seed from env if available');
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
    } catch (e) {
      console.warn('[store] Failed to save store:', e.message);
    }
  }, 250);
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
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
function inGuildEphemeral(interaction) {
  return interaction.inGuild() ? { ephemeral: true } : {};
}

function profileUrl(userId) {
  return `https://www.torn.com/profiles.php?XID=${userId}`;
}

function cleanDestName(s) {
  if (!s) return null;
  return s.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
}

function parseDestination(description) {
  if (!description) return null;
  const text = description.trim();
  // Try "from X" (returning) or "to X" (outbound)
  const fromMatch = text.match(/from\s+([A-Za-z\s-]+)$/i);
  const toMatch = text.match(/to\s+([A-Za-z\s-]+)$/i);
  const dest = cleanDestName((fromMatch && fromMatch[1]) || (toMatch && toMatch[1]) || '');
  if (!dest) return null;
  // Canonicalize to mapping key capitalization
  const keys = Object.keys(TRAVEL_SECONDS.airstrip);
  const found = keys.find(k => k.toLowerCase() === dest.toLowerCase());
  return found || dest;
}

function estimateTravelWindow(type, dest, startedAtMs) {
  // Returns { earliest: unixSec, latest: unixSec, ambiguous: boolean }
  const pad = 0.05; // ±5%
  const startedAtSec = Math.floor(startedAtMs / 1000);

  if (!dest) {
    // Unknown destination -> no ETA
    return { earliest: null, latest: null, ambiguous: false };
  }

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

  const mapKey = ['airstrip', 'private', 'standard_economy', 'standard_business'].includes(typeKey)
    ? typeKey
    : null;
  if (!mapKey) return { earliest: null, latest: null, ambiguous: false };

  const sec = TRAVEL_SECONDS[mapKey]?.[dest];
  if (!sec) return { earliest: null, latest: null, ambiguous: false };

  const earliest = Math.floor(startedAtSec + sec * (1 - pad));
  const latest = Math.floor(startedAtSec + sec * (1 + pad));
  return { earliest, latest, ambiguous: false };
}

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

  // Travel block
  if (state === 'Traveling') {
    const dest = travel?.dest || parseDestination(status?.description);
    const type = status?.travel_type || travel?.type || 'unknown';
    const typePretty = type.replace(/_/g, ' ');
    if (dest) lines.push(`• Destination: ${dest}`);
    lines.push(`• Travel type: ${typePretty}`);

    if (travel?.earliest && travel?.latest) {
      const e = `<t:${travel.earliest}:R>`;
      const l = `<t:${travel.latest}:R>`;
      if (travel.ambiguous) {
        lines.push(`• ETA window: ${e} to ${l} (standard econ/business)`);
      } else {
        lines.push(`• ETA: ${e} to ${l} (±5%)`);
      }
    } else {
      lines.push(`• ETA: unknown`);
    }
  }

  // Jail/Hospital extra
  if (state === 'Jail' || state === 'Hospital') {
    // We don't have remaining time from this endpoint, so show what we can
    if (status?.details) lines.push(`• Details: ${status.details}`);
  }

  // Abroad/Okay are simple
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
    saveStoreDebounced();
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
      saveStoreDebounced();
      console.log(`[init] ${name} (${userId}) -> ${state}`);
      isTicking = false;
      return;
    }

    if (state !== prev) {
      // State changed
      cfg.lastState = state;

      // If we care about this state, notify
      const shouldAlert = cfg.states.includes(state);
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

      saveStoreDebounced();

      if (shouldAlert) {
        const embed = buildStateEmbed({
          userId,
          name,
          state,
          status,
          travel
        });
        await notifyOwnerEmbed(embed);
        console.log(`[change] Notified: ${name} (${userId}) -> ${state}`);
      } else {
        console.log(`[change] ${name} (${userId}) -> ${state} (filtered)`);
      }
    } else if (state === 'Traveling' && cfg.travel && cfg.travel.dest == null) {
      // Try to enrich travel with dest on subsequent polls if it was missing
      const dest = parseDestination(status.description);
      if (dest) {
        const window = estimateTravelWindow(cfg.travel.type || status.travel_type || 'standard', dest, cfg.travel.startedAt);
        cfg.travel.dest = dest;
        cfg.travel.earliest = window.earliest;
        cfg.travel.latest = window.latest;
        cfg.travel.ambiguous = window.ambiguous;
        saveStoreDebounced();
      }
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
          await interaction.reply({ content: 'Owner only.', ...inGuildEphemeral(interaction) });
          return;
        }
        const selected = interaction.values || [];
        const cfg = store.watchers[userId];
        if (!cfg) {
          await interaction.reply({ content: `ID ${userId} not found.`, ...inGuildEphemeral(interaction) });
          return;
        }
        cfg.states = selected;
        saveStoreDebounced();
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
        await interaction.reply({ content: 'Owner only.', ...inGuildEphemeral(interaction) });
        return;
      }
      const cfg = store.watchers[userId];
      if (!cfg) {
        await interaction.reply({ content: `ID ${userId} not found.`, ...inGuildEphemeral(interaction) });
        return;
      }

      if (kind === 'toggle') {
        cfg.enabled = cfg.enabled === false ? true : false;
        saveStoreDebounced();
        refreshPollOrder();
        await interaction.update({
          content: `${cfg.enabled !== false ? 'Enabled' : 'Disabled'} watching for ${cfg.name || userId}.`,
          components: [statesSelectRow(userId, cfg.states), enableButtonsRow(userId, cfg.enabled !== false)]
        });
        return;
      }

      if (kind === 'remove') {
        delete store.watchers[userId];
        saveStoreDebounced();
        refreshPollOrder();
        await interaction.update({ content: `Removed watcher for ${userId}.`, components: [] });
        return;
      }
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'watch') return;

    if (interaction.user.id !== OWNER_DISCORD_ID) {
      await interaction.reply({ content: 'Nope. Owner-only command.', ...inGuildEphemeral(interaction) });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const eph = inGuildEphemeral(interaction);

    if (sub === 'add') {
      const userId = String(interaction.options.getInteger('user_id'));
      const statesInput = interaction.options.getString('states');
      let states = statesInput ? parseStatesInput(statesInput) : [...DEFAULT_STATES_LIST];

      if (store.watchers[userId]) {
        await interaction.reply({ content: `Already watching ID ${userId}. Use /watch states or /watch menu.`, ...eph });
        return;
      }

      store.watchers[userId] = {
        states,
        enabled: true,
        lastState: null,
        name: `User ${userId}`,
        travel: null
      };
      saveStoreDebounced();
      refreshPollOrder();

      await interaction.reply({ content: `Adding watcher for ${userId} (${states.join(', ')}) — priming baseline...`, ...eph });
      await primeBaseline(userId);
      await interaction.followUp({ content: `Watcher added for ${store.watchers[userId].name} (${userId}).`, ...eph });
      return;
    }

    if (sub === 'remove') {
      const userId = String(interaction.options.getInteger('user_id'));
      if (!store.watchers[userId]) {
        await interaction.reply({ content: `ID ${userId} is not watched.`, ...eph });
        return;
      }
      delete store.watchers[userId];
      saveStoreDebounced();
      refreshPollOrder();
      await interaction.reply({ content: `Removed watcher for ID ${userId}.`, ...eph });
      return;
    }

    if (sub === 'list') {
      const entries = Object.entries(store.watchers);
      if (!entries.length) {
        await interaction.reply({ content: 'No watchers configured.', ...eph });
        return;
      }
      const lines = entries.map(([uid, cfg]) => {
        const st = cfg.enabled === false ? 'disabled' : 'enabled';
        return `• ${cfg.name || 'User'} (${uid}) — ${st} — states: ${cfg.states.join(', ')}`;
      });
      await interaction.reply({ content: lines.join('\n'), ...eph });
      return;
    }

    if (sub === 'states') {
      const userId = String(interaction.options.getInteger('user_id'));
      const statesInput = interaction.options.getString('states');
      if (!store.watchers[userId]) {
        await interaction.reply({ content: `ID ${userId} is not watched. Use /watch add first.`, ...eph });
        return;
      }
      let states;
      try {
        states = parseStatesInput(statesInput);
      } catch (e) {
        await interaction.reply({ content: e.message, ...eph });
        return;
      }
      store.watchers[userId].states = states;
      saveStoreDebounced();
      await interaction.reply({ content: `Updated states for ${userId} -> ${states.join(', ')}`, ...eph });
      return;
    }

    if (sub === 'menu') {
      const userId = String(interaction.options.getInteger('user_id'));
      const cfg = store.watchers[userId];
      if (!cfg) {
        await interaction.reply({ content: `ID ${userId} is not watched. Use /watch add first.`, ...eph });
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
      await interaction.reply({
        embeds: [embed],
        components: [statesSelectRow(userId, cfg.states), enableButtonsRow(userId, cfg.enabled !== false)],
        ...eph
      });
      return;
    }

    if (sub === 'enable') {
      const userId = String(interaction.options.getInteger('user_id'));
      const on = interaction.options.getBoolean('on');
      if (!store.watchers[userId]) {
        await interaction.reply({ content: `ID ${userId} is not watched.`, ...eph });
        return;
      }
      store.watchers[userId].enabled = !!on;
      saveStoreDebounced();
      refreshPollOrder();
      await interaction.reply({ content: `${on ? 'Enabled' : 'Disabled'} watching for ${userId}.`, ...eph });
      return;
    }

    if (sub === 'interval') {
      const ms = interaction.options.getInteger('ms');
      if (!Number.isFinite(ms) || ms < 1000) {
        await interaction.reply({ content: 'Interval must be >= 1000 ms.', ...eph });
        return;
      }
      store.requestMs = ms;
      saveStoreDebounced();
      restartPollTimer();
      const perCycle = pollOrder.length ? ((ms * pollOrder.length) / 1000).toFixed(1) : '0';
      await interaction.reply({ content: `Polling interval set to ${ms} ms (≈ ${perCycle}s per cycle).`, ...eph });
      return;
    }

    if (sub === 'show') {
      const userId = String(interaction.options.getInteger('user_id'));
      const cfg = store.watchers[userId];
      if (!cfg) {
        await interaction.reply({ content: `ID ${userId} is not watched.`, ...eph });
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
        await interaction.reply({ embeds: [embed], ...eph });
      } catch (e) {
        await interaction.reply({ content: `Fetch failed: ${e?.response?.status || e.message}`, ...eph });
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
      await interaction.reply({ content: 'Sent you a DM. If you didn’t get it, check privacy settings.', ...eph });
      return;
    }
  } catch (e) {
    console.error('[cmd] Error:', e);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: `Error: ${e.message}`, ...inGuildEphemeral(interaction) }); } catch {}
    }
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
    saveStoreDebounced();
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
process.on('SIGINT', () => { console.log('SIGINT'); saveStoreDebounced(); setTimeout(() => process.exit(0), 300); });
process.on('SIGTERM', () => { console.log('SIGTERM'); saveStoreDebounced(); setTimeout(() => process.exit(0), 300); });