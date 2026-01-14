const config = require('../config');
const store = require('../services/store');
const api = require('../services/api');
const Embeds = require('./embeds');
const Components = require('./components');
const Modals = require('./modals');
const { parseStates, parseTimes, parseTime, formatTime } = require('../utils');
const { createTravelInfo } = require('../utils/travel');
const { COLORS } = require('../config/constants');
const { EmbedBuilder } = require('discord.js');

// Forward declaration - will be set by index.js
let startPollers = () => {};

function setPollerStarter(fn) {
  startPollers = fn;
}

/**
 * Handle all Discord interactions
 */
async function handleInteraction(interaction) {
  // Owner check
  if (interaction.user.id !== config.discord.ownerId) {
    return interaction.reply?.({ 
      content: '🔒 This bot is owner-only.', 
      ephemeral: true,
    }).catch(() => {});
  }
  
  const ephemeral = interaction.inGuild();
  
  try {
    if (interaction.isModalSubmit()) {
      await handleModal(interaction, ephemeral);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelect(interaction);
    } else if (interaction.isChatInputCommand()) {
      await handleCommand(interaction, ephemeral);
    }
  } catch (error) {
    console.error('[handler]', error);
    
    const msg = `❌ ${error.message}`;
    
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// MODAL HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleModal(i, ephemeral) {
  const [, type, id] = i.customId.split(':');
  
  await i.deferUpdate().catch(() => i.deferReply({ ephemeral }));
  
  switch (type) {
    case 'adduser': {
      const userId = i.fields.getTextInputValue('user_id').trim();
      const states = parseStates(i.fields.getTextInputValue('states') || 'all');
      const warn = parseTimes(i.fields.getTextInputValue('warn'));
      
      if (store.watchers[userId]) {
        return i.editReply({ content: '⚠️ Already tracking this user' });
      }
      
      let profile;
      try {
        profile = await api.getProfile(userId);
      } catch {
        return i.editReply({ content: '❌ User not found' });
      }
      
      store.watchers[userId] = {
        name: profile.name,
        states,
        preTimesSec: warn.length ? warn : undefined,
        enabled: true,
        lastState: profile.status?.state || 'Okay',
        preFired: {},
        travel: profile.status?.state === 'Traveling' 
          ? createTravelInfo(profile.status) 
          : null,
      };
      
      store.save('add-user');
      startPollers();
      
      return i.editReply({
        content: `✅ Now tracking **${profile.name}**`,
        embeds: [Embeds.userStatus(userId, profile, store.watchers[userId])],
        components: Components.userConfig(userId),
      });
    }
    
    case 'addfaction': {
      const fid = i.fields.getTextInputValue('faction_id').trim();
      const states = parseStates(i.fields.getTextInputValue('states') || 'all');
      const offline = parseInt(i.fields.getTextInputValue('offline')) || config.defaults.offlineHours;
      
      if (store.factions.items[fid]) {
        return i.editReply({ content: '⚠️ Already tracking this faction' });
      }
      
      let data;
      try {
        data = await api.getFaction(fid);
      } catch {
        return i.editReply({ content: '❌ Faction not found' });
      }
      
      store.factions.items[fid] = {
        id: fid,
        name: data.name,
        tag: data.tag,
        enabled: true,
        states,
        members: {},
        offline: { enabled: true, hours: offline },
        daily: { enabled: true },
      };
      
      store.save('add-faction');
      startPollers();
      
      return i.editReply({
        content: `✅ Now tracking **${data.name}** (${Object.keys(data.members || {}).length} members)`,
        components: Components.factionConfig(fid),
      });
    }
    
    case 'chain': {
      const min = parseInt(i.fields.getTextInputValue('min')) || 10;
      const thresholds = parseTimes(i.fields.getTextInputValue('thresholds'));
      
      store.self.chain.min = min;
      if (thresholds.length) {
        store.self.chain.thresholds = thresholds;
      }
      
      store.save('chain-config');
      
      return i.editReply({
        embeds: [Embeds.alertsConfig()],
        components: Components.alertsButtons(),
      });
    }
    
    case 'userwarn': {
      const warn = parseTimes(i.fields.getTextInputValue('warn'));
      const cfg = store.watchers[id];
      
      if (cfg) {
        cfg.preTimesSec = warn.length ? warn : undefined;
        store.save('user-warn');
      }
      
      const profile = await api.getProfile(id).catch(() => null);
      
      return i.editReply({
        embeds: [Embeds.userStatus(id, profile, cfg)],
        components: Components.userConfig(id),
      });
    }
    
    case 'factionwarn': {
      const warn = parseTimes(i.fields.getTextInputValue('warn'));
      const f = store.factions.items[id];
      
      if (f) {
        f.preTimesSec = warn.length ? warn : undefined;
        store.save('faction-warn');
      }
      
      return i.editReply({
        embeds: [Embeds.factionList()],
        components: Components.factionConfig(id),
      });
    }
    
    case 'factionoffline': {
      const hours = parseInt(i.fields.getTextInputValue('hours')) || config.defaults.offlineHours;
      const f = store.factions.items[id];
      
      if (f) {
        f.offline = f.offline || {};
        f.offline.hours = hours;
        store.save('faction-offline');
      }
      
      return i.editReply({
        components: Components.factionConfig(id),
      });
    }
    
    case 'delay': {
      const time = parseTime(i.fields.getTextInputValue('time')) || 0;
      const cfg = store.watchers[id];
      
      if (cfg?.travel) {
        cfg.travel.earliest = (cfg.travel.earliest || 0) + time;
        cfg.travel.latest = (cfg.travel.latest || 0) + time;
        store.save('delay');
      }
      
      const profile = await api.getProfile(id).catch(() => null);
      
      return i.editReply({
        content: `✅ Added ${formatTime(time)} delay`,
        embeds: [Embeds.userStatus(id, profile, cfg)],
      });
    }
    
    default:
      return i.editReply({ content: '❌ Unknown modal type' });
  }
}

// ═══════════════════════════════════════════════════════════════
// BUTTON HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleButton(i) {
  const [action, type, id] = i.customId.split(':');
  
  // Dashboard navigation
  if (action === 'dash') {
    await i.deferUpdate();
    
    switch (type) {
      case 'main':
      case 'refresh':
        return i.editReply({
          embeds: [Embeds.dashboard()],
          components: Components.dashboardButtons(),
        });
      
      case 'users':
        return i.editReply({
          embeds: [Embeds.userList()],
          components: Components.userListMenu(),
        });
      
      case 'factions':
        return i.editReply({
          embeds: [Embeds.factionList()],
          components: Components.factionListMenu(),
        });
      
      case 'alerts':
        return i.editReply({
          embeds: [Embeds.alertsConfig()],
          components: Components.alertsButtons(),
        });
    }
  }
  
  // Modal triggers
  if (action === 'modal') {
    switch (type) {
      case 'adduser':
        return i.showModal(Modals.addUser());
      case 'addfaction':
        return i.showModal(Modals.addFaction());
      case 'chain':
        return i.showModal(Modals.chainConfig());
      case 'userwarn':
        return i.showModal(Modals.userWarn(id));
      case 'factionwarn':
        return i.showModal(Modals.factionWarn(id));
      case 'factionoffline':
        return i.showModal(Modals.factionOffline(id));
      case 'delay':
        return i.showModal(Modals.delay(id));
    }
  }
  
  // Toggle actions
  if (action === 'toggle') {
    await i.deferUpdate();
    
    switch (type) {
      case 'bar': {
        store.self.bars[id] = !store.self.bars[id];
        store.save('toggle-bar');
        startPollers();
        
        return i.editReply({
          embeds: [Embeds.alertsConfig()],
          components: Components.alertsButtons(),
        });
      }
      
      case 'cd': {
        store.self.cooldowns[id] = !store.self.cooldowns[id];
        store.save('toggle-cd');
        startPollers();
        
        return i.editReply({
          embeds: [Embeds.alertsConfig()],
          components: Components.alertsButtons(),
        });
      }

      case 'icon': {
        store.self.icons[id] = !store.self.icons[id];
        store.save('toggle-icon');
        startPollers();
        
        return i.editReply({
          embeds: [Embeds.alertsConfig()],
          components: Components.alertsButtons(),
        });
      }
      
      case 'addiction': {
        store.self.addiction.enabled = !store.self.addiction.enabled;
        store.save('toggle-addiction');
        startPollers();
        
        return i.editReply({
          embeds: [Embeds.alertsConfig()],
          components: Components.alertsButtons(),
        });
      }
      
      case 'chain': {
        store.self.chain.enabled = !store.self.chain.enabled;
        store.save('toggle-chain');
        startPollers();
        
        return i.editReply({
          embeds: [Embeds.alertsConfig()],
          components: Components.alertsButtons(),
        });
      }
      
      case 'user': {
        const cfg = store.watchers[id];
        if (cfg) {
          cfg.enabled = cfg.enabled === false;
        }
        store.save('toggle-user');
        startPollers();
        
        const profile = await api.getProfile(id).catch(() => null);
        
        return i.editReply({
          embeds: [Embeds.userStatus(id, profile, cfg)],
          components: Components.userConfig(id),
        });
      }
      
      case 'faction': {
        const f = store.factions.items[id];
        if (f) {
          f.enabled = f.enabled === false;
        }
        store.save('toggle-faction');
        startPollers();
        
        return i.editReply({
          components: Components.factionConfig(id),
        });
      }
      
      case 'foffline': {
        const f = store.factions.items[id];
        if (f) {
          f.offline = f.offline || {};
          f.offline.enabled = f.offline.enabled === false;
        }
        store.save('toggle-foffline');
        
        return i.editReply({
          components: Components.factionConfig(id),
        });
      }
      
      case 'fdaily': {
        const f = store.factions.items[id];
        if (f) {
          f.daily = f.daily || {};
          f.daily.enabled = f.daily.enabled === false;
        }
        store.save('toggle-fdaily');
        
        return i.editReply({
          components: Components.factionConfig(id),
        });
      }
    }
  }
  
  // Remove actions
  if (action === 'remove') {
    await i.deferUpdate();
    
    if (type === 'user') {
      delete store.watchers[id];
      store.save('remove-user');
      startPollers();
      
      return i.editReply({
        content: '✅ User removed',
        embeds: [Embeds.userList()],
        components: Components.userListMenu(),
      });
    }
    
    if (type === 'faction') {
      delete store.factions.items[id];
      store.save('remove-faction');
      startPollers();
      
      return i.editReply({
        content: '✅ Faction removed',
        embeds: [Embeds.factionList()],
        components: Components.factionListMenu(),
      });
    }
  }
  
  // Refresh actions
  if (action === 'refresh') {
    await i.deferUpdate();
    
    if (type === 'user') {
      const cfg = store.watchers[id];
      const profile = await api.getProfile(id).catch(() => null);
      
      if (profile && cfg) {
        cfg.name = profile.name;
        cfg.lastState = profile.status?.state;
        if (profile.status?.state === 'Traveling') {
          cfg.travel = createTravelInfo(profile.status);
        }
        store.save('refresh');
      }
      
      return i.editReply({
        embeds: [Embeds.userStatus(id, profile, cfg)],
        components: Components.userConfig(id),
      });
    }
  }
  
  // Alerts refresh
  if (action === 'alerts' && type === 'refresh') {
    await i.deferUpdate();
    
    // Import and call poll functions
    const { pollBars, pollCooldowns } = require('../pollers/self');
    await pollBars().catch(() => {});
    await pollCooldowns().catch(() => {});
    
    return i.editReply({
      embeds: [Embeds.alertsConfig()],
      components: Components.alertsButtons(),
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// SELECT MENU HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleSelect(i) {
  await i.deferUpdate();
  
  const [type, id] = i.customId.split(':');
  
  if (type === 'select') {
    if (id === 'user') {
      const userId = i.values[0];
      const cfg = store.watchers[userId];
      const profile = await api.getProfile(userId).catch(() => null);
      
      return i.editReply({
        embeds: [Embeds.userStatus(userId, profile, cfg)],
        components: Components.userConfig(userId),
      });
    }
    
    if (id === 'faction') {
      const fid = i.values[0];
      
      return i.editReply({
        components: Components.factionConfig(fid),
      });
    }
  }
  
  // State selection for users
  if (type === 'states') {
    const cfg = store.watchers[id];
    if (cfg) {
      cfg.states = i.values;
    }
    store.save('states');
    
    const profile = await api.getProfile(id).catch(() => null);
    
    return i.editReply({
      embeds: [Embeds.userStatus(id, profile, cfg)],
      components: Components.userConfig(id),
    });
  }
  
  // State selection for factions
  if (type === 'fstates') {
    const f = store.factions.items[id];
    if (f) {
      f.states = i.values;
    }
    store.save('fstates');
    
    return i.editReply({
      components: Components.factionConfig(id),
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// SLASH COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleCommand(i, ephemeral) {
  await i.deferReply({ ephemeral });
  
  switch (i.commandName) {
    case 'dashboard':
      return i.editReply({
        embeds: [Embeds.dashboard()],
        components: Components.dashboardButtons(),
      });
    
    case 'help':
      return i.editReply({
        embeds: [Embeds.help()],
      });
    
    case 'alerts':
      return i.editReply({
        embeds: [Embeds.alertsConfig()],
        components: Components.alertsButtons(),
      });
    
    case 'track':
      return handleTrackCommand(i);
    
    case 'status':
      return handleStatusCommand(i);
    
    case 'remove':
      return handleRemoveCommand(i);
    
    case 'delay':
      return handleDelayCommand(i);
    
    default:
      return i.editReply({ content: '❌ Unknown command' });
  }
}

async function handleTrackCommand(i) {
  const sub = i.options.getSubcommand();
  
  if (sub === 'user') {
    const userId = String(i.options.getInteger('id'));
    const states = parseStates(i.options.getString('alerts'));
    const warn = parseTimes(i.options.getString('warn'));
    
    if (store.watchers[userId]) {
      return i.editReply({ content: '⚠️ Already tracking this user' });
    }
    
    let profile;
    try {
      profile = await api.getProfile(userId);
    } catch {
      return i.editReply({ content: '❌ User not found' });
    }
    
    store.watchers[userId] = {
      name: profile.name,
      states,
      preTimesSec: warn.length ? warn : undefined,
      enabled: true,
      lastState: profile.status?.state || 'Okay',
      preFired: {},
      travel: profile.status?.state === 'Traveling' 
        ? createTravelInfo(profile.status) 
        : null,
    };
    
    store.save('add');
    startPollers();
    
    return i.editReply({
      embeds: [Embeds.userStatus(userId, profile, store.watchers[userId])],
      components: Components.userConfig(userId),
    });
  }
  
  if (sub === 'faction') {
    const fid = String(i.options.getInteger('id'));
    const states = parseStates(i.options.getString('alerts'));
    const warn = parseTimes(i.options.getString('warn'));
    const offline = i.options.getInteger('offline') || config.defaults.offlineHours;
    
    if (store.factions.items[fid]) {
      return i.editReply({ content: '⚠️ Already tracking this faction' });
    }
    
    let data;
    try {
      data = await api.getFaction(fid);
    } catch {
      return i.editReply({ content: '❌ Faction not found' });
    }
    
    store.factions.items[fid] = {
      id: fid,
      name: data.name,
      enabled: true,
      states,
      preTimesSec: warn.length ? warn : undefined,
      members: {},
      offline: { enabled: true, hours: offline },
      daily: { enabled: true },
    };
    
    store.save('add-faction');
    startPollers();
    
    return i.editReply({
      content: `✅ Tracking **${data.name}**`,
      components: Components.factionConfig(fid),
    });
  }
}

async function handleStatusCommand(i) {
  const id = String(i.options.getInteger('id'));
  
  // Try user first
  try {
    const profile = await api.getProfile(id);
    const cfg = store.watchers[id];
    
    return i.editReply({
      embeds: [Embeds.userStatus(id, profile, cfg)],
      components: cfg 
        ? Components.userConfig(id) 
        : Components.quickActions(id, profile.status?.state),
    });
  } catch {}
  
  // Try faction
  try {
    const data = await api.getFaction(id);
    const f = store.factions.items[id];
    const memberCount = Object.keys(data.members || {}).length;
    
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(`🏴 ${data.name}`)
      .addFields(
        { name: 'Members', value: String(memberCount), inline: true },
        { name: 'Respect', value: Number(data.respect || 0).toLocaleString(), inline: true },
        { 
          name: 'Tracking', 
          value: f 
            ? (f.enabled === false ? '🔴 Paused' : '🟢 Active') 
            : 'Not tracked', 
          inline: true,
        },
      );
    
    return i.editReply({
      embeds: [embed],
      components: f ? Components.factionConfig(id) : [],
    });
  } catch {}
  
  return i.editReply({ content: '❌ Not found' });
}

async function handleRemoveCommand(i) {
  const id = String(i.options.getInteger('id'));
  
  if (store.watchers[id]) {
    delete store.watchers[id];
    store.save('remove');
    startPollers();
    return i.editReply({ content: '✅ User removed' });
  }
  
  if (store.factions.items[id]) {
    delete store.factions.items[id];
    store.save('remove');
    startPollers();
    return i.editReply({ content: '✅ Faction removed' });
  }
  
  return i.editReply({ content: '❌ Not found' });
}

async function handleDelayCommand(i) {
  const id = String(i.options.getInteger('id'));
  const time = parseTime(i.options.getString('time')) || 0;
  
  const cfg = store.watchers[id];
  if (!cfg?.travel) {
    return i.editReply({ content: '❌ User not traveling' });
  }
  
  cfg.travel.earliest = (cfg.travel.earliest || 0) + time;
  cfg.travel.latest = (cfg.travel.latest || 0) + time;
  store.save('delay');
  
  const profile = await api.getProfile(id).catch(() => null);
  
  return i.editReply({
    content: `✅ Added ${formatTime(time)} delay`,
    embeds: [Embeds.userStatus(id, profile, cfg)],
  });
}

module.exports = {
  handleInteraction,
  setPollerStarter,
};