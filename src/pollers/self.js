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
// RACING POLLING — Smart XP Race Finder
//
// Criteria for a qualifying race:
//   • track_id === 10  (Docks)
//   • laps === 100
//   • participants.maximum === 100
//   • participants.current >= 50
//   • status === 'open'
//   • starts within 30 minutes
//   • no password, no join fee, no car class, no stock car required
//
// Gate conditions (when to send a reminder):
//   • racing reminders are enabled
//   • local server hour is between 23:00 and 02:59 (11pm–3am)
//   • at least 15 minutes since the last reminder was sent
// ═══════════════════════════════════════════════════════════════

// Track which race IDs we've already alerted for (reset on restart — that's fine)
const _notifiedRaceIds = new Set();

/**
 * Returns true if current local hour is in the 11pm–3am window.
 */
function _isActiveHour() {
  const h = new Date().getHours();
  return h >= 23 || h < 3;
}

/**
 * Returns true if the 15-minute cooldown since the last reminder has passed.
 */
function _isCooldownOver(racing) {
  if (!racing.lastNotify) return true;
  return (Math.floor(Date.now() / 1000) - racing.lastNotify) >= 15 * 60;
}

/**
 * Check whether a race from the API matches all XP race criteria.
 */
function _qualifies(race) {
  const now = Math.floor(Date.now() / 1000);
  const minutesToStart = (race.schedule.start - now) / 60;
  const req = race.requirements;

  return (
    race.track_id === 10 &&
    race.laps === 100 &&
    race.participants.maximum === 100 &&
    race.participants.current >= 50 &&
    race.status === 'open' &&
    minutesToStart > 0 &&
    minutesToStart <= 30 &&
    req.requires_password === false &&
    req.join_fee === 0 &&
    req.car_class === null &&
    req.requires_stock_car === false
  );
}

async function pollRacing() {
  const { self } = store.data;

  if (!self.racing.enabled) return;

  // ── Gate: time window (11pm–3am local) ──
  if (!_isActiveHour()) return;

  // ── Gate: 15-minute cooldown between reminders ──
  if (!_isCooldownOver(self.racing)) return;

  try {
    const races = await api.getCustomRaces();

    // Filter to qualifying races that haven't been notified yet
    const qualifying = races
      .filter(r => _qualifies(r) && !_notifiedRaceIds.has(r.id))
      .sort((a, b) => b.participants.current - a.participants.current); // most-full first

    if (qualifying.length === 0) return;

    const best = qualifying[0];

    await notify(Embeds.racingXpAlert(best));

    // Update state
    self.racing.lastNotify = Math.floor(Date.now() / 1000);
    _notifiedRaceIds.add(best.id);

    // Keep the set from growing unboundedly across a long session
    if (_notifiedRaceIds.size > 200) {
      const oldest = [..._notifiedRaceIds].slice(0, 100);
      oldest.forEach(id => _notifiedRaceIds.delete(id));
    }

    store.save('racing');
    console.log(`[racing] XP race alert sent — race #${best.id} (${best.participants.current} players)`);

  } catch (error) {
    console.warn('[racing]', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// ENERGY REFILL REMINDER
// ═══════════════════════════════════════════════════════════════

const REFILL_ALERT_TIMES = [
  { h: 22, m: 0  },
  { h: 23, m: 0  },
  { h: 23, m: 15 },
  { h: 23, m: 30 },
  { h: 23, m: 45 },
  { h: 23, m: 50 },
  { h: 23, m: 55 },
];

let refillTimer = null;

function cancelRefillReminder() {
  if (refillTimer) {
    clearTimeout(refillTimer);
    refillTimer = null;
  }
}

function scheduleRefillReminder() {
  cancelRefillReminder();

  const refill = store.self.refill || {};
  const anyEnabled = refill.energy || refill.nerve || refill.token;
  if (!anyEnabled) return;

  const now = new Date();

  const candidates = REFILL_ALERT_TIMES
    .map(({ h, m }) => new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0
    )))
    .filter(t => t > now);

  let next;
  if (candidates.length) {
    next = candidates[0];
  } else {
    const first = REFILL_ALERT_TIMES[0];
    next = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
      first.h, first.m, 0
    ));
  }

  const delay = next - now;
  refillTimer = setTimeout(runRefillCheck, delay);
  console.log(`[refill] Next check scheduled for ${next.toISOString()}`);
}

async function runRefillCheck() {
  refillTimer = null;

  const refill = store.self.refill || {};
  const anyEnabled = refill.energy || refill.nerve || refill.token;

  if (!anyEnabled) {
    scheduleRefillReminder();
    return;
  }

  console.log('[refill] Checking refill usage...');

  try {
    const data = await api.getRefills();

    const types = [
      { key: 'energy', label: 'Energy', used: data.energy },
      { key: 'nerve',  label: 'Nerve',  used: data.nerve  },
      { key: 'token',  label: 'Token',  used: data.token  },
    ];

    for (const { key, label, used } of types) {
      if (!refill[key]) continue;

      if (!used) {
        await notify(Embeds.refillReminder(key, label));
        console.log(`[refill] ${label} reminder sent`);
      } else {
        console.log(`[refill] ${label} refill already used today`);
      }
    }
  } catch (error) {
    console.warn('[refill]', error.message);
  }

  scheduleRefillReminder();
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
  
  if (hasBars || hasChain) {
    console.log('[self] Starting bars polling');
    barsTimer = setInterval(pollBars, config.timing.barsMs);
    pollBars();
  }
  
  if (hasChain) {
    console.log('[self] Starting chain polling');
    chainTimer = setInterval(pollChain, config.timing.chainMs);
  }
  
  if (hasCooldowns) {
    console.log('[self] Starting cooldowns polling');
    pollCooldowns();
  }
  
  // Racing: poll every 2 minutes
  if (hasRacing) {
    console.log('[self] Starting racing polling (XP race finder, every 2min)');
    racingTimer = setInterval(pollRacing, 2 * 60 * 1000);
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
  scheduleRefillReminder,
  cancelRefillReminder,
};