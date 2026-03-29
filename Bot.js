require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');

const OpenAI = require('openai');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;
const DRAFT_CHANNEL_ID = process.env.DRAFT_CHANNEL_ID;

const ROLES = {
  fr: process.env.ROLE_FR,
  en: process.env.ROLE_EN,
  de: process.env.ROLE_DE,
  it: process.env.ROLE_IT,
  ru: process.env.ROLE_RU || '',
};

const EVENT_CHANNELS = {
  beartrap: process.env.CHANNEL_BEAR_TRAP_ID,
  crazyjoe: process.env.CHANNEL_CRAZY_JOE_ID,
  minegivrefeu: process.env.CHANNEL_MINE_GIVRE_FEU_ID,
  foundry: process.env.CHANNEL_FOUNDRY_ID,
};

const EVENT_LABELS = {
  beartrap: 'Bear Trap',
  crazyjoe: 'Crazy Joe',
  minegivrefeu: 'Mine Givre-feu',
  foundry: 'Bataille de la Fonderie',
};

// Stockage en mémoire
const draftStore = new Map();
const conversationStore = new Map();

const CONVERSATION_QUESTIONS = [
  "Quel est l'objectif du message ?",
  "À qui s'adresse ce guide ? (débutants, tous les membres, officiers, etc.)",
  "Quel ton veux-tu ? (clair, motivant, strict, pédagogique, etc.)",
  "Quelles informations doivent absolument apparaître ?",
  "Y a-t-il des erreurs à éviter ou des consignes importantes à rappeler ?",
  "Y a-t-il un format particulier souhaité ?",
];

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

function buildDraftButtons(draftId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`draft_validate:${draftId}`)
        .setLabel('Valider')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`draft_refuse:${draftId}`)
        .setLabel('Refuser')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`draft_edit:${draftId}`)
        .setLabel('Éditer')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text || '';
  }

  return text.slice(0, maxLength - 3).trimEnd() + '...';
}

function splitMessage(text, maxLength = 2000) {
  const chunks = [];
  let remaining = (text || '').trim();

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf('\n', maxLength);

    if (splitIndex < 100) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }

    if (splitIndex < 100) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function buildDraftPreview(draft) {
  const header =
    `🧠 **Brouillon IA - ${draft.eventLabel}**\n` +
    `📍 Salon cible : <#${draft.targetChannelId}>\n` +
    `👤 Demandé par : <@${draft.requestedBy}>\n\n`;

  const footer = `\n\n⚠️ Aperçu tronqué si le brouillon est trop long.`;
  const maxContentLength = 2000 - header.length - footer.length;

  const previewText = truncateText(draft.content, Math.max(200, maxContentLength));

  return header + previewText + footer;
}

function getSessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function buildConversationInstructions(session) {
  const lines = [];

  for (let i = 0; i < CONVERSATION_QUESTIONS.length; i++) {
    const question = CONVERSATION_QUESTIONS[i];
    const answer = session.answers[i] || 'Non précisé';
    lines.push(`- ${question}\n  Réponse : ${answer}`);
  }

  if (session.extraNotes && session.extraNotes.length > 0) {
    lines.push('\nInformations complémentaires :');
    for (const note of session.extraNotes) {
      lines.push(`- ${note}`);
    }
  }

  return `
Contexte fourni par l'administrateur :
${lines.join('\n')}

Rédige un guide Discord adapté à ces attentes.
Respecte strictement les demandes ci-dessus.
`;
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

async function generateEventGuide(eventKey, extraInstructions = '') {
  const eventLabel = EVENT_LABELS[eventKey] || eventKey;

  const prompt = `
Tu rédiges un guide Discord clair, utile et structuré pour des joueurs de Whiteout Survival.
Sujet : ${eventLabel}

Contraintes :
- Réponds en français.
- Ton clair, pratique, sans blabla inutile.
- Format Discord lisible.
- Utilise des titres courts et des puces.
- N'invente pas de chiffres précis si tu n'es pas sûr.
- Si une information dépend du serveur/alliance, indique-le comme conseil à adapter.
- Structure :
  1. Objectif
  2. Préparation
  3. Comment ça se joue
  4. Conseils utiles
  5. Erreurs à éviter

Instructions supplémentaires :
${extraInstructions || 'Aucune.'}
`;

  const response = await openai.responses.create({
    model: 'gpt-5.4-mini',
    input: prompt,
  });

  const text = response.output_text?.trim();

  if (!text) {
    throw new Error('Réponse IA vide.');
  }

  return text;
}

async function publishDraft(guild, draft) {
  const targetChannel = await guild.channels.fetch(draft.targetChannelId).catch(() => null);

  if (!targetChannel || !targetChannel.isTextBased()) {
    throw new Error('Salon cible introuvable ou non textuel.');
  }

  const parts = splitMessage(draft.content, 2000);

  for (const part of parts) {
    await targetChannel.send(part);
  }
}

async function startDraftConversation(message, eventKey) {
  const sessionKey = getSessionKey(message.guild.id, message.author.id);

  conversationStore.set(sessionKey, {
    eventKey,
    guildId: message.guild.id,
    channelId: message.channel.id,
    userId: message.author.id,
    step: 0,
    answers: [],
    extraNotes: [],
    createdAt: Date.now(),
  });

  await message.reply(
    `🧠 On prépare un brouillon pour **${EVENT_LABELS[eventKey]}**.\n\n` +
      `Réponds à mes questions directement dans ce salon.\n` +
      `Tu peux taper **done** à tout moment pour générer.\n` +
      `Tu peux taper **cancel** pour annuler.\n\n` +
      `**Question 1/${CONVERSATION_QUESTIONS.length}** : ${CONVERSATION_QUESTIONS[0]}`
  );
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

    const sessionKey = getSessionKey(message.guild.id, message.author.id);
    const session = conversationStore.get(sessionKey);

    // Gestion conversation active
    if (session && message.channel.id === session.channelId) {
      const content = message.content.trim();

      if (content.toLowerCase() === 'cancel') {
        conversationStore.delete(sessionKey);
        await message.reply('❌ Création du brouillon annulée.');
        return;
      }

      if (content.toLowerCase() === 'done') {
        if (!DRAFT_CHANNEL_ID) {
          conversationStore.delete(sessionKey);
          return message.reply("❌ DRAFT_CHANNEL_ID n'est pas configuré.");
        }

        const draftChannel = await message.guild.channels.fetch(DRAFT_CHANNEL_ID).catch(() => null);
        if (!draftChannel || !draftChannel.isTextBased()) {
          conversationStore.delete(sessionKey);
          return message.reply('❌ Salon de draft introuvable.');
        }

        await message.reply(
          `⏳ Je génère maintenant le brouillon pour **${EVENT_LABELS[session.eventKey]}**...`
        );

        const extraInstructions = buildConversationInstructions(session);
        const generatedText = await generateEventGuide(session.eventKey, extraInstructions);

        const draftId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const draft = {
          id: draftId,
          eventKey: session.eventKey,
          eventLabel: EVENT_LABELS[session.eventKey],
          targetChannelId: EVENT_CHANNELS[session.eventKey],
          requestedBy: message.author.id,
          content: generatedText,
          draftMessageId: null,
          draftChannelId: null,
        };

        const sentDraftMessage = await draftChannel.send({
          content: buildDraftPreview(draft),
          components: buildDraftButtons(draftId),
        });

        draft.draftMessageId = sentDraftMessage.id;
        draft.draftChannelId = draftChannel.id;

        draftStore.set(draftId, draft);
        conversationStore.delete(sessionKey);

        await sendLog(
          message.guild,
          `🧠 Brouillon **${draft.eventLabel}** généré par **${message.author.tag}**`
        );

        return;
      }

      if (session.step < CONVERSATION_QUESTIONS.length) {
        session.answers[session.step] = content;
        session.step += 1;
        conversationStore.set(sessionKey, session);

        if (session.step < CONVERSATION_QUESTIONS.length) {
          await message.reply(
            `**Question ${session.step + 1}/${CONVERSATION_QUESTIONS.length}** : ${CONVERSATION_QUESTIONS[session.step]}\n\n` +
              `Tape **done** si tu veux générer avec les éléments déjà fournis.`
          );
        } else {
          await message.reply(
            `✅ J'ai récupéré les informations principales.\n` +
              `Tu peux encore ajouter des précisions dans un nouveau message, ou taper **done** pour générer le brouillon.`
          );
        }
        return;
      }

      session.extraNotes.push(content);
      conversationStore.set(sessionKey, session);

      await message.reply(
        `📝 Information complémentaire ajoutée.\n` +
          `Tape **done** pour générer le brouillon, ou **cancel** pour annuler.`
      );
      return;
    }

    if (message.content === '!setup-lang') {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply("❌ Tu n'as pas la permission.");
      }

      await message.channel.send({
        content:
          `🌍 **Choisis ta langue :**\n` +
          `Clique sur un bouton ci-dessous :`,
        components: buildLanguageButtons(),
      });
      return;
    }

    if (message.content === '!test') {
      await message.channel.send({
        content:
          `🧪 **Test du panneau de langue**\n` +
          `Clique sur un bouton pour tester l’attribution du rôle.`,
        components: buildLanguageButtons(),
      });
      return;
    }

    // Démarrer une conversation de draft
    if (message.content.startsWith('!draft-event ')) {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply("❌ Tu n'as pas la permission.");
      }

      const parts = message.content.replace('!draft-event ', '').trim().split(' ');
      const eventKey = (parts.shift() || '').toLowerCase();

      if (!EVENT_CHANNELS[eventKey]) {
        return message.reply(
          `❌ Événement inconnu. Utilise : ${Object.keys(EVENT_CHANNELS).join(', ')}`
        );
      }

      if (conversationStore.has(sessionKey)) {
        return message.reply(
          `⚠️ Tu as déjà une session de rédaction en cours.\n` +
            `Tape **done** pour générer ou **cancel** pour annuler avant d'en démarrer une autre.`
        );
      }

      await startDraftConversation(message, eventKey);
      return;
    }
  } catch (error) {
    console.error('Erreur messageCreate :', error);
    await message.reply('❌ Une erreur est survenue pendant le traitement du message.').catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Boutons langue
    if (interaction.isButton() && interaction.customId.startsWith('lang_')) {
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
      const allLanguageRoleIds = Object.values(ROLES).filter(Boolean);
      const rolesToRemove = allLanguageRoleIds.filter(
        (roleId) => roleId !== roleIdToAdd && member.roles.cache.has(roleId)
      );

      if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove).catch((error) => {
          console.error('Erreur suppression anciens rôles langue :', error);
        });
      }

      if (!member.roles.cache.has(roleIdToAdd)) {
        await member.roles.add(roleIdToAdd);
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
      return;
    }

    // Boutons draft
    if (interaction.isButton() && interaction.customId.startsWith('draft_')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "❌ Tu n'as pas la permission.",
          ephemeral: true,
        });
        return;
      }

      const [action, draftId] = interaction.customId.replace('draft_', '').split(':');
      const draft = draftStore.get(draftId);

      if (!draft) {
        await interaction.reply({
          content: '❌ Brouillon introuvable ou expiré.',
          ephemeral: true,
        });
        return;
      }

      if (action === 'validate') {
        await publishDraft(interaction.guild, draft);

        await interaction.update({
          content: `✅ **Publié** dans <#${draft.targetChannelId}>\n\n${truncateText(draft.content, 1800)}`,
          components: [],
        });

        await sendLog(
          interaction.guild,
          `✅ Guide **${draft.eventLabel}** publié par **${interaction.user.tag}**`
        );

        draftStore.delete(draftId);
        return;
      }

      if (action === 'refuse') {
        await interaction.update({
          content: `⏳ Régénération du brouillon **${draft.eventLabel}**...`,
          components: [],
        });

        const regenerated = await generateEventGuide(
          draft.eventKey,
          'Propose une nouvelle version, plus claire, plus structurée et plus utile que la précédente.'
        );

        draft.content = regenerated;
        draftStore.set(draftId, draft);

        const updatedMessage = await interaction.message.edit({
          content: buildDraftPreview(draft),
          components: buildDraftButtons(draftId),
        });

        draft.draftMessageId = updatedMessage.id;
        draft.draftChannelId = updatedMessage.channel.id;
        draftStore.set(draftId, draft);

        await sendLog(
          interaction.guild,
          `🔁 Brouillon **${draft.eventLabel}** régénéré par **${interaction.user.tag}**`
        );
        return;
      }

      if (action === 'edit') {
        const modal = new ModalBuilder()
          .setCustomId(`draft_modal:${draftId}`)
          .setTitle(`Éditer - ${draft.eventLabel}`);

        const textInput = new TextInputBuilder()
          .setCustomId('draft_content')
          .setLabel('Contenu du guide')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(draft.content.slice(0, 4000))
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(textInput));
        await interaction.showModal(modal);
        return;
      }
    }

    // Modal édition
    if (interaction.isModalSubmit() && interaction.customId.startsWith('draft_modal:')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "❌ Tu n'as pas la permission.",
          ephemeral: true,
        });
        return;
      }

      const draftId = interaction.customId.split(':')[1];
      const draft = draftStore.get(draftId);

      if (!draft) {
        await interaction.reply({
          content: '❌ Brouillon introuvable ou expiré.',
          ephemeral: true,
        });
        return;
      }

      const newContent = interaction.fields.getTextInputValue('draft_content').trim();
      draft.content = newContent;
      draftStore.set(draftId, draft);

      if (draft.draftChannelId && draft.draftMessageId) {
        const draftChannel = await interaction.guild.channels.fetch(draft.draftChannelId).catch(() => null);

        if (draftChannel && draftChannel.isTextBased()) {
          const draftMessage = await draftChannel.messages.fetch(draft.draftMessageId).catch(() => null);

          if (draftMessage) {
            await draftMessage.edit({
              content: buildDraftPreview(draft),
              components: buildDraftButtons(draftId),
            });
          }
        }
      }

      await interaction.reply({
        content: '✅ Brouillon mis à jour.',
        ephemeral: true,
      });

      await sendLog(
        interaction.guild,
        `✏️ Brouillon **${draft.eventLabel}** édité par **${interaction.user.tag}**`
      );
      return;
    }
  } catch (error) {
    console.error('Erreur interaction :', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ Une erreur est survenue.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);