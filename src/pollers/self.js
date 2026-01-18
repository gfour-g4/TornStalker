const store = require('../services/store');
const api = require('../services/api');
const { notify } = require('../services/notify');
const Embeds = require('../discord/embeds');
const { BARS, COOLDOWNS } = require('../config/constants');
const config = require('../config');

let barsTimer = null;
let chainTimer = null;
let cooldownTimer = null;
let racingTimer = null;

// ═══════════════════════════════════════════════════════════════
// BAR POLLING
// ═══════════════════════════════════════════════════════════════

async function pollBars() {
  try {
    const data = await api.getBars();
    const { self } = store.data;
    
    for (const bar of BARS) {
      if (!self.bars[bar]) continue;
      
      const current = data[bar];
      if (!current) continue;
      
      const isFull = current.current >= current.maximum;
      
      // Alert if just became full
      if (isFull && !self.bars.wasFull[bar]) {
        await notify(Embeds.barFull(bar, current));
      }
      
      self.bars.wasFull[bar] = isFull;
      self.bars.last[bar] = current;
    }
    
    // Also update chain data
    if (data.chain) {
      self.chain.last = {
        ...data.chain,
        updatedAt: Date.now(),
      };
    }
    
    store.save('bars');
  } catch (error) {
    console.warn('[bars]', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// CHAIN POLLING
// ═══════════════════════════════════════════════════════════════

async function pollChain() {
  try {
    const data = await api.getBars();
    const chain = data.chain;
    
    if (!chain) return;
    
    const { self } = store.data;
    const prevCount = self.chain.last?.current ?? 0;
    const currentCount = chain.current ?? 0;
    
    // Detect new chain epoch (chain reset or started)
    if (currentCount < prevCount || (prevCount === 0 && currentCount > 0)) {
      self.chain.epochId = (self.chain.epochId || 0) + 1;
      self.chain.fired[self.chain.epochId] = [];
    }
    
    self.chain.last = {
      ...chain,
      updatedAt: Date.now(),
    };
    
    // Check if we should alert
    if (!self.chain.enabled) return;
    if (currentCount < (self.chain.min || 10)) return;
    
    const epochFired = self.chain.fired[self.chain.epochId] || [];
    self.chain.fired[self.chain.epochId] = epochFired;
    
    const thresholds = (self.chain.thresholds || [120, 60, 30]).sort((a, b) => b - a);
    
    for (const threshold of thresholds) {
      if (!epochFired.includes(threshold) && chain.timeout <= threshold && chain.timeout >= 0) {
        epochFired.push(threshold);
        await notify(Embeds.chainAlert(chain, threshold));
      }
    }
    
    store.save('chain');
  } catch (error) {
    console.warn('[chain]', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// COOLDOWN POLLING
// ═══════════════════════════════════════════════════════════════

async function pollCooldowns() {
  try {
    const cooldowns = await api.getCooldowns();
    const { self } = store.data;
    
    let soonestExpiry = Infinity;
    
    for (const cd of COOLDOWNS) {
      if (!self.cooldowns[cd]) continue;
      
      const prev = self.cooldowns.last[cd] || 0;
      const current = cooldowns[cd] ?? 0;
      
      self.cooldowns.last[cd] = current;
      
      // Alert if just became ready (was >0, now 0)
      if (prev > 0 && current <= 0) {
        await notify(Embeds.cooldownReady(cd));
      }
      
      // Track soonest expiry for smart scheduling
      if (current > 0) {
        soonestExpiry = Math.min(soonestExpiry, current);
      }
    }
    
    store.save('cooldowns');
    
    // Schedule next poll based on soonest expiry
    const nextPoll = soonestExpiry < Infinity 
      ? (soonestExpiry + 2) * 1000  // 2 second buffer
      : 30 * 60 * 1000;             // 30 minutes default
    
    scheduleCooldownPoll(nextPoll);
    
  } catch (error) {
    console.warn('[cooldowns]', error.message);
    // Retry in 5 minutes on error
    scheduleCooldownPoll(5 * 60 * 1000);
  }
}

function scheduleCooldownPoll(ms) {
  clearTimeout(cooldownTimer);
  
  const hasActiveCooldowns = COOLDOWNS.some(c => store.self.cooldowns[c]);
  if (!hasActiveCooldowns) return;
  
  cooldownTimer = setTimeout(pollCooldowns, Math.max(2000, ms));
}

// ═══════════════════════════════════════════════════════════════
// RACING POLLING
// ═══════════════════════════════════════════════════════════════

async function pollRacing() {
  const { self } = store.data;
  
  if (!self.racing.enabled) return;
  
  try {
    const log = await api.getRacingLog();
    const { racing } = store.data.self;
    
    const events = Object.values(log);
    const now = Math.floor(Date.now() / 1000);
    
    // 1. Handle no logs (New account or API error)
    // Assume not in race, but ensure we don't spam if history is empty
    if (events.length === 0) {
      if ((now - (racing.lastNotify || 0)) > 60 * 60) {
        await notify(Embeds.racingJoinReminder());
        racing.lastNotify = now;
        racing.inRace = false;
        store.save('racing');
      }
      return;
    }
    
    // 2. Sort by timestamp descending (newest first)
    events.sort((a, b) => b.timestamp - a.timestamp);
    const latest = events[0];
    
    // 3. Check status based on latest event
    // Join codes: 8711 (Custom), 8715 (Official)
    const isRacing = latest.log === 8711 || latest.log === 8715;
    
    const prevInRace = racing.inRace;
    racing.inRace = isRacing;
    racing.lastChecked = now;
    
    // 4. Notify if we need to join a race
    if (!isRacing) {
      const lastNotify = racing.lastNotify || 0;
      
      // Notify if:
      // A. We were previously marked as racing (immediate notification upon finish)
      // B. We haven't notified in over 1 hour (periodic reminder)
      if (prevInRace || (now - lastNotify) > 60 * 60) {
        await notify(Embeds.racingJoinReminder());
        racing.lastNotify = now;
        console.log(`[racing] Race finished/idle. Last event: ${latest.title} (${latest.timestamp}). Sent reminder.`);
      }
    }
    
    store.save('racing');
  } catch (error) {
    console.warn('[racing]', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// START/STOP
// ═══════════════════════════════════════════════════════════════

function startSelfPollers() {
  stopSelfPollers();
  
  const { self } = store.data;
  const hasBars = BARS.some(b => self.bars[b]);
  const hasChain = self.chain.enabled;
  const hasCooldowns = COOLDOWNS.some(c => self.cooldowns[c]);
  const hasRacing = self.racing.enabled;
  
  // Bars polling
  if (hasBars || hasChain) {
    console.log('[self] Starting bars polling');
    barsTimer = setInterval(pollBars, config.timing.barsMs);
    pollBars();
  }
  
  // Chain polling (more frequent)
  if (hasChain) {
    console.log('[self] Starting chain polling');
    chainTimer = setInterval(pollChain, config.timing.chainMs);
  }
  
  // Cooldowns polling (smart scheduling)
  if (hasCooldowns) {
    console.log('[self] Starting cooldowns polling');
    pollCooldowns();
  }
  
  // Racing polling (check every 5 minutes)
  if (hasRacing) {
    console.log('[self] Starting racing polling');
    racingTimer = setInterval(pollRacing, 5 * 60 * 1000);
    pollRacing(); // Initial check
  }
}

function stopSelfPollers() {
  clearInterval(barsTimer);
  clearInterval(chainTimer);
  clearTimeout(cooldownTimer);
  clearInterval(racingTimer);
  
  barsTimer = null;
  chainTimer = null;
  cooldownTimer = null;
  racingTimer = null;
}

module.exports = {
  pollBars,
  pollChain,
  pollCooldowns,
  pollRacing,
  startSelfPollers,
  stopSelfPollers,
};