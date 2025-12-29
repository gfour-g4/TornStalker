const { DESTINATIONS, TRAVEL_TIMES } = require('../config/constants');

const TRAVEL_PAD = 0.03; // 3% padding for estimation

/**
 * Get travel time for a destination and travel type
 */
function getTravelTime(type, destination) {
  const idx = DESTINATIONS.findIndex(
    d => d.toLowerCase() === destination?.toLowerCase()
  );
  return idx >= 0 ? TRAVEL_TIMES[type]?.[idx] : null;
}

/**
 * Estimate arrival window for travel
 */
function estimateTravel(type, destination, startMs) {
  const startSec = Math.floor(startMs / 1000);
  
  if (!destination) {
    return { earliest: null, latest: null };
  }
  
  // Standard class could be economy or business
  if (type === 'standard') {
    const econ = getTravelTime('standard_economy', destination);
    const bus = getTravelTime('standard_business', destination);
    
    if (!econ || !bus) return { earliest: null, latest: null };
    
    return {
      earliest: Math.floor(startSec + Math.min(econ, bus) * (1 - TRAVEL_PAD)),
      latest: Math.floor(startSec + Math.max(econ, bus) * (1 + TRAVEL_PAD)),
    };
  }
  
  const sec = getTravelTime(type, destination);
  if (!sec) return { earliest: null, latest: null };
  
  return {
    earliest: Math.floor(startSec + sec * (1 - TRAVEL_PAD)),
    latest: Math.floor(startSec + sec * (1 + TRAVEL_PAD)),
  };
}

/**
 * Parse destination from status description
 */
function parseDestination(description) {
  if (!description) return null;
  
  // Match "Traveling to X" or "Returning from X"
  const match = description.match(/(?:from|to)\s+([A-Za-z\s-]+)$/i);
  if (!match) return null;
  
  const dest = match[1].replace(/[^\w\s-]/g, '').trim();
  
  // Try to find exact match in known destinations
  const known = DESTINATIONS.find(
    d => d.toLowerCase() === dest.toLowerCase()
  );
  
  return known || dest;
}

/**
 * Parse travel direction from status description
 */
function parseTravelDirection(description) {
  if (!description) return 'outbound';
  return /returning|from\s+\w/i.test(description) ? 'return' : 'outbound';
}

/**
 * Infer travel type from status
 */
function inferTravelType(status) {
  return status?.travel_type?.toLowerCase() || 'standard';
}

/**
 * Create complete travel info from status
 */
function createTravelInfo(status) {
  const description = status?.description || '';
  const destination = parseDestination(description);
  const type = inferTravelType(status);
  const direction = parseTravelDirection(description);
  const startedAt = Date.now();
  
  return {
    startedAt,
    type,
    destination,
    direction,
    ...estimateTravel(type, destination, startedAt),
  };
}

/**
 * Format destination for display
 */
function formatDestination(travel) {
  if (!travel?.destination) return 'Unknown';
  
  return travel.direction === 'return'
    ? `← Returning from ${travel.destination}`
    : `→ Flying to ${travel.destination}`;
}

/**
 * Get ETA timestamp (midpoint of estimation window)
 */
function getETA(travel) {
  if (!travel?.earliest || !travel?.latest) return null;
  return Math.floor((travel.earliest + travel.latest) / 2);
}

module.exports = {
  getTravelTime,
  estimateTravel,
  parseDestination,
  parseTravelDirection,
  inferTravelType,
  createTravelInfo,
  formatDestination,
  getETA,
  DESTINATIONS,
};
