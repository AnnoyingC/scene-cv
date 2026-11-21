import * as THREE from 'three';
import { sfx } from './sfx.js';

// 书桌上的木头万年历（bake_room.py 里的 DESKCAL）：两块数字方块、七棱的星期滚筒、三根四棱的月份条按材质拆出来，
// 转到今天的日期。方块 A 印着 0–5，方块 B 印着 0 1 2 6 7 8，9 就是倒过来的 6；哪块放左边看这一天要哪几个数字。
// 月份条：今天这个月所在的那根放到最上面（只有最上面那根露出来），转到这个月朝前。
// 光照是按烘焙时的摆法烘好的：转过以后，每个面改用烘焙时朝同一个方向的那个面的光（不然翻上来的底面是黑的）。
// 打开页面先显示烘焙时的日期，过一会儿自己拨到今天；点它会随手拨乱再拨回今天；过了零点自己翻。
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const BARS = ['bar2', 'bar1', 'bar3']; // 烘焙时从上到下
const v3 = (a) => new THREE.Vector3().fromArray(a);
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

export function createDeskCalendar(room) {
  const M = room.manifest.deskcal;
  if (!M) return null;
  const T = new THREE.Matrix4().fromArray(M.matrix);
  const qT = new THREE.Quaternion();
  T.decompose(new THREE.Vector3(), qT, new THREE.Vector3());
  const qTi = qT.clone().invert();
  const keys = Object.keys(M.pieces);
  const taken = room.takeParts(keys.map((k) => [M.pieces[k].mat]));
  const P = {};
  keys.forEach((k, i) => {
    const t = taken[i];
    if (!t) return;
    const src = M.pieces[k];
    const piece = { ...t, key: k, faces: src.faces.map((f) => ({ label: f.label, n: v3(f.n), up: v3(f.up) })),
      center: v3(src.center), pivot: v3(src.center).applyMatrix4(T), g0: t.group.position.clone(),
      from: null, to: null, t: 1, delay: 0, light: null };
    for (const m of t.parts) m.userData.deskCal = true;
    piece.light = lightTable(t.parts);
    P[k] = piece;
  });
  if (keys.some((k) => !P[k])) return null;

  // 烘焙时朝前的那几个面就是"正着摆"的样子：把要显示的面转到它们的位置
  const face = (k, label) => P[k].faces.find((f) => f.label === label);
  const TARGET = { cube: face('cubeA', '4'), roller: face('roller', 'TUE'), bar: face('bar2', 'JUL') };
  const SLOT = { cubeL: P.cubeB.center, cubeR: P.cubeA.center, roller: P.roller.center,
    bar0: P.bar2.center, bar1: P.bar1.center, bar2: P.bar3.center };

  // 世界里的转动：把 piece 的 f 面（flip：字倒过来）转到 target 面的朝向，挪到 slot
  const basis = (n, up) => new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, n), up, n);
  function pose(k, f, flip, target, slot) {
    const p = P[k];
    let ql = new THREE.Quaternion();
    if (f) {
      const up = flip ? f.up.clone().negate() : f.up;
      const R = basis(target.n, target.up).multiply(basis(f.n, up).transpose());
      ql = new THREE.Quaternion().setFromRotationMatrix(R);
    }
    const q = qT.clone().multiply(ql).multiply(qTi);
    const S = slot.clone().applyMatrix4(T);
    return { q, pos: S.add(p.g0.clone().sub(p.pivot).applyQuaternion(q)) };
  }

  function layout(date) {
    const d = date.getDate(), tens = Math.floor(d / 10), units = d % 10;
    const has = (k, n) => (n === 9 ? face(k, '6') : face(k, String(n)));
    const [L, R] = has('cubeA', tens) && has('cubeB', units) ? ['cubeA', 'cubeB'] : ['cubeB', 'cubeA'];
    const out = {
      [L]: pose(L, has(L, tens), tens === 9, TARGET.cube, SLOT.cubeL),
      [R]: pose(R, has(R, units), units === 9, TARGET.cube, SLOT.cubeR),
      roller: pose('roller', face('roller', DAYS[date.getDay()]), false, TARGET.roller, SLOT.roller),
    };
    const m = MONTHS[date.getMonth()];
    const top = BARS.find((b) => face(b, m));
    BARS.filter((b) => b !== top).forEach((b, i) => { out[b] = pose(b, null, false, null, SLOT['bar' + (i + 1)]); });
    out[top] = pose(top, face(top, m), false, TARGET.bar, SLOT.bar0);
    return out;
  }

  // 拨到某一天：各块错开一点先后，抬起来、转过去、落下
  const ORDER = ['bar2', 'bar1', 'bar3', 'roller', 'cubeB', 'cubeA'];
  function setDate(date, { instant = false, stagger = 0.09 } = {}) {
    const to = layout(date);
    ORDER.forEach((k, i) => {
      const p = P[k];
      p.from = { q: p.group.quaternion.clone(), pos: p.group.position.clone() };
      p.to = to[k];
      p.t = instant ? 1 : 0;
      p.delay = instant ? 0 : i * stagger;
      if (instant) apply(p, 1);
    });
  }
  const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  function apply(p, k) {
    const e = ease(k);
    p.group.quaternion.slerpQuaternions(p.from.q, p.to.q, e);
    p.group.position.lerpVectors(p.from.pos, p.to.pos, e).addScaledVector(UP, Math.sin(Math.PI * k) * 0.025);
    if (k >= 0.5 && p.lit !== p.to) { relight(p, p.to.q); p.lit = p.to; }
  }

  let queue = [];   // 点了以后：先拨到一个随便的日子，再拨回今天
  let wait = 1.4;   // 打开页面过一会儿再自己拨到今天
  let today = new Date().toDateString();
  setDate(new Date(2026, 6, 14), { instant: true }); // 烘焙时的样子：7 月 14 日星期二（把 from / to 先填好）
  queue.push(() => setDate(new Date()));

  function update(dt) {
    if (wait > 0) { wait -= dt; return; }
    let busy = false;
    for (const k of ORDER) {
      const p = P[k];
      if (p.t >= 1) continue;
      busy = true;
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.t = Math.min(1, p.t + dt / 0.55);
      apply(p, p.t);
      if (p.t >= 1) sfx.play('wood', { gain: 0.55 }); // 木块落回原位：咔哒一声
    }
    if (!busy && queue.length) { queue.shift()(); wait = queue.length ? 0.25 : 0; }
    if (!busy && !queue.length && new Date().toDateString() !== today) { today = new Date().toDateString(); setDate(new Date()); }
  }
  function shuffle() {
    if (queue.length || ORDER.some((k) => P[k].t < 1)) return;
    const r = new Date(2000 + Math.floor(Math.random() * 30), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28));
    queue = [() => setDate(r, { stagger: 0.05 }), () => setDate(new Date())];
  }
  const label = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return { groups: keys.map((k) => P[k].group), update, shuffle, label };
}

