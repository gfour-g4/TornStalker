require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const {
  Client, GatewayIntentBits, Partials, SlashCommandBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

// ========= Configuration =========
const CONFIG = {
  discord: { token: process.env.DISCORD_TOKEN, ownerId: process.env.OWNER_DISCORD_ID, guildId: process.env.GUILD_ID },
  torn: { apiKey: process.env.TORN_API_KEY, userIds: process.env.USER_IDS, factionIds: process.env.FACTION_IDS },
  timing: { requestMs: Number(process.env.REQUEST_INTERVAL_MS) || 5000, factionMs: Number(process.env.FACTION_INTERVAL_MS) || 30000 },
  persist: process.env.PERSIST_PATH || './store.json',
  port: Number(process.env.PORT) || 3000,
  defaults: { offlineHours: Number(process.env.FACTION_OFFLINE_HOURS) || 24 }
};

['token', 'ownerId'].forEach(k => { if (!CONFIG.discord[k]) throw new Error(`Missing DISCORD_${k.toUpperCase()}`); });
if (!CONFIG.torn.apiKey) throw new Error('Missing TORN_API_KEY');

// ========= Constants =========
const STATES = ['Traveling', 'Abroad', 'Jail', 'Hospital', 'Okay'];
const BARS = ['energy', 'nerve', 'happy', 'life'];
const COOLDOWNS = ['drug', 'medical', 'booster'];

const EMOJI = {
  Traveling: '✈️', Abroad: '🗺️', Jail: '🚔', Hospital: '🏥', Okay: '✅',
  energy: '⚡', nerve: '💢', happy: '😊', life: '❤️',
  drug: '💊', medical: '🩹', booster: '💉',
  chain: '⛓️', on: '🟢', off: '🔴', user: '👤', faction: '🏴'
};

const COLORS = {
  Traveling: 0x2b8aeb, Abroad: 0xffc107, Jail: 0x6c757d, Hospital: 0xdc3545, Okay: 0x28a745,
  brand: 0x5865F2, warn: 0xff9800, good: 0x1abc9c, bad: 0xe53935
};

const DESTINATIONS = ['Mexico', 'Cayman Islands', 'Canada', 'Hawaii', 'United Kingdom', 'Argentina', 'Switzerland', 'Japan', 'China', 'UAE', 'South Africa'];
const TRAVEL_TIMES = {
  standard_economy: [1560, 2100, 2460, 8040, 9540, 10020, 10500, 13500, 14520, 16260, 17820],
  standard_business: [480, 660, 720, 2400, 2880, 3000, 3180, 4080, 4320, 4860, 5340],
  airstrip: [1080, 1500, 1740, 5640, 6660, 7020, 7380, 9480, 10140, 11400, 12480],
  private: [780, 1080, 1200, 4020, 4800, 4980, 5280, 6780, 7260, 8100, 8940]
};

// ========= Utilities =========
const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const profileUrl = id => `https://www.torn.com/profiles.php?XID=${id}`;
const ts = (unix, style = 'f') => `<t:${unix}:${style}>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// Parse human time: "5m", "1h30m", "90s", "2h" -> seconds
const parseTime = input => {
  if (!input) return null;
  const str = input.toString().toLowerCase().trim();
  if (/^\d+$/.test(str)) return parseInt(str); // plain seconds
  let total = 0;
  const h = str.match(/(\d+)\s*h/), m = str.match(/(\d+)\s*m/), s = str.match(/(\d+)\s*s/);
  if (h) total += parseInt(h[1]) * 3600;
  if (m) total += parseInt(m[1]) * 60;
  if (s) total += parseInt(s[1]);
  return total || null;
};

// Format seconds to human: 3661 -> "1h 1m 1s"
const humanTime = sec => {
  if (!sec || sec <= 0) return 'now';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  return parts.join(' ') || 'now';
};

// Parse multiple times: "5m, 2m, 30s" -> [300, 120, 30]
const parseTimes = input => {
  if (!input) return [];
  const low = input.toLowerCase().trim();
  if (['off', 'none', '-', 'disable', '0'].includes(low)) return [];
  return [...new Set(input.split(/[,\s]+/).map(parseTime).filter(n => n > 0))].sort((a, b) => b - a);
};

// Parse states with fuzzy matching
const parseStates = input => {
  if (!input?.trim()) return [...STATES];
  const val = input.trim().toLowerCase();
  if (['all', '*', 'any'].includes(val)) return [...STATES];
  if (['none', '-', 'off'].includes(val)) return [];
  return [...new Set(input.split(/[,\s|]+/).map(s => {
    const low = s.toLowerCase();
    const match = STATES.find(st => st.toLowerCase().startsWith(low));
    if (!match) throw new Error(`Unknown state: "${s}". Try: ${STATES.join(', ')}`);
    return match;
  }))];
};

// Progress bar visualization
const progressBar = (current, max, length = 10) => {
  const pct = clamp(current / max, 0, 1);
  const filled = Math.round(pct * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled) + ` ${current}/${max}`;
};

// Travel estimation
const getTravelTime = (type, dest) => {
  const idx = DESTINATIONS.findIndex(d => d.toLowerCase() === dest?.toLowerCase());
  return idx >= 0 ? TRAVEL_TIMES[type]?.[idx] : null;
};

const estimateTravel = (type, dest, startMs) => {
  const PAD = 0.03, startSec = Math.floor(startMs / 1000);
  if (!dest) return { earliest: null, latest: null };
  if (type === 'standard') {
    const [econ, bus] = ['standard_economy', 'standard_business'].map(t => getTravelTime(t, dest));
    if (!econ || !bus) return { earliest: null, latest: null };
    return { earliest: Math.floor(startSec + Math.min(econ, bus) * (1 - PAD)), latest: Math.floor(startSec + Math.max(econ, bus) * (1 + PAD)) };
  }
  const sec = getTravelTime(type, dest);
  return sec ? { earliest: Math.floor(startSec + sec * (1 - PAD)), latest: Math.floor(startSec + sec * (1 + PAD)) } : { earliest: null, latest: null };
};

const parseDestination = desc => {
  const match = desc?.match(/(?:from|to)\s+([A-Za-z\s-]+)$/i);
  const dest = match?.[1]?.replace(/[^\w\s-]/g, '').trim();
  return DESTINATIONS.find(d => d.toLowerCase() === dest?.toLowerCase()) || dest;
};

const parseTravelDir = desc => /returning|from\s+\w/i.test(desc || '') ? 'return' : 'outbound';
const inferTravelType = status => status?.travel_type?.toLowerCase() || 'standard';

const createTravel = status => {
  const desc = status?.description || '';
  const dest = parseDestination(desc), type = inferTravelType(status), dir = parseTravelDir(desc);
  return { startedAt: Date.now(), type, dest, direction: dir, ...estimateTravel(type, dest, Date.now()) };
};

// ========= Storage =========
class Store {
  constructor(configPath) {
    this.path = this._resolvePath(configPath);
    this.data = { requestMs: CONFIG.timing.requestMs, watchers: {}, self: this._selfDefaults(), factions: { requestMs: CONFIG.timing.factionMs, items: {} } };
    this.timer = null;
  }

  _resolvePath(target) {
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target + '.probe', ''); fs.unlinkSync(target + '.probe'); return target; }
    catch { return '/tmp/store.json'; }
  }

  _selfDefaults() {
    return {
      bars: { energy: false, nerve: false, happy: false, life: false, last: {}, wasFull: {} },
      cooldowns: { drug: false, medical: false, booster: false, last: {} },
      chain: { enabled: false, min: 10, thresholds: [120, 60, 30], last: {}, epochId: 0, fired: {} }
    };
  }

  load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, 'utf8').trim();
        if (raw) Object.assign(this.data, JSON.parse(raw));
      }
      this.data.watchers ??= {};
      this.data.self ??= this._selfDefaults();
      this.data.factions ??= { requestMs: CONFIG.timing.factionMs, items: {} };
    } catch (e) { console.warn('[store] Load failed:', e.message); }
  }

  save(reason = '') {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { const tmp = this.path + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2)); fs.renameSync(tmp, this.path); }
      catch (e) { console.warn('[store] Save failed:', e.message); }
    }, 300);
  }

  get watchers() { return this.data.watchers; }
  get self() { return this.data.self; }
  get factions() { return this.data.factions; }
  get requestMs() { return this.data.requestMs; }
  set requestMs(v) { this.data.requestMs = v; }
}

const store = new Store(path.resolve(CONFIG.persist));

// ========= API =========
class TornAPI {
  constructor(key) {
    this.key = key;
    this.v2 = axios.create({ baseURL: 'https://api.torn.com/v2', timeout: 12000 });
    this.v1 = axios.create({ baseURL: 'https://api.torn.com', timeout: 12000 });
  }
  async getProfile(id) { const { data } = await this.v2.get(`/user/${id}/basic`, { params: { striptags: true, key: this.key } }); return data?.profile; }
  async getBars() { const { data } = await this.v1.get('/user/', { params: { key: this.key, selections: 'bars' } }); return data; }
  async getCooldowns() { const { data } = await this.v1.get('/user/', { params: { key: this.key, selections: 'cooldowns' } }); return data?.cooldowns; }
  async getFaction(id) { const { data } = await this.v1.get(`/faction/${id}`, { params: { key: this.key, selections: 'basic' } }); return data; }
  async searchUser(name) { const { data } = await this.v1.get('/user/', { params: { key: this.key, selections: 'search', name } }); return data; }
}

const api = new TornAPI(CONFIG.torn.apiKey);

// ========= Notification System =========
let client;

const notify = async (embeds, components = []) => {
  try {
    const user = await client.users.fetch(CONFIG.discord.ownerId, { force: true });
    await user.send({ embeds: Array.isArray(embeds) ? embeds : [embeds], components });
  } catch (e) { console.error('[dm] Failed:', e.message); }
};

// ========= Smart Embeds =========
const Embeds = {
  // Main dashboard showing everything
  dashboard() {
    const { watchers, self, factions } = store.data;
    const userCount = Object.keys(watchers).filter(id => watchers[id]?.enabled !== false).length;
    const factionCount = Object.keys(factions.items).filter(id => factions.items[id]?.enabled !== false).length;
    
    const barStatus = BARS.map(b => `${EMOJI[b]} ${cap(b)}: ${self.bars[b] ? EMOJI.on : EMOJI.off}`).join('\n');
    const cdStatus = COOLDOWNS.map(c => `${EMOJI[c]} ${cap(c)}: ${self.cooldowns[c] ? EMOJI.on : EMOJI.off}`).join('\n');
    const chainStatus = `${EMOJI.chain} Chain: ${self.chain.enabled ? `${EMOJI.on} (min ${self.chain.min}, alerts at ${self.chain.thresholds.map(t => humanTime(t)).join(', ')})` : EMOJI.off}`;

    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('📊 Torn Tracker Dashboard')
      .setDescription('Your active tracking configuration')
      .addFields(
        { name: `${EMOJI.user} Users Tracked`, value: userCount ? `${userCount} active` : 'None', inline: true },
        { name: `${EMOJI.faction} Factions Tracked`, value: factionCount ? `${factionCount} active` : 'None', inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
        { name: '⚡ Bar Alerts', value: barStatus, inline: true },
        { name: '💊 Cooldown Alerts', value: cdStatus, inline: true },
        { name: '\u200b', value: chainStatus, inline: false }
      )
      .setFooter({ text: 'Use buttons below to configure • /help for commands' })
      .setTimestamp();
  },

  // User list
  userList() {
    const entries = Object.entries(store.watchers);
    if (!entries.length) {
      return new EmbedBuilder().setColor(COLORS.brand).setTitle(`${EMOJI.user} Tracked Users`).setDescription('No users tracked yet.\n\nUse `/track` to add someone!');
    }
    
    const lines = entries.map(([id, cfg]) => {
      const status = cfg.enabled === false ? EMOJI.off : EMOJI.on;
      const stateEmoji = cfg.lastState ? EMOJI[cfg.lastState] || '❓' : '❓';
      const states = cfg.states?.length ? cfg.states.map(s => EMOJI[s]).join('') : 'none';
      const pre = cfg.preTimesSec?.length ? ` • ⏰ ${cfg.preTimesSec.map(humanTime).join(', ')}` : '';
      return `${status} **${cfg.name || id}** ${stateEmoji} ${cfg.lastState || 'Unknown'}\n┗ Alerts: ${states}${pre}`;
    });

    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(`${EMOJI.user} Tracked Users (${entries.length})`)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: 'Select a user below to configure' });
  },

  // Faction list
  factionList() {
    const items = store.factions.items;
    const entries = Object.entries(items);
    if (!entries.length) {
      return new EmbedBuilder().setColor(COLORS.brand).setTitle(`${EMOJI.faction} Tracked Factions`).setDescription('No factions tracked yet.\n\nUse `/track` to add one!');
    }
    
    const lines = entries.map(([id, f]) => {
      const status = f.enabled === false ? EMOJI.off : EMOJI.on;
      const memberCount = Object.keys(f.members || {}).length;
      const states = f.states?.length ? f.states.map(s => EMOJI[s]).join('') : 'none';
      const features = [
        f.offline?.enabled !== false ? `offline>${f.offline?.hours || 24}h` : null,
        f.daily?.enabled !== false ? 'daily' : null
      ].filter(Boolean).join(', ');
      return `${status} **${f.name || `Faction ${id}`}**\n┗ ${memberCount} members • Alerts: ${states}${features ? ` • ${features}` : ''}`;
    });

    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(`${EMOJI.faction} Tracked Factions (${entries.length})`)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: 'Select a faction below to configure' });
  },

  // Personal alerts config
  alertsConfig() {
    const { self } = store.data;
    
    const barLines = BARS.map(b => {
      const on = self.bars[b];
      const last = self.bars.last[b];
      const bar = last ? progressBar(last.current || 0, last.maximum || 100, 8) : 'No data';
      return `${EMOJI[b]} **${cap(b)}**: ${on ? EMOJI.on : EMOJI.off}\n┗ ${bar}`;
    });

    const cdLines = COOLDOWNS.map(c => {
      const on = self.cooldowns[c];
      const last = self.cooldowns.last[c];
      const time = last > 0 ? humanTime(last) : 'Ready';
      return `${EMOJI[c]} **${cap(c)}**: ${on ? EMOJI.on : EMOJI.off} (${time})`;
    });

    const chain = self.chain;
    const chainLine = `${EMOJI.chain} **Chain**: ${chain.enabled ? EMOJI.on : EMOJI.off}\n┗ Min: ${chain.min} • Alerts: ${chain.thresholds.map(humanTime).join(', ')}`;

    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('🔔 Personal Alerts')
      .setDescription('Configure alerts for your own account')
      .addFields(
        { name: '⚡ Bars (alert when full)', value: barLines.join('\n'), inline: false },
        { name: '💊 Cooldowns (alert when ready)', value: cdLines.join('\n'), inline: false },
        { name: '⛓️ Chain Timer', value: chainLine, inline: false }
      )
      .setFooter({ text: 'Click buttons to toggle • Last updated' })
      .setTimestamp();
  },

  // User status card
  userStatus(userId, profile, cfg) {
    const status = profile?.status || {};
    const state = status.state || 'Okay';
    const travel = cfg?.travel;

    const emb = new EmbedBuilder()
      .setColor(COLORS[state] || COLORS.brand)
      .setAuthor({ name: `${profile?.name || cfg?.name || 'User'} [${userId}]`, url: profileUrl(userId) })
      .setTitle(`${EMOJI[state] || '❓'} ${state}`)
      .setTimestamp();

    const lines = [];
    if (status.description) lines.push(status.description);

    if (state === 'Traveling' && travel?.earliest) {
      const mid = Math.floor((travel.earliest + travel.latest) / 2);
      const dest = travel.direction === 'return' ? `Torn ← ${travel.dest}` : `→ ${travel.dest}`;
      lines.push(`**Destination:** ${dest}`, `**ETA:** ${ts(mid, 'R')} (${ts(mid, 't')})`);
    } else if (['Jail', 'Hospital'].includes(state) && status.until) {
      lines.push(`**Ends:** ${ts(Number(status.until), 'R')} (${ts(Number(status.until), 't')})`);
    }

    emb.setDescription(lines.join('\n') || 'No additional info');

    if (cfg) {
      const alerts = cfg.states?.length ? cfg.states.map(s => `${EMOJI[s]} ${s}`).join(', ') : 'None';
      const pre = cfg.preTimesSec?.length ? cfg.preTimesSec.map(humanTime).join(', ') : 'None';
      emb.addFields(
        { name: 'Alert States', value: alerts, inline: true },
        { name: 'Early Warnings', value: pre, inline: true },
        { name: 'Status', value: cfg.enabled === false ? `${EMOJI.off} Paused` : `${EMOJI.on} Active`, inline: true }
      );
    }

    return emb;
  },

  // Notification embeds
  stateChange(userId, name, oldState, newState, status, travel) {
    const lines = [];
    if (status?.description) lines.push(status.description);

    if (newState === 'Traveling' && travel?.earliest) {
      const mid = Math.floor((travel.earliest + travel.latest) / 2);
      const dest = travel.direction === 'return' ? `Torn ← ${travel.dest}` : `→ ${travel.dest}`;
      lines.push(`**Destination:** ${dest}`, `**ETA:** ${ts(mid, 'R')}`);
    } else if (['Jail', 'Hospital'].includes(newState) && status?.until) {
      lines.push(`**Ends:** ${ts(Number(status.until), 'R')}`);
    }

    return new EmbedBuilder()
      .setColor(COLORS[newState] || COLORS.brand)
      .setTitle(`${EMOJI[newState]} ${name} → ${newState}`)
      .setDescription(lines.join('\n') || null)
      .addFields({ name: 'Previous', value: `${EMOJI[oldState] || '❓'} ${oldState || 'Unknown'}`, inline: true })
      .setURL(profileUrl(userId))
      .setTimestamp();
  },

  preAlert(name, userId, state, endAt, left) {
    return new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`⏰ ${name} - ${state} ending soon!`)
      .setDescription(`**Ends:** ${ts(endAt, 'R')} (${ts(endAt, 't')})\n**Time left:** ~${humanTime(left)}`)
      .setURL(profileUrl(userId))
      .setTimestamp();
  },

  barFull(kind, bar) {
    return new EmbedBuilder()
      .setColor(COLORS.good)
      .setTitle(`${EMOJI[kind]} ${cap(kind)} is FULL!`)
      .setDescription(progressBar(bar.current, bar.maximum, 15))
      .setTimestamp();
  },

  cooldownReady(kind) {
    return new EmbedBuilder().setColor(COLORS.good).setTitle(`${EMOJI[kind]} ${cap(kind)} cooldown ready!`).setTimestamp();
  },

  chainAlert(chain, threshold) {
    const pct = Math.round((chain.timeout / 300) * 100);
    return new EmbedBuilder()
      .setColor(chain.timeout <= 30 ? COLORS.bad : COLORS.warn)
      .setTitle(`${EMOJI.chain} Chain Alert!`)
      .setDescription(`**Chain:** ${chain.current}/${chain.maximum}\n**Time left:** ${humanTime(chain.timeout)}\n${progressBar(chain.timeout, 300, 15)}`)
      .setTimestamp();
  },

  factionMemberChange(fName, uid, member, oldState, newState, travel) {
    const lines = [];
    if (newState === 'Traveling' && travel?.earliest) {
      const mid = Math.floor((travel.earliest + travel.latest) / 2);
      lines.push(`**ETA:** ${ts(mid, 'R')}`);
    } else if (['Jail', 'Hospital'].includes(newState) && member?.status?.until) {
      lines.push(`**Ends:** ${ts(Number(member.status.until), 'R')}`);
    }

    return new EmbedBuilder()
      .setColor(COLORS[newState] || COLORS.brand)
      .setTitle(`${EMOJI[newState]} ${member.name} → ${newState}`)
      .setDescription(`**Faction:** ${fName}${lines.length ? '\n' + lines.join('\n') : ''}`)
      .addFields({ name: 'Previous', value: `${EMOJI[oldState] || '❓'} ${oldState || '?'}`, inline: true })
      .setURL(profileUrl(uid))
      .setTimestamp();
  },

  factionJoinLeave(type, fName, uid, name) {
    const join = type === 'join';
    return new EmbedBuilder()
      .setColor(join ? COLORS.good : COLORS.bad)
      .setTitle(`${join ? '🟢' : '🔴'} ${name} ${join ? 'joined' : 'left'} ${fName}`)
      .setURL(profileUrl(uid))
      .setTimestamp();
  },

  factionOffline(fName, uid, name, lastTs, hours) {
    return new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`😴 ${name} offline > ${hours}h`)
      .setDescription(`**Faction:** ${fName}\n**Last seen:** ${ts(Number(lastTs), 'R')}`)
      .setURL(profileUrl(uid))
      .setTimestamp();
  },

  factionDaily(fName, delta, total) {
    const up = delta >= 0;
    return new EmbedBuilder()
      .setColor(up ? COLORS.good : COLORS.bad)
      .setTitle(`📈 ${fName} Daily Report`)
      .setDescription(`${up ? '📈' : '📉'} **${up ? '+' : ''}${delta.toLocaleString()}** respect\n**Total:** ${total.toLocaleString()}`)
      .setTimestamp();
  },

  factionMilestone(fName, respect) {
    const milestone = Math.floor(respect / 100000) * 100000;
    return new EmbedBuilder()
      .setColor(COLORS.good)
      .setTitle(`🎉 ${fName} hit ${milestone.toLocaleString()} respect!`)
      .setTimestamp();
  },

  help() {
    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('📖 Torn Tracker Help')
      .setDescription('Quick reference for all commands')
      .addFields(
        { name: '📊 /dashboard', value: 'Main control panel - see everything at a glance', inline: false },
        { name: '👤 /track user <id>', value: 'Add a user to track\n• Optional: `alerts` (states like "jail,hospital")\n• Optional: `warn` (early warnings like "5m,2m")', inline: false },
        { name: '🏴 /track faction <id>', value: 'Add a faction to track\n• Optional: `alerts`, `warn`, `offline` hours', inline: false },
        { name: '🔔 /alerts', value: 'Configure personal bar/cooldown/chain alerts', inline: false },
        { name: '👁️ /status <id>', value: 'Quick status check for any user', inline: false },
        { name: '⏱️ /delay <id> <time>', value: 'Add delay to travel ETA (e.g., "5m")', inline: false },
        { name: '🗑️ /remove <id>', value: 'Stop tracking a user or faction', inline: false }
      )
      .addFields({ name: '💡 Time Format', value: 'Use human-readable times: `5m`, `1h30m`, `90s`', inline: false })
      .setFooter({ text: 'Tip: Most configuration can be done through button menus!' });
  }
};

// ========= UI Components =========
const Components = {
  dashboardButtons() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dash:users').setLabel('Users').setEmoji('👤').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('dash:factions').setLabel('Factions').setEmoji('🏴').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('dash:alerts').setLabel('Personal Alerts').setEmoji('🔔').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('dash:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
      )
    ];
  },

  userListMenu() {
    const entries = Object.entries(store.watchers).slice(0, 25);
    if (!entries.length) return [];
    
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select:user')
          .setPlaceholder('Select a user to configure...')
          .addOptions(entries.map(([id, cfg]) => ({
            label: cfg.name || `User ${id}`,
            description: `${cfg.enabled === false ? 'Paused' : 'Active'} • ${cfg.lastState || 'Unknown'}`,
            value: id,
            emoji: cfg.enabled === false ? EMOJI.off : EMOJI.on
          })))
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dash:main').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('modal:adduser').setLabel('Add User').setEmoji('➕').setStyle(ButtonStyle.Success)
      )
    ];
  },

  factionListMenu() {
    const entries = Object.entries(store.factions.items).slice(0, 25);
    if (!entries.length) {
      return [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('dash:main').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('modal:addfaction').setLabel('Add Faction').setEmoji('➕').setStyle(ButtonStyle.Success)
        )
      ];
    }
    
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select:faction')
          .setPlaceholder('Select a faction to configure...')
          .addOptions(entries.map(([id, f]) => ({
            label: f.name || `Faction ${id}`,
            description: `${Object.keys(f.members || {}).length} members`,
            value: id,
            emoji: f.enabled === false ? EMOJI.off : EMOJI.on
          })))
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dash:main').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('modal:addfaction').setLabel('Add Faction').setEmoji('➕').setStyle(ButtonStyle.Success)
      )
    ];
  },

  alertsButtons() {
    const { self } = store.data;
    
    const barRow = new ActionRowBuilder().addComponents(
      ...BARS.map(b => new ButtonBuilder()
        .setCustomId(`toggle:bar:${b}`)
        .setLabel(cap(b))
        .setEmoji(EMOJI[b])
        .setStyle(self.bars[b] ? ButtonStyle.Success : ButtonStyle.Secondary)
      )
    );

    const cdRow = new ActionRowBuilder().addComponents(
      ...COOLDOWNS.map(c => new ButtonBuilder()
        .setCustomId(`toggle:cd:${c}`)
        .setLabel(cap(c))
        .setEmoji(EMOJI[c])
        .setStyle(self.cooldowns[c] ? ButtonStyle.Success : ButtonStyle.Secondary)
      )
    );

    const chainRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('toggle:chain')
        .setLabel('Chain Alerts')
        .setEmoji(EMOJI.chain)
        .setStyle(self.chain.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('modal:chain')
        .setLabel('Configure Chain')
        .setEmoji('⚙️')
        .setStyle(ButtonStyle.Primary)
    );

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dash:main').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('alerts:refresh').setLabel('Refresh Status').setEmoji('🔄').setStyle(ButtonStyle.Primary)
    );

    return [barRow, cdRow, chainRow, navRow];
  },

  userConfig(userId) {
    const cfg = store.watchers[userId];
    if (!cfg) return [];

    const stateRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`states:${userId}`)
        .setPlaceholder('Select alert states...')
        .setMinValues(0)
        .setMaxValues(STATES.length)
        .addOptions(STATES.map(s => ({
          label: s,
          value: s,
          emoji: EMOJI[s],
          default: cfg.states?.includes(s)
        })))
    );

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`toggle:user:${userId}`).setLabel(cfg.enabled === false ? 'Enable' : 'Pause').setStyle(cfg.enabled === false ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`modal:userwarn:${userId}`).setLabel('Early Warnings').setEmoji('⏰').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`refresh:user:${userId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`remove:user:${userId}`).setLabel('Remove').setStyle(ButtonStyle.Danger)
    );

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dash:users').setLabel('Back to List').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setURL(profileUrl(userId)).setLabel('Open in Torn').setStyle(ButtonStyle.Link)
    );

    return [stateRow, actionRow, navRow];
  },

  factionConfig(fid) {
    const f = store.factions.items[fid];
    if (!f) return [];

    const stateRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`fstates:${fid}`)
        .setPlaceholder('Select alert states...')
        .setMinValues(0)
        .setMaxValues(STATES.length)
        .addOptions(STATES.map(s => ({
          label: s,
          value: s,
          emoji: EMOJI[s],
          default: f.states?.includes(s)
        })))
    );

    const featureRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`toggle:faction:${fid}`).setLabel(f.enabled === false ? 'Enable' : 'Pause').setStyle(f.enabled === false ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`toggle:foffline:${fid}`).setLabel(`Offline (${f.offline?.hours || 24}h)`).setEmoji('😴').setStyle(f.offline?.enabled !== false ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`toggle:fdaily:${fid}`).setLabel('Daily Report').setEmoji('📈').setStyle(f.daily?.enabled !== false ? ButtonStyle.Success : ButtonStyle.Secondary)
    );

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`modal:factionwarn:${fid}`).setLabel('Early Warnings').setEmoji('⏰').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`modal:factionoffline:${fid}`).setLabel('Offline Hours').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`remove:faction:${fid}`).setLabel('Remove').setStyle(ButtonStyle.Danger)
    );

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dash:factions').setLabel('Back to List').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    );

    return [stateRow, featureRow, actionRow, navRow];
  },

  quickActions(userId, state) {
    const actions = [new ButtonBuilder().setCustomId(`refresh:user:${userId}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary)];
    
    if (state === 'Traveling') {
      actions.push(new ButtonBuilder().setCustomId(`modal:delay:${userId}`).setLabel('Add Delay').setEmoji('⏱️').setStyle(ButtonStyle.Primary));
    }
    
    actions.push(new ButtonBuilder().setURL(profileUrl(userId)).setLabel('Open in Torn').setStyle(ButtonStyle.Link));
    
    return [new ActionRowBuilder().addComponents(actions)];
  }
};

// ========= Modals =========
const Modals = {
  addUser() {
    return new ModalBuilder()
      .setCustomId('modal:adduser:submit')
      .setTitle('Add User to Track')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('user_id').setLabel('Torn User ID').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g., 12345')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('states').setLabel('Alert States (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('jail, hospital, traveling (or "all")')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('warn').setLabel('Early Warnings (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g., 5m, 2m, 30s')
        )
      );
  },

  addFaction() {
    return new ModalBuilder()
      .setCustomId('modal:addfaction:submit')
      .setTitle('Add Faction to Track')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('faction_id').setLabel('Faction ID').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g., 12345')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('states').setLabel('Alert States (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('jail, hospital, traveling (or "all")')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('offline').setLabel('Offline Alert Hours (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g., 24')
        )
      );
  },

  chainConfig() {
    const chain = store.self.chain;
    return new ModalBuilder()
      .setCustomId('modal:chain:submit')
      .setTitle('Chain Alert Settings')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('min').setLabel('Minimum Chain').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g., 10').setValue(String(chain.min || 10))
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('thresholds').setLabel('Alert Times').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g., 2m, 1m, 30s').setValue(chain.thresholds?.map(humanTime).join(', ') || '2m, 1m, 30s')
        )
      );
  },

  userWarn(userId) {
    const cfg = store.watchers[userId];
    return new ModalBuilder()
      .setCustomId(`modal:userwarn:${userId}:submit`)
      .setTitle('Early Warning Alerts')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('warn').setLabel('Alert before state ends').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g., 5m, 2m, 30s').setValue(cfg?.preTimesSec?.map(humanTime).join(', ') || '')
        )
      );
  },

  factionWarn(fid) {
    const f = store.factions.items[fid];
    return new ModalBuilder()
      .setCustomId(`modal:factionwarn:${fid}:submit`)
      .setTitle('Early Warning Alerts')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('warn').setLabel('Alert before state ends').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g., 5m, 2m, 30s').setValue(f?.preTimesSec?.map(humanTime).join(', ') || '')
        )
      );
  },

  factionOffline(fid) {
    const f = store.factions.items[fid];
    return new ModalBuilder()
      .setCustomId(`modal:factionoffline:${fid}:submit`)
      .setTitle('Offline Alert Settings')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('hours').setLabel('Hours before alert').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g., 24').setValue(String(f?.offline?.hours || 24))
        )
      );
  },

  delay(userId) {
    return new ModalBuilder()
      .setCustomId(`modal:delay:${userId}:submit`)
      .setTitle('Add Travel Delay')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('time').setLabel('Delay Time').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g., 5m, 30s, 1h')
        )
      );
  }
};

// ========= Pollers =========
class Poller {
  constructor(name) { this.name = name; this.items = []; this.index = 0; this.timer = null; this.ticking = false; }
  refresh(items) { this.items = items; if (this.index >= items.length) this.index = 0; }
  start(ms, fn) { this.stop(); if (!this.items.length) return; this.timer = setInterval(() => this.tick(fn), ms); this.tick(fn); }
  stop() { clearInterval(this.timer); this.timer = null; }
  async tick(fn) {
    if (this.ticking || !this.items.length) return;
    this.ticking = true;
    try { await fn(this.items[this.index]); this.index = (this.index + 1) % this.items.length; }
    catch (e) { console.warn(`[${this.name}]`, e?.response?.status === 429 ? 'Rate limited' : e.message); }
    finally { this.ticking = false; }
  }
}

const userPoller = new Poller('users');
const factionPoller = new Poller('factions');

// Session key for pre-alerts
const sessionKey = (state, status, travel) => {
  if (state === 'Traveling' && travel?.startedAt) return `T:${travel.direction}:${travel.startedAt}`;
  if (['Jail', 'Hospital'].includes(state) && status?.until) return `${state[0]}:${status.until}`;
  return null;
};

// Check and fire pre-alerts
const checkPreAlerts = async (id, name, state, status, travel, preTimesSec, preFired, onFire) => {
  if (!preTimesSec?.length) return;
  
  const endAt = state === 'Traveling' ? travel?.earliest : ['Jail', 'Hospital'].includes(state) ? Number(status?.until) : null;
  if (!endAt) return;
  
  const left = endAt - Math.floor(Date.now() / 1000);
  if (left <= 0) return;
  
  const key = sessionKey(state, status, travel);
  if (!key) return;
  
  preFired[key] ??= [];
  for (const t of preTimesSec) {
    if (left <= t && !preFired[key].includes(t)) {
      preFired[key].push(t);
      await onFire(name, id, state, endAt, left);
    }
  }
};

// User polling
const pollUser = async (userId) => {
  const cfg = store.watchers[userId];
  if (!cfg || cfg.enabled === false) return;

  const profile = await api.getProfile(userId);
  const status = profile?.status || {};
  const state = status.state || 'Okay';
  const prev = cfg.lastState;
  
  cfg.name = profile?.name || cfg.name;

  // Pre-alerts
  cfg.preFired ??= {};
  await checkPreAlerts(userId, cfg.name, state, status, cfg.travel, cfg.preTimesSec, cfg.preFired, 
    (name, id, st, endAt, left) => notify(Embeds.preAlert(name, id, st, endAt, left)));

  // First poll - just set baseline
  if (!prev) {
    cfg.lastState = state;
    cfg.travel = state === 'Traveling' ? createTravel(status) : null;
    store.save('baseline');
    return;
  }

  // Travel direction change
  if (state === 'Traveling' && prev === 'Traveling' && cfg.travel) {
    const newDir = parseTravelDir(status.description);
    const newDest = parseDestination(status.description);
    if (newDir !== cfg.travel.direction || newDest !== cfg.travel.dest) {
      cfg.travel = createTravel(status);
      store.save('travel-update');
      if (cfg.states?.includes('Traveling')) {
        await notify(Embeds.stateChange(userId, cfg.name, 'Traveling', 'Traveling', status, cfg.travel));
      }
    }
  }

  // State change
  if (state !== prev) {
    cfg.travel = state === 'Traveling' ? createTravel(status) : null;
    
    // Clear pre-fired for new session
    const key = sessionKey(state, status, cfg.travel);
    if (key) delete cfg.preFired[key];
    
    if (cfg.states?.includes(state)) {
      await notify(Embeds.stateChange(userId, cfg.name, prev, state, status, cfg.travel), Components.quickActions(userId, state));
    }
    
    cfg.lastState = state;
    store.save('state-change');
  }
};

// Faction polling
const pollFaction = async (fid) => {
  const fconf = store.factions.items[fid];
  if (!fconf || fconf.enabled === false) return;

  const data = await api.getFaction(fid);
  const fName = data.name || `Faction ${fid}`;
  Object.assign(fconf, { name: data.name, tag: data.tag });

  // Respect milestone
  const curRespect = Number(data.respect || 0);
  const prevStep = fconf.lastRespectStep ?? Math.floor((fconf.lastRespect || 0) / 100000);
  const stepNow = Math.floor(curRespect / 100000);
  if (stepNow > prevStep) await notify(Embeds.factionMilestone(fName, curRespect));
  Object.assign(fconf, { lastRespect: curRespect, lastRespectStep: stepNow });

  const prevMap = fconf.members ??= {};
  const newMap = data.members || {};
  const watchStates = new Set(fconf.states || []);
  const offlineThresh = (fconf.offline?.hours || CONFIG.defaults.offlineHours) * 3600;
  const nowSec = Math.floor(Date.now() / 1000);

  // Joins/Leaves
  for (const uid of Object.keys(newMap)) {
    if (!prevMap[uid]) {
      await notify(Embeds.factionJoinLeave('join', fName, uid, newMap[uid].name));
      prevMap[uid] = { name: newMap[uid].name, lastState: newMap[uid].status?.state, preFired: {} };
    }
  }
  for (const uid of Object.keys(prevMap)) {
    if (!newMap[uid]) {
      await notify(Embeds.factionJoinLeave('leave', fName, uid, prevMap[uid].name || uid));
      delete prevMap[uid];
    }
  }

  // Member updates
  for (const [uid, m] of Object.entries(newMap)) {
    const cached = prevMap[uid] ??= { name: m.name, lastState: null, preFired: {} };
    const curState = m.status?.state || 'Okay';
    const tsLast = Number(m.last_action?.timestamp || 0);

    // Travel
    if (curState === 'Traveling') {
      const newDir = parseTravelDir(m.status?.description), newDest = parseDestination(m.status?.description);
      if (!cached.travel || newDir !== cached.travel.direction || newDest !== cached.travel.dest) {
        cached.travel = createTravel(m.status);
      }
    } else {
      cached.travel = null;
    }

    // State change
    if (cached.lastState && curState !== cached.lastState && watchStates.has(curState)) {
      await notify(Embeds.factionMemberChange(fName, uid, m, cached.lastState, curState, cached.travel));
    }

    // Offline
    if (fconf.offline?.enabled !== false && tsLast > 0 && (nowSec - tsLast) >= offlineThresh && !cached.offlineNotified) {
      await notify(Embeds.factionOffline(fName, uid, m.name, tsLast, fconf.offline?.hours || CONFIG.defaults.offlineHours));
      cached.offlineNotified = true;
    } else if ((nowSec - tsLast) < offlineThresh) {
      cached.offlineNotified = false;
    }

    // Pre-alerts
    cached.preFired ??= {};
    await checkPreAlerts(uid, m.name, curState, m.status, cached.travel, fconf.preTimesSec, cached.preFired,
      (name, id, st, endAt, left) => notify(Embeds.preAlert(`${name} (${fName})`, id, st, endAt, left)));

    Object.assign(cached, { name: m.name, lastState: curState, lastActionTs: tsLast || cached.lastActionTs });
  }

  store.save('faction-poll');
};

// Self pollers (bars, cooldowns, chain)
let barsTimer = null, cooldownTimer = null, chainTimer = null;

const pollBars = async () => {
  try {
    const data = await api.getBars();
    const { self } = store.data;

    for (const b of BARS) {
      if (!self.bars[b]) continue;
      const bar = data[b];
      const isFull = bar?.current >= bar?.maximum;
      if (isFull && !self.bars.wasFull[b]) {
        await notify(Embeds.barFull(b, bar));
      }
      self.bars.wasFull[b] = isFull;
      self.bars.last[b] = bar;
    }

    if (data.chain) self.chain.last = { ...data.chain, updatedAt: Date.now() };
    store.save('bars');
  } catch (e) { console.warn('[bars]', e.message); }
};

const pollChain = async () => {
  try {
    const data = await api.getBars();
    const chain = data.chain;
    if (!chain) return;

    const { self } = store.data;
    const prev = self.chain.last?.current ?? 0;
    const cur = chain.current ?? 0;

    if (cur < prev || (prev === 0 && cur > 0)) {
      self.chain.epochId = (self.chain.epochId || 0) + 1;
      self.chain.fired[self.chain.epochId] = [];
    }

    self.chain.last = { ...chain, updatedAt: Date.now() };

    if (!self.chain.enabled || cur < (self.chain.min || 10)) return;

    const fired = self.chain.fired[self.chain.epochId] ||= [];
    for (const t of (self.chain.thresholds || [120, 60, 30]).sort((a, b) => b - a)) {
      if (!fired.includes(t) && chain.timeout <= t && chain.timeout >= 0) {
        fired.push(t);
        await notify(Embeds.chainAlert(chain, t));
      }
    }
    store.save('chain');
  } catch (e) { console.warn('[chain]', e.message); }
};

const pollCooldowns = async () => {
  try {
    const cds = await api.getCooldowns();
    const { self } = store.data;
    let soonest = Infinity;

    for (const c of COOLDOWNS) {
      if (!self.cooldowns[c]) continue;
      const prev = self.cooldowns.last[c], val = cds[c] ?? 0;
      self.cooldowns.last[c] = val;
      if (prev > 0 && val <= 0) await notify(Embeds.cooldownReady(c));
      if (val > 0) soonest = Math.min(soonest, val);
    }

    store.save('cooldowns');
    scheduleCooldown(soonest < Infinity ? (soonest + 2) * 1000 : 30 * 60 * 1000);
  } catch (e) {
    console.warn('[cooldowns]', e.message);
    scheduleCooldown(5 * 60 * 1000);
  }
};

const scheduleCooldown = ms => {
  clearTimeout(cooldownTimer);
  if (COOLDOWNS.some(c => store.self.cooldowns[c])) {
    cooldownTimer = setTimeout(pollCooldowns, Math.max(2000, ms));
  }
};

const startPollers = () => {
  // Users
  const userIds = Object.keys(store.watchers).filter(id => store.watchers[id]?.enabled !== false);
  userPoller.refresh(userIds);
  userPoller.start(store.requestMs, pollUser);

  // Factions  
  const factionIds = Object.keys(store.factions.items).filter(id => store.factions.items[id]?.enabled !== false);
  factionPoller.refresh(factionIds);
  factionPoller.start(store.factions.requestMs, pollFaction);

  // Self
  clearInterval(barsTimer);
  clearInterval(chainTimer);
  if (BARS.some(b => store.self.bars[b]) || store.self.chain.enabled) {
    barsTimer = setInterval(pollBars, 60000);
    pollBars();
  }
  if (store.self.chain.enabled) {
    chainTimer = setInterval(pollChain, 10000);
  }
  if (COOLDOWNS.some(c => store.self.cooldowns[c])) pollCooldowns();
};

// Daily digest
let dailyTimer = null;
const scheduleDailyDigest = () => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5));
  clearTimeout(dailyTimer);
  dailyTimer = setTimeout(runDailyDigest, next - now);
};

const runDailyDigest = async () => {
  for (const [fid, f] of Object.entries(store.factions.items)) {
    if (f.enabled === false || f.daily?.enabled === false) continue;
    try {
      const data = await api.getFaction(fid);
      const cur = Number(data.respect || 0);
      f.daily ??= {};
      if (f.daily.respectAtMidnight != null) {
        await notify(Embeds.factionDaily(data.name || fid, cur - f.daily.respectAtMidnight, cur));
      }
      f.daily.respectAtMidnight = cur;
      store.save('daily');
      await sleep(900);
    } catch {}
  }
  scheduleDailyDigest();
};

// ========= Discord Client =========
client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

// Express
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.listen(CONFIG.port, () => console.log(`[web] :${CONFIG.port}`));

// Commands - simplified, UX-focused
const commands = [
  new SlashCommandBuilder().setName('dashboard').setDescription('📊 Open the main control panel'),
  new SlashCommandBuilder().setName('help').setDescription('📖 Show help and commands'),
  new SlashCommandBuilder().setName('track')
    .setDescription('👁️ Start tracking a user or faction')
    .addSubcommand(sc => sc.setName('user').setDescription('Track a Torn user')
      .addIntegerOption(o => o.setName('id').setDescription('Torn user ID').setRequired(true))
      .addStringOption(o => o.setName('alerts').setDescription('States to alert (e.g., "jail, hospital" or "all")'))
      .addStringOption(o => o.setName('warn').setDescription('Early warnings (e.g., "5m, 2m")')))
    .addSubcommand(sc => sc.setName('faction').setDescription('Track a faction')
      .addIntegerOption(o => o.setName('id').setDescription('Faction ID').setRequired(true))
      .addStringOption(o => o.setName('alerts').setDescription('States to alert'))
      .addStringOption(o => o.setName('warn').setDescription('Early warnings'))
      .addIntegerOption(o => o.setName('offline').setDescription('Offline alert hours'))),
  new SlashCommandBuilder().setName('status').setDescription('👁️ Check current status')
    .addIntegerOption(o => o.setName('id').setDescription('User or faction ID').setRequired(true)),
  new SlashCommandBuilder().setName('remove').setDescription('🗑️ Stop tracking')
    .addIntegerOption(o => o.setName('id').setDescription('User or faction ID').setRequired(true)),
  new SlashCommandBuilder().setName('alerts').setDescription('🔔 Configure personal alerts'),
  new SlashCommandBuilder().setName('delay').setDescription('⏱️ Add delay to travel ETA')
    .addIntegerOption(o => o.setName('id').setDescription('User ID').setRequired(true))
    .addStringOption(o => o.setName('time').setDescription('Delay time (e.g., "5m")').setRequired(true)),
].map(c => c.toJSON());

// Interaction handler
client.on('interactionCreate', async (i) => {
  if (i.user.id !== CONFIG.discord.ownerId) {
    return i.reply?.({ content: '🔒 Owner only', ephemeral: true }).catch(() => {});
  }

  const eph = i.inGuild();

  try {
    // Modal submissions
    if (i.isModalSubmit()) {
      const [, type, id] = i.customId.split(':');
      await i.deferUpdate().catch(() => i.deferReply({ ephemeral: eph }));

      if (type === 'adduser') {
        const userId = i.fields.getTextInputValue('user_id').trim();
        const states = parseStates(i.fields.getTextInputValue('states') || 'all');
        const warn = parseTimes(i.fields.getTextInputValue('warn'));
        
        if (store.watchers[userId]) return i.editReply({ content: '⚠️ Already tracking this user' });
        
        let profile;
        try { profile = await api.getProfile(userId); } catch { return i.editReply({ content: '❌ User not found' }); }
        
        store.watchers[userId] = {
          name: profile.name, states, preTimesSec: warn.length ? warn : undefined,
          enabled: true, lastState: profile.status?.state || 'Okay', preFired: {},
          travel: profile.status?.state === 'Traveling' ? createTravel(profile.status) : null
        };
        store.save('add-user');
        startPollers();
        
        return i.editReply({ content: `✅ Now tracking **${profile.name}**`, embeds: [Embeds.userStatus(userId, profile, store.watchers[userId])], components: Components.userConfig(userId) });
      }

      if (type === 'addfaction') {
        const fid = i.fields.getTextInputValue('faction_id').trim();
        const states = parseStates(i.fields.getTextInputValue('states') || 'all');
        const offline = parseInt(i.fields.getTextInputValue('offline')) || CONFIG.defaults.offlineHours;
        
        if (store.factions.items[fid]) return i.editReply({ content: '⚠️ Already tracking this faction' });
        
        let data;
        try { data = await api.getFaction(fid); } catch { return i.editReply({ content: '❌ Faction not found' }); }
        
        store.factions.items[fid] = {
          id: fid, name: data.name, tag: data.tag, enabled: true,
          states, members: {}, offline: { enabled: true, hours: offline }, daily: { enabled: true }
        };
        store.save('add-faction');
        startPollers();
        
        return i.editReply({ content: `✅ Now tracking **${data.name}** (${Object.keys(data.members || {}).length} members)`, components: Components.factionConfig(fid) });
      }

      if (type === 'chain') {
        const min = parseInt(i.fields.getTextInputValue('min')) || 10;
        const thresholds = parseTimes(i.fields.getTextInputValue('thresholds'));
        store.self.chain.min = min;
        if (thresholds.length) store.self.chain.thresholds = thresholds;
        store.save('chain-config');
        return i.editReply({ embeds: [Embeds.alertsConfig()], components: Components.alertsButtons() });
      }

      if (type === 'userwarn' && id) {
        const warn = parseTimes(i.fields.getTextInputValue('warn'));
        const cfg = store.watchers[id];
        if (cfg) {
          cfg.preTimesSec = warn.length ? warn : undefined;
          store.save('user-warn');
        }
        const profile = await api.getProfile(id).catch(() => null);
        return i.editReply({ embeds: [Embeds.userStatus(id, profile, cfg)], components: Components.userConfig(id) });
      }

      if (type === 'factionwarn' && id) {
        const warn = parseTimes(i.fields.getTextInputValue('warn'));
        const f = store.factions.items[id];
        if (f) {
          f.preTimesSec = warn.length ? warn : undefined;
          store.save('faction-warn');
        }
        return i.editReply({ embeds: [Embeds.factionList()], components: Components.factionConfig(id) });
      }

      if (type === 'factionoffline' && id) {
        const hours = parseInt(i.fields.getTextInputValue('hours')) || CONFIG.defaults.offlineHours;
        const f = store.factions.items[id];
        if (f) {
          f.offline ??= {};
          f.offline.hours = hours;
          store.save('faction-offline');
        }
        return i.editReply({ components: Components.factionConfig(id) });
      }

      if (type === 'delay' && id) {
        const time = parseTime(i.fields.getTextInputValue('time')) || 0;
        const cfg = store.watchers[id];
        if (cfg?.travel) {
          cfg.travel.earliest = (cfg.travel.earliest || 0) + time;
          cfg.travel.latest = (cfg.travel.latest || 0) + time;
          store.save('delay');
        }
        const profile = await api.getProfile(id).catch(() => null);
        return i.editReply({ content: `✅ Added ${humanTime(time)} delay`, embeds: [Embeds.userStatus(id, profile, cfg)] });
      }

      return;
    }

    // Buttons
    if (i.isButton()) {
      const [action, type, id] = i.customId.split(':');

      if (action === 'dash') {
        await i.deferUpdate();
        if (type === 'main' || type === 'refresh') return i.editReply({ embeds: [Embeds.dashboard()], components: Components.dashboardButtons() });
        if (type === 'users') return i.editReply({ embeds: [Embeds.userList()], components: Components.userListMenu() });
        if (type === 'factions') return i.editReply({ embeds: [Embeds.factionList()], components: Components.factionListMenu() });
        if (type === 'alerts') return i.editReply({ embeds: [Embeds.alertsConfig()], components: Components.alertsButtons() });
      }

      if (action === 'modal') {
        if (type === 'adduser') return i.showModal(Modals.addUser());
        if (type === 'addfaction') return i.showModal(Modals.addFaction());
        if (type === 'chain') return i.showModal(Modals.chainConfig());
        if (type === 'userwarn') return i.showModal(Modals.userWarn(id));
        if (type === 'factionwarn') return i.showModal(Modals.factionWarn(id));
        if (type === 'factionoffline') return i.showModal(Modals.factionOffline(id));
        if (type === 'delay') return i.showModal(Modals.delay(id));
      }

      if (action === 'toggle') {
        await i.deferUpdate();
        
        if (type === 'bar') {
          store.self.bars[id] = !store.self.bars[id];
          store.save('toggle-bar');
          startPollers();
          return i.editReply({ embeds: [Embeds.alertsConfig()], components: Components.alertsButtons() });
        }
        
        if (type === 'cd') {
          store.self.cooldowns[id] = !store.self.cooldowns[id];
          store.save('toggle-cd');
          startPollers();
          return i.editReply({ embeds: [Embeds.alertsConfig()], components: Components.alertsButtons() });
        }
        
        if (type === 'chain') {
          store.self.chain.enabled = !store.self.chain.enabled;
          store.save('toggle-chain');
          startPollers();
          return i.editReply({ embeds: [Embeds.alertsConfig()], components: Components.alertsButtons() });
        }
        
        if (type === 'user') {
          const cfg = store.watchers[id];
          if (cfg) cfg.enabled = cfg.enabled === false;
          store.save('toggle-user');
          startPollers();
          const profile = await api.getProfile(id).catch(() => null);
          return i.editReply({ embeds: [Embeds.userStatus(id, profile, cfg)], components: Components.userConfig(id) });
        }
        
        if (type === 'faction') {
          const f = store.factions.items[id];
          if (f) f.enabled = f.enabled === false;
          store.save('toggle-faction');
          startPollers();
          return i.editReply({ components: Components.factionConfig(id) });
        }
        
        if (type === 'foffline') {
          const f = store.factions.items[id];
          if (f) { f.offline ??= {}; f.offline.enabled = f.offline.enabled === false; }
          store.save('toggle-foffline');
          return i.editReply({ components: Components.factionConfig(id) });
        }
        
        if (type === 'fdaily') {
          const f = store.factions.items[id];
          if (f) { f.daily ??= {}; f.daily.enabled = f.daily.enabled === false; }
          store.save('toggle-fdaily');
          return i.editReply({ components: Components.factionConfig(id) });
        }
      }

      if (action === 'remove') {
        await i.deferUpdate();
        if (type === 'user') {
          delete store.watchers[id];
          store.save('remove-user');
          startPollers();
          return i.editReply({ content: '✅ User removed', embeds: [Embeds.userList()], components: Components.userListMenu() });
        }
        if (type === 'faction') {
          delete store.factions.items[id];
          store.save('remove-faction');
          startPollers();
          return i.editReply({ content: '✅ Faction removed', embeds: [Embeds.factionList()], components: Components.factionListMenu() });
        }
      }

      if (action === 'refresh') {
        await i.deferUpdate();
        if (type === 'user') {
          const cfg = store.watchers[id];
          const profile = await api.getProfile(id).catch(() => null);
          if (profile) {
            cfg.name = profile.name;
            cfg.lastState = profile.status?.state;
            if (profile.status?.state === 'Traveling') cfg.travel = createTravel(profile.status);
            store.save('refresh');
          }
          return i.editReply({ embeds: [Embeds.userStatus(id, profile, cfg)], components: Components.userConfig(id) });
        }
      }

      if (action === 'alerts' && type === 'refresh') {
        await i.deferUpdate();
        await pollBars().catch(() => {});
        await pollCooldowns().catch(() => {});
        return i.editReply({ embeds: [Embeds.alertsConfig()], components: Components.alertsButtons() });
      }

      return;
    }

    // Select menus
    if (i.isStringSelectMenu()) {
      await i.deferUpdate();
      const [type, id] = i.customId.split(':');

      if (type === 'select') {
        if (id === 'user') {
          const userId = i.values[0];
          const cfg = store.watchers[userId];
          const profile = await api.getProfile(userId).catch(() => null);
          return i.editReply({ embeds: [Embeds.userStatus(userId, profile, cfg)], components: Components.userConfig(userId) });
        }
        if (id === 'faction') {
          const fid = i.values[0];
          return i.editReply({ components: Components.factionConfig(fid) });
        }
      }

      if (type === 'states') {
        const cfg = store.watchers[id];
        if (cfg) cfg.states = i.values;
        store.save('states');
        const profile = await api.getProfile(id).catch(() => null);
        return i.editReply({ embeds: [Embeds.userStatus(id, profile, cfg)], components: Components.userConfig(id) });
      }

      if (type === 'fstates') {
        const f = store.factions.items[id];
        if (f) f.states = i.values;
        store.save('fstates');
        return i.editReply({ components: Components.factionConfig(id) });
      }

      return;
    }

    // Slash commands
    if (!i.isChatInputCommand()) return;
    await i.deferReply({ ephemeral: eph });

    if (i.commandName === 'dashboard') {
      return i.editReply({ embeds: [Embeds.dashboard()], components: Components.dashboardButtons() });
    }

    if (i.commandName === 'help') {
      return i.editReply({ embeds: [Embeds.help()] });
    }

    if (i.commandName === 'alerts') {
      return i.editReply({ embeds: [Embeds.alertsConfig()], components: Components.alertsButtons() });
    }

    if (i.commandName === 'track') {
      const sub = i.options.getSubcommand();
      
      if (sub === 'user') {
        const userId = String(i.options.getInteger('id'));
        const states = parseStates(i.options.getString('alerts'));
        const warn = parseTimes(i.options.getString('warn'));
        
        if (store.watchers[userId]) return i.editReply({ content: '⚠️ Already tracking this user' });
        
        let profile;
        try { profile = await api.getProfile(userId); } catch { return i.editReply({ content: '❌ User not found' }); }
        
        store.watchers[userId] = {
          name: profile.name, states, preTimesSec: warn.length ? warn : undefined,
          enabled: true, lastState: profile.status?.state || 'Okay', preFired: {},
          travel: profile.status?.state === 'Traveling' ? createTravel(profile.status) : null
        };
        store.save('add');
        startPollers();
        
        return i.editReply({ embeds: [Embeds.userStatus(userId, profile, store.watchers[userId])], components: Components.userConfig(userId) });
      }
      
      if (sub === 'faction') {
        const fid = String(i.options.getInteger('id'));
        const states = parseStates(i.options.getString('alerts'));
        const warn = parseTimes(i.options.getString('warn'));
        const offline = i.options.getInteger('offline') || CONFIG.defaults.offlineHours;
        
        if (store.factions.items[fid]) return i.editReply({ content: '⚠️ Already tracking this faction' });
        
        let data;
        try { data = await api.getFaction(fid); } catch { return i.editReply({ content: '❌ Faction not found' }); }
        
        store.factions.items[fid] = {
          id: fid, name: data.name, enabled: true, states,
          preTimesSec: warn.length ? warn : undefined,
          members: {}, offline: { enabled: true, hours: offline }, daily: { enabled: true }
        };
        store.save('add-faction');
        startPollers();
        
        return i.editReply({ content: `✅ Tracking **${data.name}**`, components: Components.factionConfig(fid) });
      }
    }

    if (i.commandName === 'status') {
      const id = String(i.options.getInteger('id'));
      
      // Try user first
      try {
        const profile = await api.getProfile(id);
        const cfg = store.watchers[id];
        return i.editReply({ embeds: [Embeds.userStatus(id, profile, cfg)], components: cfg ? Components.userConfig(id) : Components.quickActions(id, profile.status?.state) });
      } catch {}
      
      // Try faction
      try {
        const data = await api.getFaction(id);
        const f = store.factions.items[id];
        const memberCount = Object.keys(data.members || {}).length;
        const emb = new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle(`${EMOJI.faction} ${data.name}`)
          .addFields(
            { name: 'Members', value: String(memberCount), inline: true },
            { name: 'Respect', value: Number(data.respect || 0).toLocaleString(), inline: true },
            { name: 'Tracking', value: f ? (f.enabled === false ? `${EMOJI.off} Paused` : `${EMOJI.on} Active`) : 'Not tracked', inline: true }
          );
        return i.editReply({ embeds: [emb], components: f ? Components.factionConfig(id) : [] });
      } catch {}
      
      return i.editReply({ content: '❌ Not found' });
    }

    if (i.commandName === 'remove') {
      const id = String(i.options.getInteger('id'));
      
      if (store.watchers[id]) {
        delete store.watchers[id];
        store.save('remove');
        startPollers();
        return i.editReply({ content: '✅ User removed' });
      }
      
      if (store.factions.items[id]) {
        delete store.factions.items[id];
        store.save('remove');
        startPollers();
        return i.editReply({ content: '✅ Faction removed' });
      }
      
      return i.editReply({ content: '❌ Not found' });
    }

    if (i.commandName === 'delay') {
      const id = String(i.options.getInteger('id'));
      const time = parseTime(i.options.getString('time')) || 0;
      
      const cfg = store.watchers[id];
      if (!cfg?.travel) return i.editReply({ content: '❌ User not traveling' });
      
      cfg.travel.earliest = (cfg.travel.earliest || 0) + time;
      cfg.travel.latest = (cfg.travel.latest || 0) + time;
      store.save('delay');
      
      const profile = await api.getProfile(id).catch(() => null);
      return i.editReply({ content: `✅ Added ${humanTime(time)} delay`, embeds: [Embeds.userStatus(id, profile, cfg)] });
    }

  } catch (e) {
    console.error('[interaction]', e);
    const msg = `❌ ${e.message}`;
    (i.deferred || i.replied ? i.editReply(msg) : i.reply({ content: msg, ephemeral: true })).catch(() => {});
  }
});

// ========= Startup =========
store.load();

// Seed from env
if (!Object.keys(store.watchers).length && CONFIG.torn.userIds) {
  CONFIG.torn.userIds.split(',').filter(Boolean).forEach(id => {
    store.watchers[id.trim()] = { states: [...STATES], enabled: true, lastState: null, name: `User ${id}`, preFired: {} };
  });
  store.save('seed');
}

if (!Object.keys(store.factions.items).length && CONFIG.torn.factionIds) {
  CONFIG.torn.factionIds.split(',').filter(Boolean).forEach(id => {
    store.factions.items[id.trim()] = {
      id: id.trim(), enabled: true, states: [...STATES], members: {},
      offline: { enabled: true, hours: CONFIG.defaults.offlineHours }, daily: { enabled: true }
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
  } catch (e) { console.warn('[cmd]', e.message); }

  // Prime baselines
  for (const [id, cfg] of Object.entries(store.watchers)) {
    if (!cfg.lastState) {
      try {
        const p = await api.getProfile(id);
        cfg.name = p.name;
        cfg.lastState = p.status?.state || 'Okay';
        if (p.status?.state === 'Traveling') cfg.travel = createTravel(p.status);
        await sleep(500);
      } catch {}
    }
  }
  store.save('primed');

  startPollers();
  scheduleDailyDigest();
  
  console.log(`[ready] ${Object.keys(store.watchers).length} users, ${Object.keys(store.factions.items).length} factions`);
});

client.login(CONFIG.discord.token);

['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { store.save('exit'); setTimeout(() => process.exit(0), 300); }));