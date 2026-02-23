// ═══════════════════════════════════════════════════════════════
// STATES & TRACKING
// ═══════════════════════════════════════════════════════════════

const STATES = ['Traveling', 'Abroad', 'Jail', 'Hospital', 'Okay'];
const BARS = ['energy', 'nerve', 'happy', 'life'];
const COOLDOWNS = ['drug', 'medical', 'booster', 'alcohol'];

// ═══════════════════════════════════════════════════════════════
// EMOJI MAPPINGS
// ═══════════════════════════════════════════════════════════════

const EMOJI = {
  // States
  Traveling: '✈️',
  Abroad: '🗺️',
  Jail: '🚔',
  Hospital: '🏥',
  Okay: '✅',
  Unknown: '❓',
  
  // Bars
  energy: '⚡',
  nerve: '💢',
  happy: '😊',
  life: '❤️',
  
  // Cooldowns
  drug: '💊',
  medical: '🩹',
  booster: '💉',
  alcohol: '🍺',
  
  // UI
  chain: '⛓️',
  on: '🟢',
  off: '🔴',
  user: '👤',
  faction: '🏴',
  warning: '⚠️',
  success: '✅',
  error: '❌',
  loading: '⏳',
};

// ═══════════════════════════════════════════════════════════════
// COLORS
// ═══════════════════════════════════════════════════════════════

const COLORS = {
  // States
  Traveling: 0x3498db,
  Abroad: 0xf39c12,
  Jail: 0x7f8c8d,
  Hospital: 0xe74c3c,
  Okay: 0x2ecc71,
  
  // UI
  brand: 0x5865f2,
  warn: 0xf39c12,
  good: 0x2ecc71,
  bad: 0xe74c3c,
  info: 0x3498db,
};

// ═══════════════════════════════════════════════════════════════
// TORN LINKS
// ═══════════════════════════════════════════════════════════════

const LINKS = {
  // Items
  drugs: 'https://www.torn.com/item.php#drugs-items',
  alcohol: 'https://www.torn.com/item.php#alcohol-items',
  boosters: 'https://www.torn.com/item.php#boosters-items',
  medical: 'https://www.torn.com/factions.php?step=your&type=1#armoury-medical',
  
  // Locations
  hospital: 'https://www.torn.com/hospitalview.php',
  jail: 'https://www.torn.com/jailview.php',
  travel: 'https://www.torn.com/travelagency.php',
  gym: 'https://www.torn.com/gym.php',
  crimes: 'https://www.torn.com/crimes.php',
  home: 'https://www.torn.com/index.php',
  pointsBuilding: 'https://www.torn.com/page.php?sid=points',
  
  // Dynamic
  profile: (id) => `https://www.torn.com/profiles.php?XID=${id}`,
  attack: (id) => `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`,
  faction: (id) => `https://www.torn.com/factions.php?step=profile&ID=${id}`,
  bounty: (id) => `https://www.torn.com/bounties.php?p=add&XID=${id}`,
  trade: (id) => `https://www.torn.com/trade.php#step=start&userID=${id}`,
  mail: (id) => `https://www.torn.com/messages.php#/p=compose&XID=${id}`,
};

// Map cooldowns to their action links
const COOLDOWN_LINKS = {
  drug: LINKS.drugs,
  medical: LINKS.medical,
  booster: LINKS.boosters,
  alcohol: LINKS.alcohol,
};

// Map bars to their action links
const BAR_LINKS = {
  energy: LINKS.gym,
  nerve: LINKS.crimes,
  happy: LINKS.drugs,
  life: LINKS.hospital,
};

// ═══════════════════════════════════════════════════════════════
// TRAVEL DATA
// ═══════════════════════════════════════════════════════════════

const DESTINATIONS = [
  'Mexico', 'Cayman Islands', 'Canada', 'Hawaii', 
  'United Kingdom', 'Argentina', 'Switzerland', 
  'Japan', 'China', 'UAE', 'South Africa'
];

const TRAVEL_TIMES = {
  standard_economy: [1560, 2100, 2460, 8040, 9540, 10020, 10500, 13500, 14520, 16260, 17820],
  standard_business: [480, 660, 720, 2400, 2880, 3000, 3180, 4080, 4320, 4860, 5340],
  airstrip: [1080, 1500, 1740, 5640, 6660, 7020, 7380, 9480, 10140, 11400, 12480],
  private: [780, 1080, 1200, 4020, 4800, 4980, 5280, 6780, 7260, 8100, 8940],
};

// ═══════════════════════════════════════════════════════════════
// ACTION DESCRIPTIONS
// ═══════════════════════════════════════════════════════════════

const BAR_ACTIONS = {
  energy: { text: 'Hit the gym!', link: LINKS.gym },
  nerve: { text: 'Commit some crimes!', link: LINKS.crimes },
  happy: { text: 'Time to boost!', link: LINKS.drugs },
  life: { text: 'You\'re at full health!', link: LINKS.home },
};

const COOLDOWN_ACTIONS = {
  drug: { text: 'Take some drugs!', link: LINKS.drugs },
  medical: { text: 'Use faction medical!', link: LINKS.medical },
  booster: { text: 'Use a booster!', link: LINKS.boosters },
  alcohol: { text: 'Have a drink!', link: LINKS.alcohol },
};

module.exports = {
  STATES,
  BARS,
  COOLDOWNS,
  EMOJI,
  COLORS,
  LINKS,
  COOLDOWN_LINKS,
  BAR_LINKS,
  DESTINATIONS,
  TRAVEL_TIMES,
  BAR_ACTIONS,
  COOLDOWN_ACTIONS,
};
