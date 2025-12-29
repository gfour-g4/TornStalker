const store = require('../services/store');
const api = require('../services/api');
const { notify } = require('../services/notify');
const Embeds = require('../discord/embeds');
const Components = require('../discord/components');
const { 
  createTravelInfo, 
  parseDestination, 
  parseTravelDirection,
} = require('../utils/travel');
const { sessionKey } = require('../utils/format');

/**
 * Check and fire pre-alerts for a user
 */
async function checkPreAlerts(userId, name, state, status, travel, preTimesSec, preFired) {
  if (!preTimesSec?.length) return;
  
  // Determine end time
  let endAt = null;
  if (state === 'Traveling' && travel?.earliest) {
    endAt = travel.earliest;
  } else if (['Jail', 'Hospital'].includes(state) && status?.until) {
    endAt = Number(status.until);
  }
  
  if (!endAt) return;
  
  const nowSec = Math.floor(Date.now() / 1000);
  const left = endAt - nowSec;
  
  if (left <= 0) return;
  
  const key = sessionKey(state, status, travel);
  if (!key) return;
  
  preFired[key] = preFired[key] || [];
  
  for (const threshold of preTimesSec) {
    if (left <= threshold && !preFired[key].includes(threshold)) {
      preFired[key].push(threshold);
      await notify(Embeds.preAlert(name, userId, state, endAt, left));
    }
  }
}

/**
 * Poll a single user
 */
async function pollUser(userId) {
  const cfg = store.watchers[userId];
  if (!cfg || cfg.enabled === false) return;
  
  let profile;
  try {
    profile = await api.getProfile(userId);
  } catch (error) {
    console.warn(`[user] Skipping ${cfg.name || userId}: ${error.message}`);
    return;
  }
  
  const status = profile.status;
  const state = status.state;
  const prevState = cfg.lastState;
  
  // Update name
  cfg.name = profile.name || cfg.name;
  cfg.lastCheck = Date.now();
  
  // First poll - establish baseline
  if (!prevState) {
    cfg.lastState = state;
    cfg.travel = state === 'Traveling' ? createTravelInfo(status) : null;
    store.save('baseline');
    console.log(`[user] Baseline: ${cfg.name} = ${state}`);
    return;
  }
  
  // Same state
  if (state === prevState) {
    // Pre-alerts
    cfg.preFired = cfg.preFired || {};
    await checkPreAlerts(
      userId, 
      cfg.name, 
      state, 
      status, 
      cfg.travel, 
      cfg.preTimesSec, 
      cfg.preFired
    );
    
    // Travel direction/destination changes
    if (state === 'Traveling' && cfg.travel) {
      const newDir = parseTravelDirection(status.description);
      const newDest = parseDestination(status.description);
      
      if (newDir !== cfg.travel.direction || newDest !== cfg.travel.destination) {
        cfg.travel = createTravelInfo(status);
        store.save('travel-update');
        
        if (cfg.states?.includes('Traveling')) {
          await notify(
            Embeds.stateChange(userId, cfg.name, 'Traveling', 'Traveling', status, cfg.travel)
          );
        }
      }
    }
    
    return;
  }
  
  // STATE CHANGED
  console.log(`[user] ${cfg.name}: ${prevState} → ${state}`);
  
  const oldState = prevState;
  cfg.lastState = state;
  cfg.travel = state === 'Traveling' ? createTravelInfo(status) : null;
  
  // Reset pre-fired alerts for new session
  cfg.preFired = cfg.preFired || {};
  const key = sessionKey(state, status, cfg.travel);
  if (key) {
    delete cfg.preFired[key];
  }
  
  store.save('state-change');
  
  // Send notification if this state is tracked
  if (cfg.states?.includes(state)) {
    await notify(
      Embeds.stateChange(userId, cfg.name, oldState, state, status, cfg.travel),
      Components.quickActions(userId, state)
    );
  }
}

module.exports = {
  pollUser,
  checkPreAlerts,
};