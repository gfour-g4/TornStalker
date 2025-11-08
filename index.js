require('dotenv').config();

const axios = require('axios');
const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const {
  DISCORD_TOKEN,
  OWNER_DISCORD_ID,
  TORN_API_KEY,
  USER_IDS,
  WATCH_FIELDS,
  REQUEST_INTERVAL_MS,
  SELF_PING_URL,
  PORT
} = process.env;

// Basic env validation
function assertEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
assertEnv('DISCORD_TOKEN', DISCORD_TOKEN);
assertEnv('OWNER_DISCORD_ID', OWNER_DISCORD_ID);
assertEnv('TORN_API_KEY', TORN_API_KEY);
assertEnv('USER_IDS', USER_IDS);

const userIds = USER_IDS.split(',').map(s => s.trim()).filter(Boolean);
if (userIds.length === 0) {
  console.error('USER_IDS must contain at least one Torn user ID');
  process.exit(1);
}

const watchFields = (WATCH_FIELDS || 'description,state')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const REQUEST_MS = Number(REQUEST_INTERVAL_MS || 5000);
const SELF_PING_MS = 12 * 60 * 1000; // every 12 min

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel] // for DMs
});

// Express for health + keep-alive endpoint
const app = express();
app.get('/', (_req, res) => {
  res.status(200).send(`OK ${new Date().toISOString()}`);
});
app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});
const listenPort = Number(PORT || 3000);
app.listen(listenPort, () => {
  console.log(`[web] Listening on :${listenPort}`);
});

// Self-ping to keep Render free service awake
if (SELF_PING_URL) {
  setInterval(async () => {
    try {
      await axios.get(SELF_PING_URL, { timeout: 8000 });
      console.log(`[keepalive] Pinged ${SELF_PING_URL}`);
    } catch (e) {
      console.warn('[keepalive] Self-ping failed:', e?.response?.status || e.message);
    }
  }, SELF_PING_MS);
} else {
  console.log('SELF_PING_URL not set; self-ping disabled.');
}

// Torn API client
const torn = axios.create({
  baseURL: 'https://api.torn.com/v2',
  timeout: 12000
});

// Track last known status signature for each user
const lastStatusSig = new Map(); // userId -> stringified watched fields
const lastStatusObj = new Map(); // userId -> full status obj
const lastNameById = new Map();  // userId -> last seen name

function pickWatchedFields(status) {
  const picked = {};
  for (const f of watchFields) {
    picked[f] = status?.[f] ?? null;
  }
  return picked;
}

function statusSignature(status) {
  return JSON.stringify(pickWatchedFields(status));
}

function computeDiff(oldObj, newObj) {
  const diffs = [];
  for (const f of watchFields) {
    const oldVal = oldObj?.[f] ?? null;
    const newVal = newObj?.[f] ?? null;
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffs.push({ field: f, from: oldVal, to: newVal });
    }
  }
  return diffs;
}

function formatStatusSummary(s) {
  if (!s) return 'No status data.';
  const parts = [];
  if (s.state) parts.push(`state: ${s.state}`);
  if (s.description) parts.push(`description: ${s.description}`);
  if (s.details) parts.push(`details: ${s.details}`);
  if (s.color) parts.push(`color: ${s.color}`);
  if (s.travel_type) parts.push(`travel_type: ${s.travel_type}`);
  if (s.plane_image_type) parts.push(`plane: ${s.plane_image_type}`);
  if (s.until) parts.push(`until: ${s.until}`);
  return parts.join(' | ');
}

function formatDiffLines(diffs) {
  if (!diffs?.length) return '- No changes detected';
  return diffs
    .map(d => `- ${d.field}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`)
    .join('\n');
}

async function fetchTornProfile(userId) {
  // /v2/user/{userId}/basic?striptags=true&key=...
  const url = `/user/${encodeURIComponent(userId)}/basic`;
  const params = { striptags: true, key: TORN_API_KEY };
  const { data } = await torn.get(url, { params });
  if (!data?.profile) {
    throw new Error(`Malformed response for user ${userId}`);
  }
  return data.profile; // { id, name, level, gender, status: {...} }
}

