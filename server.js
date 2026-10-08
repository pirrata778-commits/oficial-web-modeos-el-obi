import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import dotenv from 'dotenv';
import pg from 'pg';
import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  DISCORD_NOTIFICATION_LAYOUT,
  MODEOS_WEB_URL,
  NotificationValidationError,
  PLATFORM_STATUSES,
  createBotPresence,
  createBotEmbed,
  createNotification,
  createNotificationEmbed,
  notificationChannelEnvironment,
  normalizePlatformStatus
} from './discord-notifications.js';
import { decryptBotToken, encryptBotToken } from './discord-bot-secrets.js';
import { parseSiteImageDataUrl, SiteImageValidationError } from './site-images.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');
process.env.PUBLIC_URL = publicUrl;
const frontendUrl = process.env.FRONTEND_URL?.replace(/\/+$/, '') || publicUrl;
const frontendOrigin = frontendUrl ? new URL(frontendUrl).origin : null;
const backendOrigin = new URL(publicUrl).origin;
const redirectUri = `${process.env.PUBLIC_URL}/api/auth/discord/callback`;
const { Pool } = pg;
const siteImageSlots = new Set(['lobby', 'modelos', 'directos']);
let configuredBots = [];
const devCommandCatalog = [
  { name: 'ping', description: 'Consultar la latencia del bot' },
  { name: 'status', description: 'Consultar el estado del bot en el servidor' },
  { name: 'guilds', description: 'Listar los servidores conectados' },
  { name: 'send', description: 'Enviar un mensaje a un canal del servidor' },
  { name: 'setup', description: 'Configurar los canales de avisos del servidor' }
];

try {
  configuredBots = process.env.DISCORD_BOTS_JSON
    ? JSON.parse(process.env.DISCORD_BOTS_JSON)
    : process.env.DISCORD_BOT_TOKEN
      ? [{ name: process.env.DISCORD_BOT_NAME || 'MODEOS EL OBI', token: process.env.DISCORD_BOT_TOKEN }]
      : [];
} catch {
  throw new Error('DISCORD_BOTS_JSON debe contener un array JSON de bots.');
}
if (!Array.isArray(configuredBots) || configuredBots.some(bot => !bot || typeof bot.name !== 'string' || !bot.name.trim() || typeof bot.token !== 'string' || !bot.token.trim())) {
  throw new Error('DISCORD_BOTS_JSON debe contener objetos con name y token.');
}
if (process.env.DISCORD_BOTS_JSON && configuredBots.length === 0) {
  throw new Error('DISCORD_BOTS_JSON debe configurar al menos un bot.');
}
configuredBots = configuredBots.map(bot => ({ name: bot.name.trim(), token: bot.token.trim() }));
if (new Set(configuredBots.map(bot => bot.name)).size !== configuredBots.length) {
  throw new Error('Cada bot configurado debe tener un nombre único.');
}
if (new Set(configuredBots.map(bot => bot.token)).size !== configuredBots.length) {
  throw new Error('Cada instancia debe usar un token de bot distinto.');
}

if (!process.env.SESSION_SECRET || !process.env.DEV_PASSWORD || !process.env.DATABASE_URL) {
  throw new Error('Faltan SESSION_SECRET, DEV_PASSWORD o DATABASE_URL en .env');
}
if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || configuredBots.length === 0) {
  console.warn('[CONFIG] OAuth o bot de Discord todavía no están configurados.');
}

if (!process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID) {
  console.warn('[CONFIG] Falta DISCORD_ANNOUNCEMENTS_CHANNEL_ID; las notificaciones se conservaran en cola hasta configurarlo.');
}

const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.searchParams.set('sslmode', 'verify-full');
const database = new Pool({ connectionString: databaseUrl.toString() });
database.on('error', error => {
  console.error('[NEON] Error inesperado en una conexión inactiva de PostgreSQL:', error);
});
const PgSessionStore = connectPgSimple(session);
const sessionStore = new PgSessionStore({
  pool: database,
  tableName: 'user_sessions',
  createTableIfMissing: true
});
try {
  await database.query(`
  CREATE TABLE IF NOT EXISTS security_logs (
    id BIGSERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    ip TEXT,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dev_attempts (
    session_id TEXT PRIMARY KEY,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS site_images (
    slot TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    image_data BYTEA NOT NULL,
    alt_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS site_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS site_messages (
    message_id BIGSERIAL PRIMARY KEY,
    content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS bots (
    id BIGSERIAL PRIMARY KEY,
    bot_name TEXT NOT NULL UNIQUE,
    discord_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'beta' CHECK (status IN ('activo', 'beta', 'mantenimiento'))
  );
  ALTER TABLE bots ADD COLUMN IF NOT EXISTS discord_user_id TEXT;
  ALTER TABLE bots ADD COLUMN IF NOT EXISTS client_id TEXT;
  ALTER TABLE bots ADD COLUMN IF NOT EXISTS encrypted_token TEXT;
  ALTER TABLE bots ADD COLUMN IF NOT EXISTS managed_token BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE bots ADD COLUMN IF NOT EXISTS setup_command_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  UPDATE bots SET client_id = discord_user_id WHERE client_id IS NULL AND discord_user_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS bot_commands (
    bot_id BIGINT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    command_name TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bot_id, command_name)
  );
  INSERT INTO bot_commands (bot_id, command_name, is_enabled)
  SELECT existing_bot.id, commands.command_name,
         CASE WHEN commands.command_name = 'setup' THEN existing_bot.setup_command_enabled ELSE TRUE END
  FROM bots existing_bot
  CROSS JOIN (VALUES ('ping'), ('status'), ('guilds'), ('send'), ('setup')) AS commands(command_name)
  ON CONFLICT (bot_id, command_name) DO NOTHING;
  CREATE TABLE IF NOT EXISTS streaming_links (
    platform TEXT PRIMARY KEY CHECK (platform IN ('twitch', 'youtube')),
    url TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS live_announcement_config (
    config_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (config_id = 1),
    title_template TEXT NOT NULL DEFAULT 'Estamos en directo',
    message_template TEXT NOT NULL DEFAULT 'El directo oficial de MODEOS EL OBI ya ha comenzado.',
    channel_id TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO live_announcement_config (config_id)
  VALUES (1)
  ON CONFLICT (config_id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS video_announcement_config (
    config_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (config_id = 1),
    platform TEXT NOT NULL DEFAULT 'youtube' CHECK (platform = 'youtube'),
    title_template TEXT NOT NULL DEFAULT '🎬 Nuevo vídeo: {title}',
    target_channel_id TEXT NOT NULL DEFAULT '',
    notification_text TEXT NOT NULL DEFAULT '{url}',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO video_announcement_config (config_id)
  VALUES (1)
  ON CONFLICT (config_id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS discord_notification_routes (
    event_type TEXT PRIMARY KEY CHECK (event_type IN ('developer_announcement', 'platform_status', 'live_started')),
    bot_id BIGINT REFERENCES bots(id) ON DELETE SET NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discord_notification_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN ('developer_announcement', 'platform_status', 'live_started')),
    payload JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO site_settings (setting_key, setting_value)
  VALUES ('maintenance', 'false'::jsonb),
         ('maintenance_message', '"Estamos realizando tareas de mantenimiento."'::jsonb),
         ('platform_status', '"activo"'::jsonb)
  ON CONFLICT (setting_key) DO NOTHING;
`);
} catch (error) {
  console.error('[NEON] No se pudo conectar o inicializar el esquema PostgreSQL. Revisa DATABASE_URL, TLS y el acceso de red:', error);
  throw error;
}

const app = express();
app.set('trust proxy', 1);
const devLogClients = new Set();
const siteUpdateClients = new Set();
const notificationDeliveriesInProgress = new Set();
const botInstances = [];

app.use((request, response, next) => {
  const origin = request.headers.origin;
  const isApiRequest = request.path.startsWith('/api/');
  const isAllowedOrigin = origin === frontendOrigin || origin === backendOrigin;
  if (isApiRequest && origin && !isAllowedOrigin) {
    return response.status(403).json({ error: 'Origen no autorizado.' });
  }
  if (isAllowedOrigin) {
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Modeos-Webhook-Secret');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (request.method === 'OPTIONS') {
    if (!isAllowedOrigin) return response.status(403).end();
    return response.sendStatus(204);
  }
  next();
});
function now() {
  return new Date().toISOString();
}

