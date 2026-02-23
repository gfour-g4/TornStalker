const { EmbedBuilder } = require('discord.js');
const store = require('../services/store');
const { 
  STATES, BARS, COOLDOWNS, 
  EMOJI, COLORS, LINKS, 
  BAR_LINKS, COOLDOWN_LINKS,
  BAR_ACTIONS, COOLDOWN_ACTIONS,
} = require('../config/constants');
const { 
  formatTime, discordTimestamp, 
  progressBar, capitalize, formatNumber,
  formatDestination, getETA,
} = require('../utils');

// ═══════════════════════════════════════════════════════════════
// DASHBOARD & OVERVIEW
// ═══════════════════════════════════════════════════════════════

function dashboard() {
  const stats = store.getStats();
  const { self } = store.data;
  
  // Bar status with values
  const barLines = BARS.map(b => {
    const on = self.bars[b];
    const last = self.bars.last[b];
    const val = last ? `\`${last.current}/${last.maximum}\`` : '`—`';
    return `${EMOJI[b]} ${capitalize(b)}: ${on ? EMOJI.on : EMOJI.off} ${val}`;
  }).join('\n');
  
  // Cooldown status
  const cdLines = COOLDOWNS.map(c => {
    const on = self.cooldowns[c];
    const remaining = self.cooldowns.last[c] || 0;
    const status = remaining > 0 ? `⏱ ${formatTime(remaining)}` : '✓ Ready';
    return `${EMOJI[c]} ${capitalize(c)}: ${on ? EMOJI.on : EMOJI.off} ${status}`;
  }).join('\n');
  
  // Chain config
  const chain = self.chain;
  const chainInfo = chain.enabled
    ? `${EMOJI.on} Min: **${chain.min}** • Alerts: ${chain.thresholds.map(formatTime).join(', ')}`
    : EMOJI.off;
  
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('📊 Torn Tracker Dashboard')
    .setDescription([
      `Monitoring **${stats.users.active}** users, **${stats.factions.active}** factions`,
      `(${stats.factions.members} total members)`,
    ].join('\n'))
    .addFields(
      {
        name: `${EMOJI.user} Users`,
        value: stats.users.total 
          ? `**${stats.users.active}**/${stats.users.total} active` 
          : '*None*',
        inline: true,
      },
      {
        name: `${EMOJI.faction} Factions`,
        value: stats.factions.total 
          ? `**${stats.factions.active}**/${stats.factions.total} active` 
          : '*None*',
        inline: true,
      },
      {
        name: '📡 Status',
        value: `${EMOJI.on} Online`,
        inline: true,
      },
      { name: '⚡ Bars', value: barLines, inline: true },
      { name: '💊 Cooldowns', value: cdLines, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: `${EMOJI.chain} Chain`, value: chainInfo, inline: false },
    )
    .setFooter({ text: 'Use buttons to configure • /help for commands' })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
// USER VIEWS
// ═══════════════════════════════════════════════════════════════

function userList(page = 0, perPage = 10) {
  const entries = Object.entries(store.watchers);
  
  if (!entries.length) {
    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(`${EMOJI.user} Tracked Users`)
      .setDescription([
        'No users tracked yet.',
        '',
        '**Quick Start:**',
        '• Use `/track user <id>` to add someone',
        '• Get user IDs from their Torn profile URL',
      ].join('\n'))
      .setFooter({ text: 'Track targets to get notified when they leave hospital/jail!' });
  }
  
  const totalPages = Math.ceil(entries.length / perPage);
  const pageEntries = entries.slice(page * perPage, (page + 1) * perPage);
  
  const lines = pageEntries.map(([id, cfg]) => {
    const status = cfg.enabled === false ? EMOJI.off : EMOJI.on;
    const stateEmoji = EMOJI[cfg.lastState] || EMOJI.Unknown;
    const states = cfg.states?.length
      ? cfg.states.map(s => EMOJI[s]).join('')
      : '`none`';
    const pre = cfg.preTimesSec?.length
      ? `\n┃ ⏰ ${cfg.preTimesSec.map(formatTime).join(', ')}`
      : '';
    
    return [
      `${status} **[${cfg.name || 'Unknown'}](${LINKS.profile(id)})** \`[${id}]\``,
      `┃ ${stateEmoji} ${cfg.lastState || 'Unknown'}`,
      `┃ 🔔 ${states}${pre}`,
    ].join('\n');
  });
  
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(`${EMOJI.user} Tracked Users (${entries.length})`)
    .setDescription(lines.join('\n\n'))
    .setFooter({ 
      text: totalPages > 1 
        ? `Page ${page + 1}/${totalPages} • Select user to configure`
        : 'Select a user to configure',
    });
}

function userStatus(userId, profile, cfg) {
  const status = profile?.status || {};
  const state = status.state || 'Unknown';
  const travel = cfg?.travel;
  
  const embed = new EmbedBuilder()
    .setColor(COLORS[state] || COLORS.brand)
    .setAuthor({
      name: `${profile?.name || cfg?.name || 'User'} [${userId}]`,
      url: LINKS.profile(userId),
    })
    .setTitle(`${EMOJI[state] || EMOJI.Unknown} ${state}`)
    .setURL(LINKS.profile(userId))
    .setTimestamp();
  
  const lines = [];
  if (status.description) {
    lines.push(`> ${status.description}`);
  }
  
  // State-specific info with action links
  if (state === 'Traveling' && travel?.earliest) {
    const eta = getETA(travel);
    lines.push(
      '',
      `✈️ ${formatDestination(travel)}`,
      `**ETA:** ${discordTimestamp(eta, 'R')} (${discordTimestamp(eta, 't')})`,
    );
  } else if (state === 'Jail' && status.until) {
    const until = Number(status.until);
    lines.push(
      '',
      `**Released:** ${discordTimestamp(until, 'R')} (${discordTimestamp(until, 't')})`,
      `🔗 [View in Jail](${LINKS.jail})`,
    );
  } else if (state === 'Hospital' && status.until) {
    const until = Number(status.until);
    lines.push(
      '',
      `**Discharged:** ${discordTimestamp(until, 'R')} (${discordTimestamp(until, 't')})`,
      `🔗 [View in Hospital](${LINKS.hospital})`,
    );
  } else if (state === 'Okay') {
    lines.push('', `🎯 [Attack](${LINKS.attack(userId)}) • [Profile](${LINKS.profile(userId)})`);
  } else if (state === 'Abroad') {
    lines.push('', `🔗 [Travel Agency](${LINKS.travel})`);
  }
  
  // Last action
  const lastAction = profile?.last_action?.timestamp;
  if (lastAction) {
    lines.push('', `**Last Active:** ${discordTimestamp(lastAction, 'R')}`);
  }
  
  embed.setDescription(lines.join('\n') || '*No additional info*');
  
  // Tracking configuration
  if (cfg) {
    const alerts = cfg.states?.length
      ? cfg.states.map(s => `${EMOJI[s]} ${s}`).join('\n')
      : '*None*';
    
    const warnings = cfg.preTimesSec?.length
      ? cfg.preTimesSec.map(formatTime).join(', ')
      : '*None*';
    
    const statusText = cfg.enabled === false
      ? `${EMOJI.off} Paused`
      : `${EMOJI.on} Active`;
    
    embed.addFields(
      { name: '🔔 Alerts', value: alerts, inline: true },
      { name: '⏰ Warnings', value: warnings, inline: true },
      { name: '📡 Status', value: statusText, inline: true },
    );
  }
  
  return embed;
}

// ═══════════════════════════════════════════════════════════════
// FACTION VIEWS
// ═══════════════════════════════════════════════════════════════

function factionList(page = 0, perPage = 5) {
  const entries = Object.entries(store.factions.items);
  
  if (!entries.length) {
    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(`${EMOJI.faction} Tracked Factions`)
      .setDescription([
        'No factions tracked yet.',
        '',
        '**Quick Start:**',
        '• Use `/track faction <id>` to add one',
        '• Get faction IDs from the faction page URL',
      ].join('\n'))
      .setFooter({ text: 'Track your faction to monitor member activity!' });
  }
  
  const totalPages = Math.ceil(entries.length / perPage);
  const pageEntries = entries.slice(page * perPage, (page + 1) * perPage);
  
  const lines = pageEntries.map(([id, f]) => {
    const status = f.enabled === false ? EMOJI.off : EMOJI.on;
    const memberCount = Object.keys(f.members || {}).length;
    const states = f.states?.length
      ? f.states.map(s => EMOJI[s]).join('')
      : '`none`';
    
    const features = [
      f.offline?.enabled !== false ? `😴 >${f.offline?.hours || 24}h` : null,
      f.daily?.enabled !== false ? '📈 Daily' : null,
    ].filter(Boolean).join(' • ');
    
    return [
      `${status} **[${f.name || `Faction ${id}`}](${LINKS.faction(id)})** \`[${id}]\``,
      `┃ 👥 ${memberCount} members`,
      `┃ 🔔 ${states}`,
      features ? `┃ ${features}` : null,
    ].filter(Boolean).join('\n');
  });
  
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(`${EMOJI.faction} Tracked Factions (${entries.length})`)
    .setDescription(lines.join('\n\n'))
    .setFooter({
      text: totalPages > 1
        ? `Page ${page + 1}/${totalPages} • Select faction to configure`
        : 'Select a faction to configure',
    });
}

// ═══════════════════════════════════════════════════════════════
// PERSONAL ALERTS
// ═══════════════════════════════════════════════════════════════

function alertsConfig() {
  const { self } = store.data;
  
  const barLines = BARS.map(b => {
    const on = self.bars[b];
    const last = self.bars.last[b];
    const bar = last 
      ? progressBar(last.current || 0, last.maximum || 100, 10)
      : '`No data`';
    const link = BAR_LINKS[b] ? `[Use →](${BAR_LINKS[b]})` : '';
    
    return `${EMOJI[b]} **${capitalize(b)}** ${on ? EMOJI.on : EMOJI.off}\n┗ ${bar} ${link}`;
  });
  
  const cdLines = COOLDOWNS.map(c => {
    const on = self.cooldowns[c];
    const remaining = self.cooldowns.last[c] || 0;
    const status = remaining > 0 ? `⏱ ${formatTime(remaining)}` : '✅ Ready';
    const link = COOLDOWN_LINKS[c] ? `[Use →](${COOLDOWN_LINKS[c]})` : '';
    
    return `${EMOJI[c]} **${capitalize(c)}** ${on ? EMOJI.on : EMOJI.off}\n┗ ${status} ${link}`;
  });
  
  const chain = self.chain;
  const chainLine = chain.enabled
    ? `${EMOJI.on} **Enabled**\n┗ Min: **${chain.min}** • Alerts: ${chain.thresholds.map(formatTime).join(', ')}`
    : `${EMOJI.off} **Disabled**`;
  
  // Addiction config
  const addiction = self.addiction;
  const addictionDailyCheck = addiction.dailyCheck || {};
  const addictionLine = addiction.dailyCheck?.enabled
    ? `${EMOJI.on} **Enabled**\n┗ Threshold: **${addiction.threshold ?? -5}** • Check: **${String(addictionDailyCheck.hour ?? 18).padStart(2, '0')}:${String(addictionDailyCheck.minute ?? 10).padStart(2, '0')}** Torn time`
    : `${EMOJI.off} **Disabled**`;
  
  // Racing config
  const racing = self.racing;
  const racingLine = racing.enabled
    ? `${EMOJI.on} **Enabled**\n┗ Reminds you to join a race when not in one`
    : `${EMOJI.off} **Disabled**`;
  
  // Refill reminder config
  const refill = self.refill || {};
  const refillLine = refill.enabled
    ? `${EMOJI.on} **Enabled**\n┗ Alerts at 22:00, 23:00, 23:15, 23:30, 23:45, 23:50, 23:55 Torn time`
    : `${EMOJI.off} **Disabled**`;
  
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🔔 Personal Alerts')
    .setDescription('Get notified when your bars fill, cooldowns expire, or other events occur.')
    .addFields(
      { name: '⚡ Bar Alerts (full)', value: barLines.join('\n\n'), inline: false },
      { name: '💊 Cooldown Alerts (ready)', value: cdLines.join('\n\n'), inline: false },
      { name: '⛓️ Chain Alerts', value: chainLine, inline: false },
      { name: '⚠️ Addiction Daily Check', value: addictionLine, inline: false },
      { name: '🏎️ Racing Reminders', value: racingLine, inline: false },
      { name: '⚡ Energy Refill Reminder', value: refillLine, inline: false },
    )
    .setFooter({ text: 'Toggle with buttons below' })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS - State Changes
// ═══════════════════════════════════════════════════════════════

function stateChange(userId, name, oldState, newState, status, travel) {
  const lines = [];
  
  if (status?.description) {
    lines.push(`> ${status.description}`);
  }
  
  if (newState === 'Traveling' && travel?.earliest) {
    const eta = getETA(travel);
    lines.push(
      '',
      `✈️ ${formatDestination(travel)}`,
      `**ETA:** ${discordTimestamp(eta, 'R')}`,
    );
  } else if (newState === 'Jail' && status?.until) {
    const until = Number(status.until);
    lines.push(
      '',
      `**Released:** ${discordTimestamp(until, 'R')}`,
      `🔗 [View in Jail](${LINKS.jail})`,
    );
  } else if (newState === 'Hospital' && status?.until) {
    const until = Number(status.until);
    lines.push(
      '',
      `**Discharged:** ${discordTimestamp(until, 'R')}`,
      `🔗 [View in Hospital](${LINKS.hospital})`,
    );
  } else if (newState === 'Okay' && oldState !== 'Okay') {
    lines.push('', `🎯 **[Attack Now!](${LINKS.attack(userId)})**`);
  }
  
  return new EmbedBuilder()
    .setColor(COLORS[newState] || COLORS.brand)
    .setTitle(`${EMOJI[newState] || EMOJI.Unknown} ${name} → ${newState}`)
    .setURL(LINKS.profile(userId))
    .setDescription(lines.join('\n') || null)
    .addFields({
      name: 'Previous',
      value: `${EMOJI[oldState] || EMOJI.Unknown} ${oldState || 'Unknown'}`,
      inline: true,
    })
    .setFooter({ text: `ID: ${userId}` })
    .setTimestamp();
}

function preAlert(name, userId, state, endAt, left) {
  const stateLinks = {
    Jail: `[View in Jail](${LINKS.jail})`,
    Hospital: `[View in Hospital](${LINKS.hospital})`,
    Traveling: `[Travel Agency](${LINKS.travel})`,
  };
  
  return new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle(`⏰ ${name} - ${state} ending soon!`)
    .setURL(LINKS.profile(userId))
    .setDescription([
      `**Ends:** ${discordTimestamp(endAt, 'R')} (${discordTimestamp(endAt, 't')})`,
      `**Time left:** ~${formatTime(left)}`,
      '',
      `🎯 [Attack](${LINKS.attack(userId)})`,
      stateLinks[state] || '',
    ].filter(Boolean).join('\n'))
    .setFooter({ text: `ID: ${userId} • Get ready!` })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS - Personal Alerts
// ═══════════════════════════════════════════════════════════════

function barFull(kind, bar) {
  const action = BAR_ACTIONS[kind] || { text: '', link: '' };
  
  return new EmbedBuilder()
    .setColor(COLORS.good)
    .setTitle(`${EMOJI[kind]} ${capitalize(kind)} is FULL!`)
    .setDescription([
      progressBar(bar.current, bar.maximum, 20),
      `**${formatNumber(bar.current)}** / **${formatNumber(bar.maximum)}**`,
      '',
      action.text,
      action.link ? `🔗 [Go Now →](${action.link})` : '',
    ].filter(Boolean).join('\n'))
    .setTimestamp();
}

function cooldownReady(kind) {
  const action = COOLDOWN_ACTIONS[kind] || { text: 'Cooldown ready!', link: '' };
  
  return new EmbedBuilder()
    .setColor(COLORS.good)
    .setTitle(`${EMOJI[kind]} ${capitalize(kind)} Cooldown Ready!`)
    .setDescription([
      action.text,
      action.link ? `🔗 [Use Now →](${action.link})` : '',
    ].filter(Boolean).join('\n'))
    .setTimestamp();
}

function chainAlert(chain, threshold) {
  const urgent = chain.timeout <= 30;
  const bar = progressBar(chain.timeout, 300, 20, { showValues: false });
  const pct = Math.round((chain.timeout / 300) * 100);
  
  return new EmbedBuilder()
    .setColor(urgent ? COLORS.bad : COLORS.warn)
    .setTitle(`${urgent ? '🚨' : EMOJI.chain} Chain Alert! ${urgent ? '🚨' : ''}`)
    .setDescription([
      `**Chain:** ${formatNumber(chain.current)} / ${formatNumber(chain.maximum)}`,
      `**Time Left:** ${formatTime(chain.timeout)} (${pct}%)`,
      '',
      bar,
      '',
      urgent ? '⚠️ **CHAIN ABOUT TO DROP!**' : `Alert at: ${formatTime(threshold)}`,
    ].join('\n'))
    .setTimestamp();
}

function addictionRehabAlert(addiction, threshold) {
  // Calculate tomorrow 4pm Torn time (UTC)
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    16, 0, 0 // 4:00pm UTC
  ));
  const tomorrowTimestamp = Math.floor(tomorrow.getTime() / 1000);
  
  return new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle('⚠️ Company Addiction Alert')
    .setDescription([
      `**Current Addiction:** ${addiction}`,
      `**Threshold:** ${threshold}`,
      '',
      '⚠️ **Go to rehab before tomorrow 4pm!**',
      `**Deadline:** ${discordTimestamp(tomorrowTimestamp, 'R')} (${discordTimestamp(tomorrowTimestamp, 't')})`,
      '',
      '🔗 [Rehab](https://www.torn.com/city.php#rehab)',
    ].join('\n'))
    .setTimestamp();
}

function racingJoinReminder() {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🏎️ Racing Reminder')
    .setDescription([
      'You are not currently in a race.',
      '',
      '🔗 [Join a Race](https://www.torn.com/loader.php?sid=racing)',
    ].join('\n'))
    .setTimestamp();
}

function refillReminder() {
  // Show when the Torn day resets (midnight UTC)
  const now = new Date();
  const midnight = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
    0, 0, 0
  ));
  const midnightTs = Math.floor(midnight.getTime() / 1000);

  return new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle('⚡ Energy Refill Reminder!')
    .setDescription([
      "You haven't used your **daily energy refill** yet!",
      '',
      `⏰ Resets ${discordTimestamp(midnightTs, 'R')} at ${discordTimestamp(midnightTs, 't')} Torn time`,
      '',
      `🔗 [Use Refill Now](${LINKS.pointsBuilding})`,
    ].join('\n'))
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS - Faction Alerts
// ═══════════════════════════════════════════════════════════════

