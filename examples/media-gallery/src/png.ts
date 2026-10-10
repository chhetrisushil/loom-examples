import { deflateSync, inflateSync } from "node:zlib";

// A real, valid PNG built in code: no binary fixtures. Solid-colour, 8-bit RGB, a few dozen bytes.
// (A scripted "vision" model decodes it again, so what it reports is read from the bytes it was given.)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

export type Rgb = readonly [number, number, number];

/** A `size` x `size` solid-colour PNG. */
export function tinyPng(rgb: Rgb, size = 2): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array(0)),
    ])
  );
}

export interface PngFacts {
  readonly width: number;
  readonly height: number;
  /** The first pixel. */
  readonly rgb: Rgb;
}

/** Read a PNG built by {@link tinyPng} back: what a model that was handed these bytes can report. */
export function readPng(bytes: Uint8Array): PngFacts | undefined {
  const b = Buffer.from(bytes);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return undefined;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  // IDAT follows the 25-byte IHDR chunk after the 8-byte signature.
  const idatLen = b.readUInt32BE(33);
  const raw = inflateSync(b.subarray(41, 41 + idatLen));
  return { width, height, rgb: [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0] };
}
