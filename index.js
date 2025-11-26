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

const COLOR_INFO = 0x5865F2;
const COLOR_WARN = 0xff9800;
const COLOR_GOOD = 0x1abc9c;
const COLOR_BAD = 0xe53935;

const BARS = ['energy', 'nerve', 'happy', 'life']; // NEW
const COOLDOWNS = ['drug', 'medical', 'booster']; // NEW

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

// NEW: legacy v1 endpoints for bars/cooldowns
const tornUser = axios.create({
  baseURL: 'https://api.torn.com',
  timeout: 12000
});

async function fetchTornProfile(userId) {
  const url = `/user/${encodeURIComponent(userId)}/basic`;
  const params = { striptags: true, key: TORN_API_KEY };
  const { data } = await torn.get(url, { params });
  if (!data?.profile) throw new Error(`Malformed response for user ${userId}`);
  return data.profile;
}

// NEW: bars + chain (v1 user?selections=bars)
async function fetchBars() {
  const params = { key: TORN_API_KEY, selections: 'bars' };
  const { data } = await tornUser.get('/user/', { params });
  if (!data) throw new Error('Malformed bars response');
  return data;
}

// NEW: cooldowns (v1 user?selections=cooldowns)
async function fetchCooldowns() {
  const params = { key: TORN_API_KEY, selections: 'cooldowns' };
  const { data } = await tornUser.get('/user/', { params });
  if (!data?.cooldowns) throw new Error('Malformed cooldowns response');
  return data.cooldowns;
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
    //   travel: { startedAt, type, dest, earliest, latest, ambiguous, direction } | null,
    //   preTimesSec: number[] | undefined,
    //   preFired: { [sessionKey: string]: number[] } | undefined
    // }
  },
  // NEW: self-watching for own account
  self: {
    bars: {
      energy: false, nerve: false, happy: false, life: false,
      last: { energy: null, nerve: null, happy: null, life: null }, // {current, maximum}
      wasFull: { energy: false, nerve: false, happy: false, life: false }
    },
    cooldowns: {
      drug: false, medical: false, booster: false,
      last: { drug: null, medical: null, booster: null } // number seconds
    },
    chain: {
      enabled: false,
      min: 10,
      thresholds: [120, 90, 60, 30],
      last: { current: null, timeout: null },
      epochId: 0, // increments when chain resets / drops
      fired: {} // { [epochId]: Set<number> }
    }
  }
};

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      if (raw && raw.trim()) {
        const json = JSON.parse(raw);
        store = Object.assign(store, json);

        // sanity
        if (!store.watchers || typeof store.watchers !== 'object') store.watchers = {};
        if (!store.self) store.self = { bars: { energy:false, nerve:false, happy:false, life:false, last:{}, wasFull:{} }, cooldowns: { drug:false, medical:false, booster:false, last:{} }, chain: { enabled:false, min:10, thresholds:[120,90,60,30], last:{}, epochId:0, fired:{} } };
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
function parseSecondsList(input, fallback = []) { // NEW
  if (!input) return fallback;
  const nums = input.split(/[,\s]+/).map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 0);
  return [...new Set(nums)].sort((a,b) => b - a); // desc
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
function parseTravelDirection(description) { // NEW
  if (!description) return 'outbound';
  const s = description.toLowerCase();
  if (/returning/.test(s) || /to\s+torn\s+from/.test(s) || /\bfrom\s+[a-z]/.test(s)) return 'return';
  return 'outbound';
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

function humanizeShort(sec) { // NEW
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `${m}m${s ? s + 's' : ''}`;
  return `${s}s`;
}

function buildStateEmbed({ userId, name, state, status, travel, titlePrefix = 'Status' }) {
  const color = STATE_COLORS[state] || COLOR_INFO;
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
      const direction = travel?.direction === 'return' ? 'return' : 'outbound';
      if (travel?.dest) lines.push(`• Destination: ${direction === 'return' ? 'Torn (from ' + travel.dest + ')' : travel.dest}`);
      lines.push(`• Travel type: ${typePretty}`);

      lines.push(`• ETA: ${center} (±${plusMinusMin}m)`);
      lines.push(`• Window: ${windowShort} (±5%)`);
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
    if (status?.until) lines.push(`• Ends: ${ts(Number(status.until), 't')}`);
  }

  emb.setDescription(lines.join('\n') || 'No extra info.');
  emb.addFields(
    { name: 'Profile', value: `[Open in Torn](${profileUrl(userId)})`, inline: true },
    { name: 'State', value: `${emoji} ${state}`, inline: true }
  );

  return emb;
}

// NEW: embeds
function buildBarFullEmbed(kind, bar) {
  const pretty = capitalize(kind);
  const emb = new EmbedBuilder()
    .setColor(COLOR_GOOD)
    .setTitle(`🔔 ${pretty} full`)
    .addFields({ name: pretty, value: `${bar.current}/${bar.maximum} • fulltime: ${bar.fulltime ? humanizeShort(bar.fulltime) : '0s'}` })
    .setTimestamp(new Date());
  return emb;
}
function buildCooldownEndedEmbed(kind) {
  const pretty = capitalize(kind);
  const emb = new EmbedBuilder()
    .setColor(COLOR_GOOD)
    .setTitle(`🔔 ${pretty} cooldown ended`)
    .setTimestamp(new Date());
  return emb;
}
function buildChainAlertEmbed(chain, firedAt, min, threshold) {
  const emb = new EmbedBuilder()
    .setColor(COLOR_WARN)
    .setTitle(`⛓️ Chain timeout alert`)
    .setDescription(`Chain: ${chain.current}/${chain.maximum}\nTimeout: ${chain.timeout}s\nAlert at ≤ ${threshold}s`)
    .addFields(
      { name: 'Min chain', value: String(min), inline: true },
      { name: 'Next break', value: ts(Math.floor((Date.now()/1000) + chain.timeout), 't'), inline: true }
    )
    .setTimestamp(new Date(firedAt));
  return emb;
}
function buildPreAlertEmbed(name, userId, state, endAt, secsLeft) {
  const emoji = STATE_EMOJI[state] || '⏰';
  const emb = new EmbedBuilder()
    .setColor(COLOR_WARN)
    .setTitle(`${emoji} ${state} ending soon`)
    .setDescription(`${name} (${userId}) is about to end ${state}\nEnds ~ ${ts(endAt, 't')} (in ${humanizeShort(secsLeft)})`)
    .addFields({ name: 'Profile', value: `[Open in Torn](${profileUrl(userId)})`, inline: true })
    .setTimestamp(new Date());
  return emb;
}
function buildTravelDirectionEmbed(name, userId, travel, status) {
  const typePretty = (travel?.type || status?.travel_type || 'unknown').replace(/_/g, ' ');
  const dir = travel?.direction === 'return' ? 'Returning to Torn' : 'Departing to';
  const destText = travel?.direction === 'return'
    ? (travel?.dest ? `from ${travel.dest}` : '')
    : (travel?.dest || 'unknown');
  const emb = new EmbedBuilder()
    .setColor(STATE_COLORS.Traveling)
    .setTitle(`✈️ ${dir} ${destText}`)
    .setDescription([
      travel?.earliest ? `• ETA: ${ts(travel.earliest, 't')} (earliest)` : '• ETA: unknown',
      `• Type: ${typePretty}`
    ].join('\n'))
    .setTimestamp(new Date());
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

// ========= Poller for watched users (states) =========
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

// NEW: session key for pre-alerts
function sessionKeyForState(state, status, travel) {
  if (state === 'Traveling' && travel?.startedAt) {
    const dir = travel?.direction || 'outbound';
    return `T:${dir}:${travel.startedAt}`;
  }
  if ((state === 'Jail' || state === 'Hospital') && status?.until) {
    return `${state[0]}:${status.until}`;
  }
  return null;
}

// NEW: pre-alert evaluation
async function maybePreAlert(userId, name, state, status, travel, preTimesSec) {
  if (!preTimesSec || preTimesSec.length === 0) return;

  let endAt = null;
  if (state === 'Traveling' && travel?.earliest) {
    endAt = travel.earliest;
  } else if ((state === 'Jail' || state === 'Hospital') && status?.until) {
    endAt = Number(status.until);
  } else {
    return; // no ETA available
  }

  const now = Math.floor(Date.now() / 1000);
  const left = endAt - now;
  if (left <= 0) return;

  const key = sessionKeyForState(state, status, travel);
  if (!key) return;

  const cfg = store.watchers[userId];
  cfg.preFired = cfg.preFired || {};
  const fired = new Set(cfg.preFired[key] || []);

  let sent = false;
  for (const t of preTimesSec) {
    if (left <= t && !fired.has(t)) {
      fired.add(t);
      sent = true;
      const emb = buildPreAlertEmbed(name, userId, state, endAt, left);
      await notifyOwnerEmbed(emb);
      console.log(`[pre] ${name} (${userId}) ${state} ~${left}s left (threshold ${t}s)`);
    }
  }
  if (sent) {
    cfg.preFired[key] = [...fired];
    // prune old keys (keep last 10)
    const keys = Object.keys(cfg.preFired);
    if (keys.length > 10) {
      for (const k of keys.slice(0, keys.length - 10)) delete cfg.preFired[k];
    }
    saveStoreDebounced('pre-alert');
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

    // Pre-alert attempt also when state hasn't changed (so we can catch the time-left thresholds)
    await maybePreAlert(userId, name, state, status, cfg.travel, cfg.preTimesSec);

    if (!prev) {
      cfg.lastState = state;
      cfg.travel = null;
      saveStoreDebounced('init');
      console.log(`[init] ${name} (${userId}) -> ${state}`);
      isTicking = false;
      return;
    }

    // Detect travel direction change while staying in Traveling
    if (state === 'Traveling' && prev === 'Traveling') {
      const desc = status?.description || '';
      const newDir = parseTravelDirection(desc);
      const newDest = parseDestination(desc) || cfg.travel?.dest || null;
      const newType = status.travel_type || cfg.travel?.type || 'standard';

      const prevDir = cfg.travel?.direction || 'outbound';
      const dirChanged = newDir !== prevDir;

      // Also detect destination change (e.g., outbound UAE -> return from UAE) or any change
      const destChanged = (newDest || null) !== (cfg.travel?.dest || null);

      if (dirChanged || destChanged) {
        const startedAt = Date.now();
        const window = estimateTravelWindow(newType, newDest, startedAt);
        cfg.travel = {
          startedAt,
          type: newType,
          dest: newDest || null,
          earliest: window.earliest,
          latest: window.latest,
          ambiguous: window.ambiguous,
          direction: newDir
        };
        saveStoreDebounced('travel-dir-change');
        // Notify about travel direction change
        const shouldAlert = Array.isArray(cfg.states) && cfg.states.includes('Traveling');
        if (shouldAlert) {
          const emb = buildTravelDirectionEmbed(name, userId, cfg.travel, status);
          await notifyOwnerEmbed(emb);
          console.log(`[travel] Direction/destination change for ${name} (${userId})`);
        }
      }
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
        const direction = parseTravelDirection(status.description);
        const window = estimateTravelWindow(type, dest, startedAt);
        travel = {
          startedAt,
          type,
          dest: dest || null,
          earliest: window.earliest,
          latest: window.latest,
          ambiguous: window.ambiguous,
          direction
        };
        cfg.travel = travel;
      } else {
        cfg.travel = null;
      }

      // new session -> reset preFired for this session key only (others kept)
      if ((state === 'Traveling' && cfg.travel?.startedAt) || ((state === 'Jail' || state === 'Hospital') && status?.until)) {
        const key = sessionKeyForState(state, status, cfg.travel);
        if (key && cfg.preFired) delete cfg.preFired[key]; // ensure fresh
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
      cfg.travel.direction = cfg.travel.direction || parseTravelDirection(status.description);
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

// ========= NEW: Bars / Cooldowns / Chain pollers =========
let barsTimer = null;
let chainTimer = null;
let cooldownTimer = null;
let cooldownNextTimeoutAt = 0;

function anyBarEnabled() {
  const b = store.self?.bars || {};
  return BARS.some(k => b[k] === true);
}
function anyCooldownEnabled() {
  const c = store.self?.cooldowns || {};
  return COOLDOWNS.some(k => c[k] === true);
}

function restartBarsTimer() {
  if (barsTimer) clearInterval(barsTimer);
  if (anyBarEnabled() || (store.self?.chain?.enabled)) {
    const interval = 60_000; // bars every 1 min (chain has its own)
    barsTimer = setInterval(pollBars, interval);
    console.log(`[bars] Polling every ${interval/1000}s`);
    // also do an immediate kick
    pollBars().catch(() => {});
  }
}

function restartChainTimer() {
  if (chainTimer) clearInterval(chainTimer);
  if (store.self?.chain?.enabled) {
    const interval = 10_000; // every 10 seconds
    chainTimer = setInterval(pollChain, interval);
    console.log(`[chain] Polling every ${interval/1000}s`);
    pollChain().catch(() => {});
  }
}

function scheduleCooldownTimer(ms) {
  if (cooldownTimer) clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(async () => {
    await pollCooldowns().catch(() => {});
  }, ms);
  cooldownNextTimeoutAt = Date.now() + ms;
  console.log(`[cooldowns] Next check in ${Math.round(ms/1000)}s`);
}

function restartCooldownTimer() {
  if (!anyCooldownEnabled()) {
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = null;
    console.log('[cooldowns] Disabled');
    return;
  }
  // Start immediately; subsequent scheduling depends on values
  pollCooldowns().catch(() => {});
}

async function pollBars() {
  try {
    const data = await fetchBars();
    const bars = {
      energy: data.energy,
      nerve: data.nerve,
      happy: data.happy,
      life: data.life
    };
    const now = Date.now();

    // Bars -> notify when full (transition only)
    if (anyBarEnabled()) {
      for (const k of BARS) {
        if (!store.self.bars[k]) continue; // not watching
        const bar = bars[k];
        const isFull = bar && bar.current >= bar.maximum;
        const wasFull = store.self.bars.wasFull[k] === true;

        store.self.bars.last[k] = { current: bar.current, maximum: bar.maximum, fulltime: bar.fulltime };

        if (isFull && !wasFull) {
          const emb = buildBarFullEmbed(k, bar);
          await notifyOwnerEmbed(emb);
          console.log(`[bars] ${capitalize(k)} full -> notified`);
        }
        store.self.bars.wasFull[k] = isFull;
      }
      saveStoreDebounced('bars');
    }

    // Keep last chain snapshot for immediate read by pollChain() (chain polling has its own timer too)
    if (data.chain) {
      store.self.chain.last = { current: data.chain.current, timeout: data.chain.timeout, maximum: data.chain.maximum, updatedAt: now };
    }
  } catch (e) {
    console.warn('[bars] Error:', e?.response?.status || e.message);
  }
}

async function pollChain() {
  try {
    const data = await fetchBars(); // chain lives in bars selection
    const chain = data.chain;
    if (!chain) return;

    const conf = store.self.chain;
    const prev = store.self.chain.last || {};
    store.self.chain.last = { current: chain.current, timeout: chain.timeout, maximum: chain.maximum, updatedAt: Date.now() };

    // Evaluate epoch (reset detection)
    const prevCur = prev.current ?? 0;
    const cur = chain.current ?? 0;

    // New epoch when chain resets (cur < prev) or prev==0 and cur>0 (start)
    if ((cur < prevCur) || (prevCur === 0 && cur > 0)) {
      conf.epochId = (conf.epochId || 0) + 1;
      conf.fired[conf.epochId] = new Set();
      console.log(`[chain] New epoch ${conf.epochId} (cur=${cur}, prev=${prevCur})`);
    } else if (conf.epochId === 0) {
      conf.epochId = 1;
      conf.fired[conf.epochId] = conf.fired[conf.epochId] || new Set();
    }

    saveStoreDebounced('chain-snapshot');

    if (!conf.enabled) return;
    if (cur < (conf.min ?? 10)) return; // below min

    const firedSet = conf.fired[conf.epochId] || new Set();
    const now = Date.now();

    // Fire thresholds when timeout <= t and not already fired in this epoch
    const thresholds = (conf.thresholds || [120,90,60,30]).slice().sort((a,b)=>b-a);
    for (const t of thresholds) {
      const already = firedSet.has(t);
      if (!already && chain.timeout <= t && chain.timeout >= 0) {
        firedSet.add(t);
        conf.fired[conf.epochId] = firedSet;
        const emb = buildChainAlertEmbed(chain, now, conf.min, t);
        await notifyOwnerEmbed(emb);
        console.log(`[chain] Alert at ${t}s (cur=${cur}, timeout=${chain.timeout})`);
      }
    }
  } catch (e) {
    console.warn('[chain] Error:', e?.response?.status || e.message);
  }
}

async function pollCooldowns() {
  try {
    const cds = await fetchCooldowns();
    const conf = store.self.cooldowns;

    let anyRunning = false;
    let soonest = Infinity;
    for (const c of COOLDOWNS) {
      if (!conf[c]) continue; // not watching this cooldown
      const prev = conf.last[c];
      const val = cds[c] ?? 0;
      conf.last[c] = val;

      if (val > 0) {
        anyRunning = true;
        if (val < soonest) soonest = val;
      }

      // notify when transitions from >0 to 0 (ended)
      if ((prev ?? null) !== null && prev > 0 && val <= 0) {
        const emb = buildCooldownEndedEmbed(c);
        await notifyOwnerEmbed(emb);
        console.log(`[cooldowns] ${c} ended -> notified`);
      }
    }

    saveStoreDebounced('cooldowns');

    // schedule next poll
    if (anyCooldownEnabled()) {
      if (anyRunning && Number.isFinite(soonest)) {
        // schedule right when the soonest ends (+2s safety)
        scheduleCooldownTimer(Math.max(2000, (soonest + 2) * 1000));
      } else {
        // nothing running, recheck every 30 minutes
        scheduleCooldownTimer(30 * 60 * 1000);
      }
    }
  } catch (e) {
    console.warn('[cooldowns] Error:', e?.response?.status || e.message);
    // try again in 5 minutes
    if (anyCooldownEnabled()) scheduleCooldownTimer(5 * 60 * 1000);
  }
}

// ========= Commands =========
const base = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Manage Torn state watches')
  .setDMPermission(true);

const cmdWatch = base
  .addSubcommand(sc => sc
    .setName('add')
    .setDescription('Add a Torn user to the watch list')
    .addIntegerOption(o => o.setName('user_id').setDescription('Torn user ID').setRequired(true))
    .addStringOption(o => o.setName('states').setDescription('States to alert (comma-separated or "all")'))
    .addStringOption(o => o.setName('time_left').setDescription('Extra alerts X seconds before end, e.g. "120,60,30"')) // NEW
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
  );

const cmdEnergy = new SlashCommandBuilder().setName('energy').setDescription('Toggle Energy full alert').addBooleanOption(o => o.setName('on').setDescription('true/false'));
const cmdNerve = new SlashCommandBuilder().setName('nerve').setDescription('Toggle Nerve full alert').addBooleanOption(o => o.setName('on').setDescription('true/false'));
const cmdHappy = new SlashCommandBuilder().setName('happy').setDescription('Toggle Happy full alert').addBooleanOption(o => o.setName('on').setDescription('true/false'));
const cmdLife = new SlashCommandBuilder().setName('life').setDescription('Toggle Life full alert').addBooleanOption(o => o.setName('on').setDescription('true/false'));

const cmdDrug = new SlashCommandBuilder().setName('drug').setDescription('Toggle Drug cooldown end alert').addBooleanOption(o => o.setName('on').setDescription('true/false'));
const cmdMedical = new SlashCommandBuilder().setName('medical').setDescription('Toggle Medical cooldown end alert').addBooleanOption(o => o.setName('on').setDescription('true/false'));
const cmdBooster = new SlashCommandBuilder().setName('booster').setDescription('Toggle Booster cooldown end alert').addBooleanOption(o => o.setName('on').setDescription('true/false'));

const cmdChain = new SlashCommandBuilder()
  .setName('chain')
  .setDescription('Configure chain timeout alerts')
  .addBooleanOption(o => o.setName('on').setDescription('Enable/disable').setRequired(false))
  .addIntegerOption(o => o.setName('min').setDescription('Minimum chain (default 10)').setRequired(false))
  .addStringOption(o => o.setName('time_left').setDescription('Seconds list, e.g. "120,90,60,30"').setRequired(false));

const cmdDelay = new SlashCommandBuilder()
  .setName('delay')
  .setDescription('Add minutes to a user’s current travel ETA')
  .addIntegerOption(o => o.setName('id').setDescription('Torn user ID').setRequired(true))
  .addIntegerOption(o => o.setName('minutes').setDescription('Minutes to add').setRequired(true));

const commands = [
  cmdWatch,
  cmdEnergy, cmdNerve, cmdHappy, cmdLife,
  cmdDrug, cmdMedical, cmdBooster,
  cmdChain,
  cmdDelay
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

    const isEph = inGuildEphemeral(interaction);

    // Owner check
    if (interaction.user.id !== OWNER_DISCORD_ID) {
      await interaction.reply({ content: 'Owner only.', ephemeral: isEph });
      return;
    }

    // Top-level: /watch
    if (interaction.commandName === 'watch') {
      const sub = interaction.options.getSubcommand();
      try { await interaction.deferReply({ ephemeral: isEph }); } catch {}

      if (sub === 'add') {
        const userId = String(interaction.options.getInteger('user_id'));
        const statesInput = interaction.options.getString('states');
        const preInput = interaction.options.getString('time_left'); // NEW
        let states = statesInput ? parseStatesInput(statesInput) : [...DEFAULT_STATES_LIST];
        const preTimes = parseSecondsList(preInput, []); // NEW

        if (store.watchers[userId]) {
          await interaction.editReply({ content: `Already watching ID ${userId}. Use /watch states or /watch menu.` });
          return;
        }

        store.watchers[userId] = {
          states,
          enabled: true,
          lastState: null,
          name: `User ${userId}`,
          travel: null,
          preTimesSec: preTimes.length ? preTimes : undefined,
          preFired: {}
        };
        saveStoreDebounced('add');
        refreshPollOrder();

        await interaction.editReply({ content: `Adding watcher for ${userId} (${states.join(', ')}) — priming baseline...` });
        await primeBaseline(userId);
        await interaction.followUp({ content: `Watcher added for ${store.watchers[userId].name} (${userId}).${preTimes.length ? ` Pre-alerts: ${preTimes.join(', ')}s` : ''}`, ephemeral: isEph });
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
          const pre = cfg.preTimesSec?.length ? ` | pre: ${cfg.preTimesSec.join(',')}s` : '';
          return `• ${cfg.name || 'User'} (${uid}) — ${st} — states: ${cfg.states.join(', ')}${pre}`;
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
          .setColor(COLOR_INFO)
          .setTitle(`Configure alerts for ${cfg.name || userId}`)
          .setDescription(`Choose which states should trigger a DM for this user.`)
          .addFields(
            { name: 'Current states', value: cfg.states.length ? cfg.states.map(s => `${STATE_EMOJI[s]} ${s}`).join(' • ') : '(none)' },
            { name: 'Status', value: cfg.enabled === false ? 'disabled' : 'enabled', inline: true },
            { name: 'User', value: `[Profile](${profileUrl(userId)})`, inline: true },
            { name: 'Pre-alerts', value: cfg.preTimesSec?.length ? cfg.preTimesSec.map(s=>`${s}s`).join(', ') : '(none)', inline: false }
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
          .setColor(COLOR_INFO)
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
    }

    // Bars toggles
    async function handleBarToggle(kind) {
      try { await interaction.deferReply({ ephemeral: isEph }); } catch {}
      const on = interaction.options.getBoolean('on');
      const prev = store.self.bars[kind];
      store.self.bars[kind] = (typeof on === 'boolean') ? on : !prev;
      saveStoreDebounced('bars-toggle');
      restartBarsTimer();
      await interaction.editReply({ content: `${capitalize(kind)} alerts: ${store.self.bars[kind] ? 'ON' : 'OFF'}` });
    }
    if (interaction.commandName === 'energy') return handleBarToggle('energy');
    if (interaction.commandName === 'nerve') return handleBarToggle('nerve');
    if (interaction.commandName === 'happy') return handleBarToggle('happy');
    if (interaction.commandName === 'life') return handleBarToggle('life');

    // Cooldowns toggles
    async function handleCooldownToggle(kind) {
      try { await interaction.deferReply({ ephemeral: isEph }); } catch {}
      const on = interaction.options.getBoolean('on');
      const prev = store.self.cooldowns[kind];
      store.self.cooldowns[kind] = (typeof on === 'boolean') ? on : !prev;
      saveStoreDebounced('cooldown-toggle');
      restartCooldownTimer();
      await interaction.editReply({ content: `${capitalize(kind)} cooldown alerts: ${store.self.cooldowns[kind] ? 'ON' : 'OFF'}` });
    }
    if (interaction.commandName === 'drug') return handleCooldownToggle('drug');
    if (interaction.commandName === 'medical') return handleCooldownToggle('medical');
    if (interaction.commandName === 'booster') return handleCooldownToggle('booster');

    // Chain config
    if (interaction.commandName === 'chain') {
      try { await interaction.deferReply({ ephemeral: isEph }); } catch {}
      const on = interaction.options.getBoolean('on');
      const min = interaction.options.getInteger('min');
      const tlist = interaction.options.getString('time_left');
      if (typeof on === 'boolean') store.self.chain.enabled = on;
      if (Number.isFinite(min)) store.self.chain.min = Math.max(0, min);
      if (tlist) store.self.chain.thresholds = parseSecondsList(tlist, [120,90,60,30]);
      saveStoreDebounced('chain-config');
      restartChainTimer();
      await interaction.editReply({ content: `Chain alerts: ${store.self.chain.enabled ? 'ON' : 'OFF'} | min=${store.self.chain.min} | thresholds=${store.self.chain.thresholds.join(',')}` });
      return;
    }

    // Delay
    if (interaction.commandName === 'delay') {
      try { await interaction.deferReply({ ephemeral: isEph }); } catch {}
      const id = String(interaction.options.getInteger('id'));
      const minutes = interaction.options.getInteger('minutes');
      const cfg = store.watchers[id];
      if (!cfg) {
        await interaction.editReply({ content: `ID ${id} is not watched.` });
        return;
      }
      if (!cfg.travel || cfg.lastState !== 'Traveling') {
        await interaction.editReply({ content: `${cfg.name || id} is not currently Traveling.` });
        return;
      }
      const addSec = Math.max(0, minutes) * 60;
      cfg.travel.earliest = (cfg.travel.earliest || 0) + addSec;
      cfg.travel.latest = (cfg.travel.latest || 0) + addSec;
      saveStoreDebounced('delay');
      await interaction.editReply({ content: `Added ${minutes}m delay to ${cfg.name || id}'s travel. New earliest: ${cfg.travel.earliest ? ts(cfg.travel.earliest, 't') : 'unknown'}` });
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

  // Start self timers
  restartBarsTimer();
  restartCooldownTimer();
  restartChainTimer();

  console.log(`[watch] Watching ${pollOrder.length} user(s). States available: ${ALLOWED_STATES.join(', ')}`);
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('SIGINT'); saveStoreNow('exit'); setTimeout(() => process.exit(0), 200); });
process.on('SIGTERM', () => { console.log('SIGTERM'); saveStoreNow('exit'); setTimeout(() => process.exit(0), 200); });