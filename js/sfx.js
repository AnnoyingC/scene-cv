// 房间里的声音（Web Audio）：动作音效（翻书、开灯、插录像带、万年历木块……）、窗外循环的雨声、电视放节目时低低的背景音乐。
// 浏览器不允许网页自己出声：第一次点击 / 拖动 / 按键以后才开始，雨声慢慢淡入。
// 底部的 Sound 开关记在 localStorage；关掉以后整个音频停掉。音效文件和来源见 assets/sfx/README.md（都是 CC0）。
// 各模块直接 import { sfx } 调 sfx.play('名字')；还没开始 / 关着的时候什么都不做。
const BASE = new URL('../assets/sfx/', import.meta.url).href;
const KEY = 'scenecv.sound';
// 名字 → 文件（数组 = 几个变体随机挑一个）
const FILES = {
  'book-open': 'book-open', 'book-flip': ['book-flip1', 'book-flip2'], 'book-close': 'book-close', 'book-place': 'book-place',
  paper: 'paper', 'photo-pin': 'photo-pin', switch: 'switch', wood: ['wood1', 'wood2', 'wood3'], key: 'key', tick: 'tick',
  'tape-latch': 'tape-latch', 'tv-static': 'tv-static', 'tv-glitch': 'tv-glitch',
};
const LOOPS = { rain: 'rain', music: 'tv-music' };
const LEVEL = { sfx: 0.75, rain: 0.3, music: 0.14 }; // 雨和电视音乐压得很低，是背景

let on = true;
try { on = localStorage.getItem(KEY) !== 'off'; } catch { /* 隐私模式：默认开 */ }
let ctx = null, master = null;
const bus = {}, buffers = new Map(), listeners = new Set();
let musicWant = 0, rainWant = 1;

const load = (file) => {
  if (!buffers.has(file)) {
    buffers.set(file, fetch(BASE + file + '.mp3').then((r) => r.arrayBuffer()).then((a) => ctx.decodeAudioData(a))
      .then((b) => { buffers.set(file, b); return b; }).catch(() => { buffers.set(file, null); return null; }));
  }
  return buffers.get(file);
};

// 循环：一段接一段交叠 2 秒淡入淡出，mp3 首尾的空白和接缝都听不出来
function looper(file, out, xf = 2) {
  load(file).then((buf) => {
    if (!buf) return;
    const D = buf.duration, step = D - xf;
    let next = ctx.currentTime + 0.05;
    const sched = () => {
      while (next < ctx.currentTime + 4) {
        const s = ctx.createBufferSource(), e = ctx.createGain();
        s.buffer = buf;
        s.connect(e).connect(out);
        e.gain.setValueAtTime(0, next);
        e.gain.linearRampToValueAtTime(1, next + xf);
        e.gain.setValueAtTime(1, next + step);
        e.gain.linearRampToValueAtTime(0, next + D);
        s.start(next);
        s.stop(next + D + 0.05);
        next += step;
      }
    };
    sched();
    setInterval(sched, 1000);
  });
}

function start() {
  if (ctx || !on) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.connect(ctx.destination);
  for (const k of ['sfx', 'rain', 'music']) { bus[k] = ctx.createGain(); bus[k].gain.value = 0; bus[k].connect(master); }
  bus.sfx.gain.value = LEVEL.sfx;
  bus.rain.gain.setTargetAtTime(LEVEL.rain * rainWant, ctx.currentTime + 0.3, 1.5); // 雨声慢慢进来
  for (const f of Object.values(FILES).flat()) load(f);
  looper(LOOPS.rain, bus.rain);
  looper(LOOPS.music, bus.music);
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => { start(); if (ctx?.state === 'suspended' && on) ctx.resume(); }, { capture: true, passive: true });
}

export const sfx = {
  get on() { return on; },
  // gain：音量（1 = 正常）；rate：音高（每次再随机偏一点，不会每次一模一样）；dur：只放前面这么多秒（尾巴淡出）；delay：晚多少秒
  play(name, { gain = 1, rate = 1, dur = 0, delay = 0 } = {}) {
    if (!ctx || !on || ctx.state !== 'running') return;
    const pick = FILES[name];
    const file = Array.isArray(pick) ? pick[Math.floor(Math.random() * pick.length)] : pick;
    const buf = buffers.get(file);
    if (!buf || buf instanceof Promise) return;
    const s = ctx.createBufferSource(), g = ctx.createGain(), t = ctx.currentTime + delay;
    s.buffer = buf;
    s.playbackRate.value = rate * (0.95 + Math.random() * 0.1);
    g.gain.setValueAtTime(gain, t);
    if (dur) { g.gain.setValueAtTime(gain, t + Math.max(0, dur - 0.12)); g.gain.linearRampToValueAtTime(0, t + dur); }
    s.connect(g).connect(bus.sfx);
    s.start(t);
    if (dur) s.stop(t + dur + 0.02);
  },
  // 合成的声音，不用文件：答录机的"嘀"（freq 赫兹，dur 秒）
  tone(freq = 1000, { dur = 0.35, gain = 0.2, delay = 0 } = {}) {
    if (!ctx || !on || ctx.state !== 'running') return;
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + delay;
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.setValueAtTime(gain, t + Math.max(0.02, dur - 0.03));
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(bus.sfx);
    o.start(t);
    o.stop(t + dur + 0.02);
  },
  // 磁带底噪：一直响到 stop()（淡出）。返回 { stop }；没开声音的时候也返回一个什么都不做的 stop
  hiss({ gain = 0.045 } = {}) {
    if (!ctx || !on || ctx.state !== 'running') return { stop() {} };
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
    s.buffer = buf;
    s.loop = true;
    bp.type = 'bandpass';
    bp.frequency.value = 4200;
    bp.Q.value = 0.5;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.25);
    s.connect(bp).connect(g).connect(bus.sfx);
    s.start(t);
    return {
      stop() {
        const t1 = ctx.currentTime;
        g.gain.cancelScheduledValues(t1);
        g.gain.setValueAtTime(g.gain.value, t1);
        g.gain.linearRampToValueAtTime(0, t1 + 0.3);
        s.stop(t1 + 0.35);
      },
    };
  },
  // 每帧由 room.js 调：tv = 背景音乐要多大（0..1：点进电视看节目时 1，电视在后面自己轮播时小一点）；
  // 唱机放歌时背景音乐让开、雨声也小一点
  mix({ tv = 0, record = false } = {}) {
    const m = record ? 0 : tv, r = record ? 0.5 : 1;
    if (!ctx) { musicWant = m; rainWant = r; return; }
    if (m !== musicWant) { musicWant = m; bus.music.gain.setTargetAtTime(LEVEL.music * m, ctx.currentTime, m ? 1.2 : 0.5); }
    if (r !== rainWant) { rainWant = r; bus.rain.gain.setTargetAtTime(LEVEL.rain * r, ctx.currentTime, 0.8); }
  },
  toggle() {
    on = !on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* 不保存也行 */ }
    if (on) { start(); ctx?.resume(); } else ctx?.suspend();
    listeners.forEach((f) => f(on));
    return on;
  },
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
};
