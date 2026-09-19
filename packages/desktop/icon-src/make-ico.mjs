/**
 * 把一堆 PNG 拼成一个多尺寸 .ico。
 *
 * ICO 从 Vista 起允许直接内嵌 PNG（不必是 BMP），所以这里不做任何像素处理，
 * 只写一个 6 字节头 + 每张图 16 字节的目录项，然后把 PNG 原样接在后面。
 *
 * 跑法：node packaging/icon/make-ico.mjs <png目录> <输出.ico>
 * PNG 怎么来的、为什么不在这一步做光栅化，见同目录的 读我.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [pngDir, outFile] = process.argv.slice(2);
if (!pngDir || !outFile) {
  console.error('用法：node make-ico.mjs <png目录> <输出.ico>');
  process.exit(1);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const images = SIZES.map((size) => ({ size, data: readFileSync(join(pngDir, `${size}.png`)) }));

const HEADER = 6;
const ENTRY = 16;

const header = Buffer.alloc(HEADER);
header.writeUInt16LE(0, 0); // 保留位，必须是 0
header.writeUInt16LE(1, 2); // 1 = 图标（2 是光标）
header.writeUInt16LE(images.length, 4);

const entries = Buffer.alloc(ENTRY * images.length);
let offset = HEADER + ENTRY * images.length;

images.forEach((img, i) => {
  const at = i * ENTRY;
  // 256 写作 0 —— 这个字段只有一个字节，装不下 256
  entries.writeUInt8(img.size >= 256 ? 0 : img.size, at + 0);
  entries.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1);
  entries.writeUInt8(0, at + 2); // 调色板颜色数，真彩色写 0
  entries.writeUInt8(0, at + 3); // 保留位
  entries.writeUInt16LE(1, at + 4); // 颜色平面数
  entries.writeUInt16LE(32, at + 6); // 每像素位数：RGBA
  entries.writeUInt32LE(img.data.length, at + 8);
  entries.writeUInt32LE(offset, at + 12);
  offset += img.data.length;
});

const ico = Buffer.concat([header, entries, ...images.map((i) => i.data)]);
writeFileSync(outFile, ico);

console.log(`${outFile}  ${ico.length} 字节  ${images.map((i) => i.size).join('/')}`);
