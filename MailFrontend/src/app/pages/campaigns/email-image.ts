/**
 * Makes a picture from the computer email-ready before it is uploaded.
 *
 * Inboxes show PNG, JPG and GIF — Gmail shows no SVG, Outlook no WebP — so
 * those two are redrawn as PNG or JPG. Anything wider than the email can use at
 * twice the pixel density is scaled down, which turns a 2 MB banner into a few
 * hundred KB. Small PNGs and JPGs that already fit go up untouched.
 */
export type EmailImageKind = 'logo' | 'banner';

export interface EmailImage {
  blob: Blob;
  /** How light the visible part is, 0 (black) to 1 (white); null when unknown. */
  ink: number | null;
}

/** Twice the widest the designs show them: a 300 px logo, a 600 px banner. */
const MAX_WIDTH: Record<EmailImageKind, number> = { logo: 600, banner: 1200 };
const KEEP_AS_IS_BYTES: Record<EmailImageKind, number> = { logo: 200 * 1024, banner: 500 * 1024 };
const MAX_GIF_BYTES = 2 * 1024 * 1024;

const BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
};

export async function prepareEmailImage(file: File, kind: EmailImageKind): Promise<EmailImage> {
  const type = file.type || BY_EXTENSION[(file.name.split('.').pop() || '').toLowerCase()] || '';

  if (type === 'image/gif') {
    // Redrawing would freeze an animation, so a GIF goes up as it is.
    if (file.size > MAX_GIF_BYTES) throw new Error('This GIF is over 2 MB. Save it as a JPG, or make the GIF smaller.');
    return { blob: file, ink: null };
  }
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(type)) {
    throw new Error('Choose a PNG, JPG, GIF, SVG or WebP picture.');
  }

  const maxWidth = MAX_WIDTH[kind];
  const image = type === 'image/svg+xml' ? await loadSvg(file, maxWidth) : await loadImage(URL.createObjectURL(file));
  const ink = inkOf(image);
  const fits = image.naturalWidth <= maxWidth && file.size <= KEEP_AS_IS_BYTES[kind];
  if (fits && (type === 'image/png' || type === 'image/jpeg')) return { blob: file, ink };

  const scale = Math.min(1, maxWidth / image.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot prepare pictures. Try Chrome.');

  // A logo keeps its transparency as PNG; a banner is a photo or a screenshot,
  // which is far smaller as JPG — on white, the colour behind it in every design.
  const asPng = kind === 'logo';
  if (!asPng) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return new Promise<EmailImage>((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve({ blob, ink }) : reject(new Error('The picture could not be prepared.'))),
    asPng ? 'image/png' : 'image/jpeg',
    0.85
  ));
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminanceOf(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return relative((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function relative(r: number, g: number, b: number): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The average lightness of the opaque pixels — what shows against a background. */
function inkOf(image: HTMLImageElement): number | null {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 120 / image.naturalWidth);
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      sum += relative(data[i], data[i + 1], data[i + 2]);
      count += 1;
    }
    return count ? sum / count : null;
  } catch {
    return null;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (image.naturalWidth && image.naturalHeight) resolve(image);
      else reject(new Error('This picture has no size. Export it as PNG and try again.'));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This picture could not be opened. Export it as PNG or JPG and try again.'));
    };
    image.src = url;
  });
}

/**
 * Draws an SVG at exactly the width it will be used at, so the PNG is sharp.
 * Loaded as an image, its scripts never run.
 */
async function loadSvg(file: File, width: number): Promise<HTMLImageElement> {
  const svg = new DOMParser().parseFromString(await file.text(), 'image/svg+xml').documentElement;
  if (svg.nodeName.toLowerCase() !== 'svg') throw new Error('This SVG could not be read. Export it as PNG and try again.');

  const box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const attr = (name: string) => parseFloat(svg.getAttribute(name) || '');
  const ratio = box.length === 4 && box[2] > 0 && box[3] > 0
    ? box[2] / box[3]
    : attr('width') > 0 && attr('height') > 0 ? attr('width') / attr('height') : 0;
  if (!ratio) throw new Error('This SVG has no size. Export it as PNG and try again.');

  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${attr('width')} ${attr('height')}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(Math.round(width / ratio)));
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  return loadImage(URL.createObjectURL(blob));
}
