require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const {
  Client, GatewayIntentBits, Partials, SlashCommandBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
} = require('discord.js');

// ========= Configuration =========
const CONFIG = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    ownerId: process.env.OWNER_DISCORD_ID,
    guildId: process.env.GUILD_ID
  },
  torn: {
    apiKey: process.env.TORN_API_KEY,
    userIds: process.env.USER_IDS,
    factionIds: process.env.FACTION_IDS
  },
  timing: {
    requestMs: Number(process.env.REQUEST_INTERVAL_MS) || 5000,
    factionMs: Number(process.env.FACTION_INTERVAL_MS) || 30000,
    selfPingMs: 12 * 60 * 1000,
    barsMs: 60000,
    chainMs: 10000
  },
  paths: {
    persist: process.env.PERSIST_PATH || './store.json',
    selfPingUrl: process.env.SELF_PING_URL
  },
  defaults: {
    states: process.env.DEFAULT_STATES || 'Traveling,Jail,Hospital',
    offlineHours: Number(process.env.FACTION_OFFLINE_HOURS) || 24
  },
  port: Number(process.env.PORT) || 3000
};

// Validate required env vars
['token', 'ownerId'].forEach(k => {
  if (!CONFIG.discord[k]) throw new Error(`Missing DISCORD_${k.toUpperCase()}`);
});
if (!CONFIG.torn.apiKey) throw new Error('Missing TORN_API_KEY');

// ========= Constants =========
const STATES = ['Traveling', 'Abroad', 'Jail', 'Hospital', 'Okay'];
const BARS = ['energy', 'nerve', 'happy', 'life'];
const COOLDOWNS = ['drug', 'medical', 'booster'];

const EMOJI = { Traveling: '✈️', Abroad: '🗺️', Jail: '🚔', Hospital: '🏥', Okay: '✅' };
const COLORS = {
  Traveling: 0x2b8aeb, Abroad: 0xffc107, Jail: 0x6c757d, Hospital: 0xdc3545, Okay: 0x28a745,
  info: 0x5865F2, warn: 0xff9800, good: 0x1abc9c, bad: 0xe53935
};

const RESPECT_STEP = 100_000;

// Travel durations (seconds) - condensed
const DESTINATIONS = ['Mexico', 'Cayman Islands', 'Canada', 'Hawaii', 'United Kingdom', 'Argentina', 'Switzerland', 'Japan', 'China', 'UAE', 'South Africa'];
const TRAVEL_TIMES = {
  standard_economy: [26, 35, 41, 134, 159, 167, 175, 225, 242, 271, 297].map(m => m * 60),
  standard_business: [8, 11, 12, 40, 48, 50, 53, 68, 72, 81, 89].map(m => m * 60),
  airstrip: [18, 25, 29, 94, 111, 117, 123, 158, 169, 190, 208].map(m => m * 60),
  private: [13, 18, 20, 67, 80, 83, 88, 113, 121, 135, 149].map(m => m * 60)
};

const getTravelTime = (type, dest) => {
  const idx = DESTINATIONS.findIndex(d => d.toLowerCase() === dest?.toLowerCase());
  return idx >= 0 ? TRAVEL_TIMES[type]?.[idx] : null;
};

// ========= Utilities =========
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const profileUrl = id => `https://www.torn.com/profiles.php?XID=${id}`;
const ts = (unix, style = 'f') => `<t:${unix}:${style}>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stripTags = s => s?.replace(/<[^>]*>/g, '') || '';

const humanize = sec => {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m${s ? s + 's' : ''}` : `${s}s`;
};

const parseStates = input => {
  if (!input?.trim()) return null;
  const val = input.trim().toLowerCase();
  if (['all', '*', 'everything'].includes(val)) return [...STATES];
  const parts = input.split(/[,\s|]+/).filter(Boolean).map(capitalize);
  const invalid = parts.filter(s => !STATES.includes(s));
  if (invalid.length) throw new Error(`Invalid states: ${invalid.join(', ')}`);
  return [...new Set(parts)];
};

const parseSeconds = (input, fallback = []) => {
  if (!input) return fallback;
  if (['off', 'none', '-', 'disable'].includes(input.trim().toLowerCase())) return [];
  return [...new Set(input.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n) && n >= 0))].sort((a, b) => b - a);
};

const parseDestination = desc => {
  if (!desc) return null;
  const match = desc.match(/(?:from|to)\s+([A-Za-z\s-]+)$/i);
  const dest = match?.[1]?.replace(/[^\w\s-]/g, '').trim();
  return DESTINATIONS.find(d => d.toLowerCase() === dest?.toLowerCase()) || dest;
};

const parseTravelDir = desc => /returning|to\s+torn\s+from|\bfrom\s+[a-z]/i.test(desc || '') ? 'return' : 'outbound';

const inferTravelType = status => status?.travel_type?.toLowerCase() || 'standard';

const estimateTravel = (type, dest, startMs) => {
  const PAD = 0.03, startSec = Math.floor(startMs / 1000);
  if (!dest) return { earliest: null, latest: null, ambiguous: false };
  
  if (type === 'standard') {
    const [econ, bus] = ['standard_economy', 'standard_business'].map(t => getTravelTime(t, dest));
    if (!econ || !bus) return { earliest: null, latest: null, ambiguous: false };
    return {
      earliest: Math.floor(startSec + Math.min(econ, bus) * (1 - PAD)),
      latest: Math.floor(startSec + Math.max(econ, bus) * (1 + PAD)),
      ambiguous: true
    };
  }
  
  const sec = getTravelTime(type, dest);
  return sec ? {
    earliest: Math.floor(startSec + sec * (1 - PAD)),
    latest: Math.floor(startSec + sec * (1 + PAD)),
    ambiguous: false
  } : { earliest: null, latest: null, ambiguous: false };
};

// ========= Storage =========
class Store {
  constructor(configPath) {
    this.path = this._resolvePath(configPath);
    this.data = this._defaults();
    this.saveTimer = null;
  }

