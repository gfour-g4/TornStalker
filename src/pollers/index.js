const config = require('../config');
const store = require('../services/store');
const { pollUser } = require('./user');
const { pollFaction } = require('./faction');
const { startSelfPollers, stopSelfPollers, scheduleRefillReminder, cancelRefillReminder } = require('./self');

// ═══════════════════════════════════════════════════════════════
// POLLER CLASS
// ═══════════════════════════════════════════════════════════════

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
    if (this.index >= items.length) {
      this.index = 0;
    }
  }
  
  start(intervalMs, pollFn) {
    this.stop();
    
    if (!this.items.length) {
      console.log(`[${this.name}] No items to poll`);
      return;
    }
    
    console.log(`[${this.name}] Starting with ${this.items.length} items @ ${intervalMs}ms`);
    
    this.timer = setInterval(() => this.tick(pollFn), intervalMs);
    this.tick(pollFn); // Immediate first tick
  }
  
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  
  async tick(pollFn) {
    if (this.ticking || !this.items.length) return;
    
    this.ticking = true;
    const item = this.items[this.index];
    this.index = (this.index + 1) % this.items.length;
    
    try {
      await pollFn(item);
    } catch (error) {
      const msg = error?.response?.status === 429 
        ? 'Rate limited' 
        : error.message;
      console.warn(`[${this.name}] ${item}: ${msg}`);
    } finally {
      this.ticking = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// POLLER INSTANCES
// ═══════════════════════════════════════════════════════════════

const userPoller = new Poller('users');
const factionPoller = new Poller('factions');

// ═══════════════════════════════════════════════════════════════
// START/STOP ALL POLLERS
// ═══════════════════════════════════════════════════════════════

function startPollers() {
  // User polling
  const userIds = store.getActiveUsers();
  userPoller.refresh(userIds);
  userPoller.start(store.requestMs, pollUser);
  
  // Faction polling
  const factionIds = store.getActiveFactions();
  factionPoller.refresh(factionIds);
  factionPoller.start(store.factions.requestMs, pollFaction);
  
  // Self polling (bars, cooldowns, chain, racing)
  startSelfPollers();
  
  // Refill reminder (reschedule in case toggle changed)
  scheduleRefillReminder();
}

function stopPollers() {
  userPoller.stop();
  factionPoller.stop();
  stopSelfPollers();
  cancelRefillReminder();
}

// ═══════════════════════════════════════════════════════════════
// DAILY DIGEST
// ═══════════════════════════════════════════════════════════════

let dailyTimer = null;

function scheduleDailyDigest() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 5 // 00:00:05 UTC
  ));
  
  const delay = next - now;
  
  clearTimeout(dailyTimer);
  dailyTimer = setTimeout(runDailyDigest, delay);
  
  console.log(`[daily] Scheduled for ${next.toISOString()}`);
}

async function runDailyDigest() {
  const api = require('../services/api');
  const { notify } = require('../services/notify');
  const Embeds = require('../discord/embeds');
  const { sleep } = require('../utils');
  
  console.log('[daily] Running digest...');
  
  for (const [fid, f] of Object.entries(store.factions.items)) {
    if (f.enabled === false || f.daily?.enabled === false) continue;
    
    try {
      const data = await api.getFaction(fid);
      const currentRespect = Number(data.respect || 0);
      
      f.daily = f.daily || {};
      
      if (f.daily.respectAtMidnight != null) {
        const delta = currentRespect - f.daily.respectAtMidnight;
        await notify(Embeds.factionDaily(data.name || fid, fid, delta, currentRespect));
      }
      
      f.daily.respectAtMidnight = currentRespect;
      store.save('daily');
      
      await sleep(1000);
    } catch (error) {
      console.warn(`[daily] ${fid}: ${error.message}`);
    }
  }
  
  // Schedule next
  scheduleDailyDigest();
}

// ═══════════════════════════════════════════════════════════════
// DAILY ADDICTION CHECK
// ═══════════════════════════════════════════════════════════════

let addictionCheckTimer = null;

function scheduleAddictionCheck() {
  const { addiction } = store.self;
  
  if (!addiction.dailyCheck?.enabled) {
    return;
  }
  
  const now = new Date();
  const hour = addiction.dailyCheck.hour ?? 18;
  const minute = addiction.dailyCheck.minute ?? 10;
  
  // Calculate next occurrence at the specified hour:minute
  let next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0
  ));
  
  // If it's already past today's check time, schedule for tomorrow
  if (next <= now) {
    next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      hour,
      minute,
      0
    ));
  }
  
  const delay = next - now;
  
  clearTimeout(addictionCheckTimer);
  addictionCheckTimer = setTimeout(runAddictionCheck, delay);
  
  console.log(`[addiction-check] Scheduled for ${next.toISOString()}`);
}

async function runAddictionCheck() {
  const api = require('../services/api');
  const { notify } = require('../services/notify');
  const Embeds = require('../discord/embeds');
  
  const { addiction } = store.self;
  
  if (!addiction.dailyCheck?.enabled) {
    return;
  }
  
  console.log('[addiction-check] Running check...');
  
  try {
    const ownerId = await api.getOwnerId();
    if (!ownerId) {
      console.warn('[addiction-check] Owner ID not set');
      scheduleAddictionCheck();
      return;
    }
    
    const employees = await api.getCompanyEmployees();
    const self = employees[String(ownerId)];
    
    if (!self) {
      console.warn('[addiction-check] Self not found in company employees');
      scheduleAddictionCheck();
      return;
    }
    
    const currentAddiction = self.effectiveness?.addiction ?? 0;
    const threshold = addiction.threshold ?? -5;
    
    if (currentAddiction <= threshold) {
      await notify(Embeds.addictionRehabAlert(currentAddiction, threshold));
      console.log(`[addiction-check] Alert sent: ${currentAddiction} <= ${threshold}`);
    }
    
  } catch (error) {
    if (error.message.includes('company')) {
      console.log('[addiction-check] Not in a company');
    } else {
      console.warn('[addiction-check]', error.message);
    }
  }
  
  // Schedule next
  scheduleAddictionCheck();
}

module.exports = {
  Poller,
  userPoller,
  factionPoller,
  startPollers,
  stopPollers,
  scheduleDailyDigest,
  scheduleAddictionCheck,
  scheduleRefillReminder,
  cancelRefillReminder,
};