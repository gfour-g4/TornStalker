const store = require('../services/store');
const api = require('../services/api');
const { notify } = require('../services/notify');
const Embeds = require('../discord/embeds');
const { 
  COOLDOWNS, 
  COOLDOWN_ICON_MAP, 
  TRACKABLE_ICONS,
  ICON_IDS,
} = require('../config/constants');

/**
 * Build a map of icon ID -> icon data from the icons array
 */
function buildIconMap(icons) {
  const map = {};
  for (const icon of icons) {
    map[icon.id] = icon;
  }
  return map;
}

/**
 * Poll icons endpoint for cooldowns and trackable events
 */
async function pollIcons() {
  try {
    const icons = await api.getIcons();
    const iconMap = buildIconMap(icons);
    const { self } = store.data;
    const nowSec = Math.floor(Date.now() / 1000);
    
    // ─────────────────────────────────────────────────────────
    // Cooldowns via Icons
    // ─────────────────────────────────────────────────────────
    
    for (const cd of COOLDOWNS) {
      if (!self.cooldowns[cd]) continue;
      
      const iconId = COOLDOWN_ICON_MAP[cd];
      const icon = iconMap[iconId];
      const wasReady = self.cooldowns.wasReady[cd] ?? true;
      
      if (icon) {
        // Cooldown is active
        self.cooldowns.lastIcons[iconId] = {
          until: icon.until,
          description: icon.description,
          checkedAt: nowSec,
        };
        self.cooldowns.wasReady[cd] = false;
      } else {
        // No icon = cooldown ready
        if (!wasReady) {
          // Just became ready - notify!
          await notify(Embeds.cooldownReady(cd));
          console.log(`[icons] ${cd} cooldown ready`);
        }
        self.cooldowns.wasReady[cd] = true;
        delete self.cooldowns.lastIcons[iconId];
      }
    }
    
    // ─────────────────────────────────────────────────────────
    // Trackable Icons (Racing, OC, Bank, Education, Donator)
    // ─────────────────────────────────────────────────────────
    
    for (const [key, config] of Object.entries(TRACKABLE_ICONS)) {
      if (!self.icons[key]) continue;
      
      // Handle racing specially (has start and end icons)
      if (key === 'racing') {
        await handleRacingIcon(iconMap, self.icons);
        continue;
      }
      
      const iconId = config.id;
      const icon = iconMap[iconId];
      const lastIcon = self.icons.last[iconId];
      const wasNotified = self.icons.notified[iconId];
      
      if (icon) {
        const isNew = !lastIcon || 
          (icon.until && icon.until !== lastIcon.until);
        
        if (isNew && !wasNotified) {
          // New activity started
          await notify(Embeds.iconStarted(key, icon));
          self.icons.notified[iconId] = true;
          console.log(`[icons] ${config.name} started`);
        }
        
        // Check if activity just ended (had until, now past)
        if (lastIcon?.until && icon.until === null && lastIcon.until <= nowSec) {
          await notify(Embeds.iconEnded(key, icon));
          self.icons.notified[iconId] = false;
          console.log(`[icons] ${config.name} ended`);
        }
        
        self.icons.last[iconId] = {
          until: icon.until,
          description: icon.description,
          checkedAt: nowSec,
        };
      } else {
        // Icon disappeared
        if (lastIcon && wasNotified) {
          // Activity ended (icon removed)
          await notify(Embeds.iconEnded(key, { title: config.name }));
          console.log(`[icons] ${config.name} ended (icon removed)`);
        }
        
        self.icons.notified[iconId] = false;
        delete self.icons.last[iconId];
      }
    }
    
    store.save('icons');
  } catch (error) {
    console.warn('[icons]', error.message);
  }
}

/**
 * Special handling for racing icons (active vs finished)
 */
async function handleRacingIcon(iconMap, iconsState) {
  const activeIcon = iconMap[ICON_IDS.RACING_ACTIVE];
  const finishedIcon = iconMap[ICON_IDS.RACING_FINISHED];
  
  const lastActive = iconsState.last[ICON_IDS.RACING_ACTIVE];
  const wasNotified = iconsState.notified[ICON_IDS.RACING_ACTIVE];
  
  if (activeIcon) {
    // Currently racing
    const isNew = !lastActive || activeIcon.until !== lastActive.until;
    
    if (isNew && !wasNotified) {
      await notify(Embeds.iconStarted('racing', activeIcon));
      iconsState.notified[ICON_IDS.RACING_ACTIVE] = true;
      console.log('[icons] Racing started');
    }
    
    iconsState.last[ICON_IDS.RACING_ACTIVE] = {
      until: activeIcon.until,
      description: activeIcon.description,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  } else if (finishedIcon) {
    // Race just finished (finished icon appears briefly)
    if (wasNotified) {
      await notify(Embeds.racingFinished(finishedIcon));
      iconsState.notified[ICON_IDS.RACING_ACTIVE] = false;
      console.log('[icons] Racing finished');
    }
    
    delete iconsState.last[ICON_IDS.RACING_ACTIVE];
  } else {
    // No racing icons - race ended or idle
    if (lastActive && wasNotified) {
      await notify(Embeds.iconEnded('racing', { title: 'Racing' }));
      console.log('[icons] Racing ended (icon removed)');
    }
    
    iconsState.notified[ICON_IDS.RACING_ACTIVE] = false;
    delete iconsState.last[ICON_IDS.RACING_ACTIVE];
  }
}

/**
 * Get remaining time for a cooldown from icons
 */
function getCooldownRemaining(cooldownType) {
  const iconId = COOLDOWN_ICON_MAP[cooldownType];
  const iconData = store.self.cooldowns.lastIcons[iconId];
  
  if (!iconData?.until) return 0;
  
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.max(0, iconData.until - nowSec);
}

/**
 * Check if a cooldown is ready
 */
function isCooldownReady(cooldownType) {
  return store.self.cooldowns.wasReady[cooldownType] ?? true;
}

module.exports = {
  pollIcons,
  getCooldownRemaining,
  isCooldownReady,
  buildIconMap,
};