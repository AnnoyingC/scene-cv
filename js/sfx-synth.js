// 不用录音文件、现场算出来的声音：窗外排水沟里的滴水、录像机把带子吃进去的机械声。
// 都是纯函数，只算采样（Float32Array），不碰 Web Audio：浏览器里 sfx.js 拿去做成 AudioBuffer 播放，
// 脚本里也能直接跑出 WAV 来测响度（scripts/render-sfx-synth.mjs），听到的和测到的是同一份代码。
//
// 滴水用 van den Doel（2005，"Physically based models for liquid sounds"）的气泡模型：水滴砸进水面会卷进一个小气泡，
// 气泡按 Minnaert 共振频率 f ≈ 3 / 半径 振一下、很快衰减、音高往上挑一点——"叮""咚"就是它。
// 再加上砸到水面那一下的轻响、铁皮檐沟自己的余振、落水管的空腔共鸣，最后隔着窗户（高频被吃掉）、在楼和楼之间回响一点。
const TAU = Math.PI * 2;

// ---------- 小工具 ----------
// 一阶低通 / 高通（就地改）
function lowpass(x, sr, fc) {
  const a = 1 - Math.exp(-TAU * fc / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; }
  return x;
}
function highpass(x, sr, fc) {
  const a = Math.exp(-TAU * fc / sr);
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; py = a * (py + v - px); px = v; x[i] = py; }
  return x;
}
// 二阶带通（RBJ），给噪声塑形用
function bandpass(x, sr, fc, q) {
  const w = TAU * fc / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], y = b0 * v + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}
// 衰减的正弦（一个振动模态）：从第 i0 个采样开始，加到 out 上
function mode(out, sr, i0, f, amp, decay, phase = 0) {
  const n = Math.min(out.length - i0, Math.ceil(sr * decay * 7));
  const w = TAU * f / sr, k = Math.exp(-1 / (sr * decay)), att = Math.max(1, Math.round(sr * 0.0004)); // 0.4 ms 起振，相位随机也不会咔一声
  let e = amp;
  for (let i = 0; i < n; i++) { out[i0 + i] += e * Math.sin(w * i + phase) * Math.min(1, i / att); e *= k; }
}
// 一小下噪声（碰撞的那一下）：exp 衰减，tau 秒
function burst(out, sr, i0, amp, tau, rnd) {
  const n = Math.min(out.length - i0, Math.ceil(sr * tau * 6));
  for (let i = 0; i < n; i++) out[i0 + i] += amp * (rnd() * 2 - 1) * Math.exp(-i / (sr * tau));
}
const peakOf = (x) => { let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i])); return p; };

// ---------- 气泡：van den Doel 模型 ----------
// f0：共振频率（Hz）；xi：音高上挑的程度（论文里听感最真的是 0.1 左右）
function bubble(out, sr, i0, f0, amp, xi = 0.1) {
  const r = 3 / f0; // 气泡半径（米），Minnaert：f ≈ 3 / r
  const d = 0.13 / r + 0.0072 * Math.pow(r, -1.5); // 衰减率（1/秒）：粘滞 + 热传导
  const sigma = xi * d; // f(t) = f0 · (1 + σt)
  const n = Math.min(out.length - i0, Math.ceil(sr * 7 / d));
  const att = Math.max(1, Math.round(sr * 0.0006)); // 0.6 ms 起音，免得咔一声
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += TAU * f0 * (1 + sigma * t) / sr;
    out[i0 + i] += amp * Math.sin(ph) * Math.exp(-d * t) * Math.min(1, i / att);
  }
}

// ---------- 室外的一点回响（楼和楼之间） ----------
// 简化的 Schroeder 混响：四个带阻尼的梳状滤波 + 两个全通；左右声道用错开一点的延时，听起来有宽度
function reverb(x, sr, seconds, offset) {
  const out = new Float32Array(x.length);
  const combs = [29.7, 37.1, 41.1, 43.7].map((ms) => Math.round(sr * (ms + offset) / 1000));
  for (const D of combs) {
    const g = Math.pow(10, -3 * D / (sr * seconds)); // 混响时间 seconds（衰减 60 dB）
    const buf = new Float32Array(D);
    let j = 0, lp = 0;
    for (let i = 0; i < x.length; i++) {
      const y = buf[j];
      lp += 0.45 * (y - lp); // 反射一次高频就少一点
      buf[j] = x[i] + g * lp;
      out[i] += y * 0.25;
      j = (j + 1) % D;
    }
  }
  for (const [ms, g] of [[5.0, 0.7], [1.7, 0.7]]) {
    const D = Math.round(sr * ms / 1000), buf = new Float32Array(D);
    let j = 0;
    for (let i = 0; i < out.length; i++) {
      const v = buf[j], u = out[i] + g * v;
      buf[j] = u;
      out[i] = v - g * u;
      j = (j + 1) % D;
    }
  }
  return out;
}

