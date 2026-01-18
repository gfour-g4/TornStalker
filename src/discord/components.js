const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
  } = require('discord.js');
  const store = require('../services/store');
  const { STATES, BARS, COOLDOWNS, EMOJI, LINKS } = require('../config/constants');
  const { capitalize } = require('../utils');
  
  // ═══════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════
  
  function dashboardButtons() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash:users')
          .setLabel('Users')
          .setEmoji('👤')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('dash:factions')
          .setLabel('Factions')
          .setEmoji('🏴')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('dash:alerts')
          .setLabel('Personal Alerts')
          .setEmoji('🔔')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('dash:refresh')
          .setLabel('Refresh')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
  }
  
  // ═══════════════════════════════════════════════════════════════
  // USER LIST
  // ═══════════════════════════════════════════════════════════════
  
  function userListMenu() {
    const entries = Object.entries(store.watchers).slice(0, 25);
    
    const rows = [];
    
    if (entries.length) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select:user')
            .setPlaceholder('Select a user to configure...')
            .addOptions(entries.map(([id, cfg]) => ({
              label: cfg.name || `User ${id}`,
              description: `${cfg.enabled === false ? 'Paused' : 'Active'} • ${cfg.lastState || 'Unknown'}`,
              value: id,
              emoji: cfg.enabled === false ? EMOJI.off : EMOJI.on,
            }))),
        ),
      );
    }
    
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash:main')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('modal:adduser')
          .setLabel('Add User')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success),
      ),
    );
    
    return rows;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FACTION LIST
  // ═══════════════════════════════════════════════════════════════
  
  function factionListMenu() {
    const entries = Object.entries(store.factions.items).slice(0, 25);
    
    const rows = [];
    
    if (entries.length) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select:faction')
            .setPlaceholder('Select a faction to configure...')
            .addOptions(entries.map(([id, f]) => ({
              label: f.name || `Faction ${id}`,
              description: `${Object.keys(f.members || {}).length} members`,
              value: id,
              emoji: f.enabled === false ? EMOJI.off : EMOJI.on,
            }))),
        ),
      );
    }
    
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash:main')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('modal:addfaction')
          .setLabel('Add Faction')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success),
      ),
    );
    
    return rows;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // ALERTS CONFIG
  // ═══════════════════════════════════════════════════════════════
  
  function alertsButtons() {
    const { self } = store.data;
    
    const barRow = new ActionRowBuilder().addComponents(
      ...BARS.map(b =>
        new ButtonBuilder()
          .setCustomId(`toggle:bar:${b}`)
          .setLabel(capitalize(b))
          .setEmoji(EMOJI[b])
          .setStyle(self.bars[b] ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    );
    
    const cdRow = new ActionRowBuilder().addComponents(
      ...COOLDOWNS.map(c =>
        new ButtonBuilder()
          .setCustomId(`toggle:cd:${c}`)
          .setLabel(capitalize(c))
          .setEmoji(EMOJI[c])
          .setStyle(self.cooldowns[c] ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    );
    
    const chainRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('toggle:chain')
        .setLabel('Chain Alerts')
        .setEmoji(EMOJI.chain)
        .setStyle(self.chain.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('modal:chain')
        .setLabel('Configure')
        .setEmoji('⚙️')
        .setStyle(ButtonStyle.Primary),
    );
    
    // Combine addiction and racing into one row to stay within Discord's 5-row limit
    const addictionRacingRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('toggle:addiction')
        .setLabel('Addiction Check')
        .setEmoji('⚠️')
        .setStyle((self.addiction.dailyCheck?.enabled) ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('modal:addiction')
        .setLabel('Configure')
        .setEmoji('⚙️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('toggle:racing')
        .setLabel('Racing Reminders')
        .setEmoji('🏎️')
        .setStyle(self.racing.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
    
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('dash:main')
        .setLabel('Back')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('alerts:refresh')
        .setLabel('Refresh Data')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Primary),
    );
    
    return [barRow, cdRow, chainRow, addictionRacingRow, navRow];
  }
  
  // ═══════════════════════════════════════════════════════════════
  // USER CONFIG
  // ═══════════════════════════════════════════════════════════════
  
  function userConfig(userId) {
    const cfg = store.watchers[userId];
    if (!cfg) return [];
    
    const stateRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`states:${userId}`)
        .setPlaceholder('Select alert states...')
        .setMinValues(0)
        .setMaxValues(STATES.length)
        .addOptions(STATES.map(s => ({
          label: s,
          value: s,
          emoji: EMOJI[s],
          default: cfg.states?.includes(s),
        }))),
    );
    
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`toggle:user:${userId}`)
        .setLabel(cfg.enabled === false ? 'Enable' : 'Pause')
        .setStyle(cfg.enabled === false ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`modal:userwarn:${userId}`)
        .setLabel('Warnings')
        .setEmoji('⏰')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`refresh:user:${userId}`)
        .setLabel('Refresh')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`remove:user:${userId}`)
        .setLabel('Remove')
        .setStyle(ButtonStyle.Danger),
    );
    
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('dash:users')
        .setLabel('Back')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setURL(LINKS.profile(userId))
        .setLabel('Torn Profile')
        .setStyle(ButtonStyle.Link),
      new ButtonBuilder()
        .setURL(LINKS.attack(userId))
        .setLabel('Attack')
        .setStyle(ButtonStyle.Link),
    );
    
    return [stateRow, actionRow, navRow];
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FACTION CONFIG
  // ═══════════════════════════════════════════════════════════════
  
  function factionConfig(factionId) {
    const f = store.factions.items[factionId];
    if (!f) return [];
    
    const stateRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`fstates:${factionId}`)
        .setPlaceholder('Select alert states...')
        .setMinValues(0)
        .setMaxValues(STATES.length)
        .addOptions(STATES.map(s => ({
          label: s,
          value: s,
          emoji: EMOJI[s],
          default: f.states?.includes(s),
        }))),
    );
    
    const featureRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`toggle:faction:${factionId}`)
        .setLabel(f.enabled === false ? 'Enable' : 'Pause')
        .setStyle(f.enabled === false ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`toggle:foffline:${factionId}`)
        .setLabel(`Offline (${f.offline?.hours || 24}h)`)
        .setEmoji('😴')
        .setStyle(f.offline?.enabled !== false ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`toggle:fdaily:${factionId}`)
        .setLabel('Daily')
        .setEmoji('📈')
        .setStyle(f.daily?.enabled !== false ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
    
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`modal:factionwarn:${factionId}`)
        .setLabel('Warnings')
        .setEmoji('⏰')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`modal:factionoffline:${factionId}`)
        .setLabel('Offline Hours')
        .setEmoji('⚙️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`remove:faction:${factionId}`)
        .setLabel('Remove')
        .setStyle(ButtonStyle.Danger),
    );
    
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('dash:factions')
        .setLabel('Back')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setURL(LINKS.faction(factionId))
        .setLabel('View Faction')
        .setStyle(ButtonStyle.Link),
    );
    
    return [stateRow, featureRow, actionRow, navRow];
  }
  
  // ═══════════════════════════════════════════════════════════════
  // QUICK ACTIONS
  // ═══════════════════════════════════════════════════════════════
  
  function quickActions(userId, state) {
    const buttons = [
      new ButtonBuilder()
        .setCustomId(`refresh:user:${userId}`)
        .setLabel('Refresh')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    ];
    
    if (state === 'Traveling') {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`modal:delay:${userId}`)
          .setLabel('Add Delay')
          .setEmoji('⏱️')
          .setStyle(ButtonStyle.Primary),
      );
    }
    
    buttons.push(
      new ButtonBuilder()
        .setURL(LINKS.profile(userId))
        .setLabel('Profile')
        .setStyle(ButtonStyle.Link),
      new ButtonBuilder()
        .setURL(LINKS.attack(userId))
        .setLabel('Attack')
        .setStyle(ButtonStyle.Link),
    );
    
    return [new ActionRowBuilder().addComponents(buttons)];
  }
  
  // ═══════════════════════════════════════════════════════════════
  // EXPORTS
  // ═══════════════════════════════════════════════════════════════
  
  module.exports = {
    dashboardButtons,
    userListMenu,
    factionListMenu,
    alertsButtons,
    userConfig,
    factionConfig,
    quickActions,
  };