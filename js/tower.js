// 3D 塔楼书房（烘焙光照版）。几何和光照由 Blender 预先算好（blender/bake_tower.py → assets/tower/），这里负责交互：
//   - 开场站在门口，正对一扇窄窄的尖拱窗，屋子中间是一只石头水盆。拖动转头，滚轮 / 双指缩放
//   - 水盆 = 作品：盆体常亮。水晶入水后荡开亮纹、升起光柱，乱码逐渐浮现，水面映出项目画面；
//     常亮蓝青色底光与项目色共同照亮屋子（复用烘焙好的"水盆"光照层）
//   - 壁炉上的水晶球 = 关于我：球里起雾，上方一个字一个字浮现介绍
//   - 书桌上的羊皮纸 = 联系方式；左墙书架 = 书单
//   - 点壁炉 / 蜡烛：熄火、生火（切的是光照层的系数）
//   - 棋盘上两枚棋子自己来回走；窗边两面挂旗随风摆动（js/tower-banners.js）
//   - #about #work #shelf #online 是真实 URL；页面底部的"素材致谢"是 #credits（和书桌房间同一个路由：镜头不动，只开面板）
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TV } from './tv.js';
import { paintParchment } from './paint.js';
import { BakedRoom, loadBaked, tvLight } from './baked.js';
import { waterMaterial, orbMaterial, flameMaterial, gemMaterial, OrbText, RIPPLES } from './magic.js';
import { BasinMagic } from './basin.js';
import { TowerBanners } from './tower-banners.js';
import { TowerCat } from './tower-cat.js';
import { PaperFire } from './paper-fire.js';

const BASE = new URL('../assets/tower/', import.meta.url).href;
const CREDITS = new URL('../assets/vendor/credits.json', import.meta.url).href;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = THREE.MathUtils.degToRad;
const ROUTES = ['about', 'work', 'shelf', 'online'];
const HINTS = { about: '水晶球 · 关于我', work: '水盆 · 作品', shelf: '书架 · 书单', online: '羊皮纸 · 联系方式' };
const BASIN_GAIN = 0.3; // 项目画面只给常亮的冥想盆底光添加一点染色。
// 绿火：烘焙好的壁炉光是橙色的（约 #ff8a3a），乘上这个系数就变成绿光（不是颜色本身，是对橙光的校正）
const FIRE_GREEN = new THREE.Color(0.2, 1.85, 1.9);
const EMBER_GREEN = new THREE.Color('#2dff6a');
const CAT_FIRE = new THREE.Color('#ffbb77'), CAT_GREEN = new THREE.Color('#5dff8c');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

