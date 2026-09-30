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

export function createNotificationEmbed(notification) {
  const normalized = createNotification(notification);
  let color = 0x5865f2;
  let author = 'Desarrollador oficial de MODEOS EL OBI';

  if (normalized.type === 'platform_status') {
    color = platformMeta[normalized.platformStatus].color;
    author = 'Estado oficial de MODEOS EL OBI';
  } else if (normalized.type === 'live_started') {
    color = 0x9146ff;
    author = 'Directo oficial de MODEOS EL OBI';
  }

  return {
    color,
    author: { name: author },
    title: normalized.title,
    description: normalized.message,
    url: MODEOS_WEB_URL,
    fields: [{ name: 'Web oficial', value: `[Abrir MODEOS EL OBI](${MODEOS_WEB_URL})`, inline: false }],
    footer: { text: 'MODEOS EL OBI | Notificacion oficial' },
    timestamp: normalized.occurredAt
  };
}
