require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;

const ROLES = {
  fr: process.env.ROLE_FR,
  en: process.env.ROLE_EN,
  de: process.env.ROLE_DE,
  it: process.env.ROLE_IT,
};

client.once(Events.ClientReady, () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    // Rôle de base
    if (AUTO_ROLE_ID) {
      await member.roles.add(AUTO_ROLE_ID);
    }

    // Message de bienvenue avec boutons
    const welcomeChannel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);

    if (welcomeChannel && welcomeChannel.isTextBased()) {

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lang_fr').setLabel('Français').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lang_en').setLabel('English').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lang_de').setLabel('Deutsch').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lang_it').setLabel('Italiano').setStyle(ButtonStyle.Primary),
      );

      await welcomeChannel.send({
        content: `👋 Bienvenue ${member} !\n🌍 Choisis ta langue :`,
        components: [row],
      });
    }

    // Log
    const logChannel = await member.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send(`📥 Nouveau membre : **${member.user.tag}**`);
    }

  } catch (error) {
    console.error(error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const roleId = ROLES[interaction.customId.split('_')[1]];

  if (!roleId) return;

  try {
    await interaction.member.roles.add(roleId);

    await interaction.reply({
      content: "✅ Rôle ajouté !",
      ephemeral: true,
    });

  } catch (error) {
    console.error(error);
  }
});

client.login(process.env.DISCORD_TOKEN);