export async function start(content, { nav = null } = {}) {
  const { tapes: projects, books = [], links } = content;
  const N = projects.length;
  $('room').hidden = false;
  const canvas = $('gl'), hintEl = $('hint'), backBtn = $('back'), panel = $('panel'), help = $('help'), loading = $('loading');
  const baseTitle = content.name || document.title;
  const TITLES = { home: baseTitle, about: `关于我 · ${baseTitle}`, work: `作品 · ${baseTitle}`, shelf: `书架 · ${baseTitle}`, online: `联系 · ${baseTitle}`, credits: `素材致谢 · ${baseTitle}` };

  // ---------- 渲染器 ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#06070b');
  const camera = new THREE.PerspectiveCamera(55, 1, 0.02, 120);
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(dpr);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.5, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------- 下载（显示进度） ----------
  const bar = loading?.querySelector('i'), pct = loading?.querySelector('b');
  const progress = (k) => {
    if (bar) bar.style.transform = `scaleX(${k})`;
    if (pct) pct.textContent = `${Math.floor(k * 100)}%`;
  };
  const data = await loadBaked(BASE, { glb: 'tower.glb', onProgress: (k) => progress(k * 0.95) });
  const room = new BakedRoom(data, { renderer, scene });
  const banners = new TowerBanners(room); // 窗边两面挂旗随风摆动（减少动态效果时静止）
  const M = data.manifest;
  const aniso = renderer.capabilities.getMaxAnisotropy();

  // ---------- 水面：TV 的画面（不要扫描线、屏幕字、雪花）----------
  const tv = new TV(512, 384, { scan: false, osd: false, noise: false, warmup: 0.7 });
  const W = M.screens.water;
  const water = new THREE.Mesh(new THREE.CircleGeometry(W.r, 72), waterMaterial(tv.texture));
  water.rotation.x = -Math.PI / 2;
  water.position.fromArray(W.pos);
  water.position.y += 0.002;
  water.userData.kind = 'work';
  scene.add(water);
  const WU = water.material.uniforms;
  const basinMagic = new BasinMagic(W);
  scene.add(basinMagic.group);
  const cat = await TowerCat.load(W, { scene, renderer, room }).catch((error) => { console.warn('知知暂时没能加载', error); return null; });
  if (cat) scene.add(cat.group);
  function startRitual(i) { basinMagic.trigger(projects[i].color); cat?.noticeBasin(); }
  const basinGlow = new THREE.Color('#83ddff');
  const basinStone = room.byMat.get('basin_stone') || [];
  let ripN = 0;
  function ripple(p, amp = 1) { // p：世界坐标
    const r = WU.rip.value[ripN++ % RIPPLES];
    r.set((p.x - W.pos[0]) / W.r, -(p.z - W.pos[2]) / W.r, WU.time.value, amp);
  }

  // ---------- 水晶球 + 上方的文字 ----------
  const O = M.screens.orb;
  const orb = new THREE.Mesh(new THREE.SphereGeometry(O.r, 48, 32), orbMaterial());
  orb.position.fromArray(O.pos);
  orb.userData.kind = 'about';
  orb.renderOrder = 2;
  scene.add(orb);
  const orbText = new OrbText(content);
  const textPlane = new THREE.Mesh(new THREE.PlaneGeometry(...O.text.size), new THREE.MeshBasicMaterial({
    map: orbText.texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  textPlane.position.fromArray(O.text.pos);
  textPlane.lookAt(textPlane.position.clone().add(new THREE.Vector3().fromArray(O.text.dir)));
  textPlane.userData.kind = 'about';
  textPlane.renderOrder = 3;
  textPlane.visible = false;
  scene.add(textPlane);

  // ---------- 羊皮纸：联系方式写在纸面上（贴花，光照照样用烘焙的）----------
  const noteTex = new THREE.CanvasTexture(paintParchment({ name: content.name, links }));
  noteTex.colorSpace = THREE.SRGBColorSpace;
  noteTex.anisotropy = aniso;
  const od = M.views.online.dir;
  const noteDecal = room.decal('parchment', noteTex, new THREE.Vector3(-od[0], 0, -od[2]).normalize()); // 纸的上方 = 背对镜头的方向

  // ---------- 壁炉的火苗：三片交叉的面 ----------
  const F = M.fire;
  const fire = new THREE.Group();
  fire.position.fromArray(F.pos);
  fire.lookAt(fire.position.clone().add(new THREE.Vector3().fromArray(F.dir)));
  const flames = [0, 0.7, -0.7].map((r, i) => {
    const g = new THREE.PlaneGeometry(F.w * (i ? 0.8 : 1), F.h * (i ? 0.85 : 1));
    g.translate(0, (F.h * (i ? 0.85 : 1)) / 2, 0);
    const m = new THREE.Mesh(g, flameMaterial(i * 1.37 + 0.2));
    m.rotation.y = r;
    m.position.z = -0.03 * Math.abs(r);
    m.renderOrder = 1;
    fire.add(m);
    return m;
  });
  scene.add(fire);
  // 绿火从炉口里窜出来：炉口前面两片往屋里倾斜的大火苗，平时不显示（揉纸投火时用）
  const flare = new THREE.Group();
  flare.position.copy(fire.position).addScaledVector(new THREE.Vector3().fromArray(F.dir).setY(0).normalize(), 0.12);
  flare.quaternion.copy(fire.quaternion);
  const flares = [-0.25, 0.25].map((r, i) => {
    const g = new THREE.PlaneGeometry(F.w * 1.5, F.h * 2.1);
    g.translate(0, (F.h * 2.1) / 2, 0);
    const m = new THREE.Mesh(g, flameMaterial(3.1 + i * 1.9));
    m.rotation.set(0.38, r, 0); // 往屋里（本地 +z）倾斜，上半截伸出炉口，挡不住
    m.renderOrder = 1;
    m.material.uniforms.green.value = 1;
    flare.add(m);
    return m;
  });
  flare.visible = false;
  scene.add(flare);

  // ---------- 揉纸投火：点联系方式的链接 → 纸揉成团扔进壁炉 → 绿火 → 跳转（js/paper-fire.js）----------
  const paperFire = noteDecal && new PaperFire({
    room, scene, decal: noteDecal, texture: noteTex, fire: F, viewDir: M.views.online.dir, host: document.body, // 绿光要盖住导航栏
  });
  const fireK = new THREE.Color();
  const embers = room.emitters.filter((e) => e.layer === 'fire').map((e) => ({ e, green: EMBER_GREEN.clone().multiplyScalar(e.power) }));

  // ---------- 水晶：从模型里拆出来，换成会发光的材质 ----------
  const WATER_Y = W.pos[1];
  const center = new THREE.Vector3().fromArray(W.pos);
  const gems = room.takeParts([...Array(M.gems.count)].map((_, i) => 'gem' + i)).map((g, i) => {
    if (!g) return null;
    if (i >= N) { g.group.visible = false; return null; } // HTML 里的作品比盆沿上的水晶少：多的藏起来
    const mat = gemMaterial(projects[i].color);
    for (const m of g.parts) { m.material = mat; m.userData.gem = i; }
    // 落点：水面上、偏向它原来那一侧一点点
    const land = center.clone().add(g.home.clone().sub(center).setY(0).normalize().multiplyScalar(W.r * 0.25));
    land.y = WATER_Y - 0.05;
    const ctrl = g.home.clone().lerp(land, 0.5);
    ctrl.y = WATER_Y + 0.42;
    return { ...g, i, mat, land, ctrl, state: 'rim', pull: 0, pullT: 0, glow: 0, spin: 0, splashed: false };
  });
  function placeGem(g, k) { // k：0 = 在盆沿上，1 = 沉进水里
    const u = 1 - k;
    g.group.position.copy(g.home).multiplyScalar(u * u).addScaledVector(g.ctrl, 2 * u * k).addScaledVector(g.land, k * k);
    g.group.rotation.y = g.spin + k * Math.PI * 3;
  }
  function splash(g) {
    if (g.splashed) return;
    g.splashed = true;
    ripple(g.group.position, 1);
    startRitual(g.i);
  }

  // ---------- 动画小工具 ----------
  const tweens = [];
  const tween = (obj, dur, fn, done) => tweens.push({ obj, t: 0, dur, fn, done });
  const cancelTweens = (obj) => { for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].obj === obj) tweens.splice(i, 1); };

  // ---------- 换项目：上一颗水晶从水里浮起回到盆沿 → 新的一颗飞起落进水里 → 水面浮现画面 ----------
  let loaded = null;
  function settle(i) { // 立刻回到盆沿
    const g = gems[i];
    if (!g) return;
    cancelTweens(g);
    g.state = 'rim';
    g.group.visible = true;
    placeGem(g, 0);
  }
  function sunk(i) {
    const g = gems[i];
    if (!g) return;
    cancelTweens(g);
    g.state = 'in';
    g.pull = g.pullT = 0;
    placeGem(g, 1);
    g.group.visible = false;
  }
  function dropGem(i, { animate = true } = {}) {
    if (!N) return;
    i = ((i % N) + N) % N;
    if (loaded === i && tv.state !== 'off') return;
    const prev = loaded;
    loaded = i;
    // 初次进入先看完整仪式；已经在看作品时，从当前构图平滑拉远。
    if (prev == null || view !== 'work') { workWide = 1; workReveal = null; }
    else workReveal = { from: workWide, t: 0 };
    basinMagic.reset();
    tv.stop();
    // 快速切换时取消上一轮的回收/投掷，旧的完成回调不能再投出另一颗。
    gems.forEach((g) => { if (g) cancelTweens(g); });
    gems.forEach((g, k) => { if (g && k !== prev && k !== i && g.state !== 'rim') settle(k); });
    const play = () => { if (loaded === i) { tv.play(projects[i]); renderPanel(); } };
    const drop = () => {
      const g = gems[i];
      if (!g || g.state === 'in') { startRitual(i); return play(); }
      if (!animate) { sunk(i); startRitual(i); return play(); }
      settle(i);
      g.state = 'flying';
      g.splashed = false;
      tween(g, 1.15, (k) => {
        placeGem(g, ease(k));
        if (g.group.position.y < WATER_Y + 0.01) splash(g);
      }, () => { splash(g); sunk(i); play(); });
    };
    const p = prev != null && prev !== i ? gems[prev] : null;
    if (p && p.state === 'in' && animate) {
      p.state = 'flying';
      p.group.visible = true;
      ripple(p.land, 0.6);
      tween(p, 0.85, (k) => placeGem(p, 1 - ease(k)), () => { settle(prev); drop(); });
    } else {
      if (p) settle(prev);
      drop();
    }
    renderPanel();
  }
  const cmd = (c) => dropGem((loaded ?? 0) + (c === 'next' ? 1 : -1));

  // ---------- 棋盘：两枚棋子来回走（8 秒一轮：兵往前拱一格再退回来，马跳过去再跳回来）----------
  const chess = room.takeParts((M.chess || []).map((c) => c.mat)).map((g, i) => g && { ...g, ...M.chess[i], d: new THREE.Vector3().fromArray(M.chess[i].delta) }).filter(Boolean);
  function moveChess(t) {
    const s = t % 8;
    for (const [i, c] of chess.entries()) {
      const a = i === 0 ? 0 : 2, dur = i === 0 ? 0.8 : 1.0; // 兵在 0 秒、4 秒走；马在 2 秒、6 秒跳
      const k = smooth(a, a + dur, s) - smooth(a + 4, a + 4 + dur, s);
      const ph = s >= a && s <= a + dur ? (s - a) / dur : s >= a + 4 && s <= a + 4 + dur ? (s - a - 4) / dur : 0;
      c.group.position.copy(c.home).addScaledVector(c.d, k);
      c.group.position.y += c.hop * Math.sin(Math.PI * ph);
    }
  }

  // ---------- 火光、烛光 ----------
  const light = { fire: 1, fireT: 1, candles: 1, candlesT: 1, basin: 0 };
  const basinColor = new THREE.Color(), runeColor = new THREE.Color(), projColor = basinGlow.clone();
  const runes = room.emitters.filter((e) => e.layer === 'basin');
  const flick = (t, s) => 0.5 + 0.5 * (Math.sin(t * 7.1 + s) * 0.5 + Math.sin(t * 13.3 + s * 2) * 0.3 + Math.sin(t * 2.3 + s * 3) * 0.2);

  // ---------- 镜头 ----------
  const C = M.camera;
  const homePos = new THREE.Vector3().fromArray(C.pos);
  const look = { yaw: C.yaw, pitch: C.pitch, fov: C.fov, yawT: C.yaw, pitchT: C.pitch, fovT: C.fov };
  const par = new THREE.Vector2(), parT = new THREE.Vector2();
  const pose = () => ({ pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: 55 });
  const cur = pose(), goal = pose(), ritualPose = pose();
  let workWide = 0;
  let workReveal = null;
  let fly = null;
  let shot = null; // 过场镜头（揉纸投火）：{ target, size, dir }，有它时不管当前视角
  function cut(s, dur) {
    shot = s;
    if (!s) return startFly(); // 过场结束：回到当前视角
    fly = { from: { pos: cur.pos.clone(), yaw: cur.yaw, pitch: cur.pitch, fov: cur.fov }, t: 0, dur };
  }
  const right = new THREE.Vector3(), up = new THREE.Vector3(), dirV = new THREE.Vector3();
  function basis(yaw, pitch) {
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    up.set(Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), Math.sin(pitch) * Math.cos(yaw));
  }
  function homePose(out) {
    out.pos.copy(homePos);
    out.yaw = look.yaw;
    out.pitch = look.pitch + Math.max(0, 0.2 * (1 - camera.aspect));
    const minV = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(deg(31)) / camera.aspect));
    out.fov = Math.min(95, Math.max(look.fov, (minV * look.fov) / 55));
    return out;
  }
  function covered() { // 面板挡住了多少像素：宽屏在右边，窄屏在下面。"关于我"的面板只是右下角一行提示，宽屏时不让位；top 是顶部导航栏
    const top = nav?.height() ?? 0;
    if (panel.hidden || (view === 'about' && innerWidth > 600)) return { w: 0, h: 0, top };
    const r = panel.getBoundingClientRect();
    return innerWidth > 600 ? { w: innerWidth - r.left + 16, h: 0, top } : { w: 0, h: innerHeight - r.top + 12, top };
  }
  function focusPose(name, out) {
    framePose(M.views[name], out);
    if (name !== 'work' || workWide === 0) return out;
    // 光柱阶段看全景；消散时回到 manifest 里原来的盆内画面近景。
    framePose({
      target: [W.pos[0], W.pos[1] + basinMagic.height * 0.4, W.pos[2]],
      size: [W.r * 1.65, basinMagic.height * (innerWidth <= 600 ? 0.74 : 0.65)], dir: [0, 0.38, 0.925],
    }, ritualPose);
    out.pos.lerp(ritualPose.pos, workWide);
    out.yaw += angle(ritualPose.yaw - out.yaw) * workWide;
    out.pitch += (ritualPose.pitch - out.pitch) * workWide;
    return out;
  }
  function framePose(v, out) {
    const fov = camera.aspect < 0.8 ? 60 : 44;
    const tv_ = Math.tan(deg(fov / 2)), th = tv_ * camera.aspect;
    const cv = covered(), fw = Math.max(0.35, 1 - cv.w / innerWidth), fh = Math.max(0.35, 1 - (cv.h + cv.top) / innerHeight);
    const dist = Math.max(v.size[0] / (th * fw), v.size[1] / (tv_ * fh)) * 1.15;
    dirV.fromArray(v.dir).normalize();
    out.yaw = Math.atan2(dirV.x, dirV.z);
    out.pitch = Math.asin(-dirV.y);
    out.fov = fov;
    out.pos.fromArray(v.target).addScaledVector(dirV, dist);
    basis(out.yaw, out.pitch);
    out.pos.addScaledVector(right, (dist * th * cv.w) / innerWidth);
    out.pitch -= Math.atan((tv_ * (cv.h - cv.top)) / innerHeight); // 面板在下面：低头；导航栏在上面：抬头
    return out;
  }
  function startFly() {
    const from = { pos: cur.pos.clone(), yaw: cur.yaw, pitch: cur.pitch, fov: cur.fov };
    const d = from.pos.distanceTo((overview() ? homePose(pose()) : focusPose(view, pose())).pos);
    fly = { from, t: 0, dur: clamp(0.9 + d * 0.25, 1, 1.7) };
  }
  function updateCamera(dt) {
    const framing = gems.some((g) => g?.state === 'flying') ? 1 : basinMagic.framing;
    if (workReveal) {
      workReveal.t = Math.min(1, workReveal.t + dt / 1.15);
      workWide = workReveal.from + (1 - workReveal.from) * ease(workReveal.t);
      if (workReveal.t === 1) workReveal = null;
    } else {
      workWide += (framing - workWide) * (1 - Math.exp(-dt * 5));
      if (Math.abs(workWide - framing) < 0.0001) workWide = framing;
    }
    const a = 1 - Math.exp(-dt * 8);
    look.yaw += (look.yawT - look.yaw) * a;
    look.pitch += (look.pitchT - look.pitch) * a;
    look.fov += (look.fovT - look.fov) * a;
    par.lerp(parT, 1 - Math.exp(-dt * 3));
    if (shot) framePose(shot, goal); else if (overview()) homePose(goal); else focusPose(view, goal);
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / fly.dur);
      const e = ease(fly.t), f = fly.from;
      cur.pos.lerpVectors(f.pos, goal.pos, e);
      cur.yaw = f.yaw + angle(goal.yaw - f.yaw) * e;
      cur.pitch = f.pitch + (goal.pitch - f.pitch) * e;
      cur.fov = f.fov + (goal.fov - f.fov) * e;
      if (fly.t >= 1) fly = null;
    } else {
      cur.pos.copy(goal.pos);
      Object.assign(cur, { yaw: goal.yaw, pitch: goal.pitch, fov: goal.fov });
    }
    basis(cur.yaw, cur.pitch);
    const k = overview() ? 0.05 : 0.008;
    camera.position.copy(cur.pos).addScaledVector(right, par.x * k).addScaledVector(up, -par.y * k * 0.5);
    camera.rotation.set(cur.pitch, cur.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - cur.fov) > 1e-3) { camera.fov = cur.fov; camera.updateProjectionMatrix(); }
  }
  const zoom = (d) => { look.fovT = clamp(look.fovT + d, 28, 70); };
  function clampLook() {
    look.yawT = clamp(look.yawT, ...C.yawRange);
    look.pitchT = clamp(look.pitchT, ...C.pitchRange);
  }

  // ---------- 路由 ----------
  let view = null, credits = null; // credits：致谢列表的 HTML（第一次打开时读 credits.json，之后复用）
  const viewFromHash = () => { const h = location.hash.slice(1); return h === 'credits' || (ROUTES.includes(h) && M.views?.[h]) ? h : 'home'; };
  function overview() { return view === 'home' || view === 'credits'; } // 致谢只是开个面板，镜头还是开场的样子
  function go(name) {
    const url = name === 'home' ? location.pathname + location.search : '#' + name;
    if ((location.hash.slice(1) || 'home') !== name) history.pushState(null, '', url);
    setView(name);
  }
  function setView(name, instant = false) {
    if (name === view) return;
    if (paperFire?.busy) paperFire.cancel(); // 过场中途去了别的地方：纸回到桌上
    const first = view === null;
    view = name;
    if (name === 'credits') loadCredits();
    orbText.setActive(name === 'about');
    if (name === 'work' && loaded == null) dropGem(0, { animate: !instant });
    setHover(null);
    backBtn.hidden = name === 'home';
    help.hidden = name !== 'home';
    document.title = TITLES[name];
    nav?.setActive(name === 'home' ? null : name);
    renderPanel();
    if (instant || first) fly = null;
    else startFly();
  }
  addEventListener('popstate', () => setView(viewFromHash()));

  // ---------- HTML 面板 ----------
  function renderPanel() {
    let html = '';
    if (view === 'credits') {
      html = credits || '<div class="kicker">素材致谢</div><p>正在读取素材清单…</p>';
    } else if (view === 'work') {
      const t = loaded != null ? projects[loaded] : null;
      html = t
        ? `<div class="kicker">水晶 ${loaded + 1} / ${N}</div>
           <h2>${esc(t.title)}</h2><div class="meta">${esc(t.years)}</div>
           <p>${esc(t.desc)}</p>
           <div class="ctl">
             <button type="button" data-cmd="prev" aria-label="上一个项目">◀</button>
             <button type="button" data-cmd="next" aria-label="下一个项目">▶</button>
             ${t.url ? `<a class="go" href="${esc(t.url)}" target="_blank" rel="noopener">打开项目 →</a>` : ''}
           </div>
           <p class="tip">点盆沿上的水晶换一个项目。</p>`
        : '<h2>水盆</h2><p>还没有项目。</p>';
    } else if (view === 'about') {
      html = `<div class="kicker">关于我</div>
        <p>文字正浮现在水晶球上方。滚轮或 ↑↓ 翻页，点一下直接显示全部。</p>
        <a href="?plain=1#about">阅读纯文字版 →</a>`;
    } else if (view === 'shelf') {
      html = `<div class="kicker">书架</div><h2>在读 / 推荐</h2>
        ${books.length ? `<ul class="list">${books.map((b) => `<li>${b.url
          ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.title)} <span>${esc(b.author)}</span></a>`
          : `<div class="row">${esc(b.title)} <span>${esc(b.author)}</span></div>`}${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}</li>`).join('')}</ul>` : '<p>书架上还没有书。</p>'}`;
    } else if (view === 'online') {
      html = `<div class="kicker">联系</div>
        <ul class="list">${links.map((l, i) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener" data-link="${i}">${esc(l.label)} <span>${esc(l.handle)}</span></a></li>`).join('')}</ul>`;
    }
    panel.innerHTML = html;
    panel.hidden = !html;
    panel.classList.toggle('credits', view === 'credits');
    help.hidden = view !== 'home';
  }
  // 点联系方式：先演揉纸投火，再在本页跳过去（等几秒再开新标签页会被浏览器当成弹窗拦掉）。
  // 按住 ⌘ / Ctrl / Shift、中键、或者系统设置了减少动态效果：照常在新标签页打开。
  function burnLink(i) {
    const l = links[i];
    if (!paperFire || !l?.url || paperFire.busy) return false;
    setHover(null);
    panel.hidden = true;
    help.hidden = true;
    paperFire.start(l, {
      onCamera: cut,
      onImpact: () => { light.fireT = 1; }, // 火灭着也会被纸团点着
      onDone: (url) => location.assign(url),
      onCancel: () => renderPanel(),
    });
    return true;
  }
  addEventListener('pageshow', (e) => { // 从目标网站按后退回来（页面从缓存里恢复）：纸回到桌上
    if (e.persisted && paperFire?.busy) paperFire.cancel();
  });
  panel.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (a) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || REDUCED.matches) return;
      if (burnLink(Number(a.dataset.link))) e.preventDefault();
      return;
    }
    const b = e.target.closest('button');
    if (b?.dataset.cmd === 'close') go('home');
    else if (b?.dataset.cmd) cmd(b.dataset.cmd);
  });
  backBtn.addEventListener('click', () => go('home'));

  // ---------- 素材致谢：manifest.vendor 里用到的素材，信息来自 assets/vendor/credits.json ----------
  const creditLink = document.createElement('a');
  creditLink.href = '#credits';
  creditLink.textContent = '素材致谢';
  help.append(' · ', creditLink);
  creditLink.addEventListener('click', (e) => { e.preventDefault(); go('credits'); });
  async function loadCredits() {
    if (credits) return;
    let list = [];
    try { list = (await fetch(CREDITS).then((r) => r.json())).assets; } catch { /* 读不到就只显示说明 */ }
    const used = new Set(M.vendor || []);
    const rows = list.filter((a) => used.has(a.id)).map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">
      <b>${esc(a.zh || a.title)}</b><span>${esc(a.title)} · ${esc((a.authors || []).join('、'))} · ${esc(a.license)}</span></a></li>`).join('');
    credits = `<div class="kicker">素材致谢</div><h2>家具、灯和小物件</h2>
      <p>家具来自 Poly Haven。知知的三维网格、骨骼与动作以桌宠形象为参考重新制作；墙、地板、水盆、书桌和其余小物件也是原创的。</p>
      <ul class="list">${rows}</ul>
      <div class="ctl"><button type="button" data-cmd="close">关闭</button></div>`;
    if (view === 'credits') renderPanel();
  }

  // ---------- 拾取 ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pickables = [room.root, water, orb, textPlane, ...gems.filter(Boolean).map((g) => g.group), ...(cat ? [cat.group] : [])];
  const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  function pick(x, y) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(pickables, true)) {
      if (!shown(hit.object)) continue;
      const gi = hit.object.userData.gem;
      if (gi != null) return { kind: 'gem', key: 'gem' + gi, i: gi };
      const k = hit.object.userData.kind;
      if (k) return { kind: k, key: k };
      const name = room.hotspotAt(hit.point);
      return name ? { kind: name, key: name } : null;
    }
    return null;
  }
  function hintText(h) {
    if (h.kind === 'pet') return '知知 · 打个招呼';
    if (h.kind === 'gem') return `◆ ${projects[h.i].title}`;
    if (h.kind === 'fire') return light.fireT ? '壁炉 · 熄火' : '壁炉 · 生火';
    if (h.kind === 'candles') return light.candlesT ? '蜡烛 · 熄灭' : '蜡烛 · 点亮';
    if (h.kind === 'about' && view === 'about') return orbText.typed < orbText.total ? '点一下显示全部' : '';
    return HINTS[h.kind] || '';
  }
  let hover = null;
  function setHover(h, x, y) {
    if (h && h.kind === view && view !== 'about') h = null;
    if (paperFire?.busy) h = null;
    if (h?.key !== hover?.key) {
      if (hover?.kind === 'gem' && gems[hover.i]) gems[hover.i].pullT = 0;
      hover = h;
      if (h?.kind === 'gem') { if (gems[h.i]?.state === 'rim') gems[h.i].pullT = 1; }
      else if (h) room.highlight(h.kind);
      canvas.style.cursor = h ? 'pointer' : view === 'home' ? 'grab' : 'default';
    }
    const text = h && x != null ? hintText(h) : ''; // 导航栏悬停时只高亮物件，不显示提示
    if (text) {
      hintEl.textContent = text;
      hintEl.style.left = x + 'px';
      hintEl.style.top = y + 'px';
      hintEl.classList.add('show');
    } else hintEl.classList.remove('show');
  }
  function click(x, y, mouse) {
    if (paperFire?.busy) return paperFire.skip(); // 过场里点一下：直接跳
    const h = pick(x, y), before = view;
    if (!h) { if (view !== 'home') go('home'); return; }
    if (h.kind === 'gem') { dropGem(h.i); go('work'); }
    else if (h.kind === 'pet') cat?.pet();
    else if (h.kind === 'fire') light.fireT = light.fireT ? 0 : 1;
    else if (h.kind === 'candles') light.candlesT = light.candlesT ? 0 : 1;
    else if (h.kind === 'about' && view === 'about') orbText.finish();
    else if (h.kind !== view) go(h.kind);
    if (mouse && view === before) setHover(pick(x, y), x, y); // 镜头要飞走时不再显示提示
  }

  // ---------- 鼠标 / 触摸 ----------
  const ptrs = new Map();
  let down = null, dragging = false, pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (ptrs.size === 1) { down = { x: e.clientX, y: e.clientY }; dragging = false; } else down = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    const mouse = e.pointerType === 'mouse';
    if (mouse) parT.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    const p = ptrs.get(e.pointerId);
    if (!p) { if (mouse) setHover(pick(e.clientX, e.clientY), e.clientX, e.clientY); return; }
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch && view === 'home') zoom((before - after) * 0.08);
      pinch = 1;
      return;
    }
    if (down && !dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
      dragging = true;
      setHover(null);
      if (view === 'home') canvas.style.cursor = 'grabbing';
    }
    if (dragging && view === 'home') {
      const k = (look.fov / 55) * 0.0042 * (mouse ? 1 : 1.4);
      look.yawT += (e.clientX - p.x) * k;
      look.pitchT += (e.clientY - p.y) * k;
      clampLook();
    }
    p.x = e.clientX; p.y = e.clientY;
  });
  const release = (e) => {
    const mine = ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = 0;
    if (mine && e.type === 'pointerup' && down && !dragging && !ptrs.size) click(e.clientX, e.clientY, e.pointerType === 'mouse');
    if (!ptrs.size) { down = null; dragging = false; }
    canvas.style.cursor = hover ? 'pointer' : view === 'home' ? 'grab' : 'default';
    if (e.pointerType !== 'mouse') hintEl.classList.remove('show');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    parT.set(0, 0);
    if (!ptrs.size) setHover(null);
  });
  let wheelAcc = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (view === 'home') zoom(e.deltaY * 0.02);
    else if (view === 'about') {
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      while (Math.abs(wheelAcc) >= 40) { orbText.scrollBy(Math.sign(wheelAcc)); wheelAcc -= Math.sign(wheelAcc) * 40; }
    }
  }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (paperFire?.busy) { paperFire.cancel(); return; } // 取消过场，纸回到桌上
      if (view !== 'home') go('home');
      return;
    }
    if (e.target.closest?.('button,a,input,textarea') && !e.target.closest('#topbar')) return; // 点过导航栏以后方向键照常换项目
    if (view === 'work' && e.key === 'ArrowRight') cmd('next');
    else if (view === 'work' && e.key === 'ArrowLeft') cmd('prev');
    else if (view === 'about' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); orbText.scrollBy(e.key === 'ArrowDown' ? 2 : -2); }
  });

  // ---------- 尺寸 ----------
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();
  // 开场保留所有水晶在盆沿；第一次点击也会完整经历投掷和光柱。
  setView(viewFromHash(), true);
  // 顶部导航栏：点一项和点对应的物件走同一个 go()；悬停时高亮那个物件
  nav?.bind({
    go, routes: ROUTES.filter((r) => M.views?.[r]), current: () => view,
    preview: (kind) => setHover(kind && kind !== view ? { kind, key: kind } : null),
  });

  // ---------- 每帧 ----------
  let simT = 0;
  function tick(dt, render = true) {
    const t = (simT += dt);
    for (const tw of [...tweens]) {
      if (!tweens.includes(tw)) continue;
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.fn(k);
      if (k >= 1) { tweens.splice(tweens.indexOf(tw), 1); tw.done?.(); }
    }
    const s = 1 - Math.exp(-dt * 6);
    light.fire += (light.fireT - light.fire) * s;
    light.candles += (light.candlesT - light.candles) * s;
    light.basin += ((tv.state === 'playing' ? 1 : 0) - light.basin) * (1 - Math.exp(-dt * 2.5));
    tv.update(t, dt);
    orbText.update(t, dt);
    basinMagic.update(t, dt);
    banners.update(t);

    // 提亮现有月光与分布在四周的灯；盆的底光始终存在，换片/黑画面时也不会熄灭。
    const fx = paperFire ? paperFire.update(dt, camera, renderer.domElement.height, light.fire) : { green: 0, boost: 0, flash: 0 };
    const fireLv = light.fire * (0.82 + 0.18 * flick(t, 0)) * (1 + 0.55 * fx.boost + 0.45 * fx.flash); // 纸团进火：火一下子旺起来
    const candleLv = light.candles * (0.94 + 0.06 * flick(t * 1.3, 2));
    tvLight(tv.color, basinColor).multiplyScalar(BASIN_GAIN * light.basin);
    const breath = 1 + 0.06 * Math.sin(t * 1.2);
    runeColor.copy(basinGlow).multiplyScalar(2.6 * breath + basinMagic.power * 1.2 + basinMagic.flash * 1.8);
    basinColor.add(runeColor);
    fireK.setRGB(1, 1, 1).lerp(FIRE_GREEN, fx.green).multiplyScalar(fireLv * 1.2);
    room.setLevels({ ambient: 2.2, candles: candleLv * 1.6, fire: fireK, basin: basinColor });
    for (const { e, green } of embers) e.mat.color.copy(e.base).lerp(green, fx.green).multiplyScalar(Math.max(fireLv * 1.2, 0.02)); // 光照层传的是颜色时，炭火保留自己的底色
    if (loaded != null) projColor.set(projects[loaded].color);
    runeColor.copy(basinGlow).lerp(projColor, 0.15).multiplyScalar(2.1 * breath + basinMagic.power + basinMagic.flash);
    for (const e of runes) e.mat.color.copy(runeColor);
    for (const m of basinStone) m.material.uniforms.emissive.value.copy(basinGlow).multiplyScalar(0.055 * breath + basinMagic.flash * 0.045);
    room.U.hiK.value += ((hover && hover.kind !== 'gem' ? 1 : 0) - room.U.hiK.value) * (1 - Math.exp(-dt * 14));

    WU.time.value = t;
    WU.level.value = 0.25 + 0.75 * light.basin;
    WU.tint.value.copy(projColor);
    WU.glow.value = breath;
    WU.pulse.value = basinMagic.flash;
    WU.hover.value += ((hover?.kind === 'work' ? 1 : 0) - WU.hover.value) * s;
    const ou = orb.material.uniforms;
    ou.time.value = t;
    ou.focus.value += ((view === 'about' ? 1 : 0) - ou.focus.value) * s;
    ou.hover.value += ((hover?.kind === 'about' ? 1 : 0) - ou.hover.value) * s;
    textPlane.visible = orbText.fade > 0.01;
    for (const f of flames) { f.material.uniforms.time.value = t; f.material.uniforms.level.value = fireLv; f.material.uniforms.green.value = fx.green; }
    fire.visible = light.fire > 0.01;
    fire.scale.set(1 + 0.3 * fx.boost, 1 + 0.8 * fx.boost + 0.4 * fx.flash, 1);
    const flareLv = fx.green * (0.55 * fx.boost + 0.8 * fx.flash);
    flare.visible = flareLv > 0.01;
    for (const f of flares) { f.material.uniforms.time.value = t; f.material.uniforms.level.value = flareLv; }
    flare.scale.set(1, 0.7 + 0.5 * fx.boost + 0.5 * fx.flash, 1);

    for (const g of gems) {
      if (!g) continue;
      g.pull += (g.pullT - g.pull) * (1 - Math.exp(-dt * 12));
      g.glow += ((g.pullT ? 1 : g.i === loaded ? 0.6 : 0) - g.glow) * s;
      g.mat.uniforms.glow.value = g.glow;
      g.mat.uniforms.light.value = 0.4 + 0.6 * Math.max(light.candles, light.fire);
      if (g.state === 'rim') {
        g.spin += dt * 0.4;
        placeGem(g, 0);
        g.group.position.y += g.pull * 0.035;
      }
    }
    moveChess(t);
    updateCamera(dt);
    camera.updateMatrixWorld();
    cat?.fire.color.copy(CAT_FIRE).lerp(CAT_GREEN, fx.green);
    cat?.update(t, dt, { camera, view: overview() ? 'home' : view, fire: fireLv, candles: candleLv, basin: 0.5 + basinMagic.power });
    if (render) composer.render(dt);
  }

  const clock = new THREE.Clock();
  let frames = 0, slow = 0;
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    tick(dt);
    if (frames === 0) { progress(1); loading?.classList.add('done'); setTimeout(() => loading?.remove(), 800); }
    if (frames < 150 && ++frames > 30) {
      slow += dt;
      if (frames === 150 && slow / 120 > 1 / 28) {
        if (dpr > 1) { dpr = 1; renderer.setPixelRatio(1); composer.setPixelRatio(1); resize(); frames = 1; slow = 0; }
        else bloom.enabled = false;
      }
    }
  }
  renderer.setAnimationLoop(frame);

  window.__room = {
    go, dropGem, cmd, tick, pick, look, light, camera, renderer, composer, room, tv, orbText, gems, chess, water, orb, basinMagic, banners, cat, paperFire, burnLink,
    get view() { return view; }, get loaded() { return loaded; }, get hover() { return hover; },
    hoverAt: (x, y) => setHover(pick(x, y), x, y), clickAt: (x, y) => click(x, y, true),
  };
}
