import crypto from 'node:crypto';

function encryptionKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('DISCORD_BOT_TOKEN_ENCRYPTION_KEY debe tener al menos 32 caracteres.');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptBotToken(token, secret) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('El token del bot no puede estar vacío.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token.trim(), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptBotToken(payload, secret) {
  const [version, ivText, tagText, encryptedText, ...extra] = String(payload).split(':');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText || extra.length) {
    throw new Error('El token cifrado del bot tiene un formato no válido.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final()
  ]).toString('utf8');
}
