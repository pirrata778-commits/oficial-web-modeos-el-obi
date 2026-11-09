import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBotToken, encryptBotToken } from './discord-bot-secrets.js';

const secret = 'test-encryption-secret-with-at-least-32-characters';

test('bot token se cifra y se descifra sin guardarse en claro', () => {
  const token = 'discord-bot-token';
  const encrypted = encryptBotToken(token, secret);

  assert.notEqual(encrypted, token);
  assert.equal(decryptBotToken(encrypted, secret), token);
});

test('el token cifrado no se puede descifrar con otra clave', () => {
  const encrypted = encryptBotToken('discord-bot-token', secret);

  assert.throws(() => decryptBotToken(encrypted, 'different-encryption-secret-with-at-least-32-chars'));
});

test('rechaza claves de cifrado débiles', () => {
  assert.throws(() => encryptBotToken('discord-bot-token', 'short'));
});