async function logSecurity(type, request, details = {}) {
  const event = { type, details, timestamp: now() };
  await database.query(
    'INSERT INTO security_logs (type, ip, details, created_at) VALUES ($1, $2, $3, $4)',
    [type, request.ip, JSON.stringify(details), event.timestamp]
  );
  const payload = `event: security\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of devLogClients) response.write(payload);
  return event;
}

function readyBot() {
  return botInstances.find(instance => instance.client.isReady())?.client || null;
}

const setupSlashCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Configura los canales de avisos de MODEOS EL OBI')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .toJSON();

async function syncSetupCommand(instance, guildId, enabled) {
  if (!instance.client.isReady() || !instance.client.application) {
    throw new Error('El bot debe estar conectado antes de configurar /setup.');
  }
  const commands = await instance.client.application.commands.fetch({ guildId });
  const existingCommand = commands.find(command => command.name === 'setup');
  if (enabled && !existingCommand) {
    await instance.client.application.commands.create(setupSlashCommand, guildId);
  } else if (!enabled && existingCommand) {
    await instance.client.application.commands.delete(existingCommand.id, guildId);
  }
}

async function configureNotificationChannels(instance, guild) {
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('Invita al bot con el permiso Administrar canales y vuelve a intentarlo.');
  }

  await guild.channels.fetch();
  let category = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildCategory && channel.name === DISCORD_NOTIFICATION_LAYOUT.categoryName
  );
  if (!category) {
    category = await guild.channels.create({
      name: DISCORD_NOTIFICATION_LAYOUT.categoryName,
      type: ChannelType.GuildCategory
    });
  }

  const destinations = [];
  const requiredChannelPermissions = PermissionFlagsBits.ViewChannel
    | PermissionFlagsBits.SendMessages
    | PermissionFlagsBits.EmbedLinks;
  for (const [eventType, definition] of Object.entries(DISCORD_NOTIFICATION_LAYOUT.channels)) {
    let channel = guild.channels.cache.find(existing =>
      existing.type === ChannelType.GuildText
      && existing.parentId === category.id
      && existing.name === definition.name
    );
    if (!channel) {
      channel = await guild.channels.create({
        name: definition.name,
        type: ChannelType.GuildText,
        parent: category.id,
        position: definition.position
      });
    }
    if (!channel.permissionsFor(botMember)?.has(requiredChannelPermissions)) {
      throw new Error(`El bot necesita View Channel, Send Messages y Embed Links en ${channel.name}. Revisa los permisos heredados de la categoría.`);
    }
    await database.query(`
      INSERT INTO discord_notification_routes (event_type, bot_id, guild_id, channel_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (event_type) DO UPDATE SET
        bot_id = EXCLUDED.bot_id,
        guild_id = EXCLUDED.guild_id,
        channel_id = EXCLUDED.channel_id
    `, [eventType, instance.databaseId, guild.id, channel.id]);
    destinations.push({ eventType, channelId: channel.id, channelName: channel.name });
  }
  return { categoryName: category.name, channels: destinations };
}

function requireDev(request, response, next) {
  const developerId = process.env.DISCORD_DEV_USER_ID;
  if (!developerId) return response.status(503).json({ error: 'El acceso DEV no está configurado. Define DISCORD_DEV_USER_ID.' });
  if (request.session.devAuthenticatedUserId !== developerId
    || request.session.discordUser?.id !== developerId) {
    return response.status(401).json({ error: 'Acceso DEV no autorizado para esta cuenta de Discord.' });
  }
  next();
}
function requireDiscordUser(request, response, next) {
  if (!request.session.discordUser) return response.status(401).json({ error: 'Inicia sesión con Discord.' });
  next();
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function configuredNotificationChannel(notification) {
  const channelEnvironment = notificationChannelEnvironment(notification);
  return process.env[channelEnvironment] || process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID || null;
}

function parseQueuedNotification(row) {
  return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
}

async function markNotificationDeliveryFailed(notificationId, error) {
  const message = String(error?.message || error).slice(0, 1000);
  await database.query(`
    UPDATE discord_notification_outbox
    SET attempts = attempts + 1, last_error = $2
    WHERE id = $1 AND delivered_at IS NULL
  `, [notificationId, message]);
}

async function deliverQueuedNotification(notificationId) {
  if (notificationDeliveriesInProgress.has(notificationId)) return false;
  notificationDeliveriesInProgress.add(notificationId);
  try {
    const { rows } = await database.query(
      'SELECT id, payload, delivered_at FROM discord_notification_outbox WHERE id = $1',
      [notificationId]
    );
    const queued = rows[0];
    if (!queued || queued.delivered_at) return true;
    const notification = parseQueuedNotification(queued);
    const { rows: routeRows } = await database.query(
      'SELECT bot_id, channel_id FROM discord_notification_routes WHERE event_type = $1',
      [notification.type]
    );
    const route = routeRows[0];
    let liveChannelId = null;
    if (notification.type === 'live_started') {
      const { rows: liveConfigRows } = await database.query(
        'SELECT channel_id FROM live_announcement_config WHERE config_id = 1'
      );
      liveChannelId = liveConfigRows[0]?.channel_id || null;
    }
    const readyInstances = route
      ? botInstances.filter(instance => instance.databaseId === route.bot_id && instance.client.isReady())
      : botInstances.filter(instance => instance.client.isReady());
    if (!readyInstances.length) throw new Error(route ? 'El bot configurado para esta notificacion no esta conectado.' : 'Ningun bot esta conectado.');

    const channelId = liveChannelId || route?.channel_id || configuredNotificationChannel(notification);
    if (!channelId || !/^\d{17,20}$/.test(channelId)) {
      throw new Error(`Falta un ID valido para ${notificationChannelEnvironment(notification)}.`);
    }
    let deliveredBy = null;
    let deliveryError = null;
    for (const instance of readyInstances) {
      try {
        const channel = instance.client.channels.cache.get(channelId) || await instance.client.channels.fetch(channelId);
        if (!channel?.isTextBased()) throw new Error('El canal configurado no admite mensajes de texto.');
        await channel.send({
          embeds: [createNotificationEmbed(notification, instance.client.user.displayAvatarURL())]
        });
        deliveredBy = instance.name;
        break;
      } catch (error) {
        deliveryError = error;
      }
    }
    if (!deliveredBy) throw deliveryError || new Error('Ningun bot pudo enviar la notificacion.');
    await database.query(`
      UPDATE discord_notification_outbox
      SET delivered_at = NOW(), last_error = NULL
      WHERE id = $1 AND delivered_at IS NULL
    `, [notificationId]);
    sendBotLog(`Notificacion ${notification.type} enviada por ${deliveredBy}.`);
    return true;
  } catch (error) {
    try {
      await markNotificationDeliveryFailed(notificationId, error);
    } catch (persistenceError) {
      console.error('[DISCORD] No se pudo registrar un fallo de entrega:', persistenceError);
    }
    sendBotLog(`No se pudo entregar una notificacion: ${error.message}`, 'error');
    return false;
  } finally {
    notificationDeliveriesInProgress.delete(notificationId);
  }
}

async function queueDiscordNotification(notification) {
  const payload = createNotification({ ...notification, occurredAt: notification.occurredAt || now() });
  const { rows } = await database.query(
    'INSERT INTO discord_notification_outbox (event_type, payload) VALUES ($1, $2::jsonb) RETURNING id',
    [payload.type, JSON.stringify(payload)]
  );
  const notificationId = rows[0].id;
  void deliverQueuedNotification(notificationId);
  return { id: notificationId, queued: true };
}

async function retryPendingNotifications() {
  if (!botInstances.some(instance => instance.client.isReady())) return;
  const { rows } = await database.query(`
    SELECT id, payload
    FROM discord_notification_outbox
    WHERE delivered_at IS NULL
    ORDER BY id ASC
    LIMIT 25
  `);
  for (const row of rows) {
    const notification = parseQueuedNotification(row);
    const { rows: routeRows } = await database.query(
      'SELECT 1 FROM discord_notification_routes WHERE event_type = $1',
      [notification.type]
    );
    if (routeRows.length || configuredNotificationChannel(notification)) await deliverQueuedNotification(row.id);
  }
}

async function syncBotPresence(platformStatus, client) {
  if (!client?.isReady() || !client.user) return false;
  try {
    await client.user.setPresence(createBotPresence(platformStatus));
    return true;
  } catch (error) {
    sendBotLog(`No se pudo sincronizar la presencia de ${client.user.tag}: ${error.message}`, 'error');
    return false;
  }
}

function webhookSecretIsValid(request) {
  const expected = process.env.DISCORD_EVENTS_WEBHOOK_SECRET;
  if (!expected) return null;
  const received = request.get('X-Modeos-Webhook-Secret') || '';
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isPlatformStatus(value) {
  return PLATFORM_STATUSES.includes(value);
}

app.use(express.json({ limit: '3mb' }));
app.use((error, request, response, next) => {
  if (error?.type === 'entity.too.large') {
    const isImageUpload = request.method === 'PUT' && /^\/api\/dev\/images\/[^/]+$/.test(request.path);
    return response.status(413).json({
      error: isImageUpload
        ? 'La imagen supera el límite máximo de 2 MB.'
        : 'El cuerpo de la solicitud supera el tamaño máximo permitido.',
      code: isImageUpload ? 'IMAGE_TOO_LARGE' : 'REQUEST_TOO_LARGE'
    });
  }
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return response.status(400).json({
      error: 'El cuerpo JSON de la solicitud no es válido.',
      code: 'INVALID_JSON'
    });
  }
  next(error);
});
app.use(session({
  name: 'modeos.sid',
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: frontendOrigin && frontendOrigin !== backendOrigin ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.get(['/api/auth/discord', '/auth/discord'], (request, response) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) return response.status(503).send('Discord OAuth no está configurado.');
  const state = crypto.randomBytes(24).toString('hex');
  request.session.oauthState = state;
  const authorizationUrl = new URL('https://discord.com/api/oauth2/authorize');
  authorizationUrl.search = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state
  }).toString();
  request.session.save(error => {
    if (error) {
      console.error('[OAUTH] No se pudo guardar el state:', error);
      return response.status(500).send('No se pudo iniciar la sesión de Discord.');
    }
    response.redirect(authorizationUrl.toString());
  });
});

app.get(['/api/auth/discord/callback', '/auth/discord/callback'], async (request, response) => {
  const code = typeof request.query.code === 'string' ? request.query.code : '';
  if (request.query.error) {
    console.error('[OAUTH] Discord devolvió un error durante la autorización:', {
      error: request.query.error,
      description: request.query.error_description
    });
    return response.status(401).send('No se autorizó el acceso con Discord.');
  }
  if (!code) {
    console.error('[OAUTH] El callback no recibió el parámetro code.');
    return response.status(400).send('Discord no devolvió el código de autorización.');
  }
  if (!request.session?.oauthState || request.query.state !== request.session.oauthState) {
    console.error('[OAUTH] El callback recibió un state ausente o inválido.');
    return response.status(400).send('Estado OAuth inválido. Inicia sesión de nuevo.');
  }
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    console.error('[OAUTH] Faltan DISCORD_CLIENT_ID o DISCORD_CLIENT_SECRET.');
    return response.status(503).send('Discord OAuth no está configurado.');
  }

  let oauthStage = 'intercambio del código por token';
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) {
      console.error('[OAUTH] Discord rechazó el intercambio del código:', {
        status: tokenResponse.status,
        error: token.error,
        description: token.error_description
      });
      return response.status(401).send('Discord no devolvió un token válido. Revisa Client ID, Client Secret y Redirect URI.');
    }
    oauthStage = 'consulta del perfil de Discord @me';
    const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!userResponse.ok) {
      const errorBody = await userResponse.text();
      console.error('[OAUTH] Discord rechazó la consulta del perfil @me:', {
        status: userResponse.status,
        body: errorBody.slice(0, 1000)
      });
      return response.status(401).send('Discord no pudo validar el perfil autorizado. Inténtalo de nuevo.');
    }
    const user = await userResponse.json();
    oauthStage = 'consulta de servidores autorizados';
    const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!guildsResponse.ok) {
      const errorBody = await guildsResponse.text();
      console.error('[OAUTH] Discord rechazó la consulta de servidores:', {
        status: guildsResponse.status,
        body: errorBody.slice(0, 1000)
      });
      return response.status(502).send('Se autorizó la cuenta, pero Discord no devolvió la lista de servidores.');
    }
    const guilds = await guildsResponse.json();
    request.session.regenerate(error => {
      if (error) {
        console.error('[OAUTH] No se pudo crear la sesión:', error);
        return response.status(500).send('No se pudo crear la sesión de acceso.');
      }
      request.session.discordUser = { id: user.id, username: user.username, avatar: user.avatar };
      request.session.discordGuilds = Array.isArray(guilds) ? guilds : [];
      request.session.discordAccessToken = token.access_token;
      request.session.save(saveError => {
        if (saveError) {
          console.error('[OAUTH] No se pudo guardar la sesión:', saveError);
          return response.status(500).send('No se pudo guardar la sesión de acceso.');
        }
        response.redirect(frontendUrl || publicUrl);
      });
    });
  } catch (error) {
    console.error(`[OAUTH] Falló la etapa de ${oauthStage}:`, error);
    response.status(500).send('No se pudo completar el acceso con Discord.');
  }
});

app.post('/api/auth/logout', (request, response) => request.session.destroy(() => response.json({ ok: true })));
app.get('/api/auth/me', (request, response) => {
  const developerId = process.env.DISCORD_DEV_USER_ID;
  response.json({
    user: request.session.discordUser || null,
    devAuthenticated: Boolean(
      developerId
      && request.session.devAuthenticatedUserId === developerId
      && request.session.discordUser?.id === developerId
    )
  });
});
app.get('/api/health', asyncRoute(async (_request, response) => {
  const [state, pendingResult] = await Promise.all([
    readSiteState(),
    database.query('SELECT COUNT(*)::int AS total FROM discord_notification_outbox WHERE delivered_at IS NULL')
  ]);
  const readyInstances = botInstances.filter(instance => instance.client.isReady());
  response.json({
    status: 'ok',
    service: 'modeos-el-obi',
    database: 'connected',
    webUrl: MODEOS_WEB_URL,
    platformStatus: state.platformStatus,
    bots: botInstances.map(({ name, client }) => ({ name, ready: client.isReady(), userId: client.user?.id || null })),
    bot: {
      ready: readyInstances.length > 0,
      connectedInstances: readyInstances.length,
      pendingNotifications: pendingResult.rows[0].total
    },
    version: process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || 'local',
    checkedAt: now()
  });
}));
app.get('/api/bots', asyncRoute(async (_request, response) => {
  const { rows } = await database.query('SELECT id, bot_name, discord_user_id, status FROM bots ORDER BY id');
  response.json(rows.map(({ discord_user_id: userId, ...entry }) => ({
    ...entry,
    connected: botInstances.some(instance => instance.client.isReady() && instance.client.user?.id === userId)
  })));
}));
app.get('/api/dev/bots', requireDev, asyncRoute(async (_request, response) => {
  const { rows } = await database.query(`
    SELECT id, bot_name, client_id, status, managed_token, setup_command_enabled, discord_user_id
    FROM bots
    ORDER BY id
  `);
  response.json(rows.map(({ discord_user_id: userId, ...entry }) => ({
    ...entry,
    connected: botInstances.some(instance => instance.client.isReady() && instance.client.user?.id === userId)
  })));
}));
app.post('/api/dev/bots', requireDev, asyncRoute(async (request, response) => {
  const token = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
  if (!token || token.length > 512) return response.status(400).json({ error: 'Introduce un token de bot válido.' });
  if (!process.env.DISCORD_BOT_TOKEN_ENCRYPTION_KEY || process.env.DISCORD_BOT_TOKEN_ENCRYPTION_KEY.length < 32) {
    return response.status(503).json({ error: 'Configura DISCORD_BOT_TOKEN_ENCRYPTION_KEY (mínimo 32 caracteres) en Render antes de añadir bots.' });
  }

  let discordResponse;
  try {
    discordResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bot ${token}` }
    });
  } catch (error) {
    console.error('[BOT] No se pudo validar el token del bot con Discord:', error);
    return response.status(502).json({ error: 'No se pudo validar el token con Discord. Inténtalo de nuevo.' });
  }
  if (!discordResponse.ok) return response.status(401).json({ error: 'Discord rechazó el token. Comprueba que sea el token de un bot válido.' });
  const discordUser = await discordResponse.json();
  if (!discordUser.bot || !discordUser.id || !discordUser.username) {
    return response.status(400).json({ error: 'El token no pertenece a una cuenta bot de Discord.' });
  }
  const duplicate = await database.query('SELECT id FROM bots WHERE discord_user_id = $1', [discordUser.id]);
  if (duplicate.rowCount) return response.status(409).json({ error: 'Este bot ya está registrado.' });

  const botName = `${discordUser.username} (${discordUser.id})`;
  const encryptedToken = encryptBotToken(token, process.env.DISCORD_BOT_TOKEN_ENCRYPTION_KEY);
  const { rows } = await database.query(`
    INSERT INTO bots (bot_name, discord_user_id, client_id, encrypted_token, managed_token)
    VALUES ($1, $2, $2, $3, TRUE)
    RETURNING id, bot_name, client_id, status
  `, [botName, discordUser.id, encryptedToken]);
  await database.query(`
    INSERT INTO bot_commands (bot_id, command_name, is_enabled)
    SELECT $1, command_name, command_name <> 'setup'
    FROM unnest(ARRAY['ping', 'status', 'guilds', 'send', 'setup']::TEXT[]) AS commands(command_name)
    ON CONFLICT (bot_id, command_name) DO NOTHING
  `, [rows[0].id]);
  startBotInstance({ name: botName, token }, rows[0].id);
  await logSecurity('discord_bot_added', request, { botId: rows[0].id, discordUserId: discordUser.id });
  response.status(201).json({ ...rows[0], connected: false, managed_token: true });
}));
app.delete('/api/dev/bots/:botId', requireDev, asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.botId)) return response.status(400).json({ error: 'Identificador de bot no válido.' });
  const { rows } = await database.query('SELECT id, bot_name, managed_token FROM bots WHERE id = $1', [request.params.botId]);
  const bot = rows[0];
  if (!bot) return response.status(404).json({ error: 'No se encontró ese bot.' });
  if (!bot.managed_token) return response.status(400).json({ error: 'Este bot se administra desde las variables de entorno y no puede quitarse desde el panel.' });
  await database.query('DELETE FROM discord_notification_routes WHERE bot_id = $1', [bot.id]);
  await database.query('DELETE FROM bots WHERE id = $1', [bot.id]);
  const instanceIndex = botInstances.findIndex(instance => instance.databaseId === bot.id);
  if (instanceIndex >= 0) {
    const [instance] = botInstances.splice(instanceIndex, 1);
    instance.removed = true;
    clearTimeout(instance.retryTimer);
    instance.client.destroy();
  }
  await logSecurity('discord_bot_removed', request, { botId: bot.id });
  await broadcastBotCatalogUpdate();
  response.json({ ok: true, botId: bot.id });
}));
app.get('/api/dev/bots/:botId/guilds', requireDev, asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.botId)) return response.status(400).json({ error: 'Identificador de bot no válido.' });
  const instance = botInstances.find(bot => String(bot.databaseId) === request.params.botId);
  if (!instance) return response.status(404).json({ error: 'No se encontró ese bot.' });
  if (!instance.client.isReady()) return response.status(503).json({ error: 'El bot todavía no está conectado. Actualiza cuando aparezca como conectado.' });
  response.json(instance.client.guilds.cache.map(guild => ({ id: guild.id, name: guild.name })).sort((a, b) => a.name.localeCompare(b.name)));
}));
app.put('/api/dev/bots/:botId/setup-command', requireDev, asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.botId) || typeof request.body?.enabled !== 'boolean') {
    return response.status(400).json({ error: 'Bot o estado de /setup no válido.' });
  }
  const { rows } = await database.query(
    'SELECT id, bot_name FROM bots WHERE id = $1',
    [request.params.botId]
  );
  if (!rows[0]) return response.status(404).json({ error: 'No se encontró ese bot.' });
  const instance = botInstances.find(bot => String(bot.databaseId) === request.params.botId);
  if (!instance || !instance.client.isReady()) {
    return response.status(503).json({ error: 'El bot debe estar conectado para registrar /setup.' });
  }
  await database.query('UPDATE bots SET setup_command_enabled = $1 WHERE id = $2', [request.body.enabled, rows[0].id]);
  await database.query(`
    INSERT INTO bot_commands (bot_id, command_name, is_enabled)
    VALUES ($1, 'setup', $2)
    ON CONFLICT (bot_id, command_name) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = NOW()
  `, [rows[0].id, request.body.enabled]);
  instance.setupCommandEnabled = request.body.enabled;
  const guildResults = [];
  for (const guild of instance.client.guilds.cache.values()) {
    try {
      await syncSetupCommand(instance, guild.id, request.body.enabled);
      guildResults.push(guild.name);
    } catch (error) {
      console.error(`[BOT] No se pudo ${request.body.enabled ? 'registrar' : 'quitar'} /setup en ${guild.name}:`, error);
    }
  }
  if (guildResults.length !== instance.client.guilds.cache.size) {
    return response.status(502).json({
      error: `No se pudo actualizar /setup en todos los servidores. Actualizado en ${guildResults.length} de ${instance.client.guilds.cache.size}; revisa los permisos y vuelve a guardar.`,
      guilds: guildResults
    });
  }
  await logSecurity('discord_setup_command_toggled', request, { botId: rows[0].id, enabled: request.body.enabled });
  response.json({ id: rows[0].id, bot_name: rows[0].bot_name, enabled: request.body.enabled, guildCount: guildResults.length });
}));
app.get('/api/dev/bots/:botId/commands', requireDev, asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.botId)) return response.status(400).json({ error: 'Identificador de bot no válido.' });
  const { rows } = await database.query('SELECT id, setup_command_enabled FROM bots WHERE id = $1', [request.params.botId]);
  if (!rows[0]) return response.status(404).json({ error: 'No se encontró ese bot.' });
  const commandStates = await database.query('SELECT command_name, is_enabled FROM bot_commands WHERE bot_id = $1', [rows[0].id]);
  const stateByName = new Map(commandStates.rows.map(command => [command.command_name, command.is_enabled]));
  response.json(devCommandCatalog.map(command => ({
    ...command,
    is_enabled: command.name === 'setup'
      ? Boolean(rows[0].setup_command_enabled)
      : stateByName.get(command.name) ?? true
  })));
}));
app.put('/api/dev/bots/:botId/commands/:commandName', requireDev, asyncRoute(async (request, response) => {
  const { botId, commandName } = request.params;
  if (!/^\d+$/.test(botId) || typeof request.body?.enabled !== 'boolean'
    || !devCommandCatalog.some(command => command.name === commandName)) {
    return response.status(400).json({ error: 'Bot, comando o estado no válido.' });
  }
  const { rows } = await database.query('SELECT id FROM bots WHERE id = $1', [botId]);
  if (!rows[0]) return response.status(404).json({ error: 'No se encontró ese bot.' });
  if (commandName === 'setup') {
    const instance = botInstances.find(bot => String(bot.databaseId) === botId);
    if (!instance?.client.isReady()) return response.status(503).json({ error: 'El bot debe estar conectado para cambiar el estado de /setup.' });
    const guildResults = [];
    for (const guild of instance.client.guilds.cache.values()) {
      try {
        await syncSetupCommand(instance, guild.id, request.body.enabled);
        guildResults.push(guild.name);
      } catch (error) {
        console.error(`[BOT] No se pudo actualizar /setup en ${guild.name}:`, error);
      }
    }
    if (guildResults.length !== instance.client.guilds.cache.size) {
      return response.status(502).json({ error: `No se pudo actualizar /setup en todos los servidores (${guildResults.length}/${instance.client.guilds.cache.size}).` });
    }
    await database.query('UPDATE bots SET setup_command_enabled = $1 WHERE id = $2', [request.body.enabled, rows[0].id]);
    instance.setupCommandEnabled = request.body.enabled;
  }
  await database.query(`
    INSERT INTO bot_commands (bot_id, command_name, is_enabled)
    VALUES ($1, $2, $3)
    ON CONFLICT (bot_id, command_name) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = NOW()
  `, [rows[0].id, commandName, request.body.enabled]);
  await logSecurity('discord_command_toggled', request, { botId: rows[0].id, commandName, enabled: request.body.enabled });
  response.json({ botId: rows[0].id, commandName, enabled: request.body.enabled });
}));
app.post('/api/dev/bots/:botId/commands/:commandName/execute', requireDev, asyncRoute(async (request, response) => {
  const { botId, commandName } = request.params;
  const guildId = String(request.body?.guildId || '');
  if (!/^\d+$/.test(botId) || !/^\d{17,20}$/.test(guildId)
    || !devCommandCatalog.some(command => command.name === commandName)) {
    return response.status(400).json({ error: 'Bot, comando o servidor no válido.' });
  }
  const botResult = await database.query('SELECT id, setup_command_enabled FROM bots WHERE id = $1', [botId]);
  if (!botResult.rows[0]) return response.status(404).json({ error: 'No se encontró ese bot.' });
  const stateResult = await database.query('SELECT is_enabled FROM bot_commands WHERE bot_id = $1 AND command_name = $2', [botResult.rows[0].id, commandName]);
  const enabled = commandName === 'setup'
    ? Boolean(botResult.rows[0].setup_command_enabled)
    : stateResult.rows[0]?.is_enabled ?? true;
  if (!enabled) return response.status(409).json({ error: `El comando ${commandName} está desactivado para este bot.` });
  const instance = botInstances.find(bot => String(bot.databaseId) === botId);
  if (!instance?.client.isReady()) return response.status(503).json({ error: 'El bot no está conectado.' });
  const guild = instance.client.guilds.cache.get(guildId);
  if (!guild) return response.status(404).json({ error: 'El bot no pertenece al servidor seleccionado.' });

  let output;
  if (commandName === 'ping') {
    output = `Pong: ${instance.client.ws.ping}ms · ${guild.name}`;
  } else if (commandName === 'status') {
    output = `${instance.client.user.tag} está conectado en ${guild.name} (${guild.memberCount} miembros).`;
  } else if (commandName === 'guilds') {
    output = instance.client.guilds.cache.map(connectedGuild => `${connectedGuild.name} (${connectedGuild.id})`).join('\n') || 'Sin servidores.';
  } else if (commandName === 'send') {
    const channelId = String(request.body?.channelId || '');
    const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
    if (!/^\d{17,20}$/.test(channelId) || !message || message.length > 2000) {
      return response.status(400).json({ error: 'Indica un canal válido y un mensaje de hasta 2000 caracteres.' });
    }
    const channel = await instance.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.guildId !== guild.id) {
      return response.status(400).json({ error: 'El canal no es de texto o no pertenece al servidor seleccionado.' });
    }
    const channelPermissions = channel.permissionsFor(instance.client.user);
    if (!channelPermissions?.has(PermissionFlagsBits.SendMessages)) {
      return response.status(403).json({ error: 'El bot no tiene permiso para enviar mensajes en ese canal.' });
    }
    if (!channelPermissions.has(PermissionFlagsBits.EmbedLinks)) {
      return response.status(403).json({ error: 'El bot necesita el permiso Insertar enlaces para enviar mensajes enriquecidos.' });
    }
    await channel.send({
      embeds: [createBotEmbed({
        status: 'info',
        title: '📨 Mensaje enviado desde el Dev Panel',
        description: message,
        fields: [
          { name: 'Servidor', value: guild.name, inline: true },
          { name: 'Canal', value: `#${channel.name}`, inline: true }
        ],
        thumbnailUrl: instance.client.user.displayAvatarURL()
      })]
    });
    output = `Mensaje enviado a #${channel.name} en ${guild.name}.`;
  } else {
    const setup = await configureNotificationChannels(instance, guild);
    void retryPendingNotifications().catch(error => console.error('[DISCORD] No se pudieron reintentar las notificaciones:', error));
    output = `Configuración completada en ${guild.name}. Canales: ${setup.channels.map(channel => `#${channel.channelName}`).join(', ')}.`;
  }
  sendBotLog(`Comando ${commandName} ejecutado por DEV en ${guild.name}.`);
  await logSecurity('discord_command_executed', request, { botId: botResult.rows[0].id, commandName, guildId });
  response.json({ output });
}));
app.get('/api/social-links', asyncRoute(async (_request, response) => {
  const { rows } = await database.query(
    'SELECT platform, url FROM streaming_links WHERE is_active = TRUE'
  );
  response.setHeader('Cache-Control', 'no-store');
  response.json(rows);
}));
app.get('/api/dev/social-links', requireDev, asyncRoute(async (_request, response) => {
  const { rows } = await database.query(`
    SELECT platforms.platform, COALESCE(links.url, '') AS url, COALESCE(links.is_active, FALSE) AS is_active
    FROM (VALUES ('twitch'), ('youtube')) AS platforms(platform)
    LEFT JOIN streaming_links links ON links.platform = platforms.platform
    ORDER BY platforms.platform
  `);
  response.json(rows);
}));
app.put('/api/dev/social-links/:platform', requireDev, asyncRoute(async (request, response) => {
  const { platform } = request.params;
  const url = typeof request.body?.url === 'string' ? request.body.url.trim() : '';
  const isActive = request.body?.is_active;
  if (!['twitch', 'youtube'].includes(platform) || typeof isActive !== 'boolean' || url.length > 500) {
    return response.status(400).json({ error: 'Plataforma, enlace o estado no válido.' });
  }
  if (isActive) {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return response.status(400).json({ error: 'Introduce un enlace válido.' }); }
    const hostname = parsedUrl.hostname.toLowerCase();
    const allowedHost = platform === 'twitch'
      ? hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv')
      : hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be';
    if (parsedUrl.protocol !== 'https:' || !allowedHost || !parsedUrl.pathname.replaceAll('/', '')) {
      return response.status(400).json({ error: `El enlace debe ser HTTPS y pertenecer a ${platform === 'twitch' ? 'twitch.tv' : 'youtube.com o youtu.be'}.` });
    }
  }
  const { rows } = await database.query(`
    INSERT INTO streaming_links (platform, url, is_active)
    VALUES ($1, $2, $3)
    ON CONFLICT (platform) DO UPDATE SET url = EXCLUDED.url, is_active = EXCLUDED.is_active, updated_at = NOW()
    RETURNING platform, url, is_active
  `, [platform, url, isActive]);
  await logSecurity('streaming_link_updated', request, { platform, isActive });
  response.json(rows[0]);
}));
app.get('/api/dev/bots/:botId/guilds/:guildId/channels', requireDev, asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.botId) || !/^\d{17,20}$/.test(request.params.guildId)) {
    return response.status(400).json({ error: 'Bot o servidor no válido.' });
  }
  const instance = botInstances.find(bot => String(bot.databaseId) === request.params.botId);
  if (!instance?.client.isReady()) return response.status(503).json({ error: 'El bot todavía no está conectado.' });
  const guild = instance.client.guilds.cache.get(request.params.guildId);
  if (!guild) return response.status(404).json({ error: 'El bot no pertenece al servidor seleccionado.' });
  await guild.channels.fetch();
  const botMember = guild.members.me || await guild.members.fetchMe();
  response.json(guild.channels.cache
    .filter(channel => channel.type === ChannelType.GuildText && channel.permissionsFor(botMember)?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks
    ]))
    .map(channel => ({ id: channel.id, name: channel.name }))
    .sort((a, b) => a.name.localeCompare(b.name)));
}));
app.get('/api/dev/bot-notifications', requireDev, asyncRoute(async (_request, response) => {
  const { rows } = await database.query(`
    SELECT route.event_type, route.bot_id, route.guild_id, route.channel_id, bot.bot_name
    FROM discord_notification_routes route
    LEFT JOIN bots bot ON bot.id = route.bot_id
    ORDER BY route.event_type
  `);
  response.json(rows);
}));
app.put('/api/dev/bot-notifications', requireDev, asyncRoute(async (request, response) => {
  const eventType = String(request.body?.eventType ?? '');
  const botId = String(request.body?.botId ?? '');
  const guildId = String(request.body?.guildId ?? '');
  const channelId = String(request.body?.channelId ?? '');
  if (!Object.hasOwn(DISCORD_NOTIFICATION_LAYOUT.channels, eventType)
    || !/^\d+$/.test(botId)
    || !/^\d{17,20}$/.test(guildId)
    || !/^\d{17,20}$/.test(channelId)) {
    return response.status(400).json({ error: 'Selecciona un tipo de aviso, bot, servidor y canal válidos.' });
  }
  const instance = botInstances.find(bot => String(bot.databaseId) === botId);
  if (!instance?.client.isReady()) return response.status(503).json({ error: 'El bot todavía no está conectado.' });
  const guild = instance.client.guilds.cache.get(guildId);
  if (!guild) return response.status(404).json({ error: 'El bot no pertenece al servidor seleccionado.' });
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText
    || !channel.permissionsFor(guild.members.me)?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks
    ])) {
    return response.status(400).json({ error: 'El canal debe ser de texto y permitir ver, enviar mensajes e insertar enlaces al bot.' });
  }
  await database.query(`
    INSERT INTO discord_notification_routes (event_type, bot_id, guild_id, channel_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (event_type) DO UPDATE SET
      bot_id = EXCLUDED.bot_id,
      guild_id = EXCLUDED.guild_id,
      channel_id = EXCLUDED.channel_id
  `, [eventType, instance.databaseId, guild.id, channel.id]);
  await logSecurity('discord_notification_route_updated', request, { eventType, botId: instance.databaseId, guildId, channelId });
  void retryPendingNotifications().catch(error => console.error('[DISCORD] No se pudieron reintentar las notificaciones:', error));
  response.json({ eventType, botName: instance.name, guildName: guild.name, channelId: channel.id, channelName: channel.name });
}));
app.post('/api/dev/bot-notifications/setup', requireDev, asyncRoute(async (request, response) => {
  const botId = String(request.body?.botId ?? '');
  const guildId = String(request.body?.guildId ?? '');
  if (!/^\d+$/.test(botId) || !/^\d{17,20}$/.test(guildId)) {
    return response.status(400).json({ error: 'Selecciona un bot y un servidor válidos.' });
  }
  const instance = botInstances.find(bot => String(bot.databaseId) === botId);
  if (!instance) return response.status(404).json({ error: 'No se encontró ese bot.' });
  if (!instance.client.isReady()) return response.status(503).json({ error: 'El bot todavía no está conectado.' });
  const guild = instance.client.guilds.cache.get(guildId);
  if (!guild) return response.status(404).json({ error: 'El bot no pertenece al servidor seleccionado. Invítalo primero y vuelve a actualizar.' });
  let setup;
  try {
    setup = await configureNotificationChannels(instance, guild);
  } catch (error) {
    const statusCode = /Administrar canales|permisos heredados/.test(error.message) ? 403 : 502;
    return response.status(statusCode).json({ error: error.message });
  }

  await logSecurity('discord_notification_channels_configured', request, {
    botId: instance.databaseId,
    guildId: guild.id,
    channelIds: setup.channels.map(destination => destination.channelId)
  });
  void retryPendingNotifications().catch(error => console.error('[DISCORD] No se pudieron reintentar las notificaciones:', error));
  response.json({ botName: instance.name, guildName: guild.name, ...setup });
}));
app.post('/api/dev/bot-status', requireDev, asyncRoute(async (request, response) => {
  const { botId, status } = request.body || {};
  if (!/^\d+$/.test(String(botId ?? '')) || !isPlatformStatus(status)) {
    return response.status(400).json({ error: 'botId o status no válido.' });
  }
  const { rows } = await database.query('SELECT id, bot_name, discord_user_id FROM bots WHERE id = $1', [botId]);
  if (!rows[0]) return response.status(404).json({ error: 'No se encontró ese bot.' });
  await database.query('UPDATE bots SET status = $1 WHERE id = $2', [status, botId]);
  const client = botInstances.find(instance => instance.client.user?.id === rows[0].discord_user_id)?.client;
  if (client) await syncBotPresence(status, client);
  await broadcastBotCatalogUpdate();
  await logSecurity('bot_status_updated', request, { botId: rows[0].id, status });
  response.json({ id: rows[0].id, bot_name: rows[0].bot_name, status, connected: Boolean(client?.isReady()) });
}));
app.get('/api/discord/guilds', requireDiscordUser, asyncRoute(async (request, response) => {
  if (request.query.refresh === 'true' && request.session.discordAccessToken) {
    try {
      const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${request.session.discordAccessToken}` }
      });
      if (guildsResponse.ok) {
        const freshGuilds = await guildsResponse.json();
        if (Array.isArray(freshGuilds)) {
          request.session.discordGuilds = freshGuilds;
          await new Promise(resolve => request.session.save(resolve));
        }
      }
    } catch (err) {
      console.warn('[OAUTH] No se pudieron refrescar los servidores desde Discord:', err.message);
    }
  }

  const connectedBots = botInstances.filter(instance => instance.client.isReady());
  const guilds = (request.session.discordGuilds || []).map(guild => ({
    ...guild,
    botPresent: connectedBots.some(instance => instance.client.guilds.cache.has(guild.id))
  }));
  response.json(guilds);
}));
app.get('/api/config', (_request, response) => {
  const configuredBot = readyBot();
  const isReady = Boolean(configuredBot);
  response.json({
    discordClientId: process.env.DISCORD_CLIENT_ID || null,
    botReady: isReady,
    botTag: isReady ? configuredBot.user?.tag : null,
    botUsername: isReady ? configuredBot.user?.username : null,
    botAvatar: isReady && configuredBot.user ? configuredBot.user.displayAvatarURL() : null,
    botId: isReady && configuredBot.user ? configuredBot.user.id : (process.env.DISCORD_CLIENT_ID || null)
  });
});

async function readSiteState() {
  const [settingsResult, messagesResult] = await Promise.all([
    database.query("SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('maintenance', 'maintenance_message', 'platform_status')"),
    database.query('SELECT message_id, content, created_at FROM site_messages ORDER BY created_at DESC, message_id DESC LIMIT 100')
  ]);
  const settings = Object.fromEntries(settingsResult.rows.map(row => [row.setting_key, row.setting_value]));
  const maintenance = settings.maintenance === true;
  const configuredStatus = isPlatformStatus(settings.platform_status) ? settings.platform_status : 'activo';
  return {
    maintenance,
    maintenanceMessage: typeof settings.maintenance_message === 'string' ? settings.maintenance_message : 'Estamos realizando tareas de mantenimiento.',
    platformStatus: maintenance ? 'mantenimiento' : (configuredStatus === 'mantenimiento' ? 'activo' : configuredStatus),
    messages: messagesResult.rows
  };
}

async function persistSiteState({ maintenance, maintenanceMessage, platformStatus }) {
  const requestedStatus = isPlatformStatus(platformStatus) ? platformStatus : 'activo';
  const resolvedStatus = maintenance ? 'mantenimiento' : (requestedStatus === 'mantenimiento' ? 'activo' : requestedStatus);
  await database.query(`
    INSERT INTO site_settings (setting_key, setting_value, updated_at)
    VALUES ('maintenance', to_jsonb($1::boolean), NOW()),
           ('maintenance_message', to_jsonb($2::text), NOW()),
           ('platform_status', to_jsonb($3::text), NOW())
    ON CONFLICT (setting_key) DO UPDATE SET
      setting_value = EXCLUDED.setting_value,
      updated_at = EXCLUDED.updated_at
  `, [maintenance, maintenanceMessage, resolvedStatus]);

  return readSiteState();
}

function siteStateChanged(previous, next) {
  return previous.maintenance !== next.maintenance
    || previous.platformStatus !== next.platformStatus
    || ((previous.maintenance || next.maintenance) && previous.maintenanceMessage !== next.maintenanceMessage);
}

async function notifySiteStateChange(previous, next) {
  if (!siteStateChanged(previous, next)) return null;
  return queueDiscordNotification(createNotification({
    type: 'platform_status',
    platformStatus: next.platformStatus,
    message: next.platformStatus === 'mantenimiento' ? next.maintenanceMessage : undefined
  }));
}

async function broadcastSiteUpdate() {
  const state = await readSiteState();
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const response of siteUpdateClients) response.write(payload);
}

async function broadcastBotCatalogUpdate() {
  const payload = `data: ${JSON.stringify({ type: 'bots_changed' })}\n\n`;
  for (const response of siteUpdateClients) response.write(payload);
}

app.get('/api/site-state', asyncRoute(async (_request, response) => {
  response.json(await readSiteState());
}));

app.get('/api/site/updates', (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  siteUpdateClients.add(response);
  response.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20000);
  request.on('close', () => {
    clearInterval(heartbeat);
    siteUpdateClients.delete(response);
  });
});

app.put('/api/dev/site-state', requireDev, asyncRoute(async (request, response) => {
  const { maintenance, maintenanceMessage, platformStatus } = request.body || {};
  if (typeof maintenance !== 'boolean') {
    return response.status(400).json({ error: 'maintenance debe ser true o false.' });
  }
  if (typeof maintenanceMessage !== 'string' || maintenanceMessage.trim().length > 500) {
    return response.status(400).json({ error: 'El mensaje de mantenimiento es obligatorio y debe tener 500 caracteres o menos.' });
  }
  if (platformStatus !== undefined && !isPlatformStatus(platformStatus)) {
    return response.status(400).json({ error: 'platformStatus debe ser activo, beta o mantenimiento.' });
  }
  const previousState = await readSiteState();
  const state = await persistSiteState({
    maintenance,
    maintenanceMessage: maintenanceMessage.trim(),
    platformStatus: platformStatus ?? previousState.platformStatus
  });
  const notification = await notifySiteStateChange(previousState, state);
  await broadcastSiteUpdate();
  await logSecurity('site_state_updated', request, { maintenance });
  response.json({ ...state, notification });
}));

app.post('/api/dev/site-messages', requireDev, asyncRoute(async (request, response) => {
  const content = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
  if (!content || content.length > 1000) {
    return response.status(400).json({ error: 'El mensaje debe tener entre 1 y 1000 caracteres.' });
  }
  const { rows } = await database.query(
    'INSERT INTO site_messages (content) VALUES ($1) RETURNING message_id, content, created_at',
    [content]
  );
  const notification = await queueDiscordNotification(createNotification({
    type: 'developer_announcement',
    title: 'Comunicado oficial',
    message: content
  }));
  await logSecurity('site_message_created', request, { messageId: rows[0].message_id });
  const state = await readSiteState();
  await broadcastSiteUpdate();
  response.status(201).json({ message: rows[0], state, notification });
}));

app.delete('/api/dev/site-messages/:id', requireDev, asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) return response.status(400).json({ error: 'Identificador de mensaje inválido.' });
  const result = await database.query('DELETE FROM site_messages WHERE message_id = $1 RETURNING message_id', [request.params.id]);
  if (!result.rowCount) return response.status(404).json({ error: 'No se encontró ese mensaje.' });
  await logSecurity('site_message_removed', request, { messageId: result.rows[0].message_id });
  const state = await readSiteState();
  await broadcastSiteUpdate();
  response.json(state);
}));

app.get('/api/dev/live-announcement-config', requireDev, asyncRoute(async (_request, response) => {
  const { rows } = await database.query(`
    SELECT title_template, message_template, channel_id, is_active, updated_at
    FROM live_announcement_config WHERE config_id = 1
  `);
  response.json(rows[0]);
}));

app.put('/api/dev/live-announcement-config', requireDev, asyncRoute(async (request, response) => {
  const title = typeof request.body?.title_template === 'string' ? request.body.title_template.trim() : '';
  const message = typeof request.body?.message_template === 'string' ? request.body.message_template.trim() : '';
  const channelId = typeof request.body?.channel_id === 'string' ? request.body.channel_id.trim() : '';
  const isActive = request.body?.is_active;
  if (!title || title.length > 256 || !message || message.length > 1000
    || typeof isActive !== 'boolean' || (channelId && !/^\d{17,20}$/.test(channelId))) {
    return response.status(400).json({ error: 'Revisa el título, mensaje, canal y estado del anuncio de directo.' });
  }
  const { rows } = await database.query(`
    INSERT INTO live_announcement_config (config_id, title_template, message_template, channel_id, is_active)
    VALUES (1, $1, $2, NULLIF($3, ''), $4)
    ON CONFLICT (config_id) DO UPDATE SET
      title_template = EXCLUDED.title_template,
      message_template = EXCLUDED.message_template,
      channel_id = EXCLUDED.channel_id,
      is_active = EXCLUDED.is_active,
      updated_at = NOW()
    RETURNING title_template, message_template, channel_id, is_active, updated_at
  `, [title, message, channelId, isActive]);
  await logSecurity('live_announcement_config_updated', request, { isActive, channelId: channelId || null });
  response.json(rows[0]);
}));

app.get('/api/dev/video-announcement-config', requireDev, asyncRoute(async (_request, response) => {
  const { rows } = await database.query(`
    SELECT platform, title_template, target_channel_id, notification_text, is_active, updated_at
    FROM video_announcement_config WHERE config_id = 1
  `);
  response.json(rows[0]);
}));

app.put('/api/dev/video-announcement-config', requireDev, asyncRoute(async (request, response) => {
  const title = typeof request.body?.title_template === 'string' ? request.body.title_template.trim() : '';
  const targetChannelId = typeof request.body?.target_channel_id === 'string' ? request.body.target_channel_id.trim() : '';
  const notificationText = typeof request.body?.notification_text === 'string' ? request.body.notification_text.trim() : '';
  const isActive = request.body?.is_active;
  if (!title || title.length > 256 || !notificationText || notificationText.length > 1000
    || typeof isActive !== 'boolean' || (targetChannelId && !/^\d{17,20}$/.test(targetChannelId))) {
    return response.status(400).json({ error: 'Revisa el título, texto, canal destino y estado del aviso de vídeo.' });
  }
  const { rows } = await database.query(`
    INSERT INTO video_announcement_config (config_id, platform, title_template, target_channel_id, notification_text, is_active)
    VALUES (1, 'youtube', $1, $2, $3, $4)
    ON CONFLICT (config_id) DO UPDATE SET
      title_template = EXCLUDED.title_template,
      target_channel_id = EXCLUDED.target_channel_id,
      notification_text = EXCLUDED.notification_text,
      is_active = EXCLUDED.is_active,
      updated_at = NOW()
    RETURNING platform, title_template, target_channel_id, notification_text, is_active, updated_at
  `, [title, targetChannelId, notificationText, isActive]);
  await logSecurity('video_announcement_config_updated', request, { isActive, targetChannelId: targetChannelId || null });
  response.json(rows[0]);
}));

app.post('/api/dev/live-events', requireDev, asyncRoute(async (request, response) => {
  const { rows } = await database.query(`
    SELECT title_template, message_template, is_active
    FROM live_announcement_config WHERE config_id = 1
  `);
  const config = rows[0];
  if (!config?.is_active) return response.status(409).json({ error: 'El anuncio de directo está desactivado.' });
  const notification = createNotification({
    type: 'live_started',
    title: config.title_template,
    message: config.message_template
  });
  const queued = await queueDiscordNotification(notification);
  await logSecurity('live_event_announced', request, { notificationId: queued.id });
  response.status(202).json({ ok: true, notification: queued });
}));

app.post('/api/integrations/discord/events', asyncRoute(async (request, response) => {
  const authenticated = webhookSecretIsValid(request);
  if (authenticated === null) {
    return response.status(503).json({ error: 'El webhook de eventos no esta configurado.' });
  }
  if (!authenticated) return response.status(401).json({ error: 'Webhook no autorizado.' });

  let notification;
  try {
    notification = createNotification(request.body);
  } catch (error) {
    if (error instanceof NotificationValidationError) return response.status(400).json({ error: error.message });
    throw error;
  }

  let state = null;
  if (notification.type === 'platform_status') {
    const previousState = await readSiteState();
    const platformStatus = normalizePlatformStatus(notification.platformStatus);
    state = await persistSiteState({
      maintenance: platformStatus === 'mantenimiento',
      maintenanceMessage: platformStatus === 'mantenimiento' ? notification.message : previousState.maintenanceMessage,
      platformStatus
    });
    await broadcastSiteUpdate();
  }

  const queued = await queueDiscordNotification(notification);
  await logSecurity('discord_webhook_event_received', request, { type: notification.type, notificationId: queued.id });
  response.status(202).json({ ok: true, notification: queued, state });
}));

function siteImageUrl(slot, updatedAt) {
  return `/api/site-images/${slot}?v=${encodeURIComponent(updatedAt)}`;
}

app.get('/api/site-images', asyncRoute(async (_request, response) => {
  const { rows } = await database.query(
    'SELECT slot, alt_text, updated_at FROM site_images WHERE slot = ANY($1)',
    [Array.from(siteImageSlots)]
  );
  response.json(rows.map(image => ({
    slot: image.slot,
    alt: image.alt_text,
    updatedAt: image.updated_at,
    url: siteImageUrl(image.slot, image.updated_at)
  })));
}));

app.get('/api/site-images/:slot', asyncRoute(async (request, response) => {
  if (!siteImageSlots.has(request.params.slot)) return response.status(404).json({ error: 'Ubicación de imagen inexistente.' });
  const { rows } = await database.query(
    'SELECT mime_type, image_data FROM site_images WHERE slot = $1',
    [request.params.slot]
  );
  if (!rows[0]) return response.status(404).json({ error: 'No hay ninguna imagen publicada en esta ubicación.' });
  response.setHeader('Content-Type', rows[0].mime_type);
  response.setHeader('Cache-Control', 'public, max-age=300');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.send(rows[0].image_data);
}));

app.put('/api/dev/images/:slot', requireDev, asyncRoute(async (request, response) => {
  const { slot } = request.params;
  if (!siteImageSlots.has(slot)) return response.status(404).json({ error: 'Ubicación de imagen inexistente.' });

  let image;
  try {
    image = parseSiteImageDataUrl(request.body?.image);
  } catch (error) {
    if (!(error instanceof SiteImageValidationError)) throw error;
    return response.status(error.status).json({ error: error.message, code: error.code });
  }

  const altText = typeof request.body?.alt === 'string' ? request.body.alt.trim().slice(0, 160) : '';
  const updatedAt = now();
  await database.query(`
    INSERT INTO site_images (slot, mime_type, image_data, alt_text, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(slot) DO UPDATE SET
      mime_type = EXCLUDED.mime_type,
      image_data = EXCLUDED.image_data,
      alt_text = EXCLUDED.alt_text,
      updated_at = EXCLUDED.updated_at
  `, [slot, image.mimeType, image.imageData, altText, updatedAt]);
  await logSecurity('site_image_updated', request, {
    slot,
    mimeType: image.mimeType,
    bytes: image.imageData.length
  });
  response.json({ slot, alt: altText, updatedAt, url: siteImageUrl(slot, updatedAt) });
}));

app.delete('/api/dev/images/:slot', requireDev, asyncRoute(async (request, response) => {
  const { slot } = request.params;
  if (!siteImageSlots.has(slot)) return response.status(404).json({ error: 'Ubicación de imagen inexistente.' });
  const result = await database.query('DELETE FROM site_images WHERE slot = $1', [slot]);
  if (result.rowCount === 0) return response.status(404).json({ error: 'No hay ninguna imagen para retirar.' });
  await logSecurity('site_image_removed', request, { slot });
  response.json({ ok: true, slot });
}));
app.post('/api/dev/login', asyncRoute(async (request, response) => {
  const developerId = process.env.DISCORD_DEV_USER_ID;
  if (!developerId) return response.status(503).json({ error: 'El acceso DEV no está configurado. Define DISCORD_DEV_USER_ID.' });
  const { password } = request.body || {};
  const attemptKey = request.ip;
  const { rows } = await database.query('SELECT * FROM dev_attempts WHERE session_id = $1', [attemptKey]);
  let existing = rows[0];
  if (existing?.locked) {
    const lockExpiresAt = Date.parse(existing.updated_at) + 5 * 60 * 1000;
    if (Number.isFinite(lockExpiresAt) && lockExpiresAt > Date.now()) {
      return response.status(423).json({ error: 'Acceso DEV bloqueado temporalmente.', locked: true, retryAfter: Math.ceil((lockExpiresAt - Date.now()) / 1000) });
    }
    await database.query('UPDATE dev_attempts SET failed_attempts = 0, locked = FALSE, updated_at = $2 WHERE session_id = $1', [attemptKey, now()]);
    existing = { failed_attempts: 0, locked: false };
  }
  if (password !== process.env.DEV_PASSWORD) {
    const failedAttempts = (existing?.failed_attempts || 0) + 1;
    const locked = failedAttempts >= 5;
    await database.query(`
      INSERT INTO dev_attempts (session_id, failed_attempts, locked, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(session_id) DO UPDATE SET
        failed_attempts = EXCLUDED.failed_attempts,
        locked = EXCLUDED.locked,
        updated_at = EXCLUDED.updated_at
    `, [attemptKey, failedAttempts, locked, now()]);
    await logSecurity(locked ? 'access_locked' : 'login_failed', request, { attempts: failedAttempts });
    return response.status(401).json({ error: locked ? 'Máximo de intentos alcanzado.' : 'Contraseña incorrecta.', attemptsRemaining: Math.max(0, 5 - failedAttempts), locked: Boolean(locked) });
  }
  await database.query('UPDATE dev_attempts SET failed_attempts = 0, locked = FALSE, updated_at = $2 WHERE session_id = $1', [attemptKey, now()]);
  const { discordUser, discordGuilds, discordAccessToken } = request.session;
  await new Promise((resolve, reject) => {
    request.session.regenerate(error => error ? reject(error) : resolve());
  });
  request.session.discordUser = discordUser;
  request.session.discordGuilds = discordGuilds;
  request.session.discordAccessToken = discordAccessToken;
  request.session.devAuthenticatedUserId = developerId;
  await new Promise((resolve, reject) => {
    request.session.save(error => error ? reject(error) : resolve());
  });
  await logSecurity('login_success', request);
  response.json({ ok: true });
}));

app.post('/api/dev/logout', requireDev, asyncRoute(async (request, response) => {
  delete request.session.devAuthenticatedUserId;
  await logSecurity('logout', request);
  await new Promise((resolve, reject) => {
    request.session.save(error => error ? reject(error) : resolve());
  });
  response.json({ ok: true });
}));

app.get('/api/dev/status', requireDev, (_request, response) => {
  const configuredBot = readyBot();
  const ready = Boolean(configuredBot);
  response.json({
    ready,
    username: ready ? configuredBot.user.tag : null,
    ping: ready ? configuredBot.ws.ping : null,
    guildCount: ready ? configuredBot.guilds.cache.size : 0,
    bots: botInstances.map(({ name, client }) => ({ name, ready: client.isReady(), ping: client.isReady() ? client.ws.ping : null }))
  });
});

app.post('/api/dev/security-logs', requireDev, asyncRoute(async (request, response) => {
  await logSecurity(request.body?.type || 'client_event', request, request.body?.details || {});
  response.status(201).json({ ok: true });
}));

app.get('/api/discord/logs', requireDev, (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  response.write(`data: ${JSON.stringify({ message: 'Stream de Discord conectado.', timestamp: now() })}\n\n`);
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20000);
  devLogClients.add(response);
  request.on('close', () => {
    clearInterval(heartbeat);
    devLogClients.delete(response);
  });
});

function sendBotLog(message, level = 'info') {
  const payload = `data: ${JSON.stringify({ message, level, timestamp: now() })}\n\n`;
  for (const response of devLogClients) response.write(payload);
}

function startBotInstance(configuredBot, databaseId = null) {
  const name = configuredBot.name.trim();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const instance = { name, client, databaseId };
  botInstances.push(instance);
  let loginRetryDelay = 5_000;
  client.on(Events.ClientReady, async readyClient => {
    loginRetryDelay = 5_000;
    console.info(`[BOT] Conectado exitosamente como ${readyClient.user.tag} (${name}).`);
    sendBotLog(`${name} conectado como ${readyClient.user.tag}.`);
    try {
      const { rows } = await database.query(`
        INSERT INTO bots (bot_name, discord_user_id, client_id) VALUES ($1, $2, $2)
        ON CONFLICT (bot_name) DO UPDATE SET
          discord_user_id = EXCLUDED.discord_user_id,
          client_id = EXCLUDED.client_id
        RETURNING id, status, setup_command_enabled
      `, [name, readyClient.user.id]);
      instance.databaseId = rows[0]?.id ?? instance.databaseId;
      instance.setupCommandEnabled = Boolean(rows[0]?.setup_command_enabled);
      await database.query(`
        INSERT INTO bot_commands (bot_id, command_name, is_enabled)
        SELECT $1, command_name, CASE WHEN command_name = 'setup' THEN $2 ELSE TRUE END
        FROM unnest(ARRAY['ping', 'status', 'guilds', 'send', 'setup']::TEXT[]) AS commands(command_name)
        ON CONFLICT (bot_id, command_name) DO NOTHING
      `, [instance.databaseId, instance.setupCommandEnabled]);
      const status = isPlatformStatus(rows[0]?.status) ? rows[0].status : 'beta';
      await syncBotPresence(status, readyClient);
      if (instance.setupCommandEnabled) {
        for (const guild of readyClient.guilds.cache.values()) {
          try {
            await syncSetupCommand(instance, guild.id, true);
          } catch (error) {
            console.error(`[BOT] No se pudo registrar /setup en ${guild.name}:`, error);
          }
        }
      }
      await retryPendingNotifications();
    } catch (error) {
      console.error(`[BOT] No se pudo completar la sincronizacion inicial de ${name}:`, error);
      sendBotLog(`No se pudo completar la sincronizacion inicial de ${name}: ${error.message}`, 'error');
    }
  });
  client.on(Events.Error, error => {
    console.error(`[BOT] Error de ${name}:`, error);
    sendBotLog(`${name}: ${error.message}`, 'error');
  });
  client.on(Events.GuildCreate, guild => {
    if (!instance.setupCommandEnabled) return;
    syncSetupCommand(instance, guild.id, true).catch(error => {
      console.error(`[BOT] No se pudo registrar /setup al entrar en ${guild.name}:`, error);
    });
  });
  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'setup') return;
    if (!instance.setupCommandEnabled) {
      await interaction.reply({
        embeds: [createBotEmbed({
          status: 'error',
          title: '🚫 /setup no está habilitado',
          description: 'El administrador del bot debe habilitar este comando desde el Dev Panel.',
          thumbnailUrl: client.user.displayAvatarURL()
        })],
        ephemeral: true
      });
      return;
    }
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        embeds: [createBotEmbed({
          status: 'error',
          title: '⚠️ Selecciona un servidor',
          description: 'Usa /setup dentro del servidor que quieres configurar.',
          thumbnailUrl: client.user.displayAvatarURL()
        })],
        ephemeral: true
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        embeds: [createBotEmbed({
          status: 'error',
          title: '🔒 Permisos insuficientes',
          description: 'Necesitas el permiso Administrar canales para ejecutar /setup.',
          thumbnailUrl: client.user.displayAvatarURL()
        })],
        ephemeral: true
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const setup = await configureNotificationChannels(instance, interaction.guild);
      sendBotLog(`${name} configuró los canales de avisos en ${interaction.guild.name}.`);
      void retryPendingNotifications().catch(error => console.error('[DISCORD] No se pudieron reintentar las notificaciones:', error));
      await interaction.editReply({
        embeds: [createBotEmbed({
          status: 'success',
          title: '✅ Canales de avisos configurados',
          description: `Configuración completada en ${interaction.guild.name}.`,
          fields: setup.channels.map(channel => ({
            name: channel.eventType.replaceAll('_', ' '),
            value: `#${channel.channelName}`,
            inline: true
          })),
          thumbnailUrl: client.user.displayAvatarURL()
        })]
      });
    } catch (error) {
      console.error(`[BOT] /setup falló en ${interaction.guild.name}:`, error);
      await interaction.editReply({
        embeds: [createBotEmbed({
          status: 'error',
          title: '❌ No se pudo completar /setup',
          description: error.message,
          fields: [{ name: 'Servidor', value: interaction.guild.name, inline: true }],
          thumbnailUrl: client.user.displayAvatarURL()
        })]
      });
    }
  });
  client.on(Events.MessageCreate, message => {
    if (message.author.bot) return;
    sendBotLog(`${name} / ${message.guild?.name || 'DM'} / ${message.author.tag}: ${message.content}`);
  });
  const connectBot = async () => {
    if (instance.removed) return;
    try {
      await client.login(configuredBot.token);
    } catch (error) {
      if (instance.removed) return;
      const retryDelay = loginRetryDelay;
      loginRetryDelay = Math.min(loginRetryDelay * 2, 60_000);
      console.error(`[BOT] No se pudo conectar ${name}; nuevo intento en ${retryDelay / 1000}s:`, error);
      sendBotLog(`No se pudo conectar ${name}; nuevo intento en ${retryDelay / 1000}s: ${error.message}`, 'error');
      instance.retryTimer = setTimeout(connectBot, retryDelay);
    }
  };
  void connectBot();
  return instance;
}

