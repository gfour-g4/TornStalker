/**
 * Parse human-readable time string to seconds
 * Supports: "5m", "1h30m", "90s", "2h", plain numbers
 * @param {string|number} input - Time string or seconds
 * @returns {number|null} Seconds or null if invalid
 */
function parseTime(input) {
  if (input == null) return null;
  
  const str = String(input).toLowerCase().trim();
  if (!str) return null;
  
  // Plain number = seconds
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }
  
  let total = 0;
  const patterns = [
    { regex: /(\d+(?:\.\d+)?)\s*h/i, multiplier: 3600 },
    { regex: /(\d+(?:\.\d+)?)\s*m(?:in)?/i, multiplier: 60 },
    { regex: /(\d+(?:\.\d+)?)\s*s(?:ec)?/i, multiplier: 1 },
  ];
  
  for (const { regex, multiplier } of patterns) {
    const match = str.match(regex);
    if (match) {
      total += parseFloat(match[1]) * multiplier;
    }
  }
  
  return total > 0 ? Math.floor(total) : null;
}

/**
 * Format seconds to human-readable string
 * @param {number} seconds - Duration in seconds
 * @param {object} options - Formatting options
 * @returns {string} Formatted time string
 */
function formatTime(seconds, options = {}) {
  const { 
    verbose = false, 
    showSeconds = true,
    maxParts = 3 
  } = options;
  
  if (!seconds || seconds <= 0) return 'now';
  
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  const parts = [];
  
  if (h > 0) {
    parts.push(verbose ? `${h} hour${h !== 1 ? 's' : ''}` : `${h}h`);
  }
  if (m > 0) {
    parts.push(verbose ? `${m} minute${m !== 1 ? 's' : ''}` : `${m}m`);
  }
  if (s > 0 && showSeconds && (parts.length < maxParts || !h)) {
    parts.push(verbose ? `${s} second${s !== 1 ? 's' : ''}` : `${s}s`);
  }
  
  if (parts.length === 0) return 'now';
  
  return verbose ? parts.join(', ') : parts.join(' ');
}

/**
 * Parse multiple time values from comma-separated string
 * @param {string} input - Comma-separated times
 * @returns {number[]} Array of seconds, sorted descending
 */
function parseTimes(input) {
  if (!input) return [];
  
  const str = input.toLowerCase().trim();
  if (['off', 'none', '-', 'disable', '0', 'false'].includes(str)) {
    return [];
  }
  
  const times = input
    .split(/[,\s]+/)
    .map(parseTime)
    .filter(t => t != null && t > 0);
  
  // Remove duplicates and sort descending
  return [...new Set(times)].sort((a, b) => b - a);
}

/**
 * Create Discord timestamp
 * @param {number} unix - Unix timestamp in seconds
 * @param {string} style - Discord timestamp style
 * @returns {string} Discord timestamp string
 */
function discordTimestamp(unix, style = 'f') {
  return `<t:${Math.floor(unix)}:${style}>`;
}

/**
 * Get relative time description
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Relative time string
 */
function relativeTime(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = timestamp - now;
  
  if (Math.abs(diff) < 60) return 'just now';
  
  const absDiff = Math.abs(diff);
  const future = diff > 0;
  
  if (absDiff < 3600) {
    const mins = Math.floor(absDiff / 60);
    return future ? `in ${mins}m` : `${mins}m ago`;
  }
  
  if (absDiff < 86400) {
    const hours = Math.floor(absDiff / 3600);
    return future ? `in ${hours}h` : `${hours}h ago`;
  }
  
  const days = Math.floor(absDiff / 86400);
  return future ? `in ${days}d` : `${days}d ago`;
}

module.exports = {
  parseTime,
  formatTime,
  parseTimes,
  discordTimestamp,
  relativeTime,
  // Aliases
  humanTime: formatTime,
  ts: discordTimestamp,
};