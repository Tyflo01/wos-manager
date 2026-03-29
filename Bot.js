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
  EmbedBuilder,
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

const EVENT_COLORS = {
  beartrap: 0xf59e0b,
  crazyjoe: 0xef4444,
  minegivrefeu: 0x06b6d4,
  foundry: 0x8b5cf6,
};

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
        .setCustomId(`draft_validate_everyone:${draftId}`)
        .setLabel('Valider + @everyone')
        .setStyle(ButtonStyle.Primary),
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

function splitMessage(text, maxLength = 4000) {
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

  if (session.extraNotes?.length > 0) {
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

function buildGuideEmbeds(draft) {
  const parts = splitMessage(draft.content, 4000);

  return parts.map((part, index) => {
    const embed = new EmbedBuilder()
      .setColor(EVENT_COLORS[draft.eventKey] || 0x2b2d31)
      .setDescription(part)
      .setFooter({
        text:
          parts.length > 1
            ? `${draft.eventLabel} • Partie ${index + 1}/${parts.length}`
            : `${draft.eventLabel}`,
      })
      .setTimestamp();

    if (index === 0) {
      embed.setTitle(`📘 ${draft.eventLabel}`);
    }

    return embed;
  });
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

async function publishDraft(guild, draft, options = {}) {
  const targetChannel = await guild.channels.fetch(draft.targetChannelId).catch(() => null);

  if (!targetChannel || !targetChannel.isTextBased()) {
    throw new Error('Salon cible introuvable ou non textuel.');
  }

  const embeds = buildGuideEmbeds(draft);

  for (let i = 0; i < embeds.length; i++) {
    const payload = { embeds: [embeds[i]] };

    if (i === 0 && options.mentionEveryone) {
      payload.content = '@everyone';
      payload.allowedMentions = { parse: ['everyone'] };
    }

    await targetChannel.send(payload);
  }
}

async function updateStoredDraftMessage(guild, draftId) {
  const draft = draftStore.get(draftId);
  if (!draft || !draft.draftChannelId || !draft.draftMessageId) return;

  const draftChannel = await guild.channels.fetch(draft.draftChannelId).catch(() => null);
  if (!draftChannel || !draftChannel.isTextBased()) return;

  const draftMessage = await draftChannel.messages.fetch(draft.draftMessageId).catch(() => null);
  if (!draftMessage) return;

  await draftMessage.edit({
    content: buildDraftPreview(draft),
    components: buildDraftButtons(draftId),
  });
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
      `Tape **done** pour générer.\n` +
      `Tape **cancel** pour annuler.\n\n` +
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
            `✅ J'ai les informations principales.\n` +
              `Tu peux encore ajouter des précisions, ou taper **done** pour générer le brouillon.`
          );
        }
        return;
      }

      session.extraNotes.push(content);
      conversationStore.set(sessionKey, session);

      await message.reply(
        `📝 Information complémentaire ajoutée.\n` +
          `Tape **done** pour générer ou **cancel** pour annuler.`
      );
      return;
    }

    if (message.content === '!setup-lang') {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply("❌ Tu n'as pas la permission.");
      }

      await message.channel.send({
        content: `🌍 **Choisis ta langue :**\nClique sur un bouton ci-dessous :`,
        components: buildLanguageButtons(),
      });
      return;
    }

    if (message.content === '!test') {
      await message.channel.send({
        content: `🧪 **Test du panneau de langue**\nClique sur un bouton pour tester l’attribution du rôle.`,
        components: buildLanguageButtons(),
      });
      return;
    }

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
          `⚠️ Tu as déjà une session en cours.\nTape **done** pour générer ou **cancel** pour annuler avant d'en démarrer une autre.`
        );
      }

      await startDraftConversation(message, eventKey);
      return;
    }
  } catch (error) {
    console.error('Erreur messageCreate complète :', error);
    await message.reply('❌ Une erreur est survenue pendant le traitement du message.').catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
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

    if (interaction.isButton() && interaction.customId.startsWith('draft_')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "❌ Tu n'as pas la permission.",
          ephemeral: true,
        });
        return;
      }

      const raw = interaction.customId.replace('draft_', '');
      const firstColon = raw.indexOf(':');
      const action = raw.slice(0, firstColon);
      const draftId = raw.slice(firstColon + 1);

      const draft = draftStore.get(draftId);

      if (!draft) {
        await interaction.reply({
          content: '❌ Brouillon introuvable ou expiré.',
          ephemeral: true,
        });
        return;
      }

      if (action === 'validate' || action === 'validate_everyone') {
        await publishDraft(interaction.guild, draft, {
          mentionEveryone: action === 'validate_everyone',
        });

        await interaction.update({
          content:
            `✅ **Publié** dans <#${draft.targetChannelId}>` +
            (action === 'validate_everyone' ? ' avec **@everyone**.' : '.'),
          components: [],
        });

        await sendLog(
          interaction.guild,
          `✅ Guide **${draft.eventLabel}** publié par **${interaction.user.tag}**` +
            (action === 'validate_everyone' ? ' avec @everyone' : '')
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
          'Propose une nouvelle version, plus claire, plus structurée, plus utile et plus naturelle que la précédente.'
        );

        draft.content = regenerated;
        draftStore.set(draftId, draft);

        await updateStoredDraftMessage(interaction.guild, draftId);

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

      await updateStoredDraftMessage(interaction.guild, draftId);

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
    console.error('Erreur interaction complète :', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ Une erreur est survenue.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);