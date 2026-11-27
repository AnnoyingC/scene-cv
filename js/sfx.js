// 房间里的声音（Web Audio）：动作音效（翻书、开灯、插录像带、万年历木块……）、窗外循环的雨声和偶尔的滴水、电视放节目时低低的背景音乐。
// 浏览器不允许网页自己出声：第一次点击 / 拖动 / 按键以后才开始，雨声慢慢淡入。
// 底部的 Sound 开关记在 localStorage；关掉以后整个音频停掉。音效文件和来源见 assets/sfx/README.md（都是 CC0）；
// 滴水和录像机吃带的声音没有文件，是 js/sfx-synth.js 现场算的。
// 各模块直接 import { sfx } 调 sfx.play('名字')；还没开始 / 关着的时候什么都不做。
//
// 混音的规矩（2026-11 统一调过一遍）：
//   · 每个文件先按 TRIM 校到同一个参考响度（K 加权后最响的 100 ms ≈ -20 LUFS），所以调用时写的 gain 就是"这一下该多响"：
//       1 左右 = 大动作（厚书合上、放回书架、录像机吃带）
//       0.6～0.75 = 普通动作（开灯、拿起纸、翻页、木块、换台）
//       0.3～0.5 = 小动作（按键、滴答、拿听筒）
//   · 背景（2026-11 在浏览器里录下实际输出量过，单位 LUFS）：
//       屋里：唱片（测量时音量为 50%）-32.5，雨 -36.5、放唱片时让开到 -39；窗外滴水每一下最响 -30 上下，能听出来但不抢
//       看电视：唱片小一半 -39，雨让开到 -44 左右，录像带底噪 -45 左右；没放唱片时电视背景音乐 -34。
//       电视的这些声音（底噪、背景音乐、开机雪花）只在点进电视以后才有，人在屋里别处时电视是哑的
//       答录机放留言：磁带底噪 -43（电话里的答录提示 -47）
//       窗前：唱片小一半 -39，雨大起来 -35.5，盖过音乐
//     几个场景之间都是一两秒里慢慢变过去
import { dripSamples, vcrSamples, DRIP_SPOTS } from './sfx-synth.js';

const BASE = new URL('../assets/sfx/', import.meta.url).href;
const KEY = 'scenecv.sound';
// 名字 → 文件（数组 = 几个变体随机挑一个）；~ 开头的是现场合成的
const FILES = {
  'book-open': 'book-open', 'book-flip': ['book-flip1', 'book-flip2'], 'book-close': 'book-close', 'book-place': 'book-place',
  paper: 'paper', 'photo-pin': 'photo-pin', switch: 'switch', wood: ['wood1', 'wood2', 'wood3'], key: 'key', tick: 'tick',
  'tape-latch': 'tape-latch', 'tv-static': 'tv-static', 'tv-glitch': 'tv-glitch', vcr: ['~vcr0', '~vcr1', '~vcr2'],
};
// 每个文件校到参考响度要加减多少 dB（量法：K 加权，100 ms 窗口里最响的一段）。
// 原来 Kenney 的两个翻页变体差了 11 dB、"放回书架"比"翻开"响 16 dB，校过以后同样的 gain 听起来一样响
const TRIM = {
  'book-close': -6.8, 'book-flip1': -5.2, 'book-flip2': 5.6, 'book-open': 7.1, 'book-place': -9.4,
  key: 6.3, paper: -1.6, 'photo-pin': -7.6, switch: 2.7, 'tape-latch': -9.4, tick: 3.5,
  'tv-glitch': -3.7, 'tv-static': -1.7, wood1: -5.3, wood2: -5.3, wood3: -2.7, '~vcr': -2.3,
};
const trim = (file) => Math.pow(10, (TRIM[file] ?? TRIM[file.replace(/\d+$/, '')] ?? 0) / 20);
const LOOPS = { rain: 'rain', music: 'tv-music' };
// 各条总线的音量：sfx = 动作音效，rain = 雨（滴水也走这条，跟着一起变小变大），music = 电视背景音乐
const LEVEL = { sfx: 0.75, rain: 0.45, music: 0.14 };
// 镜头在看哪里，雨（连滴水）跟着变：看电视时背景让开，电视是主角；站到窗前，雨就在眼前（唱机那边 room.js 同时让音乐小一半）
const SCENE_RAIN = { work: 0.6, window: 1.6 };
// 唱机放歌时雨让开多少：0.7 ≈ 小 3 dB。唱片音量为 50% 时（约 -33 LUFS）雨还在音乐下面五六 dB，听得见、滴水也能从乐句的空隙里出来
const RECORD_DUCK = 0.7;
// 窗外各个滴水点的音量：三种都按响度对齐到每一下最响 -30 LUFS 左右（雨在屋里正常大小时）
const DRIP = { gutter: 0.48, pipe: 0.36, tin: 0.33 };
// 电视放节目时录像带的底噪（只在点进电视看节目时有；在屋里别处听不到）
const TV_HISS = 0.01;