  _resolvePath(target) {
    const dir = path.dirname(target);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.test-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return target;
    } catch {
      console.warn(`[store] ${target} not writable, using /tmp/store.json`);
      return '/tmp/store.json';
    }
  }

  _defaults() {
    return {
      requestMs: CONFIG.timing.requestMs,
      watchers: {},
      self: {
        bars: Object.fromEntries([...BARS.map(b => [b, false]), ['last', {}], ['wasFull', {}]]),
        cooldowns: Object.fromEntries([...COOLDOWNS.map(c => [c, false]), ['last', {}]]),
        chain: { enabled: false, min: 10, thresholds: [120, 90, 60, 30], last: {}, epochId: 0, fired: {} }
      },
      factions: { requestMs: CONFIG.timing.factionMs, items: {} }
    };
  }

  load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, 'utf8').trim();
        if (raw) Object.assign(this.data, JSON.parse(raw));
      }
      // Ensure structure
      this.data.watchers ??= {};
      this.data.self ??= this._defaults().self;
      this.data.factions ??= { requestMs: CONFIG.timing.factionMs, items: {} };
      console.log(`[store] Loaded from ${this.path}`);
    } catch (e) {
      console.warn('[store] Load failed:', e.message);
    }
  }

  save(reason = '') {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        const tmp = `${this.path}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.path);
        console.log(`[store] Saved${reason ? ` (${reason})` : ''}`);
      } catch (e) {
        console.warn('[store] Save failed:', e.message);
      }
    }, 250);
  }

  get watchers() { return this.data.watchers; }
  get self() { return this.data.self; }
  get factions() { return this.data.factions; }
  get requestMs() { return this.data.requestMs; }
  set requestMs(v) { this.data.requestMs = v; }
}

const store = new Store(path.resolve(CONFIG.paths.persist));

// ========= API Client =========
class TornAPI {
  constructor(apiKey) {
    this.key = apiKey;
    this.v2 = axios.create({ baseURL: 'https://api.torn.com/v2', timeout: 12000 });
    this.v1 = axios.create({ baseURL: 'https://api.torn.com', timeout: 12000 });
  }

  async getProfile(userId) {
    const { data } = await this.v2.get(`/user/${userId}/basic`, { params: { striptags: true, key: this.key } });
    if (!data?.profile) throw new Error(`Bad response for user ${userId}`);
    return data.profile;
  }

  async getBars() {
    const { data } = await this.v1.get('/user/', { params: { key: this.key, selections: 'bars' } });
    if (!data) throw new Error('Bad bars response');
    return data;
  }

  async getCooldowns() {
    const { data } = await this.v1.get('/user/', { params: { key: this.key, selections: 'cooldowns' } });
    if (!data?.cooldowns) throw new Error('Bad cooldowns response');
    return data.cooldowns;
  }

  async getFaction(fid) {
    const { data } = await this.v1.get(`/faction/${fid}`, { params: { key: this.key, selections: 'basic' } });
    if (!data?.members) throw new Error('Bad faction response');
    return data;
  }
}

const api = new TornAPI(CONFIG.torn.apiKey);

// ========= Embeds =========
const Embeds = {
  state({ userId, name, state, status, travel, title = 'Status' }) {
    const emb = new EmbedBuilder()
      .setColor(COLORS[state] || COLORS.info)
      .setAuthor({ name: `${name} (ID: ${userId})`, url: profileUrl(userId) })
      .setTitle(`${EMOJI[state] || 'ℹ️'} ${title}: ${state}`)
      .setTimestamp();

    const lines = status?.description ? [`• ${status.description}`] : [];

    if (state === 'Traveling' && travel?.earliest) {
      const mid = Math.floor((travel.earliest + travel.latest) / 2);
      const pm = Math.max(1, Math.round((travel.latest - travel.earliest) / 120));
      const type = (travel.type || 'unknown').replace(/_/g, ' ');
      const dest = travel.direction === 'return' ? `Torn (from ${travel.dest})` : travel.dest;
      if (travel.dest) lines.push(`• Destination: ${dest}`);
      lines.push(`• Travel type: ${type}`, `• ETA: ${ts(mid, 'f')} (±${pm}m)`);
    } else if ((state === 'Jail' || state === 'Hospital') && status?.until) {
      if (status.details) lines.push(`• Details: ${status.details}`);
      lines.push(`• Ends: ${ts(Number(status.until), 't')}`);
    }

    return emb.setDescription(lines.join('\n') || 'No extra info.')
      .addFields(
        { name: 'Profile', value: `[Open](${profileUrl(userId)})`, inline: true },
        { name: 'State', value: `${EMOJI[state] || ''} ${state}`, inline: true }
      );
  },

  barFull(kind, bar) {
    return new EmbedBuilder()
      .setColor(COLORS.good)
      .setTitle(`🔔 ${capitalize(kind)} full`)
      .addFields({ name: capitalize(kind), value: `${bar.current}/${bar.maximum}` })
      .setTimestamp();
  },

  cooldownEnded(kind) {
    return new EmbedBuilder().setColor(COLORS.good).setTitle(`🔔 ${capitalize(kind)} cooldown ended`).setTimestamp();
  },

  chainAlert(chain, threshold) {
    return new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle('⛓️ Chain timeout alert')
      .setDescription(`Chain: ${chain.current}/${chain.maximum}\nTimeout: ${chain.timeout}s`)
      .addFields({ name: 'Alert at', value: `≤ ${threshold}s`, inline: true })
      .setTimestamp();
  },

  preAlert(name, userId, state, endAt, left) {
    return new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`${EMOJI[state] || '⏰'} ${state} ending soon`)
      .setDescription(`${name} (${userId})\nEnds ~ ${ts(endAt, 't')} (in ${humanize(left)})`)
      .addFields({ name: 'Profile', value: `[Open](${profileUrl(userId)})`, inline: true })
      .setTimestamp();
  },

  factionMemberState(fName, uid, member, oldState, newState, travel) {
    const lines = [`Faction: ${fName}`];
    const until = Number(member?.status?.until || 0);
    const desc = stripTags(member?.status?.description || '');

    if (newState === 'Traveling' && travel?.earliest) {
      const mid = Math.floor((travel.earliest + travel.latest) / 2);
      const pm = Math.max(1, Math.round((travel.latest - travel.earliest) / 120));
      if (travel.dest) lines.push(`• Destination: ${travel.direction === 'return' ? `Torn (from ${travel.dest})` : travel.dest}`);
      lines.push(`• ETA: ${ts(mid, 'f')} (±${pm}m)`);
    } else {
      if (desc) lines.push(desc);
      if (['Jail', 'Hospital'].includes(newState) && until) lines.push(`Ends: ${ts(until, 't')}`);
    }

    return new EmbedBuilder()
      .setColor(COLORS[newState] || COLORS.info)
      .setTitle(`${EMOJI[newState] || '🔔'} ${member.name} → ${newState}`)
      .setDescription(lines.join('\n'))
      .addFields(
        { name: 'Prev', value: oldState || '(unknown)', inline: true },
        { name: 'Now', value: newState, inline: true },
        { name: 'Profile', value: `[Open](${profileUrl(uid)})`, inline: true }
      )
      .setTimestamp();
  },

  factionJoinLeave(kind, fName, uid, name) {
    const join = kind === 'join';
    return new EmbedBuilder()
      .setColor(join ? COLORS.good : COLORS.bad)
      .setTitle(`${join ? '🟢 Joined' : '🔴 Left'} ${fName}`)
      .setDescription(`${name} (${uid})`)
      .setTimestamp();
  },

  factionRespect(fName, prev, cur) {
    const step = Math.floor(cur / RESPECT_STEP) * RESPECT_STEP;
    return new EmbedBuilder()
      .setColor(COLORS.good)
      .setTitle(`🏆 ${fName} hit ${step.toLocaleString()} respect`)
      .setDescription(`${prev?.toLocaleString() || '—'} → ${cur.toLocaleString()}`)
      .setTimestamp();
  },

  factionDaily(fName, delta, cur) {
    return new EmbedBuilder()
      .setColor(delta >= 0 ? COLORS.good : COLORS.bad)
      .setTitle(`📈 ${fName} daily respect`)
      .setDescription(`${delta >= 0 ? 'Gained' : 'Lost'} ${Math.abs(delta).toLocaleString()}`)
      .addFields({ name: 'Total', value: cur.toLocaleString(), inline: true })
      .setTimestamp();
  },

  factionOffline(fName, uid, name, lastTs, hours) {
    return new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`⛔ ${name} offline > ${hours}h`)
      .setDescription(`Faction: ${fName}\nLast: ${ts(Number(lastTs), 'R')}`)
      .setTimestamp();
  }
};

// ========= Notification =========
const notify = async (embeds, components = []) => {
  try {
    const user = await client.users.fetch(CONFIG.discord.ownerId, { force: true });
    await user.send({ embeds: Array.isArray(embeds) ? embeds : [embeds], components });
  } catch (e) {
    console.error('[dm] Failed:', e.message);
  }
};

// ========= Poller Base =========
class Poller {
  constructor(name) {
    this.name = name;
    this.items = [];
    this.index = 0;
    this.timer = null;
    this.ticking = false;
  }

  refresh(items) {
    this.items = items;
    if (this.index >= this.items.length) this.index = 0;
    console.log(`[${this.name}] Active: ${this.items.length}`);
  }

  start(intervalMs, pollFn) {
    this.stop();
    if (!this.items.length) return;
    this.timer = setInterval(() => this.tick(pollFn), intervalMs);
    console.log(`[${this.name}] Interval: ${intervalMs}ms`);
    this.tick(pollFn);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(pollFn) {
    if (this.ticking || !this.items.length) return;
    this.ticking = true;
    const item = this.items[this.index];
    this.index = (this.index + 1) % this.items.length;
    try {
      await pollFn(item);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 429) console.warn(`[${this.name}] Rate limited`);
      else console.warn(`[${this.name}] Error:`, status || e.message);
    } finally {
      this.ticking = false;
    }
  }
}

// ========= User Watcher =========
const userPoller = new Poller('watch');

const sessionKey = (state, status, travel) => {
  if (state === 'Traveling' && travel?.startedAt) return `T:${travel.direction || 'out'}:${travel.startedAt}`;
  if (['Jail', 'Hospital'].includes(state) && status?.until) return `${state[0]}:${status.until}`;
  return null;
};

const createTravel = (status) => {
  const desc = status?.description || '';
  const dest = parseDestination(desc);
  const type = inferTravelType(status);
  const dir = parseTravelDir(desc);
  const startedAt = Date.now();
  const window = estimateTravel(type, dest, startedAt);
  return { startedAt, type, dest, direction: dir, ...window };
};

const pollUser = async (userId) => {
  const cfg = store.watchers[userId];
  if (!cfg || cfg.enabled === false) return;

  const profile = await api.getProfile(userId);
  const status = profile?.status || {};
  const name = profile?.name || cfg.name || `User ${userId}`;
  const state = status.state || 'Okay';
  const prev = cfg.lastState;

  cfg.name = name;

  // Pre-alerts
  if (cfg.preTimesSec?.length) {
    const endAt = state === 'Traveling' ? cfg.travel?.earliest : ['Jail', 'Hospital'].includes(state) ? Number(status.until) : null;
    if (endAt) {
      const left = endAt - Math.floor(Date.now() / 1000);
      if (left > 0) {
        const key = sessionKey(state, status, cfg.travel);
        if (key) {
          cfg.preFired ??= {};
          cfg.preFired[key] ??= [];
          for (const t of cfg.preTimesSec) {
            if (left <= t && !cfg.preFired[key].includes(t)) {
              cfg.preFired[key].push(t);
              await notify(Embeds.preAlert(name, userId, state, endAt, left));
              console.log(`[pre] ${name} ${state} ~${left}s (thr ${t}s)`);
            }
          }
        }
      }
    }
  }

  if (!prev) {
    cfg.lastState = state;
    cfg.travel = state === 'Traveling' ? createTravel(status) : null;
    store.save('init');
    return;
  }

  // Travel direction change
  if (state === 'Traveling' && prev === 'Traveling' && cfg.travel) {
    const newDir = parseTravelDir(status.description);
    const newDest = parseDestination(status.description);
    if (newDir !== cfg.travel.direction || newDest !== cfg.travel.dest) {
      cfg.travel = createTravel(status);
      store.save('travel-change');
      if (cfg.states?.includes('Traveling')) {
        await notify(Embeds.state({ userId, name, state, status, travel: cfg.travel, title: 'Travel Update' }));
      }
    }
  }

  // State change
  if (state !== prev) {
    cfg.lastState = state;
    cfg.travel = state === 'Traveling' ? createTravel(status) : null;
    
    // Clear pre-fired for new session
    const key = sessionKey(state, status, cfg.travel);
    if (key && cfg.preFired) delete cfg.preFired[key];
    
    store.save('state-change');
    
    if (cfg.states?.includes(state)) {
      await notify(Embeds.state({ userId, name, state, status, travel: cfg.travel }));
      console.log(`[change] ${name} → ${state}`);
    }
  }
};

const refreshUserPoller = () => {
  const items = Object.keys(store.watchers).filter(id => store.watchers[id]?.enabled !== false);
  userPoller.refresh(items);
  userPoller.start(store.requestMs, pollUser);
};

// ========= Bars/Chain/Cooldowns =========
let barsTimer = null, cooldownTimer = null, chainTimer = null;

const pollBars = async () => {
  try {
    const data = await api.getBars();
    const { self } = store;

    for (const k of BARS) {
      if (!self.bars[k]) continue;
      const bar = data[k];
      const isFull = bar?.current >= bar?.maximum;
      const wasFull = self.bars.wasFull[k];
      self.bars.last[k] = bar;
      if (isFull && !wasFull) {
        await notify(Embeds.barFull(k, bar));
        console.log(`[bars] ${k} full`);
      }
      self.bars.wasFull[k] = isFull;
    }

    if (data.chain) self.chain.last = { ...data.chain, updatedAt: Date.now() };
    store.save('bars');
  } catch (e) {
    console.warn('[bars] Error:', e.message);
  }
};

const pollChain = async () => {
  try {
    const data = await api.getBars();
    const chain = data.chain;
    if (!chain) return;

    const { self } = store;
    const prev = self.chain.last?.current ?? 0;
    const cur = chain.current ?? 0;

    if (cur < prev || (prev === 0 && cur > 0)) {
      self.chain.epochId = (self.chain.epochId || 0) + 1;
      self.chain.fired[self.chain.epochId] = [];
    }

    self.chain.last = { ...chain, updatedAt: Date.now() };

    if (!self.chain.enabled || cur < (self.chain.min || 10)) return;

    const fired = self.chain.fired[self.chain.epochId] ||= [];
    for (const t of (self.chain.thresholds || [120, 90, 60, 30]).sort((a, b) => b - a)) {
      if (!fired.includes(t) && chain.timeout <= t && chain.timeout >= 0) {
        fired.push(t);
        await notify(Embeds.chainAlert(chain, t));
        console.log(`[chain] Alert at ${t}s`);
      }
    }
    store.save('chain');
  } catch (e) {
    console.warn('[chain] Error:', e.message);
  }
};

const pollCooldowns = async () => {
  try {
    const cds = await api.getCooldowns();
    const { self } = store;
    let soonest = Infinity;

    for (const c of COOLDOWNS) {
      if (!self.cooldowns[c]) continue;
      const prev = self.cooldowns.last[c];
      const val = cds[c] ?? 0;
      self.cooldowns.last[c] = val;

      if (prev > 0 && val <= 0) {
        await notify(Embeds.cooldownEnded(c));
        console.log(`[cooldowns] ${c} ended`);
      }
      if (val > 0) soonest = Math.min(soonest, val);
    }

    store.save('cooldowns');
    scheduleCooldown(soonest < Infinity ? (soonest + 2) * 1000 : 30 * 60 * 1000);
  } catch (e) {
    console.warn('[cooldowns] Error:', e.message);
    scheduleCooldown(5 * 60 * 1000);
  }
};

const scheduleCooldown = ms => {
  clearTimeout(cooldownTimer);
  if (COOLDOWNS.some(c => store.self.cooldowns[c])) {
    cooldownTimer = setTimeout(pollCooldowns, Math.max(2000, ms));
  }
};

const startSelfPollers = () => {
  clearInterval(barsTimer);
  clearInterval(chainTimer);
  
  if (BARS.some(b => store.self.bars[b]) || store.self.chain.enabled) {
    barsTimer = setInterval(pollBars, CONFIG.timing.barsMs);
    pollBars();
  }
  
  if (store.self.chain.enabled) {
    chainTimer = setInterval(pollChain, CONFIG.timing.chainMs);
  }
  
  if (COOLDOWNS.some(c => store.self.cooldowns[c])) {
    pollCooldowns();
  }
};

// ========= Faction Poller =========
const factionPoller = new Poller('factions');
let dailyTimer = null;

const pollFaction = async (fid) => {
  const fconf = store.factions.items[fid];
  if (!fconf || fconf.enabled === false) return;

  const data = await api.getFaction(fid);
  const fName = data.name || `Faction ${fid}`;
  Object.assign(fconf, { name: data.name, tag: data.tag });

  // Respect milestone
  const curRespect = Number(data.respect || 0);
  const prevStep = fconf.lastRespectStep ?? Math.floor((fconf.lastRespect || curRespect) / RESPECT_STEP);
  const stepNow = Math.floor(curRespect / RESPECT_STEP);
  
  if (stepNow > prevStep) {
    await notify(Embeds.factionRespect(fName, fconf.lastRespect, curRespect));
  }
  Object.assign(fconf, { lastRespect: curRespect, lastRespectStep: stepNow });

  const prevMap = fconf.members ??= {};
  const newMap = data.members || {};
  const prevIds = new Set(Object.keys(prevMap));
  const newIds = new Set(Object.keys(newMap));
  const watchStates = new Set(fconf.states || []);
  const offlineThresh = (fconf.offline?.hours || CONFIG.defaults.offlineHours) * 3600;
  const nowSec = Math.floor(Date.now() / 1000);

  // Joins/Leaves
  for (const uid of newIds) {
    if (!prevIds.has(uid)) {
      const m = newMap[uid];
      await notify(Embeds.factionJoinLeave('join', fName, uid, m.name));
      prevMap[uid] = { name: m.name, lastState: m.status?.state, lastActionTs: m.last_action?.timestamp, travel: null, preFired: {} };
    }
  }
  for (const uid of prevIds) {
    if (!newIds.has(uid)) {
      await notify(Embeds.factionJoinLeave('leave', fName, uid, prevMap[uid]?.name || uid));
      delete prevMap[uid];
    }
  }

  // Member updates
  for (const [uid, m] of Object.entries(newMap)) {
    const cached = prevMap[uid] ??= { name: m.name, lastState: null, travel: null, preFired: {} };
    const curState = m.status?.state || 'Okay';
    const tsLast = Number(m.last_action?.timestamp || 0);

    // Travel handling
    if (curState === 'Traveling') {
      const newDir = parseTravelDir(m.status?.description);
      const newDest = parseDestination(m.status?.description);
      
      if (!cached.travel || newDir !== cached.travel.direction || newDest !== cached.travel.dest) {
        cached.travel = createTravel(m.status);
        if (cached.lastState === 'Traveling' && watchStates.has('Traveling')) {
          await notify(Embeds.factionMemberState(fName, uid, m, cached.lastState, curState, cached.travel));
        }
      }
    } else {
      cached.travel = null;
    }

    // State change
    if (cached.lastState && curState !== cached.lastState && watchStates.has(curState)) {
      await notify(Embeds.factionMemberState(fName, uid, m, cached.lastState, curState, cached.travel));
    }

    // Offline check
    if (fconf.offline?.enabled !== false && tsLast > 0) {
      const isOffline = (nowSec - tsLast) >= offlineThresh;
      if (isOffline && !cached.offlineNotified) {
        await notify(Embeds.factionOffline(fName, uid, m.name, tsLast, fconf.offline?.hours || CONFIG.defaults.offlineHours));
        cached.offlineNotified = true;
      } else if (!isOffline && cached.offlineNotified) {
        cached.offlineNotified = false;
      }
    }

    // Pre-alerts for faction members
    if (fconf.preTimesSec?.length && watchStates.has(curState)) {
      const endAt = curState === 'Traveling' ? cached.travel?.earliest : ['Jail', 'Hospital'].includes(curState) ? Number(m.status?.until) : null;
      if (endAt) {
        const left = endAt - nowSec;
        if (left > 0) {
          const key = sessionKey(curState, m.status, cached.travel);
          if (key) {
            cached.preFired ??= {};
            cached.preFired[key] ??= [];
            for (const t of fconf.preTimesSec) {
              if (left <= t && !cached.preFired[key].includes(t)) {
                cached.preFired[key].push(t);
                await notify(Embeds.preAlert(m.name, uid, curState, endAt, left));
              }
            }
          }
        }
      }
    }

    Object.assign(cached, { name: m.name, lastState: curState, lastActionTs: tsLast || cached.lastActionTs });
  }

  store.save('faction-poll');
};

const runDailyDigest = async () => {
  for (const [fid, fconf] of Object.entries(store.factions.items)) {
    if (fconf.enabled === false || fconf.daily?.enabled === false) continue;
    try {
      const data = await api.getFaction(fid);
      const cur = Number(data.respect || 0);
      fconf.daily ??= {};
      
      if (fconf.daily.respectAtMidnight != null) {
        const delta = cur - fconf.daily.respectAtMidnight;
        await notify(Embeds.factionDaily(data.name || fid, delta, cur));
      }
      
      fconf.daily.respectAtMidnight = cur;
      fconf.daily.lastMidnightISO = new Date().toISOString().slice(0, 10);
      store.save('daily');
      await sleep(900);
    } catch (e) {
      console.warn('[daily] Error:', e.message);
    }
  }
  scheduleDailyDigest();
};

const scheduleDailyDigest = () => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5));
  clearTimeout(dailyTimer);
  dailyTimer = setTimeout(runDailyDigest, next - now);
};

const refreshFactionPoller = () => {
  const items = Object.keys(store.factions.items).filter(id => store.factions.items[id]?.enabled !== false);
  factionPoller.refresh(items);
  factionPoller.start(store.factions.requestMs, pollFaction);
  scheduleDailyDigest();
};

// ========= Discord Client & Commands =========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

// Express server
const app = express();
app.get('/', (_, res) => res.send(`OK ${new Date().toISOString()}`));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.listen(CONFIG.port, () => console.log(`[web] :${CONFIG.port}`));

if (CONFIG.paths.selfPingUrl) {
  setInterval(async () => {
    try {
      await axios.get(CONFIG.paths.selfPingUrl, { timeout: 8000 });
    } catch {}
  }, CONFIG.timing.selfPingMs);
}

// Command builders
const buildToggleCommand = (name, desc) => new SlashCommandBuilder().setName(name).setDescription(desc).addBooleanOption(o => o.setName('on').setDescription('true/false'));

const commands = [
  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Manage watches')
    .addSubcommand(sc => sc.setName('add').setDescription('Add watcher')
      .addIntegerOption(o => o.setName('user_id').setDescription('Torn ID').setRequired(true))
      .addStringOption(o => o.setName('states').setDescription('States'))
      .addStringOption(o => o.setName('time_left').setDescription('Pre-alert seconds')))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove').addIntegerOption(o => o.setName('user_id').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('List'))
    .addSubcommand(sc => sc.setName('states').setDescription('Set states')
      .addIntegerOption(o => o.setName('user_id').setRequired(true))
      .addStringOption(o => o.setName('states').setRequired(true)))
    .addSubcommand(sc => sc.setName('menu').setDescription('UI').addIntegerOption(o => o.setName('user_id').setRequired(true)))
    .addSubcommand(sc => sc.setName('enable').setDescription('Enable/disable')
      .addIntegerOption(o => o.setName('user_id').setRequired(true))
      .addBooleanOption(o => o.setName('on').setRequired(true)))
    .addSubcommand(sc => sc.setName('interval').setDescription('Set interval').addIntegerOption(o => o.setName('ms').setRequired(true)))
    .addSubcommand(sc => sc.setName('show').setDescription('Show state').addIntegerOption(o => o.setName('user_id').setRequired(true)))
    .addSubcommand(sc => sc.setName('test').setDescription('Test DM'))
    .addSubcommand(sc => sc.setName('storage').setDescription('Info')),
  
  ...BARS.map(b => buildToggleCommand(b, `Toggle ${b} alert`)),
  ...COOLDOWNS.map(c => buildToggleCommand(c, `Toggle ${c} cooldown`)),
  
  new SlashCommandBuilder().setName('chain').setDescription('Chain config')
    .addBooleanOption(o => o.setName('on'))
    .addIntegerOption(o => o.setName('min'))
    .addStringOption(o => o.setName('time_left')),
  
  new SlashCommandBuilder().setName('delay').setDescription('Add delay')
    .addIntegerOption(o => o.setName('id').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('faction')
    .setDescription('Faction tracking')
    .addSubcommand(sc => sc.setName('add').setDescription('Add')
      .addIntegerOption(o => o.setName('id').setRequired(true))
      .addStringOption(o => o.setName('states'))
      .addIntegerOption(o => o.setName('offline_hours'))
      .addStringOption(o => o.setName('time_left')))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove').addIntegerOption(o => o.setName('id').setRequired(true)))
    .addSubcommand(sc => sc.setName('enable').setDescription('Enable/disable')
      .addIntegerOption(o => o.setName('id').setRequired(true))
      .addBooleanOption(o => o.setName('on').setRequired(true)))
    .addSubcommand(sc => sc.setName('states').setDescription('Set states')
      .addIntegerOption(o => o.setName('id').setRequired(true))
      .addStringOption(o => o.setName('states').setRequired(true)))
    .addSubcommand(sc => sc.setName('offline').setDescription('Offline config')
      .addIntegerOption(o => o.setName('id').setRequired(true))
      .addIntegerOption(o => o.setName('hours'))
      .addBooleanOption(o => o.setName('on')))
    .addSubcommand(sc => sc.setName('daily').setDescription('Daily digest')
      .addIntegerOption(o => o.setName('id').setRequired(true))
      .addBooleanOption(o => o.setName('on').setRequired(true)))
    .addSubcommand(sc => sc.setName('timeleft').setDescription('Pre-alerts')
      .addIntegerOption(o => o.setName('id').setRequired(true))
      .addStringOption(o => o.setName('time_left').setRequired(true)))
    .addSubcommand(sc => sc.setName('interval').setDescription('Set interval').addIntegerOption(o => o.setName('ms').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('List'))
    .addSubcommand(sc => sc.setName('show').setDescription('Show').addIntegerOption(o => o.setName('id').setRequired(true)))
].map(c => c.toJSON());

// UI Components
const statesSelectRow = (userId, current) => new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder()
    .setCustomId(`states:${userId}`)
    .setPlaceholder('Select states')
    .setMinValues(0)
    .setMaxValues(STATES.length)
    .addOptions(STATES.map(s => ({ label: s, value: s, emoji: EMOJI[s], default: current.includes(s) })))
);

const enableButtonsRow = (userId, enabled) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`toggle:${userId}`).setLabel(enabled ? 'Disable' : 'Enable').setStyle(enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`remove:${userId}`).setLabel('Remove').setStyle(ButtonStyle.Danger)
);

// Interaction handler
client.on('interactionCreate', async (interaction) => {
  if (interaction.user.id !== CONFIG.discord.ownerId) {
    return interaction.reply?.({ content: 'Owner only.', ephemeral: true }).catch(() => {});
  }

  const ephemeral = interaction.inGuild();

  try {
    // Select menu
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('states:')) {
      const userId = interaction.customId.split(':')[1];
      const cfg = store.watchers[userId];
      if (!cfg) return interaction.reply({ content: 'Not found.', ephemeral });
      cfg.states = interaction.values;
      store.save('states');
      return interaction.update({ content: `States: ${cfg.states.join(', ') || 'none'}`, components: [statesSelectRow(userId, cfg.states), enableButtonsRow(userId, cfg.enabled !== false)] });
    }

    // Buttons
    if (interaction.isButton()) {
      const [kind, userId] = interaction.customId.split(':');
      const cfg = store.watchers[userId];
      if (!cfg) return interaction.reply({ content: 'Not found.', ephemeral });
      
      if (kind === 'toggle') {
        cfg.enabled = !cfg.enabled;
        store.save('toggle');
        refreshUserPoller();
        return interaction.update({ content: `${cfg.enabled ? 'Enabled' : 'Disabled'}.`, components: [statesSelectRow(userId, cfg.states || []), enableButtonsRow(userId, cfg.enabled)] });
      }
      if (kind === 'remove') {
        delete store.watchers[userId];
        store.save('remove');
        refreshUserPoller();
        return interaction.update({ content: `Removed ${userId}.`, components: [] });
      }
    }

    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply({ ephemeral });

    const { commandName } = interaction;
    const sub = interaction.options.getSubcommand?.(false);
    const getInt = n => interaction.options.getInteger(n);
    const getStr = n => interaction.options.getString(n);
    const getBool = n => interaction.options.getBoolean(n);

    // Bar/Cooldown toggles
    if (BARS.includes(commandName)) {
      const on = getBool('on');
      store.self.bars[commandName] = on ?? !store.self.bars[commandName];
      store.save('bar-toggle');
      startSelfPollers();
      return interaction.editReply(`${capitalize(commandName)}: ${store.self.bars[commandName] ? 'ON' : 'OFF'}`);
    }

    if (COOLDOWNS.includes(commandName)) {
      const on = getBool('on');
      store.self.cooldowns[commandName] = on ?? !store.self.cooldowns[commandName];
      store.save('cooldown-toggle');
      scheduleCooldown(1000);
      return interaction.editReply(`${capitalize(commandName)} cooldown: ${store.self.cooldowns[commandName] ? 'ON' : 'OFF'}`);
    }

    // Chain
    if (commandName === 'chain') {
      const { chain } = store.self;
      const on = getBool('on'), min = getInt('min'), tlist = getStr('time_left');
      if (on != null) chain.enabled = on;
      if (min != null) chain.min = Math.max(0, min);
      if (tlist) chain.thresholds = parseSeconds(tlist, [120, 90, 60, 30]);
      store.save('chain');
      startSelfPollers();
      return interaction.editReply(`Chain: ${chain.enabled ? 'ON' : 'OFF'} | min=${chain.min} | thresholds=${chain.thresholds.join(',')}`);
    }

    // Delay
    if (commandName === 'delay') {
      const id = String(getInt('id')), min = getInt('minutes');
      const cfg = store.watchers[id];
      if (!cfg?.travel) return interaction.editReply('Not traveling.');
      const addSec = Math.max(0, min) * 60;
      cfg.travel.earliest += addSec;
      cfg.travel.latest += addSec;
      store.save('delay');
      return interaction.editReply(`Added ${min}m. New ETA: ${ts(cfg.travel.earliest, 't')}`);
    }

    // Watch commands
    if (commandName === 'watch') {
      const userId = String(getInt('user_id') || '');

      if (sub === 'add') {
        if (store.watchers[userId]) return interaction.editReply('Already watching.');
        const states = parseStates(getStr('states')) || parseStates(CONFIG.defaults.states);
        const pre = parseSeconds(getStr('time_left'), []);
        store.watchers[userId] = { states, enabled: true, lastState: null, name: `User ${userId}`, travel: null, preTimesSec: pre.length ? pre : undefined, preFired: {} };
        store.save('add');
        
        try {
          const profile = await api.getProfile(userId);
          store.watchers[userId].name = profile.name;
          store.watchers[userId].lastState = profile.status?.state || 'Okay';
          store.save('prime');
        } catch {}
        
        refreshUserPoller();
        return interaction.editReply(`Added ${store.watchers[userId].name} (${states.join(', ')})`);
      }

      if (sub === 'remove') {
        if (!store.watchers[userId]) return interaction.editReply('Not found.');
        delete store.watchers[userId];
        store.save('remove');
        refreshUserPoller();
        return interaction.editReply(`Removed ${userId}.`);
      }

      if (sub === 'list') {
        const entries = Object.entries(store.watchers);
        if (!entries.length) return interaction.editReply('No watchers.');
        const lines = entries.map(([id, c]) => `• ${c.name} (${id}) - ${c.enabled === false ? 'disabled' : 'enabled'} - ${c.states?.join(', ') || 'none'}`);
        return interaction.editReply(lines.join('\n'));
      }

      if (sub === 'states') {
        const cfg = store.watchers[userId];
        if (!cfg) return interaction.editReply('Not found.');
        cfg.states = parseStates(getStr('states'));
        store.save('states');
        return interaction.editReply(`States: ${cfg.states.join(', ')}`);
      }

      if (sub === 'menu') {
        const cfg = store.watchers[userId];
        if (!cfg) return interaction.editReply('Not found.');
        const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`Configure ${cfg.name || userId}`)
          .addFields(
            { name: 'States', value: cfg.states?.map(s => `${EMOJI[s]} ${s}`).join(' ') || 'none' },
            { name: 'Status', value: cfg.enabled === false ? 'disabled' : 'enabled', inline: true }
          );
        return interaction.editReply({ embeds: [embed], components: [statesSelectRow(userId, cfg.states || []), enableButtonsRow(userId, cfg.enabled !== false)] });
      }

      if (sub === 'enable') {
        const cfg = store.watchers[userId];
        if (!cfg) return interaction.editReply('Not found.');
        cfg.enabled = getBool('on');
        store.save('enable');
        refreshUserPoller();
        return interaction.editReply(`${cfg.enabled ? 'Enabled' : 'Disabled'}.`);
      }

      if (sub === 'interval') {
        const ms = getInt('ms');
        if (ms < 1000) return interaction.editReply('Min 1000ms.');
        store.requestMs = ms;
        store.save('interval');
        refreshUserPoller();
        return interaction.editReply(`Interval: ${ms}ms`);
      }

      if (sub === 'show') {
        const cfg = store.watchers[userId];
        if (!cfg) return interaction.editReply('Not found.');
        const profile = await api.getProfile(userId);
        return interaction.editReply({ embeds: [Embeds.state({ userId, name: profile.name, state: profile.status?.state || 'Okay', status: profile.status, travel: cfg.travel })] });
      }

      if (sub === 'test') {
        await notify(new EmbedBuilder().setColor(COLORS.info).setTitle('Test').setDescription('Test DM ✅').setTimestamp());
        return interaction.editReply('Sent test DM.');
      }

      if (sub === 'storage') {
        return interaction.editReply(`Path: ${store.path}\nWatchers: ${Object.keys(store.watchers).length}\nInterval: ${store.requestMs}ms`);
      }
    }

    // Faction commands
    if (commandName === 'faction') {
      const fid = String(getInt('id') || '');
      const { items } = store.factions;

      if (sub === 'add') {
        if (items[fid]) return interaction.editReply('Already tracking.');
        items[fid] = {
          id: fid, enabled: true,
          states: parseStates(getStr('states')) || parseStates(CONFIG.defaults.states),
          preTimesSec: parseSeconds(getStr('time_left'), []) || undefined,
          members: {},
          offline: { enabled: true, hours: getInt('offline_hours') || CONFIG.defaults.offlineHours },
          daily: { enabled: true }
        };
        store.save('faction-add');
        refreshFactionPoller();
        return interaction.editReply(`Added faction ${fid}`);
      }

      if (sub === 'remove') {
        if (!items[fid]) return interaction.editReply('Not found.');
        delete items[fid];
        store.save('faction-remove');
        refreshFactionPoller();
        return interaction.editReply(`Removed ${fid}`);
      }

      if (sub === 'enable') {
        if (!items[fid]) return interaction.editReply('Not found.');
        items[fid].enabled = getBool('on');
        store.save('faction-enable');
        refreshFactionPoller();
        return interaction.editReply(`Faction ${fid}: ${items[fid].enabled ? 'ON' : 'OFF'}`);
      }

      if (sub === 'states') {
        if (!items[fid]) return interaction.editReply('Not found.');
        items[fid].states = parseStates(getStr('states'));
        store.save('faction-states');
        return interaction.editReply(`States: ${items[fid].states.join(', ')}`);
      }

      if (sub === 'offline') {
        if (!items[fid]) return interaction.editReply('Not found.');
        const h = getInt('hours'), on = getBool('on');
        if (h != null) items[fid].offline.hours = Math.max(1, h);
        if (on != null) items[fid].offline.enabled = on;
        store.save('faction-offline');
        return interaction.editReply(`Offline: ${items[fid].offline.enabled ? 'ON' : 'OFF'} (${items[fid].offline.hours}h)`);
      }

      if (sub === 'daily') {
        if (!items[fid]) return interaction.editReply('Not found.');
        items[fid].daily ??= {};
        items[fid].daily.enabled = getBool('on');
        store.save('faction-daily');
        return interaction.editReply(`Daily: ${items[fid].daily.enabled ? 'ON' : 'OFF'}`);
      }

      if (sub === 'timeleft') {
        if (!items[fid]) return interaction.editReply('Not found.');
        const pre = parseSeconds(getStr('time_left'), []);
        items[fid].preTimesSec = pre.length ? pre : undefined;
        store.save('faction-timeleft');
        return interaction.editReply(`Pre-alerts: ${pre.length ? pre.join(',') + 's' : 'OFF'}`);
      }

      if (sub === 'interval') {
        const ms = getInt('ms');
        if (ms < 10000) return interaction.editReply('Min 10000ms.');
        store.factions.requestMs = ms;
        store.save('faction-interval');
        refreshFactionPoller();
        return interaction.editReply(`Interval: ${ms}ms`);
      }

      if (sub === 'list') {
        const fids = Object.keys(items);
        if (!fids.length) return interaction.editReply('No factions.');
        const lines = fids.map(id => {
          const f = items[id];
          return `• ${f.name || id} - ${f.enabled !== false ? 'on' : 'off'} - ${f.states?.join(', ') || 'none'}`;
        });
        return interaction.editReply(lines.join('\n'));
      }

      if (sub === 'show') {
        const f = items[fid];
        if (!f) return interaction.editReply('Not found.');
        return interaction.editReply([
          `Name: ${f.name || fid}`,
          `Enabled: ${f.enabled !== false}`,
          `States: ${f.states?.join(', ') || 'none'}`,
          `Pre-alerts: ${f.preTimesSec?.join(',') || 'off'}`,
          `Offline: ${f.offline?.enabled !== false ? 'ON' : 'OFF'} (${f.offline?.hours}h)`,
          `Members: ${Object.keys(f.members || {}).length}`
        ].join('\n'));
      }
    }

  } catch (e) {
    console.error('[cmd]', e);
    const msg = `Error: ${e.message}`;
    interaction.deferred || interaction.replied ? interaction.editReply(msg).catch(() => {}) : interaction.reply({ content: msg, ephemeral }).catch(() => {});
  }
});

// ========= Startup =========
store.load();

// Seed from env
if (!Object.keys(store.watchers).length && CONFIG.torn.userIds) {
  const defaultStates = parseStates(CONFIG.defaults.states);
  CONFIG.torn.userIds.split(',').filter(Boolean).forEach(id => {
    store.watchers[id.trim()] = { states: defaultStates, enabled: true, lastState: null, name: `User ${id}`, travel: null, preFired: {} };
  });
  store.save('seed');
}

if (!Object.keys(store.factions.items).length && CONFIG.torn.factionIds) {
  const defaultStates = parseStates(CONFIG.defaults.states);
  CONFIG.torn.factionIds.split(',').filter(Boolean).forEach(id => {
    store.factions.items[id.trim()] = {
      id: id.trim(), enabled: true, states: defaultStates, members: {},
      offline: { enabled: true, hours: CONFIG.defaults.offlineHours },
      daily: { enabled: true }
    };
  });
  store.save('faction-seed');
}

client.once('ready', async () => {
  console.log(`[discord] ${client.user.tag}`);
  
  try {
    if (CONFIG.discord.guildId) {
      const guild = await client.guilds.fetch(CONFIG.discord.guildId);
      await guild.commands.set(commands);
    }
    await client.application.commands.set(commands);
    console.log('[cmd] Registered');
  } catch (e) {
    console.warn('[cmd] Registration failed:', e.message);
  }

  // Prime baselines
  for (const [uid, cfg] of Object.entries(store.watchers)) {
    if (!cfg.lastState) {
      try {
        const p = await api.getProfile(uid);
        cfg.name = p.name;
        cfg.lastState = p.status?.state || 'Okay';
        store.save('prime');
        await sleep(500);
      } catch {}
    }
  }

  refreshUserPoller();
  startSelfPollers();
  refreshFactionPoller();
  
  console.log(`[watch] ${Object.keys(store.watchers).length} users, ${Object.keys(store.factions.items).length} factions`);
});

client.login(CONFIG.discord.token);

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log(sig);
  store.save('exit');
  setTimeout(() => process.exit(0), 300);
}));