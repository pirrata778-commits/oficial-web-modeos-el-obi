import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import dotenv from 'dotenv';
import pg from 'pg';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  MODEOS_WEB_URL,
  NotificationValidationError,
  PLATFORM_STATUSES,
  createBotPresence,
  createNotification,
  createNotificationEmbed,
  notificationChannelEnvironment,
  normalizePlatformStatus
} from './discord-notifications.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const frontendUrl = process.env.FRONTEND_URL?.replace(/\/+$/, '') || publicUrl;
const frontendOrigin = frontendUrl ? new URL(frontendUrl).origin : null;
const backendOrigin = new URL(publicUrl).origin;
const discordRedirectUri = `${publicUrl}/auth/discord/callback`;
const { Pool } = pg;
const siteImageSlots = new Set(['lobby', 'modelos', 'directos']);
const maxSiteImageBytes = 2 * 1024 * 1024;
let configuredBots = [];

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
const PgSessionStore = connectPgSimple(session);
const sessionStore = new PgSessionStore({
  pool: database,
  tableName: 'user_sessions',
  createTableIfMissing: true
});
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

function isAuthorizedDev(request) {
  const configuredId = process.env.DISCORD_DEV_USER_ID?.trim();
  return Boolean(configuredId && String(request.session.discordUser?.id ?? '') === String(configuredId));
}

function readyBot() {
  return botInstances.find(instance => instance.client.isReady())?.client || null;
}

function requireDev(request, response, next) {
  if (!process.env.DISCORD_DEV_USER_ID?.trim()) return response.status(503).json({ error: 'El acceso DEV no está configurado. Falta DISCORD_DEV_USER_ID.' });
  if (!request.session.discordUser) return response.status(401).json({ error: 'Inicia sesión con Discord.' });
  if (!isAuthorizedDev(request)) return response.status(403).json({ error: 'Esta cuenta de Discord no tiene permiso para acceder al panel DEV.' });
  if (!request.session.devAuthenticated) return response.status(401).json({ error: 'Sesión DEV requerida.' });
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
    const readyInstances = botInstances.filter(instance => instance.client.isReady());
    if (!readyInstances.length) throw new Error('Ningun bot esta conectado.');

    const notification = parseQueuedNotification(queued);
    const channelId = configuredNotificationChannel(notification);
    if (!channelId || !/^\d{17,20}$/.test(channelId)) {
      throw new Error(`Falta un ID valido para ${notificationChannelEnvironment(notification)}.`);
    }
    let deliveredBy = null;
    let deliveryError = null;
    for (const instance of readyInstances) {
      try {
        const channel = instance.client.channels.cache.get(channelId) || await instance.client.channels.fetch(channelId);
        if (!channel?.isTextBased()) throw new Error('El canal configurado no admite mensajes de texto.');
        await channel.send({ embeds: [createNotificationEmbed(notification)] });
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
    if (configuredNotificationChannel(notification)) await deliverQueuedNotification(row.id);
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

app.get('/auth/discord', (request, response) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) return response.status(503).send('Discord OAuth no está configurado.');
  const state = crypto.randomBytes(24).toString('hex');
  request.session.oauthState = state;
  const query = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: discordRedirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state
  });
  request.session.save(error => {
    if (error) {
      console.error('[OAUTH] No se pudo guardar el state:', error);
      return response.status(500).send('No se pudo iniciar la sesión de Discord.');
    }
    response.redirect(`https://discord.com/oauth2/authorize?${query}`);
  });
});

app.get('/auth/discord/callback', async (request, response) => {
  try {
    if (!request.query.code || request.query.state !== request.session.oauthState) return response.status(400).send('Estado OAuth inválido.');
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: request.query.code, redirect_uri: discordRedirectUri })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) return response.status(401).send('Discord no devolvió un token válido. Revisa Client ID, Client Secret y Redirect URI.');
    const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!userResponse.ok) return response.status(401).send('Discord no pudo validar el perfil autorizado. Inténtalo de nuevo.');
    const user = await userResponse.json();
    const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!guildsResponse.ok) return response.status(502).send('Se autorizó la cuenta, pero Discord no devolvió la lista de servidores.');
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
    console.error('[OAUTH]', error);
    response.status(500).send('No se pudo completar el acceso con Discord.');
  }
});

