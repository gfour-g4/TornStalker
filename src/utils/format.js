

const { STATES, EMOJI } = require('../config/constants');

/**
 * Capitalize first letter
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Create visual progress bar
 */
function progressBar(current, max, length = 10, options = {}) {
  const { 
    filledChar = '█', 
    emptyChar = '░',
    showValues = true,
    showPercent = false,
  } = options;
  
  const pct = Math.max(0, Math.min(1, current / max));
  const filled = Math.round(pct * length);
  const bar = filledChar.repeat(filled) + emptyChar.repeat(length - filled);
  
  if (showPercent) {
    return `${bar} ${Math.round(pct * 100)}%`;
  }
  
  if (showValues) {
    return `${bar} ${current.toLocaleString()}/${max.toLocaleString()}`;
  }
  
  return bar;
}

/**
 * Parse states from user input with fuzzy matching
 */
function parseStates(input) {
  if (!input?.trim()) return [...STATES];
  
  const val = input.trim().toLowerCase();
  
  // Special values
  if (['all', '*', 'any'].includes(val)) return [...STATES];
  if (['none', '-', 'off', 'false', '0'].includes(val)) return [];
  
  const parsed = [];
  const parts = input.split(/[,\s|]+/);
  
  for (const part of parts) {
    const low = part.toLowerCase().trim();
    if (!low) continue;
    
    const match = STATES.find(s => s.toLowerCase().startsWith(low));
    if (!match) {
      throw new Error(`Unknown state: "${part}". Valid: ${STATES.join(', ')}`);
    }
    
    if (!parsed.includes(match)) {
      parsed.push(match);
    }
  }
  
  return parsed;
}

/**
 * Format states for display
 */
function formatStates(states, options = {}) {
  const { useEmoji = true, separator = ' ' } = options;
  
  if (!states?.length) return '*none*';
  
  if (useEmoji) {
    return states.map(s => EMOJI[s] || s).join(separator);
  }
  
  return states.join(', ');
}

/**
 * Clamp number between min and max
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Format number with locale separators
 */
function formatNumber(num) {
  return Number(num || 0).toLocaleString();
}

/**
 * Truncate string to length
 */
function truncate(str, length, suffix = '...') {
  if (!str || str.length <= length) return str;
  return str.slice(0, length - suffix.length) + suffix;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create unique session key for pre-alerts
 */
function sessionKey(state, status, travel) {
  if (state === 'Traveling' && travel?.startedAt) {
    return `T:${travel.direction}:${travel.startedAt}`;
  }
  if (['Jail', 'Hospital'].includes(state) && status?.until) {
    return `${state[0]}:${status.until}`;
  }
  return null;
}

module.exports = {
  capitalize,
  progressBar,
  parseStates,
  formatStates,
  clamp,
  formatNumber,
  truncate,
  sleep,
  sessionKey,
  // Alias
  cap: capitalize,
};