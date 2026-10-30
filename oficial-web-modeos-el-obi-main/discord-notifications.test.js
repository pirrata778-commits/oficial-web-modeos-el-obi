import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCORD_NOTIFICATION_LAYOUT,
  DISCORD_EMBED_COLORS,
  MODEOS_WEB_URL,
  createBotPresence,
  createBotEmbed,
  createNotification,
  createNotificationEmbed,
  createNotificationMessage,
  notificationChannelEnvironment
} from './discord-notifications.js';

test('la estructura Discord usa categoria y canales Unicode ordenados', () => {
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.categoryName, 'ＭＯＤＥＯＳ・ＥＬ・ＯＢＩ');
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.channels.developer_announcement.position, 0);
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.channels.platform_status.position, 1);
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.channels.live_started.position, 2);
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.channels.mourning_announcement.position, 3);
  assert.match(DISCORD_NOTIFICATION_LAYOUT.channels.mourning_announcement.name, /🕯️/u);
  assert.match(DISCORD_NOTIFICATION_LAYOUT.channels.live_started.name, /🎥/u);
});

test('el embed corporativo incluye estado, campos, miniatura, footer y fecha', () => {
  const embed = createBotEmbed({
    status: 'success',
    title: '✅ Operación completada',
    description: 'El bot está conectado.',
    fields: [
      { name: 'Bot', value: 'MODEOS', inline: true },
      { name: 'Servidor', value: 'Comunidad', inline: true }
    ],
    thumbnailUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
    timestamp: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(embed.color, DISCORD_EMBED_COLORS.success);
  assert.equal(embed.fields[0].inline, true);
  assert.equal(embed.fields[1].name, 'Servidor');
  assert.equal(embed.thumbnail.url, 'https://cdn.discordapp.com/embed/avatars/0.png');
  assert.equal(embed.footer.text, 'MODEOS EL OBI | Dev Panel');
  assert.equal(embed.timestamp, '2026-01-01T00:00:00.000Z');
});

test('el estado desconocido usa el color informativo y omite miniaturas no HTTPS', () => {
  const embed = createBotEmbed({ status: 'other', thumbnailUrl: 'http://example.com/logo.png' });

  assert.equal(embed.color, DISCORD_EMBED_COLORS.info);
  assert.equal('thumbnail' in embed, false);
});

test('los avisos incluyen enlace web y boton interactivo de estado', () => {
  const message = createNotificationMessage({
    type: 'platform_status',
    platformStatus: 'beta',
    message: 'La web está en beta.'
  });

  assert.equal(message.embeds.length, 1);
  assert.equal(message.components.length, 1);
  assert.equal(message.components[0].type, 1);
  assert.equal(message.components[0].components[0].style, 5);
  assert.equal(message.components[0].components[0].url, MODEOS_WEB_URL);
  assert.equal(message.components[0].components[1].style, 2);
  assert.equal(message.components[0].components[1].custom_id, 'check_status');
});

test('anuncios de desarrollador incluyen la autoria oficial y la web', () => {
  const notification = createNotification({
    type: 'developer_announcement',
    title: 'Nueva funcion',
    message: 'El panel ya esta disponible.',
    occurredAt: '2026-01-01T00:00:00.000Z'
  });
  const embed = createNotificationEmbed(notification);

  assert.equal(embed.author.name, 'CEO · MODEOS EL OBI');
  assert.equal(embed.color, DISCORD_EMBED_COLORS.info);
  assert.match(embed.title, /^📣/u);
  assert.equal(embed.url, MODEOS_WEB_URL);
  assert.match(embed.fields.at(-1).value, new RegExp(MODEOS_WEB_URL.replaceAll('.', '\\.')));
});

test('alertas de mantenimiento usan rojo, estado inline y miniatura del bot', () => {
  const embed = createNotificationEmbed({
    type: 'platform_status',
    platformStatus: 'mantenimiento',
    message: 'Actualizamos la plataforma.'
  }, 'https://cdn.discordapp.com/embed/avatars/1.png');

  assert.equal(embed.author.name, 'Estado oficial de MODEOS EL OBI');
  assert.equal(embed.color, DISCORD_EMBED_COLORS.error);
  assert.equal(embed.fields[0].name, 'Estado');
  assert.equal(embed.fields[0].inline, true);
  assert.equal(embed.thumbnail.url, 'https://cdn.discordapp.com/embed/avatars/1.png');
  assert.equal(embed.url, MODEOS_WEB_URL);
  assert.equal(embed.fields.at(-1).name, 'Web oficial');
});

test('avisos de directo conservan el enlace obligatorio', () => {
  const embed = createNotificationEmbed({
    type: 'live_started',
    title: 'Directo de desarrollo',
    message: 'Ya estamos en directo.'
  });

  assert.equal(embed.author.name, 'Directo oficial de MODEOS EL OBI');
  assert.equal(embed.color, DISCORD_EMBED_COLORS.success);
  assert.match(embed.title, /^🎥/u);
  assert.equal(embed.url, MODEOS_WEB_URL);
  assert.match(embed.fields.at(-1).value, new RegExp(MODEOS_WEB_URL.replaceAll('.', '\\.')));
});

test('el comunicado de luto incluye su canal, autoría, motivo e imagen HTTPS opcional', () => {
  const notification = createNotification({
    type: 'mourning_announcement',
    title: 'En señal de luto',
    message: 'La comunidad acompaña a la familia.',
    imageUrl: 'https://modeos.example/api/site-images/mourning?v=1',
    occurredAt: '2026-01-01T00:00:00.000Z'
  });
  const embed = createNotificationEmbed(notification);

  assert.equal(notificationChannelEnvironment(notification), 'DISCORD_MOURNING_CHANNEL_ID');
  assert.equal(embed.author.name, 'Comunicado de luto · MODEOS EL OBI');
  assert.equal(embed.image.url, 'https://modeos.example/api/site-images/mourning?v=1');
  assert.equal(embed.fields[0].value, 'En señal de luto');
  assert.match(embed.title, /^🕯️/u);
  assert.throws(() => createNotification({
    type: 'mourning_announcement',
    message: 'Motivo.',
    imageUrl: 'http://modeos.example/luto.png'
  }), /HTTPS/u);
});

test('la presencia coincide con activo, beta y mantenimiento', () => {
  assert.equal(createBotPresence('activo').status, 'online');
  assert.equal(createBotPresence('beta').status, 'idle');
  assert.equal(createBotPresence('mantenimiento').status, 'dnd');
});
