const fs = require('fs');
const path = require('path');
const config = require('../config');
const { STATES, BARS, COOLDOWNS } = require('../config/constants');

class Store {
  constructor(filePath) {
    this.path = this._resolvePath(filePath);
    this.data = this._defaultData();
    this.saveTimer = null;
    this.saveDelay = 300; // ms
  }

  _resolvePath(target) {
    try {
      const dir = path.dirname(target);
      fs.mkdirSync(dir, { recursive: true });
      
      // Test write access
      const probe = `${target}.probe`;
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      
      return target;
    } catch (e) {
      console.warn(`[store] Cannot write to ${target}, using /tmp`);
      return '/tmp/torn-tracker-store.json';
    }
  }

  _defaultData() {
    return {
      version: 2,
      requestMs: config.timing.requestMs,
      watchers: {},
      self: this._selfDefaults(),
      factions: {
        requestMs: config.timing.factionMs,
        items: {},
      },
    };
  }

  _selfDefaults() {
    return {
      bars: {
        ...Object.fromEntries(BARS.map(b => [b, false])),
        last: {},
        wasFull: {},
      },
      cooldowns: {
        ...Object.fromEntries(COOLDOWNS.map(c => [c, false])),
        last: {},
      },
      chain: {
        enabled: false,
        min: 10,
        thresholds: [120, 60, 30],
        last: {},
        epochId: 0,
        fired: {},
      },
    };
  }

  load() {
    try {
      if (!fs.existsSync(this.path)) {
        console.log('[store] No existing data, starting fresh');
        return;
      }

      const raw = fs.readFileSync(this.path, 'utf8').trim();
      if (!raw) return;

      const loaded = JSON.parse(raw);
      
      // Merge with defaults to ensure all fields exist
      this.data = {
        ...this._defaultData(),
        ...loaded,
        self: {
          ...this._selfDefaults(),
          ...loaded.self,
          bars: {
            ...this._selfDefaults().bars,
            ...loaded.self?.bars,
          },
          cooldowns: {
            ...this._selfDefaults().cooldowns,
            ...loaded.self?.cooldowns,
          },
          chain: {
            ...this._selfDefaults().chain,
            ...loaded.self?.chain,
          },
        },
        factions: {
          requestMs: config.timing.factionMs,
          items: {},
          ...loaded.factions,
        },
      };

      console.log(`[store] Loaded from ${this.path}`);
    } catch (e) {
      console.error('[store] Load failed:', e.message);
    }
  }

  save(reason = '') {
    clearTimeout(this.saveTimer);
    
    this.saveTimer = setTimeout(() => {
      try {
        const tmp = `${this.path}.tmp`;
        const json = JSON.stringify(this.data, null, 2);
        
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, this.path);
        
        if (reason) {
          console.log(`[store] Saved (${reason})`);
        }
      } catch (e) {
        console.error('[store] Save failed:', e.message);
      }
    }, this.saveDelay);
  }

  saveSync() {
    clearTimeout(this.saveTimer);
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[store] Sync save failed:', e.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────

  get watchers() {
    return this.data.watchers;
  }

  get self() {
    return this.data.self;
  }

  get factions() {
    return this.data.factions;
  }

  get requestMs() {
    return this.data.requestMs;
  }

  set requestMs(value) {
    this.data.requestMs = value;
  }

  // ─────────────────────────────────────────────────────────────
  // User Methods
  // ─────────────────────────────────────────────────────────────

  getUser(userId) {
    return this.watchers[userId];
  }

  setUser(userId, data) {
    this.watchers[userId] = data;
    this.save('user-update');
  }

  removeUser(userId) {
    delete this.watchers[userId];
    this.save('user-remove');
  }

  getActiveUsers() {
    return Object.entries(this.watchers)
      .filter(([, cfg]) => cfg?.enabled !== false)
      .map(([id]) => id);
  }

  // ─────────────────────────────────────────────────────────────
  // Faction Methods
  // ─────────────────────────────────────────────────────────────

  getFaction(factionId) {
    return this.factions.items[factionId];
  }

  setFaction(factionId, data) {
    this.factions.items[factionId] = data;
    this.save('faction-update');
  }

  removeFaction(factionId) {
    delete this.factions.items[factionId];
    this.save('faction-remove');
  }

  getActiveFactions() {
    return Object.entries(this.factions.items)
      .filter(([, f]) => f?.enabled !== false)
      .map(([id]) => id);
  }

  // ─────────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────────

  getStats() {
    const users = Object.entries(this.watchers);
    const factions = Object.entries(this.factions.items);
    
    return {
      users: {
        total: users.length,
        active: users.filter(([, c]) => c?.enabled !== false).length,
      },
      factions: {
        total: factions.length,
        active: factions.filter(([, f]) => f?.enabled !== false).length,
        members: factions.reduce(
          (sum, [, f]) => sum + Object.keys(f?.members || {}).length,
          0
        ),
      },
      alerts: {
        bars: BARS.filter(b => this.self.bars[b]).length,
        cooldowns: COOLDOWNS.filter(c => this.self.cooldowns[c]).length,
        chain: this.self.chain.enabled,
      },
    };
  }
}

// Singleton instance
const store = new Store(path.resolve(config.persist));

module.exports = store;