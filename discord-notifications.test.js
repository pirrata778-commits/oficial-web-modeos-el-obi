import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCORD_NOTIFICATION_LAYOUT,
  MODEOS_WEB_URL,
  createBotPresence,
  createNotification,
  createNotificationEmbed
} from './discord-notifications.js';

test('la estructura Discord usa categoria y canales Unicode ordenados', () => {
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.categoryName, 'ＭＯＤＥＯＳ・ＥＬ・ＯＢＩ');
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.channels.developer_announcement.position, 0);
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.channels.platform_status.position, 1);
  assert.equal(DISCORD_NOTIFICATION_LAYOUT.channels.live_started.position, 2);
  assert.match(DISCORD_NOTIFICATION_LAYOUT.channels.live_started.name, /🎥/u);
});

test('anuncios de desarrollador incluyen la autoria oficial y la web', () => {
  const notification = createNotification({
    type: 'developer_announcement',
    title: 'Nueva funcion',
    message: 'El panel ya esta disponible.',
    occurredAt: '2026-01-01T00:00:00.000Z'
  });
  const embed = createNotificationEmbed(notification);

  assert.equal(embed.author.name, 'Desarrollador oficial de MODEOS EL OBI');
  assert.equal(embed.url, MODEOS_WEB_URL);
  assert.match(embed.fields[0].value, new RegExp(MODEOS_WEB_URL.replaceAll('.', '\\.')));
});

test('alertas de mantenimiento conservan el enlace obligatorio', () => {
  const embed = createNotificationEmbed({
    type: 'platform_status',
    platformStatus: 'mantenimiento',
    message: 'Actualizamos la plataforma.'
  });

  assert.equal(embed.author.name, 'Estado oficial de MODEOS EL OBI');
  assert.equal(embed.url, MODEOS_WEB_URL);
  assert.equal(embed.fields[0].name, 'Web oficial');
});

test('avisos de directo conservan el enlace obligatorio', () => {
  const embed = createNotificationEmbed({
    type: 'live_started',
    title: 'Directo de desarrollo',
    message: 'Ya estamos en directo.'
  });

  assert.equal(embed.author.name, 'Directo oficial de MODEOS EL OBI');
  assert.equal(embed.url, MODEOS_WEB_URL);
  assert.match(embed.fields[0].value, new RegExp(MODEOS_WEB_URL.replaceAll('.', '\\.')));
});

test('la presencia coincide con activo, beta y mantenimiento', () => {
  assert.equal(createBotPresence('activo').status, 'online');
  assert.equal(createBotPresence('beta').status, 'idle');
  assert.equal(createBotPresence('mantenimiento').status, 'dnd');
});
