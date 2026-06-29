/**
 * Generates a multi-size Windows .ico from the beaver pixel art.
 * No external dependencies — only Node.js built-ins.
 * Output: build/icon.ico (referenced by both electron-builder configs)
 */

import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Pixel art palette and 16×16 grid (matches the runtime icon in main.mjs) ──

const _ = [0,0,0,0],   T = [82,82,91,255],    O = [249,115,22,255]
const B = [194,65,12,255], D = [24,24,27,255], C = [6,182,212,255]
const W = [255,255,255,255]

const PIXELS = [
  [_,_,_,_,_,_,_,T,_,_,_,_,_,_,_,_],
  [_,_,_,_,_,_,T,T,T,_,_,_,_,_,_,_],
  [_,_,B,B,_,_,_,_,_,_,_,_,B,B,_,_],
  [_,_,B,O,B,_,_,_,_,_,_,B,O,B,_,_],
  [_,_,D,O,O,O,O,O,O,O,O,O,O,D,_,_],
  [_,_,D,O,O,O,O,O,O,O,O,O,O,D,_,_],
  [_,_,D,O,D,D,D,O,O,D,D,D,O,D,_,_],
  [_,_,D,O,D,C,D,O,O,D,C,D,O,D,_,_],
  [_,_,D,O,D,D,D,O,O,D,D,D,O,D,_,_],
  [_,_,D,O,O,O,O,O,O,O,O,O,O,D,_,_],
  [_,_,D,O,O,B,B,B,B,B,B,O,O,D,_,_],
  [_,_,D,O,B,W,W,B,B,W,W,B,O,D,_,_],
  [_,_,D,O,B,W,W,B,B,W,W,B,O,D,_,_],
  [_,_,D,D,D,D,D,D,D,D,D,D,D,D,_,_],
  [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
  [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
]

// ── PNG encoder ──────────────────────────────────────────────────────────────

function makePng(size) {
  const scale = size / 16

  function crc32(buf) {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      t[i] = c
    }
    let v = 0xFFFFFFFF
    for (let i = 0; i < buf.length; i++) v = t[(v ^ buf[i]) & 0xFF] ^ (v >>> 8)
    return (v ^ 0xFFFFFFFF) >>> 0
  }

  function chunk(type, data) {
    const tb = Buffer.from(type, 'ascii')
    const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length, 0)
    const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
    return Buffer.concat([lb, tb, data, cb])
  }

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  const rows = []
  for (let y = 0; y < size; y++) {
    rows.push(0) // PNG filter byte: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = PIXELS[Math.floor(y / scale)][Math.floor(x / scale)]
      rows.push(r, g, b, a)
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── ICO assembler (PNG-in-ICO, Windows Vista+) ───────────────────────────────
// Format: 6-byte ICONDIR header, N×16-byte ICONDIRENTRY, then raw PNG blobs.

const SIZES = [16, 32, 48, 64, 128, 256]
const pngs  = SIZES.map(makePng)

const dirOffset = 6 + SIZES.length * 16
const offsets   = pngs.reduce((acc, png) => {
  acc.push(acc.at(-1) + pngs[acc.length - 1]?.length ?? 0)
  return acc
}, [dirOffset])

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)           // reserved
header.writeUInt16LE(1, 2)           // type: 1 = icon
header.writeUInt16LE(SIZES.length, 4)

const entries = SIZES.map((size, i) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(size === 256 ? 0 : size, 0) // 0 encodes 256 in ICO spec
  e.writeUInt8(size === 256 ? 0 : size, 1)
  e.writeUInt8(0, 2)      // color count (0 = truecolor)
  e.writeUInt8(0, 3)      // reserved
  e.writeUInt16LE(1, 4)   // planes
  e.writeUInt16LE(32, 6)  // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8)
  e.writeUInt32LE(offsets[i], 12)
  return e
})

const ico = Buffer.concat([header, ...entries, ...pngs])

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'icon.ico')
fs.writeFileSync(outPath, ico)
console.log(`✓ icon.ico → ${outPath}  (${SIZES.join(', ')}px, ${(ico.length / 1024).toFixed(1)} KB)`)
