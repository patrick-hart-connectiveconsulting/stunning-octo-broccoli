// Reads pixel dimensions from common image formats without any native deps.
// Returns { width, height } or null when the format is unknown or malformed.

export function imageSize(buf) {
  try {
    if (buf.length < 12) return svgSize(buf);
    // PNG
    if (buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // BMP
    if (buf.toString('ascii', 0, 2) === 'BM' && buf.length >= 26) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
    // WebP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return webpSize(buf);
    }
    return svgSize(buf);
  } catch {
    return null;
  }
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    // Standalone markers without a length field
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (c4), JPG (c8), DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function svgSize(buf) {
  const head = buf.subarray(0, 4096).toString('utf8');
  const tag = head.match(/<svg\b[^>]*>/i);
  if (!tag) return null;
  const attr = (name) => {
    const m = tag[0].match(new RegExp(`\\s${name}\\s*=\\s*["']([\\d.]+)(px)?["']`, 'i'));
    return m ? Math.round(parseFloat(m[1])) : null;
  };
  let width = attr('width');
  let height = attr('height');
  if (!width || !height) {
    const vb = tag[0].match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (vb) {
      width = width || Math.round(parseFloat(vb[1]));
      height = height || Math.round(parseFloat(vb[2]));
    }
  }
  return width && height ? { width, height } : null;
}