try {
  for (const configuredBot of configuredBots) {
    startBotInstance(configuredBot);
  }
  const managedBotRecords = await database.query(`
    SELECT id, bot_name, encrypted_token
    FROM bots
    WHERE managed_token = TRUE AND encrypted_token IS NOT NULL
    ORDER BY id
  `);
  for (const botRecord of managedBotRecords.rows) {
    try {
      const token = decryptBotToken(botRecord.encrypted_token, process.env.DISCORD_BOT_TOKEN_ENCRYPTION_KEY);
      startBotInstance({ name: botRecord.bot_name, token }, botRecord.id);
    } catch (error) {
      console.error(`[BOT] No se pudo recuperar de forma segura el token almacenado para ${botRecord.bot_name}:`, error.message);
    }
  }
} catch (error) {
  console.error('[NEON] No se pudieron recuperar los bots persistidos de PostgreSQL durante el arranque:', error);
  throw error;
}
const notificationRetryTimer = setInterval(() => {
  retryPendingNotifications().catch(error => console.error('[DISCORD] Reintento de notificaciones:', error));
}, 60_000);
notificationRetryTimer.unref();
const presenceRefreshTimer = setInterval(async () => {
  if (!botInstances.some(instance => instance.client.isReady())) return;
  try {
    const { rows } = await database.query('SELECT discord_user_id, status FROM bots WHERE discord_user_id IS NOT NULL');
    await Promise.all(rows.map(row => {
      const client = botInstances.find(instance => instance.client.user?.id === row.discord_user_id)?.client;
      return client ? syncBotPresence(row.status, client) : false;
    }));
  } catch (error) {
    console.error('[DISCORD] Reconciliacion de presencia:', error);
  }
}, 5 * 60_000);
presenceRefreshTimer.unref();

app.use(express.static(__dirname));
app.use((error, request, response, next) => {
  console.error(`[API] ${request.method} ${request.path}`, error);
  if (response.headersSent) return next(error);
  response.status(500).json({ error: 'Error interno del servidor.' });
});
app.listen(port, () => {
  console.log(`[WEB] MODEOS EL OBI disponible en ${publicUrl}`);
  console.log(`[CONFIG] Redirect URI de Discord: ${redirectUri}`);
  console.log(`[CONFIG] Origen CORS del frontend: ${frontendOrigin}; backend: ${backendOrigin}`);
});