function factionMemberChange(fName, fid, uid, member, oldState, newState, travel) {
  const lines = [`**Faction:** [${fName}](${LINKS.faction(fid)})`];
  
  if (newState === 'Traveling' && travel?.earliest) {
    const eta = getETA(travel);
    lines.push('', `✈️ ${formatDestination(travel)}`, `**ETA:** ${discordTimestamp(eta, 'R')}`);
  } else if (newState === 'Jail' && member?.status?.until) {
    lines.push('', `**Released:** ${discordTimestamp(Number(member.status.until), 'R')}`);
  } else if (newState === 'Hospital' && member?.status?.until) {
    lines.push('', `**Discharged:** ${discordTimestamp(Number(member.status.until), 'R')}`);
  } else if (newState === 'Okay' && ['Jail', 'Hospital'].includes(oldState)) {
    lines.push('', `🎯 [Attack](${LINKS.attack(uid)})`);
  }
  
  return new EmbedBuilder()
    .setColor(COLORS[newState] || COLORS.brand)
    .setTitle(`${EMOJI[newState] || EMOJI.Unknown} ${member.name} → ${newState}`)
    .setURL(LINKS.profile(uid))
    .setDescription(lines.join('\n'))
    .addFields({
      name: 'Previous',
      value: `${EMOJI[oldState] || EMOJI.Unknown} ${oldState || 'Unknown'}`,
      inline: true,
    })
    .setFooter({ text: `Member ID: ${uid}` })
    .setTimestamp();
}