let on = true;
try { on = localStorage.getItem(KEY) !== 'off'; } catch { /* 隐私模式：默认开 */ }
let ctx = null, master = null;
const bus = {}, buffers = new Map(), listeners = new Set();
let musicWant = 0, rainWant = 1, hissWant = 0, tvHiss = null;

const load = (file, url = BASE + file + '.mp3') => {
  if (!buffers.has(file)) {
    buffers.set(file, fetch(url).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.arrayBuffer();
    }).then((a) => ctx.decodeAudioData(a))
      .then((b) => { buffers.set(file, b); return b; }).catch(() => { buffers.set(file, null); return null; }));
  }
  return buffers.get(file);
};
const toBuffer = (...channels) => {
  const b = ctx.createBuffer(channels.length, channels[0].length, ctx.sampleRate);
  channels.forEach((c, k) => b.getChannelData(k).set(c));
  return b;
};

// 循环：一段接一段交叠 2 秒淡入淡出，mp3 首尾的空白和接缝都听不出来
function looper(file, out, xf = 2) {
  load(file).then((buf) => {
    if (!buf) return;
    const D = buf.duration, step = D - xf;
    let next = ctx.currentTime + 0.05;
    const sched = () => {
      if (next < ctx.currentTime - step) next = ctx.currentTime + 0.05; // 标签页被冻住过：别一口气补放好几段
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

// 雨不会一直一样大：每隔几秒往大或往小慢慢飘一点（-2.5～+1 dB），像一阵密一阵疏
function breathe(g) {
  let db = 0;
  setInterval(() => {
    if (ctx.state !== 'running') return;
    db = Math.max(-2.5, Math.min(1, db + (Math.random() - 0.5) * 1.6));
    g.gain.setTargetAtTime(Math.pow(10, db / 20), ctx.currentTime, 4);
  }, 3000);
}

// 窗外的滴水：雨下着下着，檐沟里、落水管口、铁皮窗台上偶尔掉几滴。
// 一阵 2～5 滴，同一个地方滴得差不多匀（水珠攒够了就掉）；阵与阵之间隔 5～30 秒（平均十几秒）；偶尔旁边另一个地方也跟着滴一下。
// 每个点先合成 5 个变体放着（一次算一个，免得一下子卡一帧），播的时候随机挑一个、音高再偏一点点
function dripper(out) {
  const spots = Object.entries(DRIP_SPOTS).map(([kind, s]) => ({ kind, base: s.f0[0] + Math.random() * (s.f0[1] - s.f0[0]), pool: [] }));
  const pick = () => { const r = Math.random(); return spots[r < 0.4 ? 0 : r < 0.7 ? 1 : 2]; };
  const one = (s, t, g) => {
    if (!s.pool.length) return;
    const src = ctx.createBufferSource(), gn = ctx.createGain();
    src.buffer = s.pool[Math.floor(Math.random() * s.pool.length)];
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    gn.gain.value = DRIP[s.kind] * g;
    src.connect(gn).connect(out);
    src.start(t);
  };
  const episode = (t0, s = pick()) => {
    const n = 2 + Math.floor(Math.random() * 4), T = 0.35 + Math.random() * 0.55;
    let t = t0;
    for (let k = 0; k < n; k++) { one(s, t, 0.55 + Math.random() * 0.45); t += T * (0.8 + Math.random() * 0.45); }
    if (Math.random() < 0.3) { const o = pick(); if (o !== s) one(o, t0 + Math.random() * (t - t0), 0.5 + Math.random() * 0.4); }
    return t;
  };
  let next = ctx.currentTime + 6 + Math.random() * 6; // 雨先下一会儿
  setInterval(() => {
    const todo = spots.find((s) => s.pool.length < 5);
    if (todo) { const d = dripSamples(ctx.sampleRate, todo.kind, todo.base); todo.pool.push(toBuffer(d.left, d.right)); }
    if (ctx.state !== 'running' || spots.some((s) => s.pool.length < 2)) return;
    if (next < ctx.currentTime) next = ctx.currentTime + 1 + Math.random() * 4; // 后台冻住过：不补
    while (next < ctx.currentTime + 1.5) next = episode(next) + Math.min(30, 5 + -Math.log(1 - Math.random()) * 10);
  }, 400);
  return (kind) => episode(ctx.currentTime + 0.05, spots.find((s) => s.kind === kind) || pick()); // 调试：马上滴一阵
}
let dripNow = null;

// 录像带的底噪：放节目时一层很轻的"沙沙"（中高频的噪声），音量有一点点慢慢的起伏，像磁带走带不太稳。
// 不走电视音乐那条线：唱机放歌时电视音乐会让开，底噪不让
function tapeHiss() {
  const sr = ctx.sampleRate, len = sr * 5, buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; lp += 0.3 * (w - lp); d[i] = 0.6 * w + 0.8 * lp; }
  const fade = Math.round(sr * 0.05); // 首尾交叉一下，循环接缝听不出来
  for (let i = 0; i < fade; i++) { const k = i / fade; d[i] = d[i] * k + d[len - fade + i] * (1 - k); }
  const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), lpf = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = buf;
  src.loop = true;
  src.loopEnd = (len - fade) / sr;
  bp.type = 'bandpass'; bp.frequency.value = 2000; bp.Q.value = 0.5; // 和答录机的磁带底噪同一个音色：中频的"沙沙"，不扎耳朵
  lpf.type = 'lowpass'; lpf.frequency.value = 5000;
  g.gain.value = 0;
  const wob = ctx.createOscillator(), depth = ctx.createGain();
  wob.frequency.value = 0.37;
  depth.gain.value = 0; // 起伏的幅度跟着底噪的音量一起变（mix 里设）
  wob.connect(depth).connect(g.gain);
  src.connect(bp).connect(lpf).connect(g).connect(master);
  src.start();
  wob.start();
  return { g, depth };
}

function start() {
  if (ctx || !on) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.connect(ctx.destination);
  for (const k of ['sfx', 'rain', 'music']) { bus[k] = ctx.createGain(); bus[k].gain.value = 0; bus[k].connect(master); }
  bus.voice = ctx.createGain();
  bus.voice.gain.value = 0.45; // 旁白母带约 -23.5 LUFS（单声道），在电视前比雨和走带声高约 12 dB
  bus.voice.connect(master);
  bus.sfx.gain.value = LEVEL.sfx;
  bus.rain.gain.setTargetAtTime(LEVEL.rain * rainWant, ctx.currentTime + 0.3, 1.5); // 雨声慢慢进来
  for (let k = 0; k < 3; k++) buffers.set(`~vcr${k}`, toBuffer(vcrSamples(ctx.sampleRate)));
  for (const f of Object.values(FILES).flat()) load(f);
  const bed = ctx.createGain();
  bed.connect(bus.rain);
  looper(LOOPS.rain, bed);
  breathe(bed);
  dripNow = dripper(bus.rain);
  tvHiss = tapeHiss();
  looper(LOOPS.music, bus.music);
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => { start(); if (ctx?.state === 'suspended' && on) ctx.resume(); }, { capture: true, passive: true });
}

export const sfx = {
  get on() { return on; },
  // 整盘的一条旁白。出声时用声卡的时间画画面，跳章、离开电视时释放旧的声源。
  narration(url) {
    let source = null, origin = 0;
    function stop() {
      if (!source) return;
      source.stop();
      source.disconnect();
      source = null;
    }
    return {
      stop,
      get playing() { return !!source; },
      time(position, dt, audible) {
        if (!audible || !on || ctx?.state !== 'running') {
          stop();
          return position + dt;
        }
        if (!source) {
          const buffer = load(url, url);
          if (buffer instanceof Promise) return position; // 首次解码时停在当前画面，保住第一句
          if (!buffer || position >= buffer.duration) return position + dt;
          source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(bus.voice);
          const now = ctx.currentTime;
          origin = now - position;
          source.start(now, position);
        }
        return ctx.currentTime - origin;
      },
    };
  },
  // gain：音量（1 = 大动作，见文件开头）；rate：音高（每次再随机偏一点，不会每次一模一样）；dur：只放前面这么多秒（尾巴淡出）；
  // delay：晚多少秒；lp / hp：低通 / 高通（Hz）——lp 把刺耳的高频收掉，hp 把"咚"的闷重低频去掉（轻的东西没有那么沉）
  play(name, { gain = 1, rate = 1, dur = 0, delay = 0, lp = 0, hp = 0 } = {}) {
    if (!ctx || !on || ctx.state !== 'running') return;
    const pick = FILES[name];
    const file = Array.isArray(pick) ? pick[Math.floor(Math.random() * pick.length)] : pick;
    const buf = buffers.get(file);
    if (!buf || buf instanceof Promise) return;
    const s = ctx.createBufferSource(), g = ctx.createGain(), t = ctx.currentTime + delay, v = gain * trim(file);
    s.buffer = buf;
    s.playbackRate.value = rate * (0.95 + Math.random() * 0.1);
    g.gain.setValueAtTime(v, t);
    if (dur) { g.gain.setValueAtTime(v, t + Math.max(0, dur - 0.12)); g.gain.linearRampToValueAtTime(0, t + dur); }
    let node = s;
    for (const [type, f] of [['lowpass', lp], ['highpass', hp]]) {
      if (!f) continue;
      const bq = ctx.createBiquadFilter();
      bq.type = type;
      bq.frequency.value = f;
      bq.Q.value = 0.6;
      node = node.connect(bq);
    }
    node.connect(g).connect(bus.sfx);
    s.start(t);
    if (dur) s.stop(t + dur + 0.02);
  },
  // 合成的声音，不用文件：答录机的"嘀"（freq 赫兹，dur 秒）。默认 0.13 ≈ 比大动作稍微响一点点（纯音很扎耳朵，不能再大）
  tone(freq = 1000, { dur = 0.35, gain = 0.13, delay = 0 } = {}) {
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
  // 磁带底噪（答录机放留言、电话里的答录提示）：一直响到 stop()（淡出）。返回 { stop }；没开声音的时候也返回一个什么都不做的 stop。
  // 音色和电视的录像带底噪一样：中频的"沙沙"，不要 4 kHz 以上那种扎耳朵的"嘶"。
  // 默认约 -43 LUFS，在唱片下面十来 dB（2026-11 以前是 4.2 kHz 的嘶声、-33 LUFS，和唱片一样响，刺耳）
  hiss({ gain = 0.016 } = {}) {
    if (!ctx || !on || ctx.state !== 'running') return { stop() {} };
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let lo = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; lo += 0.3 * (w - lo); d[i] = 0.6 * w + 0.8 * lo; }
    const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), lpf = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
    s.buffer = buf;
    s.loop = true;
    bp.type = 'bandpass';
    bp.frequency.value = 2000;
    bp.Q.value = 0.5;
    lpf.type = 'lowpass';
    lpf.frequency.value = 5000;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.25);
    s.connect(bp).connect(lpf).connect(g).connect(bus.sfx);
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
  // 调试 / 审听：马上让窗外滴一阵（kind = gutter | pipe | tin，不写就随机）
  drip(kind) { if (ctx?.state === 'running') dripNow?.(kind); },
  // 每帧由 room.js 调：tv = 背景音乐要多大（0..1：点进电视看节目时 1，电视在后面自己轮播时小一点；0 = 没在放）；
  // record = 唱机在放歌：电视背景音乐让开、雨声也小一点；scene = 镜头在看哪里（'work' 看电视、'window' 站在窗前），雨跟着变
  mix({ tv = 0, record = false, narration = false, scene = '' } = {}) {
    const m = record || narration ? 0 : tv, r = (record ? RECORD_DUCK : 1) * (SCENE_RAIN[scene] ?? 1), h = tv >= 1 ? 1 : 0;
    if (!ctx) { musicWant = m; rainWant = r; return; }
    if (m !== musicWant) { musicWant = m; bus.music.gain.setTargetAtTime(LEVEL.music * m, ctx.currentTime, m ? 1.2 : 0.5); }
    if (r !== rainWant) { rainWant = r; bus.rain.gain.setTargetAtTime(LEVEL.rain * r, ctx.currentTime, 1); } // 一两秒里慢慢过去
    if (tvHiss && h !== hissWant) {
      hissWant = h;
      tvHiss.g.gain.setTargetAtTime(TV_HISS * h, ctx.currentTime, h ? 0.6 : 0.3);
      tvHiss.depth.gain.setTargetAtTime(TV_HISS * h * 0.12, ctx.currentTime, 0.6);
    }
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
