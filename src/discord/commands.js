const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('📊 Open the main control panel'),
  
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('📖 Show help and commands'),
  
  new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('🔔 Configure personal bar/cooldown/chain alerts'),
  
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('👁️ Start tracking a user or faction')
    .addSubcommand(sub =>
      sub
        .setName('user')
        .setDescription('Track a Torn user')
        .addIntegerOption(opt =>
          opt
            .setName('id')
            .setDescription('Torn user ID')
            .setRequired(true),
        )
        .addStringOption(opt =>
          opt
            .setName('alerts')
            .setDescription('States to alert on (e.g., "jail, hospital" or "all")'),
        )
        .addStringOption(opt =>
          opt
            .setName('warn')
            .setDescription('Early warnings (e.g., "5m, 2m")'),
        ),
    )
    .addSubcommand(sub =>
      sub
        .setName('faction')
        .setDescription('Track a faction')
        .addIntegerOption(opt =>
          opt
            .setName('id')
            .setDescription('Faction ID')
            .setRequired(true),
        )
        .addStringOption(opt =>
          opt
            .setName('alerts')
            .setDescription('States to alert on'),
        )
        .addStringOption(opt =>
          opt
            .setName('warn')
            .setDescription('Early warnings'),
        )
        .addIntegerOption(opt =>
          opt
            .setName('offline')
            .setDescription('Offline alert hours (default: 24)'),
        ),
    ),
  
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('👁️ Check current status of a user or faction')
    .addIntegerOption(opt =>
      opt
        .setName('id')
        .setDescription('User or faction ID')
        .setRequired(true),
    ),
  
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('🗑️ Stop tracking a user or faction')
    .addIntegerOption(opt =>
      opt
        .setName('id')
        .setDescription('User or faction ID')
        .setRequired(true),
    ),
  
  new SlashCommandBuilder()
    .setName('delay')
    .setDescription('⏱️ Add delay to travel ETA')
    .addIntegerOption(opt =>
      opt
        .setName('id')
        .setDescription('User ID')
        .setRequired(true),
    )
    .addStringOption(opt =>
      opt
        .setName('time')
        .setDescription('Delay time (e.g., "5m")')
        .setRequired(true),
    ),
];

module.exports = commands.map(c => c.toJSON());
