// 把 js/sfx-synth.js 现场算的声音渲染成 WAV，方便直接听、测响度（浏览器里放的就是同一份代码）。
// 用法：node scripts/render-sfx-synth.mjs [输出文件夹，默认 output/sfx-synth]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dripSamples, vcrSamples, DRIP_SPOTS } from '../js/sfx-synth.js';

const SR = 44100;
const dir = process.argv[2] || 'output/sfx-synth';
mkdirSync(dir, { recursive: true });

// 可复现的随机数（mulberry32）
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function wav(path, channels) {
  const n = channels[0].length, ch = channels.length, data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), (i * ch + c) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

const rnd = seeded(7);
for (const kind of Object.keys(DRIP_SPOTS)) {
  const [lo, hi] = DRIP_SPOTS[kind].f0, base = (lo + hi) / 2;
  for (let k = 1; k <= 3; k++) { const d = dripSamples(SR, kind, base, rnd); wav(join(dir, `drip-${kind}-${k}.wav`), [d.left, d.right]); }
}
for (let k = 1; k <= 3; k++) wav(join(dir, `vcr-${k}.wav`), [vcrSamples(SR, rnd)]);
console.log('wrote', dir);