function factionJoinLeave(type, fName, fid, uid, name) {
  const isJoin = type === 'join';
  
  return new EmbedBuilder()
    .setColor(isJoin ? COLORS.good : COLORS.bad)
    .setTitle(`${isJoin ? '🟢 Member Joined' : '🔴 Member Left'}`)
    .setURL(LINKS.profile(uid))
    .setDescription([
      `**${name}** has ${isJoin ? 'joined' : 'left'} **${fName}**`,
      '',
      `👤 [Profile](${LINKS.profile(uid)})`,
      `🏴 [Faction](${LINKS.faction(fid)})`,
    ].join('\n'))
    .setFooter({ text: `ID: ${uid}` })
    .setTimestamp();
}

function factionOffline(fName, fid, uid, name, lastTs, hours) {
  const lastSeen = Number(lastTs);
  const offlineHours = Math.floor((Date.now() / 1000 - lastSeen) / 3600);
  
  return new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle(`😴 ${name} - Inactive`)
    .setURL(LINKS.profile(uid))
    .setDescription([
      `**Faction:** [${fName}](${LINKS.faction(fid)})`,
      '',
      `**Last seen:** ${discordTimestamp(lastSeen, 'R')}`,
      `**Offline:** ~${offlineHours} hours`,
      '',
      `⚠️ Exceeds ${hours}h threshold`,
    ].join('\n'))
    .setFooter({ text: `ID: ${uid}` })
    .setTimestamp();
}