// ---------- 窗外的滴水点 ----------
// 雨下着下着，檐沟边上攒够了的水珠会掉几滴：每个"点"是窗外一个固定会滴水的地方，音色大致固定（听起来是同一个地方又滴了一下）
// 都是水珠砸在金属上（2026-11 试听：气泡模型的"叮咚"像吐泡泡，不像雨天；砸在铁皮上的尖细"嗒"才像）
//   gutter：砸在檐沟的铝槽底上，比窗台低、闷一点（槽里有水压着），"嗒"
//   pipe：  砸在落水管口，金属管"当"一下，再在管子里空空地响一会儿
//   tin：   砸在窗台的铁皮上，尖细的"嗒"
export const DRIP_SPOTS = {
  gutter: { f0: [1150, 1550], pan: -0.4 },
  pipe: { f0: [650, 900], pan: 0.45 },
  tin: { f0: [1900, 2500], pan: 0.12 },
};

// 溅开的一点水声：几毫秒的噪声，去掉低频（只有"嚓"的那一点点）
function splash(out, sr, i0, amp, rnd) {
  const n = Math.min(out.length - i0, Math.round(sr * 0.02)), att = Math.round(sr * 0.001);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1, hp = w - prev; // 一阶差分 = 简单的高通
    prev = w;
    out[i0 + i] += amp * hp * Math.min(1, i / att) * Math.exp(-i / (sr * 0.004));
  }
}

// 一滴：返回 { left, right }（立体声，已经隔着窗户、带回响）。base：这个滴水点这一次加载页面时的基准音高
export function dripSamples(sr, kind, base, rnd = Math.random) {
  const len = Math.round(sr * 1.1);
  const dry = new Float32Array(len);
  const i0 = Math.round(sr * 0.004);
  const jit = (a) => 1 + (rnd() * 2 - 1) * a;
  const f0 = base * jit(0.06);
  if (kind === 'tin') {
    // 铁皮：几个不成谐波的模态，衰得快；水珠本身只剩一点点气泡
    burst(dry, sr, i0, 0.5, 0.0005, rnd);
    const ratios = [1, 1.59, 2.43, 3.41], decays = [0.04, 0.028, 0.018, 0.012], amps = [0.5, 0.3, 0.16, 0.07]; // 水珠压着铁皮，振不长
    ratios.forEach((r, k) => mode(dry, sr, i0, f0 * r * jit(0.015), amps[k], decays[k] * jit(0.15), rnd() * TAU));
    if (rnd() < 0.5) bubble(dry, sr, i0 + Math.round(sr * 0.006), f0 * 0.62, 0.25, 0.12);
  } else if (kind === 'gutter') {
    // 铝槽：模态比铁皮低、衰得更快（槽底积着水）；砸下去溅开一点水
    burst(dry, sr, i0, 0.4, 0.0006, rnd);
    const ratios = [1, 1.47, 2.09, 2.92], decays = [0.045, 0.03, 0.019, 0.012], amps = [0.5, 0.3, 0.16, 0.07];
    ratios.forEach((r, k) => mode(dry, sr, i0, f0 * r * jit(0.02), amps[k], decays[k] * jit(0.15), rnd() * TAU));
    splash(dry, sr, i0 + Math.round(sr * 0.0015), 0.18, rnd);
  } else {
    // 落水管口：一根金属管被砸一下（管子的弯曲振动，模态比例约 1 : 2.76 : 5.4），比檐沟低、响得长一点
    burst(dry, sr, i0, 0.3, 0.0008, rnd);
    const ratios = [1, 2.76, 5.4], decays = [0.05, 0.03, 0.018], amps = [0.5, 0.22, 0.08];
    ratios.forEach((r, k) => mode(dry, sr, i0, f0 * r * jit(0.02), amps[k], decays[k] * jit(0.15), rnd() * TAU));
    splash(dry, sr, i0 + Math.round(sr * 0.0015), 0.12, rnd);
  }
  if (kind === 'pipe') {
    // 落水管：带阻尼的梳状滤波 = 一根管子的空腔共鸣（基音 230～290 Hz）
    const D = Math.round(sr / (230 + rnd() * 60)), g = 0.5, buf = new Float32Array(D);
    let j = 0, lp = 0;
    for (let i = 0; i < len; i++) {
      lp += 0.5 * (buf[j] - lp);
      const y = dry[i] + g * lp;
      buf[j] = y; dry[i] = y * 0.55;
      j = (j + 1) % D;
    }
  }
  // 隔着窗户：高频被玻璃吃掉、低频的闷响也去掉
  lowpass(lowpass(dry, sr, 5200), sr, 6500);
  highpass(dry, sr, 160);
  // 在两栋楼之间：一点回响 + 一下对面墙的回声
  const wetL = reverb(dry, sr, 0.75, 0), wetR = reverb(dry, sr, 0.75, 1.3);
  const echo = Math.round(sr * (0.065 + rnd() * 0.02));
  const pan = (DRIP_SPOTS[kind]?.pan ?? 0) + (rnd() * 2 - 1) * 0.08;
  const a = (Math.min(1, Math.max(-1, pan)) + 1) * Math.PI / 4;
  const gl = Math.cos(a), gr = Math.sin(a);
  const left = new Float32Array(len), right = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const e = i >= echo ? dry[i - echo] * 0.16 : 0;
    left[i] = dry[i] * gl + wetL[i] * 0.3 + e * gr;
    right[i] = dry[i] * gr + wetR[i] * 0.3 + e * gl;
  }
  // 统一到差不多的电平（每种点各自的响度由 sfx.js 的混音决定）
  const p = Math.max(peakOf(left), peakOf(right)) || 1, norm = 0.5 / p;
  for (let i = 0; i < len; i++) { left[i] *= norm; right[i] *= norm; }
  return { left, right };
}

