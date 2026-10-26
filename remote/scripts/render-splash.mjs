// Plain black launch screens for iOS (apple-touch-startup-image), so a cold start opens dark.
// Usage: node scripts/render-splash.mjs   (writes public/splash/WxH.png)
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIZES = [[750, 1334], [1170, 2532], [1179, 2556], [1206, 2622], [1290, 2796], [1320, 2868], [1398, 2034], [1878, 2670], [2670, 1878]];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
fs.mkdirSync('public/splash', { recursive: true });
for (const [w, h] of SIZES) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);   // every row: filter 0, then black pixels
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(`public/splash/${w}x${h}.png`, png);
  console.log(`${w}x${h}`, png.length, 'bytes');
}
