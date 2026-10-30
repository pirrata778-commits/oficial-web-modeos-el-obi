export const MAX_SITE_IMAGE_BYTES = 2 * 1024 * 1024;

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const maxEncodedSiteImageLength = Math.ceil(MAX_SITE_IMAGE_BYTES / 3) * 4;

export class SiteImageValidationError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'SiteImageValidationError';
    this.status = status;
    this.code = code;
  }
}

function hasValidImageSignature(mimeType, imageData) {
  if (mimeType === 'image/png') {
    return imageData.length >= 8
      && imageData.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (mimeType === 'image/jpeg') {
    return imageData.length >= 3
      && imageData[0] === 0xff
      && imageData[1] === 0xd8
      && imageData[2] === 0xff;
  }
  return mimeType === 'image/webp'
    && imageData.length >= 12
    && imageData.toString('ascii', 0, 4) === 'RIFF'
    && imageData.toString('ascii', 8, 12) === 'WEBP';
}

export function parseSiteImageDataUrl(dataUrl) {
  const match = typeof dataUrl === 'string'
    ? /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
    : null;
  if (!match || match[2].length === 0 || match[2].length % 4 !== 0) {
    throw new SiteImageValidationError(
      'Envía una imagen PNG, JPEG o WebP válida.',
      400,
      'IMAGE_FORMAT_INVALID'
    );
  }

  const [, mimeType, encodedData] = match;
  if (!supportedImageTypes.has(mimeType)) {
    throw new SiteImageValidationError(
      'Formato no admitido. Usa una imagen PNG, JPEG o WebP.',
      400,
      'IMAGE_FORMAT_UNSUPPORTED'
    );
  }
  if (encodedData.length > maxEncodedSiteImageLength) {
    throw new SiteImageValidationError(
      'La imagen supera el límite máximo de 2 MB.',
      413,
      'IMAGE_TOO_LARGE'
    );
  }

  const imageData = Buffer.from(encodedData, 'base64');
  if (imageData.toString('base64') !== encodedData) {
    throw new SiteImageValidationError(
      'La imagen contiene datos Base64 no válidos.',
      400,
      'IMAGE_FORMAT_INVALID'
    );
  }
  if (imageData.length > MAX_SITE_IMAGE_BYTES) {
    throw new SiteImageValidationError(
      'La imagen supera el límite máximo de 2 MB.',
      413,
      'IMAGE_TOO_LARGE'
    );
  }
  if (!hasValidImageSignature(mimeType, imageData)) {
    throw new SiteImageValidationError(
      'El contenido no coincide con el formato PNG, JPEG o WebP declarado.',
      400,
      'IMAGE_FORMAT_INVALID'
    );
  }
  return { mimeType, imageData };
}
