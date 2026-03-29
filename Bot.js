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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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
  ru: process.env.ROLE_RU || '',
};

function buildLanguageButtons() {
  const buttons = [
    { id: 'lang_fr', label: 'Français', style: ButtonStyle.Primary },
    { id: 'lang_en', label: 'English', style: ButtonStyle.Primary },
    { id: 'lang_de', label: 'Deutsch', style: ButtonStyle.Primary },
    { id: 'lang_it', label: 'Italiano', style: ButtonStyle.Primary },
  ];

  if (ROLES.ru) {
    buttons.push({ id: 'lang_ru', label: 'Русский', style: ButtonStyle.Primary });
  }

  const row = new ActionRowBuilder().addComponents(
    buttons.map((button) =>
      new ButtonBuilder()
        .setCustomId(button.id)
        .setLabel(button.label)
        .setStyle(button.style)
    )
  );

  return [row];
}

async function sendLog(guild, text) {
  try {
    if (!LOG_CHANNEL_ID) return;

    const logChannel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) return;

    await logChannel.send(text);
  } catch (error) {
    console.error('Erreur envoi log :', error);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (AUTO_ROLE_ID) {
      await member.roles.add(AUTO_ROLE_ID).catch((error) => {
        console.error('Erreur ajout rôle auto :', error);
      });
    }

    if (WELCOME_CHANNEL_ID) {
      const welcomeChannel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);

      if (welcomeChannel && welcomeChannel.isTextBased()) {
        await welcomeChannel.send({
          content:
            `👋 Bienvenue ${member} sur le serveur !\n` +
            `🌍 Choisis ta langue en cliquant sur un bouton ci-dessous :`,
          components: buildLanguageButtons(),
        });
      }
    }

    await sendLog(
      member.guild,
      `📥 Nouveau membre : **${member.user.tag}** (${member.id})`
    );
  } catch (error) {
    console.error('Erreur arrivée membre :', error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.content !== '!test') return;

    await message.channel.send({
      content:
        `🧪 **Test du panneau de langue**\n` +
        `Clique sur un bouton pour tester l’attribution du rôle.`,
      components: buildLanguageButtons(),
    });
  } catch (error) {
    console.error('Erreur commande !test :', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('lang_')) return;

    const langCode = interaction.customId.split('_')[1];
    const roleIdToAdd = ROLES[langCode];

    if (!roleIdToAdd) {
      await interaction.reply({
        content: '❌ Aucun rôle configuré pour cette langue.',
        ephemeral: true,
      });
      return;
    }

    const member = interaction.member;
    if (!member || !member.roles) {
      await interaction.reply({
        content: '❌ Impossible de récupérer ton profil serveur.',
        ephemeral: true,
      });
      return;
    }

    const allLanguageRoleIds = Object.values(ROLES).filter(Boolean);
    const rolesToRemove = allLanguageRoleIds.filter((roleId) => roleId !== roleIdToAdd && member.roles.cache.has(roleId));

    if (rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove).catch((error) => {
        console.error('Erreur suppression anciens rôles langue :', error);
      });
    }

    if (!member.roles.cache.has(roleIdToAdd)) {
      await member.roles.add(roleIdToAdd).catch((error) => {
        console.error('Erreur ajout rôle langue :', error);
        throw error;
      });
    }

    const labels = {
      fr: 'Français',
      en: 'English',
      de: 'Deutsch',
      it: 'Italiano',
      ru: 'Русский',
    };

    await interaction.reply({
      content: `✅ Ton rôle de langue a été défini sur **${labels[langCode] || langCode}**.`,
      ephemeral: true,
    });

    await sendLog(
      interaction.guild,
      `🌍 **${interaction.user.tag}** a choisi la langue **${labels[langCode] || langCode}**`
    );
  } catch (error) {
    console.error('Erreur interaction bouton langue :', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ Une erreur est survenue pendant l’attribution du rôle.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);