import * as THREE from 'three';
import { sfx } from './sfx.js';

// 电话的转盘（bake_room.py 里的 PHONE_DIAL）：带十个指孔的那一圈单独拆出来，绕转盘平面的法线转。
// 老式转盘怎么拨一位数：手指伸进那个数字的孔，顺时针转到金属挡片，松手；弹簧带着转盘转回来，
// 里面的调速器让它匀速回转（每秒十格），回转时触点断开几下就是几（1 是一下，0 是十下），"嗒嗒嗒"的就是这个。
//   - 一格 30°，数字 n（0 算 10）要转 n + 1 格：孔和挡片之间还隔着一格空行程
//   - 手转得快、到挡片一顿；回转匀速，前一格空走，后面 n 格每格一声"嗒"，最后落回原位"咔"一下
//   - 拨之前听筒里是拨号音（350 + 440 赫兹，北美的），拨第一位时停
// start(digits) 开始拨，返回拨完要多少秒（电话据此接着响回铃）；stop() 半路挂断：松手，转盘照样匀速转回去，不响
const STEP = Math.PI / 6;
const SPEED = 10 * STEP;   // 回转：每秒十格
const HOLD = 0.1;          // 转到挡片停一下再松手
const GAP = 0.38;          // 两位之间手挪到下一个孔
const LEAD = 0.75;         // 拿起听筒到开始拨：先听一下拨号音
const easeIn = (k) => k * k;
const easeOut = (k) => 1 - (1 - k) ** 2;
const windTime = (n) => 0.2 + 0.035 * n;

export function createDial(room) {
  const W = room.manifest.phone?.wheel;
  if (!W) return null;
  const [t] = room.takeParts([W.mats]);
  if (!t) return null;
  const pivot = new THREE.Vector3().fromArray(W.c), axis = new THREE.Vector3().fromArray(W.n).normalize();
  const group = new THREE.Group();
  group.position.copy(pivot);
  room.scene.add(group);
  group.updateMatrixWorld(true);
  for (const m of t.parts) group.attach(m);
  t.group.removeFromParent();

  let segs = [], clock = 0, angle = 0;
  const q = new THREE.Quaternion();
  const set = (a) => { angle = a; group.quaternion.copy(q.setFromAxisAngle(axis, -a)); }; // 顺时针（从外面看）= 绕法线转负角

  // 一位数的动作：转上去（手）、停一下、匀速转回来（弹簧 + 调速器）
  function plan(digits) {
    const out = [];
    let at = LEAD;
    for (const d of digits) {
      const n = d === 0 ? 10 : d, top = (n + 1) * STEP, back = top / SPEED;
      out.push({ t0: at, t1: at + windTime(n), a0: 0, a1: top, ease: easeOut, n, kind: 'wind' });
      at += windTime(n) + HOLD;
      out.push({ t0: at, t1: at + back, a0: top, a1: 0, ease: (k) => k, n, kind: 'back' });
      at += back + GAP;
    }
    return { segs: out, total: at - GAP };
  }

  // 声音跟着画面一帧帧放（不提前排进 Web Audio）：半路挂断时后面的"嗒"就不响了
  function sounds(p) {
    sfx.tone(350, { dur: LEAD - 0.05, gain: 0.035, delay: 0.05 });
    sfx.tone(440, { dur: LEAD - 0.05, gain: 0.035, delay: 0.05 });
    const ev = [];
    for (const s of p.segs) {
      if (s.kind === 'wind') ev.push([s.t1, () => sfx.play('tick', { gain: 0.12, rate: 0.8 })]); // 手指碰到挡片
      else {
        for (let k = 1; k <= s.n; k++) ev.push([s.t0 + k / 10, () => sfx.play('tick', { gain: 0.2, rate: 1.45 })]); // 一格一声
        ev.push([s.t1, () => sfx.play('tick', { gain: 0.16, rate: 0.7 })]); // 落回原位
      }
    }
    return ev.sort((a, b) => a[0] - b[0]);
  }
  let events = [];

  return {
    group,
    get busy() { return segs.length > 0; },
    start(digits) {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
      const p = plan(digits);
      segs = p.segs;
      clock = 0;
      events = sounds(p);
      return p.total;
    },
    stop() {
      events = [];
      if (!segs.length) return;
      const back = angle / SPEED;
      segs = angle > 1e-3 ? [{ t0: clock, t1: clock + back, a0: angle, a1: 0, ease: (k) => k, n: 0, kind: 'back' }] : [];
    },
    update(dt) {
      if (!segs.length) return;
      clock += dt;
      while (events.length && clock >= events[0][0]) events.shift()[1]();
      while (segs.length && clock >= segs[0].t1) { set(segs[0].a1); segs.shift(); }
      const s = segs[0];
      if (!s) return;
      if (clock < s.t0) return; // 两位之间：停在原位
      const k = (clock - s.t0) / (s.t1 - s.t0);
      set(s.a0 + (s.a1 - s.a0) * s.ease(Math.min(1, k)));
    },
  };
}

// 拨几位：三位，加起来不超过 15 格，拨完三四秒（0 要转一大圈，好看，但别每次都拨一串 0）
export function someDigits() {
  for (;;) {
    const d = [0, 1, 2].map(() => Math.floor(Math.random() * 10));
    if (d.reduce((s, x) => s + (x || 10), 0) <= 15) return d;
  }
}
