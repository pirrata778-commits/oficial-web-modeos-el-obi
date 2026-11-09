import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SITE_IMAGE_BYTES,
  SiteImageValidationError,
  parseSiteImageDataUrl
} from './site-images.js';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

test('acepta imágenes PNG con una firma válida', () => {
  const parsed = parseSiteImageDataUrl(`data:image/png;base64,${pngSignature.toString('base64')}`);

  assert.equal(parsed.mimeType, 'image/png');
  assert.deepEqual(parsed.imageData, pngSignature);
});

test('acepta una imagen justo en el límite de 2 MB', () => {
  const image = Buffer.alloc(MAX_SITE_IMAGE_BYTES);
  pngSignature.copy(image);

  assert.equal(
    parseSiteImageDataUrl(`data:image/png;base64,${image.toString('base64')}`).imageData.length,
    MAX_SITE_IMAGE_BYTES
  );
});

test('rechaza imágenes que superan el límite con error de tamaño', () => {
  const image = Buffer.alloc(MAX_SITE_IMAGE_BYTES + 1);
  pngSignature.copy(image);

  assert.throws(
    () => parseSiteImageDataUrl(`data:image/png;base64,${image.toString('base64')}`),
    error => error instanceof SiteImageValidationError
      && error.status === 413
      && error.code === 'IMAGE_TOO_LARGE'
  );
});

test('rechaza formatos no admitidos con un error descriptivo', () => {
  assert.throws(
    () => parseSiteImageDataUrl('data:image/gif;base64,R0lGODlh'),
    error => error instanceof SiteImageValidationError
      && error.status === 400
      && error.code === 'IMAGE_FORMAT_UNSUPPORTED'
  );
});

test('rechaza contenido cuya firma no coincide con el MIME indicado', () => {
  const jpegData = Buffer.from([0xff, 0xd8, 0xff]);

  assert.throws(
    () => parseSiteImageDataUrl(`data:image/png;base64,${jpegData.toString('base64')}`),
    error => error instanceof SiteImageValidationError
      && error.status === 400
      && error.code === 'IMAGE_FORMAT_INVALID'
  );
});

test('rechaza cadenas Base64 no válidas', () => {
  assert.throws(
    () => parseSiteImageDataUrl('data:image/png;base64,!!!!'),
    error => error instanceof SiteImageValidationError
      && error.status === 400
      && error.code === 'IMAGE_FORMAT_INVALID'
  );
});
