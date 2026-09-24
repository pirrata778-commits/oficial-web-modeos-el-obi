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
const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const frontendUrl = process.env.FRONTEND_URL || publicUrl;
const { Pool } = pg;

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
`);

const app = express();
app.set('trust proxy', 1);
const devLogClients = new Set();

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin === frontendUrl || origin === publicUrl) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (request.method === 'OPTIONS') return response.sendStatus(204);
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
  const payload = `event: security\\ndata: ${JSON.stringify(event)}\\n\\n`;
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

app.use(express.json({ limit: '100kb' }));
app.use(session({
  name: 'modeos.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: process.env.FRONTEND_URL ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
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
  response.redirect(`https://discord.com/oauth2/authorize?${query}`);
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
    if (!token.access_token) return response.status(401).send('Discord no devolvió un token válido.');
    const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const user = await userResponse.json();
    const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const guilds = await guildsResponse.json();
    request.session.discordUser = { id: user.id, username: user.username, avatar: user.avatar };
    request.session.discordGuilds = Array.isArray(guilds) ? guilds : [];
    delete request.session.oauthState;
    response.redirect(frontendUrl);
  } catch (error) {
    console.error('[OAUTH]', error);
    response.status(500).send('No se pudo completar el acceso con Discord.');
  }
});

app.post('/api/auth/logout', (request, response) => request.session.destroy(() => response.json({ ok: true })));
app.get('/api/auth/me', (request, response) => response.json({ user: request.session.discordUser || null, devAuthenticated: Boolean(request.session.devAuthenticated) }));
app.get('/api/discord/guilds', requireDiscordUser, (request, response) => {
  const guilds = (request.session.discordGuilds || []).map(guild => ({
    ...guild,
    botPresent: bot.guilds.cache.has(guild.id)
  }));
  response.json(guilds);
});
app.get('/api/config', (_request, response) => response.json({ discordClientId: process.env.DISCORD_CLIENT_ID || null }));

app.post('/api/dev/login', async (request, response) => {
  const { password } = request.body || {};
  const { rows } = await database.query('SELECT * FROM dev_attempts WHERE session_id = $1', [request.sessionID]);
  const existing = rows[0];
  if (existing?.locked) return response.status(423).json({ error: 'Acceso DEV bloqueado.', locked: true });
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
  request.session.devAuthenticated = true;
  await logSecurity('login_success', request);
  response.json({ ok: true });
});

app.post('/api/dev/logout', requireDev, async (request, response) => {
  request.session.devAuthenticated = false;
  await logSecurity('logout', request);
  response.json({ ok: true });
});

app.post('/api/dev/security-logs', requireDev, async (request, response) => {
  await logSecurity(request.body?.type || 'client_event', request, request.body?.details || {});
  response.status(201).json({ ok: true });
});

app.get('/api/discord/logs', requireDev, (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  response.write(`data: ${JSON.stringify({ message: 'Stream de Discord conectado.' })}\\n\\n`);
  devLogClients.add(response);
  request.on('close', () => devLogClients.delete(response));
});

function sendBotLog(message, level = 'info') {
  const payload = `data: ${JSON.stringify({ message, level, timestamp: now() })}\\n\\n`;
  for (const response of devLogClients) response.write(payload);
}

const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
bot.once(Events.ClientReady, client => sendBotLog(`Bot conectado como ${client.user.tag}.`));
bot.on(Events.Error, error => sendBotLog(error.message, 'error'));
bot.on(Events.MessageCreate, message => {
  if (message.author.bot) return;
  sendBotLog(`${message.guild?.name || 'DM'} / ${message.author.tag}: ${message.content}`);
});

app.post('/api/discord/commands', requireDev, async (request, response) => {
  const command = String(request.body?.command || '').trim();
  if (!command) return response.status(400).json({ error: 'Comando vacío.' });
  try {
    if (!bot.isReady()) return response.status(503).json({ error: 'El bot todavía no está conectado.' });
    if (command === '!ping') return response.json({ output: `Pong: ${bot.ws.ping}ms` });
    if (command === '!status') return response.json({ output: `Bot conectado en ${bot.guilds.cache.size} servidores.` });
    if (command === '!guilds') return response.json({ output: bot.guilds.cache.map(guild => `${guild.name} (${guild.id})`).join('\\n') || 'Sin servidores.' });
    const sendMatch = command.match(/^!send\\s+(\\d+)\\s+([\\s\\S]+)$/);
    if (sendMatch) {
      const channel = await bot.channels.fetch(sendMatch[1]);
      if (!channel?.isTextBased()) return response.status(400).json({ error: 'El canal no es de texto.' });
      await channel.send(sendMatch[2]);
      sendBotLog(`Mensaje enviado al canal ${sendMatch[1]}.`);
      return response.json({ output: 'Mensaje enviado correctamente.' });
    }
    return response.status(400).json({ error: 'Comando no permitido. Usa !ping, !status, !guilds o !send <channelId> <mensaje>.' });
  } catch (error) {
    sendBotLog(error.message, 'error');
    response.status(500).json({ error: error.message });
  }
});

app.use(express.static(__dirname));
app.listen(port, () => console.log(`[WEB] MODEOS EL OBI disponible en ${publicUrl}`));

if (process.env.DISCORD_BOT_TOKEN) bot.login(process.env.DISCORD_BOT_TOKEN).catch(error => console.error('[BOT]', error.message));
