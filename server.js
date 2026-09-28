import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import dotenv from 'dotenv';
import pg from 'pg';
import { Client, GatewayIntentBits, Events } from 'discord.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const frontendUrl = process.env.FRONTEND_URL?.replace(/\/+$/, '') || publicUrl;
const frontendOrigin = frontendUrl ? new URL(frontendUrl).origin : null;
const backendOrigin = new URL(publicUrl).origin;
const { Pool } = pg;
const siteImageSlots = new Set(['lobby', 'modelos', 'directos']);
const maxSiteImageBytes = 2 * 1024 * 1024;

if (!process.env.SESSION_SECRET || !process.env.DEV_PASSWORD || !process.env.DATABASE_URL) {
  throw new Error('Faltan SESSION_SECRET, DEV_PASSWORD o DATABASE_URL en .env');
}
if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !process.env.DISCORD_BOT_TOKEN) {
  console.warn('[CONFIG] OAuth o bot de Discord todavía no están configurados.');
}

const database = new Pool({ connectionString: process.env.DATABASE_URL });
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
  INSERT INTO site_settings (setting_key, setting_value)
  VALUES ('maintenance', 'false'::jsonb), ('maintenance_message', '"Estamos realizando tareas de mantenimiento."'::jsonb)
  ON CONFLICT (setting_key) DO NOTHING;
`);

const app = express();
app.set('trust proxy', 1);
const devLogClients = new Set();
const siteUpdateClients = new Set();

app.use((request, response, next) => {
  const origin = request.headers.origin;
  const isApiRequest = request.path.startsWith('/api/');
  if (isApiRequest && origin && origin !== frontendOrigin) {
    return response.status(403).json({ error: 'Origen no autorizado.' });
  }
  if (origin === frontendOrigin) {
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Origin', frontendOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (request.method === 'OPTIONS') {
    if (!origin || origin !== frontendOrigin) return response.status(403).end();
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

function requireDev(request, response, next) {
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

app.use(express.json({ limit: '3mb' }));
app.use(session({
  name: 'modeos.sid',
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
    redirect_uri: `${publicUrl}/auth/discord/callback`,
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
      body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: request.query.code, redirect_uri: `${publicUrl}/auth/discord/callback` })
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
app.get('/api/auth/me', (request, response) => response.json({ user: request.session.discordUser || null, devAuthenticated: Boolean(request.session.devAuthenticated) }));
app.get('/api/health', asyncRoute(async (_request, response) => {
  await database.query('SELECT 1');
  response.json({
    status: 'ok',
    service: 'modeos-el-obi',
    database: 'connected',
    version: process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || 'local',
    checkedAt: now()
  });
}));
app.get('/api/discord/guilds', requireDiscordUser, (request, response) => {
  const guilds = (request.session.discordGuilds || []).map(guild => ({
    ...guild,
    botPresent: bot.guilds.cache.has(guild.id)
  }));
  response.json(guilds);
});
app.get('/api/config', (_request, response) => response.json({ discordClientId: process.env.DISCORD_CLIENT_ID || null }));

async function readSiteState() {
  const [settingsResult, messagesResult] = await Promise.all([
    database.query("SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('maintenance', 'maintenance_message')"),
    database.query('SELECT message_id, content, created_at FROM site_messages ORDER BY created_at DESC, message_id DESC LIMIT 100')
  ]);
  const settings = Object.fromEntries(settingsResult.rows.map(row => [row.setting_key, row.setting_value]));
  return {
    maintenance: settings.maintenance === true,
    maintenanceMessage: typeof settings.maintenance_message === 'string' ? settings.maintenance_message : 'Estamos realizando tareas de mantenimiento.',
    messages: messagesResult.rows
  };
}

async function broadcastSiteUpdate() {
  const state = await readSiteState();
  const payload = `data: ${JSON.stringify(state)}\n\n`;
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
  const { maintenance, maintenanceMessage } = request.body || {};
  if (typeof maintenance !== 'boolean') {
    return response.status(400).json({ error: 'maintenance debe ser true o false.' });
  }
  if (typeof maintenanceMessage !== 'string' || maintenanceMessage.trim().length > 500) {
    return response.status(400).json({ error: 'El mensaje de mantenimiento es obligatorio y debe tener 500 caracteres o menos.' });
  }
  await database.query(`
    INSERT INTO site_settings (setting_key, setting_value, updated_at)
    VALUES ('maintenance', to_jsonb($1::boolean), NOW()),
           ('maintenance_message', to_jsonb($2::text), NOW())
    ON CONFLICT (setting_key) DO UPDATE SET
      setting_value = EXCLUDED.setting_value,
      updated_at = EXCLUDED.updated_at
  `, [maintenance, maintenanceMessage.trim()]);
  await logSecurity('site_state_updated', request, { maintenance });
  const state = await readSiteState();
  await broadcastSiteUpdate();
  response.json(state);
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
  await logSecurity('site_message_created', request, { messageId: rows[0].message_id });
  const state = await readSiteState();
  await broadcastSiteUpdate();
  response.status(201).json({ message: rows[0], state });
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
  const ready = bot.isReady();
  response.json({
    ready,
    username: ready ? bot.user.tag : null,
    ping: ready ? bot.ws.ping : null,
    guildCount: ready ? bot.guilds.cache.size : 0
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

const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
bot.once(Events.ClientReady, client => sendBotLog(`Bot conectado como ${client.user.tag}.`));
bot.on(Events.Error, error => sendBotLog(error.message, 'error'));
bot.on(Events.MessageCreate, message => {
  if (message.author.bot) return;
  sendBotLog(`${message.guild?.name || 'DM'} / ${message.author.tag}: ${message.content}`);
});

app.post('/api/discord/commands', requireDev, asyncRoute(async (request, response) => {
  const command = String(request.body?.command || '').trim();
  if (!command) return response.status(400).json({ error: 'Comando vacío.' });
  try {
    if (!bot.isReady()) return response.status(503).json({ error: 'El bot todavía no está conectado.' });
    if (command === '!ping') {
      const output = `Pong: ${bot.ws.ping}ms`;
      sendBotLog(`Comando !ping ejecutado: ${output}.`);
      return response.json({ output });
    }
    if (command === '!status') {
      const output = `Bot conectado como ${bot.user.tag} en ${bot.guilds.cache.size} servidores.`;
      sendBotLog('Comando !status ejecutado.');
      return response.json({ output });
    }
    if (command === '!guilds') {
      const output = bot.guilds.cache.map(guild => `${guild.name} (${guild.id})`).join('\n') || 'Sin servidores.';
      sendBotLog('Comando !guilds ejecutado.');
      return response.json({ output });
    }
    const sendMatch = command.match(/^!send\s+(\d+)\s+([\s\S]+)$/);
    if (sendMatch) {
      const channel = await bot.channels.fetch(sendMatch[1]);
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
app.listen(port, () => console.log(`[WEB] MODEOS EL OBI disponible en ${publicUrl}`));

if (process.env.DISCORD_BOT_TOKEN) bot.login(process.env.DISCORD_BOT_TOKEN).catch(error => console.error('[BOT]', error.message));
