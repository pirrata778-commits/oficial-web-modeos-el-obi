export const MODEOS_WEB_URL = 'https://web-modeos-el-obi.onrender.com';
export const PLATFORM_STATUSES = Object.freeze(['activo', 'beta', 'mantenimiento']);
export const DISCORD_NOTIFICATION_LAYOUT = Object.freeze({
  categoryName: 'ＭＯＤＥＯＳ・ＥＬ・ＯＢＩ',
  channels: Object.freeze({
    developer_announcement: Object.freeze({ name: '📢・ａｎｕｎｃｉｏｓ', position: 0 }),
    platform_status: Object.freeze({ name: '🔴・ｅｓｔａｄｏ－ｗｅｂ', position: 1 }),
    live_started: Object.freeze({ name: '🎥・ｄｉｒｅｃｔｏｓ', position: 2 })
  })
});
const WATCHING_ACTIVITY_TYPE = 3;

const MAX_TITLE_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 4000;
export const DISCORD_EMBED_COLORS = Object.freeze({
  success: 0x22c55e,
  error: 0xef4444,
  info: 0x9333ea
});
const EMBED_FOOTER = 'MODEOS EL OBI | Dev Panel';

const platformMeta = {
  activo: {
    color: 0x22c55e,
    title: 'La web esta operativa',
    message: 'MODEOS EL OBI vuelve a estar disponible.',
    presence: 'online',
    activity: 'MODEOS EL OBI | Web activa'
  },
  beta: {
    color: 0xeab308,
    title: 'MODEOS EL OBI esta en beta',
    message: 'La plataforma esta disponible en fase beta.',
    presence: 'idle',
    activity: 'MODEOS EL OBI | Beta'
  },
  mantenimiento: {
    color: 0xef4444,
    title: 'Mantenimiento en curso',
    message: 'La plataforma esta realizando tareas de mantenimiento.',
    presence: 'dnd',
    activity: 'MODEOS EL OBI | Mantenimiento'
  }
};

export class NotificationValidationError extends Error {}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new NotificationValidationError(`${field} es obligatorio.`);
  }
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new NotificationValidationError(`${field} debe tener entre 1 y ${maxLength} caracteres.`);
  }
  return text;
}

function optionalText(value, field, maxLength, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return requiredText(value, field, maxLength);
}

function normalizedTimestamp(value) {
  if (!value) return new Date().toISOString();
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new NotificationValidationError('occurredAt no es una fecha valida.');
  }
  return timestamp.toISOString();
}

export function normalizePlatformStatus(value) {
  if (!PLATFORM_STATUSES.includes(value)) {
    throw new NotificationValidationError('platformStatus debe ser activo, beta o mantenimiento.');
  }
  return value;
}

export function createNotification(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NotificationValidationError('El cuerpo de la notificacion debe ser un objeto JSON.');
  }

  const type = String(input.type || '').trim();
  const occurredAt = normalizedTimestamp(input.occurredAt);

  if (type === 'developer_announcement') {
    return {
      type,
      title: optionalText(input.title, 'title', MAX_TITLE_LENGTH, 'Comunicado oficial'),
      message: requiredText(input.message ?? input.content, 'message', MAX_MESSAGE_LENGTH),
      occurredAt
    };
  }

  if (type === 'platform_status') {
    const platformStatus = normalizePlatformStatus(input.platformStatus);
    const defaults = platformMeta[platformStatus];
    return {
      type,
      platformStatus,
      title: optionalText(input.title, 'title', MAX_TITLE_LENGTH, defaults.title),
      message: optionalText(input.message ?? input.content, 'message', MAX_MESSAGE_LENGTH, defaults.message),
      occurredAt
    };
  }

  if (type === 'live_started') {
    return {
      type,
      title: optionalText(input.title, 'title', MAX_TITLE_LENGTH, 'Estamos en directo'),
      message: optionalText(input.message ?? input.content, 'message', MAX_MESSAGE_LENGTH, 'El directo oficial de MODEOS EL OBI ya ha comenzado.'),
      occurredAt
    };
  }

  throw new NotificationValidationError('type debe ser developer_announcement, platform_status o live_started.');
}