// 烘焙时每个三角形朝哪（世界坐标）、它在光照贴图上的位置（三个顶点 uv1 的中心）；按朝向归成几组
function lightTable(parts) {
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const m of parts) {
    if (m.geometry.index) m.geometry = m.geometry.toNonIndexed();
    const g = m.geometry, pos = g.attributes.position, uv = g.attributes.uv1 || g.attributes.uv;
    m.updateMatrixWorld(true);
    const tris = [], groups = [];
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, i + 1).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, i + 2).applyMatrix4(m.matrixWorld);
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
      const area = n.length();
      if (area < 1e-12) { tris.push(null); continue; }
      n.normalize();
      const u = (uv.getX(i) + uv.getX(i + 1) + uv.getX(i + 2)) / 3, v = (uv.getY(i) + uv.getY(i + 1) + uv.getY(i + 2)) / 3;
      let gr = groups.find((x) => x.n.dot(n) > 0.98);
      if (!gr) groups.push(gr = { n, u: 0, v: 0, w: 0 });
      gr.u += u * area; gr.v += v * area; gr.w += area;
      tris.push(n);
    }
    for (const gr of groups) { gr.u /= gr.w; gr.v /= gr.w; }
    out.push({ m, uv, tris, groups });
  }
  return out;
}

// 按组的朝向 q（相对烘焙时）重写 uv1：每个三角形转过去以后朝哪，就用烘焙时朝那边的那组面的光
function relight(p, q) {
  const n = new THREE.Vector3();
  for (const { uv, tris, groups } of p.light) {
    tris.forEach((t, j) => {
      if (!t) return;
      n.copy(t).applyQuaternion(q);
      let best = groups[0], bd = -2;
      for (const gr of groups) { const d = gr.n.dot(n); if (d > bd) { bd = d; best = gr; } }
      for (let k = 0; k < 3; k++) uv.setXY(j * 3 + k, best.u, best.v);
    });
    uv.needsUpdate = true;
  }
}
