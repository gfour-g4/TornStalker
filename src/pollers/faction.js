const config = require('../config');
const store = require('../services/store');
const api = require('../services/api');
const { notify } = require('../services/notify');
const Embeds = require('../discord/embeds');
const { 
  createTravelInfo, 
  parseDestination, 
  parseTravelDirection,
} = require('../utils/travel');
const { sessionKey } = require('../utils/format');
const { checkPreAlerts } = require('./user');

/**
 * Poll a single faction
 */
async function pollFaction(factionId) {
  const fconf = store.factions.items[factionId];
  if (!fconf || fconf.enabled === false) return;
  
  let data;
  try {
    data = await api.getFaction(factionId);
  } catch (error) {
    console.warn(`[faction] Skipping ${fconf.name || factionId}: ${error.message}`);
    return;
  }
  
  const fName = data.name || `Faction ${factionId}`;
  
  // Update faction info
  fconf.name = data.name;
  fconf.tag = data.tag;
  fconf.lastCheck = Date.now();
  
  // ─────────────────────────────────────────────────────────────
  // Respect Milestones
  // ─────────────────────────────────────────────────────────────
  
  const currentRespect = Number(data.respect || 0);
  const prevStep = fconf.lastRespectStep ?? Math.floor((fconf.lastRespect || 0) / 100000);
  const currentStep = Math.floor(currentRespect / 100000);
  
  if (currentStep > prevStep && prevStep > 0) {
    await notify(Embeds.factionMilestone(fName, factionId, currentRespect));
  }
  
  fconf.lastRespect = currentRespect;
  fconf.lastRespectStep = currentStep;
  
  // ─────────────────────────────────────────────────────────────
  // Member Tracking
  // ─────────────────────────────────────────────────────────────
  
  const prevMembers = fconf.members || {};
  const newMembers = data.members;
  const watchStates = new Set(fconf.states || []);
  const offlineThreshold = (fconf.offline?.hours || config.defaults.offlineHours) * 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  
  const prevIds = new Set(Object.keys(prevMembers));
  const newIds = new Set(Object.keys(newMembers));
  
  // Safety check: If >50% of members "left", likely API issue
  if (prevIds.size > 10) {
    const leftCount = [...prevIds].filter(id => !newIds.has(id)).length;
    const leftPct = leftCount / prevIds.size;
    
    if (leftPct > 0.5) {
      console.warn(
        `[faction] ${fName}: ${leftCount}/${prevIds.size} (${Math.round(leftPct * 100)}%) ` +
        `members "left" - likely API issue, skipping`
      );
      return;
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // Member Joins
  // ─────────────────────────────────────────────────────────────
  
  for (const uid of newIds) {
    if (!prevIds.has(uid)) {
      const member = newMembers[uid];
      console.log(`[faction] ${fName}: ${member.name} joined`);
      
      await notify(Embeds.factionJoinLeave('join', fName, factionId, uid, member.name));
      
      // Initialize cached member data
      prevMembers[uid] = {
        name: member.name,
        lastState: member.status?.state || 'Okay',
        lastActionTs: member.last_action?.timestamp,
        preFired: {},
        travel: null,
      };
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // Member Leaves
  // ─────────────────────────────────────────────────────────────
  
  for (const uid of prevIds) {
    if (!newIds.has(uid)) {
      const cached = prevMembers[uid];
      console.log(`[faction] ${fName}: ${cached?.name || uid} left`);
      
      await notify(Embeds.factionJoinLeave('leave', fName, factionId, uid, cached?.name || uid));
      
      delete prevMembers[uid];
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // Member State Updates
  // ─────────────────────────────────────────────────────────────
  
  for (const [uid, member] of Object.entries(newMembers)) {
    const cached = prevMembers[uid];
    if (!cached) continue; // Just joined, already handled
    
    const currentState = member.status?.state || 'Okay';
    const lastActionTs = Number(member.last_action?.timestamp || 0);
    const prevState = cached.lastState;
    
    // Same state
    if (currentState === prevState) {
      // Travel direction changes
      if (currentState === 'Traveling' && cached.travel) {
        const newDir = parseTravelDirection(member.status?.description);
        const newDest = parseDestination(member.status?.description);
        
        if (newDir !== cached.travel.direction || newDest !== cached.travel.destination) {
          cached.travel = createTravelInfo(member.status);
        }
      }
      
      // Pre-alerts for faction members
      if (fconf.preTimesSec?.length) {
        cached.preFired = cached.preFired || {};
        await checkPreAlerts(
          uid,
          `${member.name} (${fName})`,
          currentState,
          member.status,
          cached.travel,
          fconf.preTimesSec,
          cached.preFired
        );
      }
    } else {
      // State changed
      console.log(`[faction] ${fName}: ${member.name} ${prevState} → ${currentState}`);
      
      const oldState = prevState;
      cached.lastState = currentState;
      cached.travel = currentState === 'Traveling' ? createTravelInfo(member.status) : null;
      
      // Reset pre-fired
      cached.preFired = cached.preFired || {};
      const key = sessionKey(currentState, member.status, cached.travel);
      if (key) {
        delete cached.preFired[key];
      }
      
      // Notify if state is watched
      if (watchStates.has(currentState)) {
        await notify(
          Embeds.factionMemberChange(fName, factionId, uid, member, oldState, currentState, cached.travel)
        );
      }
    }
    
    // ─────────────────────────────────────────────────────────────
    // Offline Check
    // ─────────────────────────────────────────────────────────────
    
    if (fconf.offline?.enabled !== false && lastActionTs > 0) {
      const isOffline = (nowSec - lastActionTs) >= offlineThreshold;
      
      if (isOffline && !cached.offlineNotified) {
        await notify(
          Embeds.factionOffline(
            fName, 
            factionId, 
            uid, 
            member.name, 
            lastActionTs, 
            fconf.offline?.hours || config.defaults.offlineHours
          )
        );
        cached.offlineNotified = true;
      } else if (!isOffline) {
        cached.offlineNotified = false;
      }
    }
    
    // Update cached data
    cached.name = member.name;
    cached.lastActionTs = lastActionTs || cached.lastActionTs;
  }
  
  // Update members reference
  fconf.members = prevMembers;
  store.save('faction');
}

module.exports = {
  pollFaction,
};