export function notificationChannelEnvironment(notification) {
  if (notification.type === 'developer_announcement') return 'DISCORD_ANNOUNCEMENTS_CHANNEL_ID';
  if (notification.type === 'platform_status') return 'DISCORD_STATUS_CHANNEL_ID';
  return 'DISCORD_LIVE_CHANNEL_ID';
}

export function notificationChannelDefinition(notification) {
  const definition = DISCORD_NOTIFICATION_LAYOUT.channels[notification.type];
  if (!definition) {
    throw new NotificationValidationError('No existe un canal para este tipo de notificacion.');
  }
  return definition;
}

export function createBotPresence(platformStatus) {
  const status = normalizePlatformStatus(platformStatus);
  const metadata = platformMeta[status];
  return {
    status: metadata.presence,
    activities: [{ name: metadata.activity, type: WATCHING_ACTIVITY_TYPE }]
  };
}

export function createBotEmbed({
  status = 'info',
  title = 'ℹ️ MODEOS EL OBI',
  description = '',
  fields = [],
  thumbnailUrl,
  timestamp = new Date().toISOString(),
  author = 'MODEOS EL OBI',
  url = MODEOS_WEB_URL
} = {}) {
  const selectedColor = DISCORD_EMBED_COLORS[status] || DISCORD_EMBED_COLORS.info;
  const embed = {
    color: selectedColor,
    author: { name: String(author).slice(0, 256) },
    title: String(title).slice(0, 256),
    url,
    fields: fields.slice(0, 24).flatMap(field => {
      const name = String(field?.name || '').trim().slice(0, 256);
      const value = String(field?.value || '').trim().slice(0, 1024);
      return name && value ? [{ name, value, inline: Boolean(field.inline) }] : [];
    }),
    footer: { text: EMBED_FOOTER },
    timestamp: new Date(timestamp).toISOString()
  };
  if (description) embed.description = String(description).slice(0, 4096);
  if (thumbnailUrl) {
    try {
      const thumbnail = new URL(thumbnailUrl);
      if (thumbnail.protocol === 'https:') embed.thumbnail = { url: thumbnail.toString() };
    } catch {}
  }
  embed.fields.push({ name: 'Web oficial', value: `[Abrir MODEOS EL OBI](${MODEOS_WEB_URL})`, inline: true });
  return embed;
}

export function createNotificationEmbed(notification, thumbnailUrl) {
  const normalized = createNotification(notification);
  let status = 'info';
  let icon = '📣';
  let author = 'Desarrollador oficial de MODEOS EL OBI';
  let fields = [{ name: 'Tipo', value: 'Comunicado oficial', inline: true }];

  if (normalized.type === 'platform_status') {
    status = normalized.platformStatus === 'activo'
      ? 'success'
      : normalized.platformStatus === 'mantenimiento' ? 'error' : 'info';
    icon = normalized.platformStatus === 'mantenimiento' ? '🚨' : '🟣';
    author = 'Estado oficial de MODEOS EL OBI';
    fields = [{ name: 'Estado', value: normalized.platformStatus.toUpperCase(), inline: true }];
  } else if (normalized.type === 'live_started') {
    status = 'success';
    icon = '🎥';
    author = 'Directo oficial de MODEOS EL OBI';
    fields = [{ name: 'Estado', value: 'EN DIRECTO', inline: true }];
  }

  return createBotEmbed({
    status,
    author,
    title: `${icon} ${normalized.title}`.slice(0, MAX_TITLE_LENGTH),
    description: normalized.message,
    fields,
    thumbnailUrl,
    timestamp: normalized.occurredAt
  });
}

export function createNotificationMessage(notification, thumbnailUrl) {
  return {
    embeds: [createNotificationEmbed(notification, thumbnailUrl)],
    components: [{
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: 'Abrir MODEOS EL OBI',
          url: MODEOS_WEB_URL,
          emoji: { name: '🌐' }
        },
        {
          type: 2,
          style: 2,
          custom_id: 'check_status',
          label: 'Verificar estado',
          emoji: { name: '⚡' }
        }
      ]
    }]
  };
}
