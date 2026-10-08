import fs from 'node:fs';

export interface ImageInfo {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}

/** Reads dimensions from a PNG or JPEG header without decoding the image. */
export function imageInfo(file: string): ImageInfo | undefined {
  const buf = fs.readFileSync(file);
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0..SOF15 carry the frame size; C4/C8/CC are other segment types.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return undefined;
}