// ---------- 录像机吃带 ----------
// 真的录像机：带子推进去 → 机芯"咔哒"一下把带仓压下去 → 小马达转一阵（穿带）。
// 这里压缩在电视雪花那半秒里：闷的塑料"咔哒"在最前面，马达声低低地跟着，雪花完了它也停。高频都收住，不刺耳
export function vcrSamples(sr, rnd = Math.random) {
  const len = Math.round(sr * 0.75);
  const x = new Float32Array(len);
  const at = (s) => Math.round(sr * s);
  const jit = (a) => 1 + (rnd() * 2 - 1) * a;
  // 带壳擦过翻盖的"沙"
  const slide = new Float32Array(len);
  for (let i = 0; i < at(0.07); i++) slide[i] = (rnd() * 2 - 1) * Math.sin(Math.PI * i / at(0.07)) * 0.22;
  bandpass(slide, sr, 1300, 0.9);
  lowpass(slide, sr, 3000);
  for (let i = 0; i < len; i++) x[i] += slide[i];
  // 带仓落下：塑料壳 + 金属架子的一记闷响（几个快速衰减的模态 + 一点被压低了高频的碰撞声）
  const t1 = at(0.06);
  const clunk = new Float32Array(len);
  burst(clunk, sr, t1, 0.5, 0.0012, rnd);
  lowpass(clunk, sr, 2200);
  for (const [f, a, d] of [[150, 0.55, 0.035], [330, 0.45, 0.025], [760, 0.3, 0.018], [1450, 0.14, 0.01]]) mode(clunk, sr, t1, f * jit(0.04), a, d, rnd() * TAU);
  for (let i = 0; i < len; i++) x[i] += clunk[i];
  // 马达 + 齿轮：小直流马达的"呜——"（基音从 300 Hz 左右升到 400 Hz 出头，谐波很少，不是蜂鸣器那种锯齿），
  // 底下一层齿轮咬合的"咯咯"（带通噪声，按齿轮的节奏一下一下地起伏）
  const motor = new Float32Array(len);
  const m0 = at(0.1), m1 = at(0.62);
  let ph = 0, gp = 0;
  const f0 = 300 * jit(0.06), gear = 22 * jit(0.1);
  for (let i = m0; i < m1; i++) {
    const k = (i - m0) / (m1 - m0);
    ph += TAU * f0 * (1 + 0.38 * Math.min(1, k * 2.2)) / sr;
    gp += TAU * gear * (1 + 0.38 * Math.min(1, k * 2.2)) / sr;
    const whine = Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph);
    const tooth = Math.pow(0.5 + 0.5 * Math.sin(gp), 3); // 齿轮一齿一齿地咬上
    const env = Math.min(1, k / 0.12) * Math.min(1, (1 - k) / 0.3);
    motor[i] = env * (whine * 0.05 + (rnd() * 2 - 1) * (0.05 + 0.3 * tooth));
  }
  bandpass(motor, sr, 700, 0.55);
  for (let i = 0; i < len; i++) x[i] += motor[i];
  // 穿好带子，磁头鼓贴上去：再一下很轻的"嗒"
  const t2 = at(0.58);
  for (const [f, a, d] of [[420, 0.12, 0.015], [980, 0.07, 0.01]]) mode(x, sr, t2, f * jit(0.05), a, d, rnd() * TAU);
  lowpass(x, sr, 4200);
  highpass(x, sr, 70);
  const p = peakOf(x) || 1;
  for (let i = 0; i < len; i++) x[i] *= 0.7 / p;
  return x;
}