async function notifyOwner(content) {
  try {
    const user = await client.users.fetch(OWNER_DISCORD_ID, { force: true });
    await user.send(content);
  } catch (e) {
    console.error('[dm] Failed to DM owner:', e.message);
  }
}

let pollingIndex = 0;
let isTicking = false;

async function pollNextUser() {
  if (isTicking) return; // avoid overlapping ticks
  isTicking = true;

  const userId = userIds[pollingIndex];
  pollingIndex = (pollingIndex + 1) % userIds.length;

  try {
    const profile = await fetchTornProfile(userId);
    const status = profile?.status || {};
    const sig = statusSignature(status);
    const prevSig = lastStatusSig.get(userId);
    const prevStatus = lastStatusObj.get(userId);
    const name = profile?.name || `User ${userId}`;
    lastNameById.set(userId, name);

    // If this is the first time we see this user, set baseline and don't alert.
    if (prevSig === undefined) {
      lastStatusSig.set(userId, sig);
      lastStatusObj.set(userId, pickWatchedFields(status));
      console.log(`[init] Baseline set for ${name} (${userId}) -> ${formatStatusSummary(status)}`);
    } else if (prevSig !== sig) {
      const newPicked = pickWatchedFields(status);
      const diffs = computeDiff(prevStatus, newPicked);
      const lines = formatDiffLines(diffs);
      const summary = formatStatusSummary(status);
      const profileUrl = `https://www.torn.com/profiles.php?XID=${userId}`;
      const msg = [
        `🛰️ Torn status updated`,
        `Name: ${name} (ID: ${userId})`,
        `Profile: ${profileUrl}`,
        ``,
        `Changed fields:`,
        `${lines}`,
        ``,
        `Current status: ${summary}`,
        `Time (UTC): ${new Date().toISOString()}`
      ].join('\n');

      await notifyOwner(msg);

      // Update baseline
      lastStatusSig.set(userId, sig);
      lastStatusObj.set(userId, newPicked);
      console.log(`[change] Notified for ${name} (${userId}).`);
    } else {
      // Unchanged
      // console.log(`[ok] No change for ${name} (${userId}).`);
    }
  } catch (e) {
    const status = e?.response?.status;
    if (status === 429) {
      console.warn(`[rate] 429 Too Many Requests (user ${userId}). Backing off temporarily.`);
    } else {
      console.warn(`[poll] Failed for user ${userId}:`, status || e.message);
    }
  } finally {
    isTicking = false;
  }
}

client.once('ready', async () => {
  console.log(`[discord] Logged in as ${client.user.tag}`);
  console.log(`[watch] Watching ${userIds.length} Torn users.`);
  console.log(`[watch] Fields: ${watchFields.join(', ')}`);
  console.log(`[watch] Interval per request: ${REQUEST_MS}ms (~${(REQUEST_MS * userIds.length / 1000).toFixed(1)}s per user cycle)`);

  // Prime: do one pass quickly to establish baselines (without notifications)
  for (const userId of userIds) {
    try {
      const profile = await fetchTornProfile(userId);
      const status = profile?.status || {};
      lastStatusSig.set(userId, statusSignature(status));
      lastStatusObj.set(userId, pickWatchedFields(status));
      lastNameById.set(userId, profile?.name || `User ${userId}`);
      console.log(`[prime] Baseline for ${lastNameById.get(userId)} (${userId}).`);
      await new Promise(r => setTimeout(r, 800)); // small spacing
    } catch (e) {
      console.warn(`[prime] Failed for ${userId}:`, e?.response?.status || e.message);
    }
  }

  // Start polling loop (one user per tick)
  setInterval(pollNextUser, REQUEST_MS);
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err.message);
  process.exit(1);
});