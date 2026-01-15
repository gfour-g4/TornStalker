const {
    ModalBuilder,
    ActionRowBuilder,
    TextInputBuilder,
    TextInputStyle,
  } = require('discord.js');
  const store = require('../services/store');
  const { formatTime } = require('../utils');
  
  function addUser() {
    return new ModalBuilder()
      .setCustomId('modal:adduser:submit')
      .setTitle('Add User to Track')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('user_id')
            .setLabel('Torn User ID')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('e.g., 12345')
            .setMinLength(1)
            .setMaxLength(10),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('states')
            .setLabel('Alert States (optional)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('jail, hospital, okay, traveling (or "all")'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('warn')
            .setLabel('Early Warnings (optional)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('e.g., 5m, 2m, 30s'),
        ),
      );
  }
  
  function addFaction() {
    return new ModalBuilder()
      .setCustomId('modal:addfaction:submit')
      .setTitle('Add Faction to Track')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('faction_id')
            .setLabel('Faction ID')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('e.g., 12345')
            .setMinLength(1)
            .setMaxLength(10),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('states')
            .setLabel('Alert States (optional)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('jail, hospital, okay, traveling (or "all")'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('offline')
            .setLabel('Offline Alert Hours (optional)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('e.g., 24'),
        ),
      );
  }
  
  function chainConfig() {
    const chain = store.self.chain;
    
    return new ModalBuilder()
      .setCustomId('modal:chain:submit')
      .setTitle('Chain Alert Settings')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('min')
            .setLabel('Minimum Chain Length')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('e.g., 10')
            .setValue(String(chain.min || 10)),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('thresholds')
            .setLabel('Alert Times (comma-separated)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('e.g., 2m, 1m, 30s')
            .setValue(chain.thresholds?.map(formatTime).join(', ') || '2m, 1m, 30s'),
        ),
      );
  }
  
  function userWarn(userId) {
    const cfg = store.watchers[userId] || {};
    
    return new ModalBuilder()
      .setCustomId(`modal:userwarn:${userId}:submit`)
      .setTitle('Early Warning Alerts')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('warn')
            .setLabel('Alert before state ends')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('e.g., 5m, 2m, 30s')
            .setValue(cfg.preTimesSec?.map(formatTime).join(', ') || ''),
        ),
      );
  }
  
  function factionWarn(factionId) {
    const f = store.factions.items[factionId] || {};
    
    return new ModalBuilder()
      .setCustomId(`modal:factionwarn:${factionId}:submit`)
      .setTitle('Early Warning Alerts')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('warn')
            .setLabel('Alert before state ends')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('e.g., 5m, 2m, 30s')
            .setValue(f.preTimesSec?.map(formatTime).join(', ') || ''),
        ),
      );
  }
  
  function factionOffline(factionId) {
    const f = store.factions.items[factionId] || {};
    
    return new ModalBuilder()
      .setCustomId(`modal:factionoffline:${factionId}:submit`)
      .setTitle('Offline Alert Settings')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('hours')
            .setLabel('Hours before alert')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('e.g., 24')
            .setValue(String(f.offline?.hours || 24)),
        ),
      );
  }
  
  function delay(userId) {
    return new ModalBuilder()
      .setCustomId(`modal:delay:${userId}:submit`)
      .setTitle('Add Travel Delay')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('time')
            .setLabel('Delay Time')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('e.g., 5m, 30s, 1h'),
        ),
      );
  }
  
  module.exports = {
    addUser,
    addFaction,
    chainConfig,
    userWarn,
    factionWarn,
    factionOffline,
    delay,
  };