app.post('/api/auth/logout', (request, response) => request.session.destroy(() => response.json({ ok: true })));
app.get('/api/auth/me', (request, response) => {
  const devAccessConfigured = Boolean(process.env.DISCORD_DEV_USER_ID?.trim());
  response.json({
    user: request.session.discordUser || null,
    devAuthorized: isAuthorizedDev(request),
    devAuthenticated: Boolean(request.session.devAuthenticated && isAuthorizedDev(request)),
    devConfigurationError: devAccessConfigured ? null : 'El acceso DEV no está configurado. Falta DISCORD_DEV_USER_ID.'
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

app.post('/api/dev/live-events', requireDev, asyncRoute(async (request, response) => {
  let notification;
  try {
    notification = createNotification({
      type: 'live_started',
      title: request.body?.title,
      message: request.body?.message
    });
  } catch (error) {
    if (error instanceof NotificationValidationError) return response.status(400).json({ error: error.message });
    throw error;
  }
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

function hasValidImageSignature(mimeType, imageData) {
  if (mimeType === 'image/png') {
    return imageData.length >= 8 && imageData.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (mimeType === 'image/jpeg') {
    return imageData.length >= 3 && imageData[0] === 0xff && imageData[1] === 0xd8 && imageData[2] === 0xff;
  }
  return mimeType === 'image/webp'
    && imageData.length >= 12
    && imageData.toString('ascii', 0, 4) === 'RIFF'
    && imageData.toString('ascii', 8, 12) === 'WEBP';
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

  const dataUrl = request.body?.image;
  const match = typeof dataUrl === 'string'
    ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
    : null;
  if (!match || match[2].length > Math.ceil(maxSiteImageBytes * 4 / 3) + 4) {
    return response.status(400).json({ error: 'Envía una imagen PNG, JPEG o WebP válida.' });
  }

  const imageData = Buffer.from(match[2], 'base64');
  if (imageData.length === 0 || imageData.length > maxSiteImageBytes || !hasValidImageSignature(match[1], imageData)) {
    return response.status(400).json({ error: 'La imagen no es válida o supera el límite de 2 MB.' });
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
  `, [slot, match[1], imageData, altText, updatedAt]);
  await logSecurity('site_image_updated', request, { slot, mimeType: match[1], bytes: imageData.length });
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
  if (!process.env.DISCORD_DEV_USER_ID?.trim()) return response.status(503).json({ error: 'El acceso DEV no está configurado. Falta DISCORD_DEV_USER_ID.' });
  if (!request.session.discordUser) return response.status(401).json({ error: 'Inicia sesión con Discord antes de desbloquear el panel DEV.' });
  if (!isAuthorizedDev(request)) return response.status(403).json({ error: 'Esta cuenta de Discord no tiene permiso para acceder al panel DEV.' });
  const { password } = request.body || {};
  const { rows } = await database.query('SELECT * FROM dev_attempts WHERE session_id = $1', [request.sessionID]);
  let existing = rows[0];
  if (existing?.locked) {
    const lockExpiresAt = Date.parse(existing.updated_at) + 5 * 60 * 1000;
    if (Number.isFinite(lockExpiresAt) && lockExpiresAt > Date.now()) {
      return response.status(423).json({ error: 'Acceso DEV bloqueado temporalmente.', locked: true, retryAfter: Math.ceil((lockExpiresAt - Date.now()) / 1000) });
    }
    await database.query('UPDATE dev_attempts SET failed_attempts = 0, locked = FALSE, updated_at = $2 WHERE session_id = $1', [request.sessionID, now()]);
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
    `, [request.sessionID, failedAttempts, locked, now()]);
    await logSecurity(locked ? 'access_locked' : 'login_failed', request, { attempts: failedAttempts });
    return response.status(401).json({ error: locked ? 'Máximo de intentos alcanzado.' : 'Contraseña incorrecta.', attemptsRemaining: Math.max(0, 5 - failedAttempts), locked: Boolean(locked) });
  }
  await database.query('UPDATE dev_attempts SET failed_attempts = 0, locked = FALSE, updated_at = $2 WHERE session_id = $1', [request.sessionID, now()]);
  request.session.devAuthenticated = true;
  await logSecurity('login_success', request);
  response.json({ ok: true });
}));

app.post('/api/dev/logout', requireDev, asyncRoute(async (request, response) => {
  request.session.devAuthenticated = false;
  await logSecurity('logout', request);
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

for (const configuredBot of configuredBots) {
  const name = configuredBot.name.trim();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  botInstances.push({ name, client });
  client.once(Events.ClientReady, async readyClient => {
    sendBotLog(`${name} conectado como ${readyClient.user.tag}.`);
    try {
      const { rows } = await database.query(`
        INSERT INTO bots (bot_name, discord_user_id) VALUES ($1, $2)
        ON CONFLICT (bot_name) DO UPDATE SET discord_user_id = EXCLUDED.discord_user_id
        RETURNING status
      `, [name, readyClient.user.id]);
      const status = isPlatformStatus(rows[0]?.status) ? rows[0].status : 'beta';
      await syncBotPresence(status, readyClient);
      await retryPendingNotifications();
    } catch (error) {
      sendBotLog(`No se pudo completar la sincronizacion inicial de ${name}: ${error.message}`, 'error');
    }
  });
  client.on(Events.Error, error => sendBotLog(`${name}: ${error.message}`, 'error'));
  client.on(Events.MessageCreate, message => {
    if (message.author.bot) return;
    sendBotLog(`${name} / ${message.guild?.name || 'DM'} / ${message.author.tag}: ${message.content}`);
  });
  client.login(configuredBot.token).catch(error => sendBotLog(`No se pudo conectar ${name}: ${error.message}`, 'error'));
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

app.post('/api/discord/commands', requireDev, asyncRoute(async (request, response) => {
  const command = String(request.body?.command || '').trim();
  if (!command) return response.status(400).json({ error: 'Comando vacío.' });
  try {
    const commandBot = readyBot();
    if (!commandBot) return response.status(503).json({ error: 'Ningún bot está conectado.' });
    if (command === '!ping') {
      const output = `Pong: ${commandBot.ws.ping}ms`;
      sendBotLog(`Comando !ping ejecutado: ${output}.`);
      return response.json({ output });
    }
    if (command === '!status') {
      const output = `Bot conectado como ${commandBot.user.tag} en ${commandBot.guilds.cache.size} servidores.`;
      sendBotLog('Comando !status ejecutado.');
      return response.json({ output });
    }
    if (command === '!guilds') {
      const output = commandBot.guilds.cache.map(guild => `${guild.name} (${guild.id})`).join('\n') || 'Sin servidores.';
      sendBotLog('Comando !guilds ejecutado.');
      return response.json({ output });
    }
    const sendMatch = command.match(/^!send\s+(\d+)\s+([\s\S]+)$/);
    if (sendMatch) {
      const channel = await commandBot.channels.fetch(sendMatch[1]);
      if (!channel?.isTextBased()) return response.status(400).json({ error: 'El canal no es de texto.' });
      await channel.send(sendMatch[2]);
      sendBotLog(`Mensaje enviado al canal ${sendMatch[1]} por la consola DEV.`);
      return response.json({ output: 'Mensaje enviado correctamente.' });
    }
    return response.status(400).json({ error: 'Comando no permitido. Usa !ping, !status, !guilds o !send <channelId> <mensaje>.' });
  } catch (error) {
    sendBotLog(error.message, 'error');
    response.status(500).json({ error: error.message });
  }
}));

app.use(express.static(__dirname));
app.use((error, request, response, next) => {
  console.error(`[API] ${request.method} ${request.path}`, error);
  if (response.headersSent) return next(error);
  response.status(500).json({ error: 'Error interno del servidor.' });
});
app.listen(port, () => {
  console.log(`[WEB] MODEOS EL OBI disponible en ${publicUrl}`);
  console.log(`[CONFIG] Redirect URI de Discord: ${discordRedirectUri}`);
  console.log(`[CONFIG] Origen CORS del frontend: ${frontendOrigin}; backend: ${backendOrigin}`);
  if (process.env.DISCORD_DEV_USER_ID?.trim()) {
    console.log('[CONFIG] DISCORD_DEV_USER_ID configurado.');
  } else {
    console.warn('[CONFIG] DISCORD_DEV_USER_ID NO configurado; acceso DEV deshabilitado.');
  }
});

