const store = require('../services/store');
const api = require('../services/api');
const { notify } = require('../services/notify');
const Embeds = require('../discord/embeds');
const { BARS, COOLDOWNS, TRACKABLE_ICONS } = require('../config/constants');
const { pollIcons, getCooldownRemaining } = require('./icons');
const { pollCompany } = require('./company');
const config = require('../config');

let barsTimer = null;
let chainTimer = null;
let iconsTimer = null;
let companyTimer = null;

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
// START/STOP
// ═══════════════════════════════════════════════════════════════

function startSelfPollers() {
  stopSelfPollers();
  
  const { self } = store.data;
  const hasBars = BARS.some(b => self.bars[b]);
  const hasChain = self.chain.enabled;
  const hasCooldowns = COOLDOWNS.some(c => self.cooldowns[c]);
  const hasIcons = Object.keys(TRACKABLE_ICONS).some(k => self.icons[k]);
  const hasAddiction = self.addiction.enabled;
  
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
  
  // Icons polling (cooldowns + trackable icons)
  if (hasCooldowns || hasIcons) {
    console.log('[self] Starting icons polling');
    iconsTimer = setInterval(pollIcons, config.timing.iconsMs || 30000);
    pollIcons();
  }
  
  // Company polling (addiction)
  if (hasAddiction) {
    console.log('[self] Starting company polling');
    companyTimer = setInterval(pollCompany, config.timing.companyMs || 60000);
    pollCompany();
  }
}

function stopSelfPollers() {
  clearInterval(barsTimer);
  clearInterval(chainTimer);
  clearInterval(iconsTimer);
  clearInterval(companyTimer);
  
  barsTimer = null;
  chainTimer = null;
  iconsTimer = null;
  companyTimer = null;
}

module.exports = {
  pollBars,
  pollChain,
  pollIcons,
  pollCompany,
  startSelfPollers,
  stopSelfPollers,
};