function factionDaily(fName, fid, delta, total) {
  const up = delta >= 0;
  
  return new EmbedBuilder()
    .setColor(up ? COLORS.good : COLORS.warn)
    .setTitle(`📊 ${fName} - Daily Report`)
    .setURL(LINKS.faction(fid))
    .setDescription([
      `${up ? '📈' : '📉'} **${up ? '+' : ''}${formatNumber(delta)}** respect today`,
      `**Total:** ${formatNumber(total)} respect`,
    ].join('\n'))
    .setTimestamp();
}

function factionMilestone(fName, fid, respect) {
  const milestone = Math.floor(respect / 100000) * 100000;
  
  return new EmbedBuilder()
    .setColor(COLORS.good)
    .setTitle('🎉 Milestone Reached!')
    .setURL(LINKS.faction(fid))
    .setDescription([
      `**${fName}** hit **${formatNumber(milestone)}** respect!`,
      '',
      '🎊 Congratulations!',
    ].join('\n'))
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
// HELP & UTILITY
// ═══════════════════════════════════════════════════════════════

function help() {
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('📖 Torn Tracker Help')
    .setDescription('Track players, factions, and get personal alerts.')
    .addFields(
      {
        name: '📊 Overview',
        value: [
          '`/dashboard` - Main control panel',
          '`/status <id>` - Quick status check',
        ].join('\n'),
        inline: false,
      },
      {
        name: '👤 User Tracking',
        value: [
          '`/track user <id>` - Add user',
          '  `alerts`: States (jail, hospital, okay, traveling)',
          '  `warn`: Early warnings (5m, 2m)',
          '`/remove <id>` - Stop tracking',
          '`/delay <id> <time>` - Add travel delay',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🏴 Faction Tracking',
        value: [
          '`/track faction <id>` - Add faction',
          '  `offline`: Hours before alert (default: 24)',
          '`/remove <id>` - Stop tracking',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🔔 Personal Alerts',
        value: [
          '`/alerts` - Configure bar/cooldown/chain alerts',
          '',
          '**Quick Links:**',
          `[Drugs](${LINKS.drugs}) • [Boosters](${LINKS.boosters}) • [Alcohol](${LINKS.alcohol})`,
          `[Medical](${LINKS.medical}) • [Gym](${LINKS.gym}) • [Crimes](${LINKS.crimes})`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '💡 Tips',
        value: [
          '• **Times:** `5m`, `1h30m`, `90s`',
          '• **States:** `okay`, `hospital`, `jail`, `traveling`',
          '• Use button menus for easy configuration!',
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: 'Most settings available through button menus!' })
    .setTimestamp();
}

function error(title, message, suggestion = null) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.bad)
    .setTitle(`${EMOJI.error} ${title}`)
    .setDescription(message);
  
  if (suggestion) {
    embed.addFields({ name: '💡 Suggestion', value: suggestion, inline: false });
  }
  
  return embed.setTimestamp();
}

function success(title, message) {
  return new EmbedBuilder()
    .setColor(COLORS.good)
    .setTitle(`${EMOJI.success} ${title}`)
    .setDescription(message)
    .setTimestamp();
}

function loading(message = 'Loading...') {
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setDescription(`${EMOJI.loading} ${message}`);
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Dashboard
  dashboard,
  
  // Users
  userList,
  userStatus,
  
  // Factions
  factionList,
  
  // Alerts config
  alertsConfig,
  
  // Notifications - User
  stateChange,
  preAlert,
  
  // Notifications - Personal
  barFull,
  cooldownReady,
  chainAlert,
  addictionRehabAlert,
  racingJoinReminder,
  refillReminder,
  
  // Notifications - Faction
  factionMemberChange,
  factionJoinLeave,
  factionOffline,
  factionDaily,
  factionMilestone,
  
  // Utility
  help,
  error,
  success,
  loading,
};