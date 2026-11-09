// 3D 房间（烘焙光照版）。几何和光照由 Blender 预先算好（blender/bake_room.py → assets/baked/），这里负责交互：
//   - 开场镜头绕着书桌上的电脑转：拖动换角度（往左拖看到书架、往右拖看到唱机和软木板），滚轮 / 双指拉近拉远
//   - 点物件 → 镜头飞过去：电脑 = 关于我，电视和录像带 = 作品，书架 = 书单，记事本 = 联系
//     #about #work #shelf #online 都是真实 URL，可以分享，浏览器后退键可用；#credits 是素材致谢（镜头不动，只开面板）
//   - 点桌上的录像带：它飞进录像机，电视播放对应的画面模块；电视画面的颜色实时染色房间
//   - 点台灯 / 落地灯开关灯（切的是烘焙好的光照层的系数，不重新算光）
//   - 悬停高亮：热点盒子来自 manifest，着色器把盒子里的像素提亮
//   - 墙上的撕页日历显示今天的日期（js/calendar.js 画纸页）
//   - Bloom 辉光 + 整体滤镜（js/grade.js：?look=名字 选预设，?looks 显示切换按钮）；帧率太低自动降分辨率
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TV } from './tv.js';
import { PCScreen } from './pc.js';
import { paintNote } from './paint.js';
import { paintCalendar } from './calendar.js';
import { BakedRoom, loadBaked, tvLight } from './baked.js';
import { GradePass, lookPicker } from './grade.js';
import { createTurntable } from './turntable.js';

const BASE = new URL('../assets/baked/', import.meta.url).href;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = THREE.MathUtils.degToRad;
const ROUTES = ['about', 'work', 'shelf', 'online'];
const HINTS = { about: '电脑 · 关于我', work: '电视 · 作品', shelf: '书架 · 书单', online: '记事本 · 联系方式' };

export async function start(content, { nav = null, music = null } = {}) {
  const { tapes, books = [], links } = content;
  const N = tapes.length;
  $('room').hidden = false;
  const canvas = $('gl'), hintEl = $('hint'), backBtn = $('back'), panel = $('panel'), help = $('help'), loading = $('loading');
  const baseTitle = content.name || document.title;
  const TITLES = { home: baseTitle, about: `关于我 · ${baseTitle}`, work: `作品 · ${baseTitle}`, shelf: `书架 · ${baseTitle}`, online: `联系 · ${baseTitle}`, credits: `致谢 · ${baseTitle}` };

  // ---------- 渲染器 ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#07080c');
  const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 120);
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(dpr);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.5, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new GradePass({ renderer, bloom }); // 滤镜接在 OutputPass 后面（处理的是 sRGB 画面）
  composer.addPass(grade);
  const qs = new URLSearchParams(location.search);
  grade.set(qs.get('look') || 'film');
  if (qs.has('looks')) lookPicker(grade, (k) => grade.set(k));

  // ---------- 下载（约 6 MB，显示进度） ----------
  // 下载占进度条的 95%，剩下 5% 是解析模型、编译着色器（这一步会卡住主线程一小会儿），第一帧画出来才算 100%
  const bar = loading?.querySelector('i'), pct = loading?.querySelector('b');
  const progress = (k) => {
    if (bar) bar.style.transform = `scaleX(${k})`;
    if (pct) pct.textContent = `${Math.floor(k * 100)}%`;
  };
  const data = await loadBaked(BASE, { onProgress: (k) => progress(k * 0.95) });
  const room = new BakedRoom(data, { renderer, scene });
  const M = data.manifest;
  const turntable = createTurntable(room, music?.track);

  // ---------- 实时画的东西：电视、电脑屏幕、记事本纸面 ----------
  const tv = new TV();
  const pc = new PCScreen(content);
  const screens = [room.screen('tv', tv.texture), room.screen('pc', pc.texture)];
  // 显像管是鼓的（电脑的还往后仰）：按 manifest 里量好的玻璃深度网格把平面弯成玻璃的形状，再往外 1 毫米。
  // 电视在推车上斜着放：平面绕 Y 轴转 rot（深度是沿屏幕自己的 z 量的，转完正好贴着玻璃）
  for (const [m, s] of [[screens[0], M.screens.tv], [screens[1], M.screens.pc]]) {
    m.rotation.y = s.rot || 0;
    if (!s.depth) continue;
    const g = new THREE.PlaneGeometry(...s.size, ...s.grid); // 顶点顺序：从上一行开始，每行从左到右，和 depth 一样
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, s.depth[i] + 0.001);
    m.geometry.dispose();
    m.geometry = g;
  }
  const noteTex = new THREE.CanvasTexture(paintNote({ name: content.name, links }));
  noteTex.colorSpace = THREE.SRGBColorSpace;
  noteTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  room.decal('notepad', noteTex);
  // 墙上的撕页日历：纸页换成今天的日期（页面一直开着的话，过了零点自己翻一页）
  if (M.calendar) {
    const calTex = new THREE.CanvasTexture(paintCalendar());
    calTex.colorSpace = THREE.SRGBColorSpace;
    calTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    for (const m of room.byMat.get(M.calendar.page) || []) m.material.uniforms.albedoMap.value = calTex;
    let today = new Date().toDateString();
    setInterval(() => {
      if (new Date().toDateString() === today) return;
      today = new Date().toDateString();
      paintCalendar(new Date(), calTex.image);
      calTex.needsUpdate = true;
    }, 60_000);
  }

  // ---------- 录像带：从房间里拆出来，可以单独移动 ----------
  // 录像机跟着电视推车绕 Y 轴转了 yaw：它的正前方是 vcrFwd，带子平躺以后也跟着转同样的角度
  const slot = new THREE.Vector3().fromArray(M.tapes.slot), vcrYaw = M.tapes.yaw || 0;
  const vcrFwd = new THREE.Vector3(Math.sin(vcrYaw), 0, Math.cos(vcrYaw));
  const FLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, vcrYaw, Math.PI / 2, 'YXZ')); // 平躺，侧标仍然朝外
  const P1 = slot.clone().addScaledVector(vcrFwd, 0.13); // 录像机口前面
  const P2 = slot.clone().addScaledVector(vcrFwd, -0.11); // 整盘推进去
  const phys = room.takeTapes().map((t, i) => {
    if (i >= N) { t.group.visible = false; return null; } // HTML 里的作品比架子上的带子少：多的藏起来
    t.label?.material.uniforms.albedo.value.set(tapes[i].color); // 侧标颜色跟 HTML 的 data-color 走
    for (const m of t.parts) m.userData.tape = i;
    const home = { pos: t.group.position.clone(), quat: t.group.quaternion.clone() };
    // 飞行路线：先往上拔出来，往右前方绕到录像机口前面，再推进去（二次贝塞尔，控制点在架子上方、往录像机那边偏一点）
    const ctrl = new THREE.Vector3(home.pos.x + (P1.x - home.pos.x) * 0.3, home.pos.y + 0.24, Math.max(home.pos.z, P1.z) + 0.05);
    return { ...t, i, home, ctrl, state: 'rack', pull: 0, pullT: 0 };
  });
  function placeTape(t, k) { // k：0 = 在架子上，1 = 整盘进了录像机
    const g = t.group, A = 0.75;
    if (k < A) {
      const e = ease(k / A), u = 1 - e;
      g.position.copy(t.home.pos).multiplyScalar(u * u).addScaledVector(t.ctrl, 2 * u * e).addScaledVector(P1, e * e);
      g.quaternion.slerpQuaternions(t.home.quat, FLAT, smooth(0.15, 0.85, e));
    } else {
      g.position.lerpVectors(P1, P2, (k - A) / (1 - A));
      g.quaternion.copy(FLAT);
    }
  }

  // ---------- 动画小工具 ----------
  const tweens = [];
  const tween = (obj, dur, fn, done) => tweens.push({ obj, t: 0, dur, fn, done });
  const cancelTweens = (obj) => { for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].obj === obj) tweens.splice(i, 1); };

  // ---------- 换带：旧带子退回架子 → 新带子飞进录像机 → 电视开始播 ----------
  let loaded = null;
  function settle(i) { // 立刻回到架子上
    const t = phys[i];
    if (!t) return;
    cancelTweens(t);
    t.state = 'rack';
    t.group.visible = true;
    t.group.position.copy(t.home.pos);
    t.group.quaternion.copy(t.home.quat);
  }
  function inside(i) { // 立刻放进录像机
    const t = phys[i];
    if (!t) return;
    cancelTweens(t);
    t.state = 'in';
    t.pull = t.pullT = 0;
    placeTape(t, 1);
    t.group.visible = false;
  }
  function insertTape(i, { animate = true } = {}) {
    if (!N) return;
    i = ((i % N) + N) % N;
    if (loaded === i && tv.state !== 'off') return;
    const prev = loaded;
    loaded = i;
    tv.stop();
    phys.forEach((t, k) => { if (t && k !== prev && k !== i && t.state !== 'rack') settle(k); }); // 连点好几盘时，半路的都先归位
    const play = () => { if (loaded === i) { tv.play(tapes[i]); renderPanel(); } };
    const load = () => {
      const t = phys[i];
      if (!t || t.state === 'in') return play(); // 架子上放不下的作品：没有实物，直接播
      if (!animate) { inside(i); return play(); }
      settle(i);
      t.state = 'flying';
      tween(t, 1.25, (k) => placeTape(t, k), () => { inside(i); play(); });
    };
    const p = prev != null && prev !== i ? phys[prev] : null;
    if (p && p.state === 'in' && animate) {
      p.state = 'flying';
      p.group.visible = true;
      tween(p, 0.8, (k) => placeTape(p, 1 - k), () => { settle(prev); load(); });
    } else {
      if (p) settle(prev);
      load();
    }
    renderPanel();
  }
  function cmd(c) {
    if (c === 'next') insertTape((loaded ?? -1) + 1);
    else if (c === 'prev') insertTape((loaded ?? 1) - 1);
    else if (c === 'stop') {
      if (tv.state !== 'off') tv.stop();
      else if (loaded != null) tv.play(tapes[loaded]);
      renderPanel();
    }
  }

  // ---------- 灯 ----------
  const light = { room: 1, roomT: 1, lamp: 1, lampT: 1 };
  const tvTint = new THREE.Color();

  // ---------- 镜头 ----------
  // 开场（home）：绕着电脑转（orbit）。姿态 = 转的中心 + 方向（yaw 左右、pitch 上下，和 bake_room.py 的 CAM 一样）+ 距离 + 视角；
  // 拖动在 yawRange / pitchRange 里转，滚轮 / 双指在 distRange 里拉近拉远；镜头出了 manifest.camera.box 就往中心拉近，不会钻进墙里。
  // 点进某个物件时，按 manifest.views 里的目标点、方向、要装下的大小算出镜头位置，并给面板让出地方。
  const C = M.camera;
  const center0 = new THREE.Vector3().fromArray(C.target), pcPos = new THREE.Vector3().fromArray(M.screens.pc.pos);
  const look = { yaw: C.yaw, pitch: C.pitch, dist: C.dist, yawT: C.yaw, pitchT: C.pitch, distT: C.dist };
  const par = new THREE.Vector2(), parT = new THREE.Vector2(); // 鼠标视差
  const pose = () => ({ pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: C.fov });
  const cur = pose(), goal = pose();
  let fly = null;
  const right = new THREE.Vector3(), up = new THREE.Vector3(), dirV = new THREE.Vector3(), fwd = new THREE.Vector3(), center = new THREE.Vector3();
  function basis(yaw, pitch) {
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    up.set(Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), Math.sin(pitch) * Math.cos(yaw));
  }
  function orbitPose(out, t, yaw, pitch, dist) { // 和 bake_room.py 的 orbit_pose 一样：位置 = 中心 - 朝向 × 距离，出了 box 就拉近
    fwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const tt = [t.x, t.y, t.z], ff = [fwd.x, fwd.y, fwd.z], lim = [C.box.x, C.box.y, [-1e9, C.box.z]];
    for (let k = 0; k < 3; k++) {
      if (-ff[k] > 1e-6) dist = Math.min(dist, (lim[k][1] - tt[k]) / -ff[k]);
      else if (-ff[k] < -1e-6) dist = Math.min(dist, (lim[k][0] - tt[k]) / -ff[k]);
    }
    out.pos.copy(t).addScaledVector(fwd, -dist);
    out.yaw = yaw;
    out.pitch = pitch;
    return out;
  }
  function homePose(out) {
    // 窄屏（竖屏手机）：视角放宽到左右至少 ~33°（上下最多 ~67°），转的中心挪回电脑正中、镜头拉近到 7 成：
    // 画面高 2 米左右，正好从地板上方到窗户上沿，看不到天花板；电脑当主角，右边的电视切到画面外
    const narrow = smooth(1.2, 0.6, camera.aspect);
    const tanV = Math.max(Math.tan(deg(C.fov / 2)), Math.min(0.66, 0.3 / camera.aspect));
    out.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanV));
    center.copy(center0);
    center.x += (pcPos.x - center.x) * narrow;
    return orbitPose(out, center, look.yaw, look.pitch, look.dist * (1 - 0.32 * narrow));
  }
  function covered() { // 面板挡住了多少像素：宽屏在右边，窄屏在下面；top 是顶部导航栏
    const top = nav?.height() ?? 0;
    if (panel.hidden) return { w: 0, h: 0, top };
    const r = panel.getBoundingClientRect();
    return innerWidth > 600 ? { w: innerWidth - r.left + 16, h: 0, top } : { w: 0, h: innerHeight - r.top + 12, top };
  }
  function focusPose(name, out) {
    const v = M.views[name];
    const fov = camera.aspect < 0.8 ? 60 : 44;
    const tv_ = Math.tan(deg(fov / 2)), th = tv_ * camera.aspect;
    const cv = covered(), fw = Math.max(0.35, 1 - cv.w / innerWidth), fh = Math.max(0.35, 1 - (cv.h + cv.top) / innerHeight);
    const dist = Math.max(v.size[0] / (th * fw), v.size[1] / (tv_ * fh)) * 1.15;
    dirV.fromArray(v.dir);
    out.yaw = Math.atan2(dirV.x, dirV.z);
    out.pitch = Math.asin(-dirV.y);
    out.fov = fov;
    out.pos.fromArray(v.target).addScaledVector(dirV, dist);
    // 把物件挪到面板和导航栏没挡住的那块区域中间。面板在右边：镜头平移（屏幕、电视还是正对着看）；
    // 面板在下面（竖屏）：镜头不往下挪（离得远时会钻到椅子、柜子后面），改成稍微低头。导航栏在上面：稍微抬头。
    basis(out.yaw, out.pitch);
    out.pos.addScaledVector(right, (dist * th * cv.w) / innerWidth);
    out.pitch -= Math.atan((tv_ * (cv.h - cv.top)) / innerHeight);
    return out;
  }
  function startFly() {
    const from = { pos: cur.pos.clone(), yaw: cur.yaw, pitch: cur.pitch, fov: cur.fov };
    const d = from.pos.distanceTo(goalPose(pose()).pos);
    fly = { from, t: 0, dur: clamp(0.9 + d * 0.25, 1, 1.6) };
  }
  function updateCamera(dt) {
    const a = 1 - Math.exp(-dt * 8);
    look.yaw += (look.yawT - look.yaw) * a;
    look.pitch += (look.pitchT - look.pitch) * a;
    look.dist += (look.distT - look.dist) * a;
    par.lerp(parT, 1 - Math.exp(-dt * 3));
    goalPose(goal);
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
    const k = orbiting() ? 0.05 : 0.008; // 头跟着鼠标轻轻平移几厘米：窗外近景 / 远景和屋里物件之间有层次
    camera.position.copy(cur.pos).addScaledVector(right, par.x * k).addScaledVector(up, -par.y * k * 0.5);
    camera.rotation.set(cur.pitch, cur.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - cur.fov) > 1e-3) { camera.fov = cur.fov; camera.updateProjectionMatrix(); }
  }
  const zoom = (k) => { look.distT = clamp(look.distT * k, ...C.distRange); }; // k > 1 拉远，k < 1 拉近
  function clampLook() {
    look.yawT = clamp(look.yawT, ...C.yawRange);
    look.pitchT = clamp(look.pitchT, ...C.pitchRange);
  }

  // ---------- 路由（URL hash ↔ 镜头） ----------
  let view = null;
  const viewFromHash = () => { const h = location.hash.slice(1); return h === 'credits' || (ROUTES.includes(h) && M.views?.[h]) ? h : 'home'; };
  const orbiting = () => view === 'home' || view === 'credits'; // 致谢只是开个面板，镜头还是开场那样绕着电脑
  const goalPose = (out) => (orbiting() ? homePose(out) : focusPose(view, out));
  function go(name) {
    const url = name === 'home' ? location.pathname + location.search : '#' + name;
    if ((location.hash.slice(1) || 'home') !== name) history.pushState(null, '', url);
    setView(name);
  }
  function setView(name, instant = false) {
    if (name === view) return;
    const first = view === null;
    view = name;
    pc.setActive(name === 'about');
    if (name === 'work' && loaded == null) insertTape(0, { animate: !instant });
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
    if (view === 'work') {
      const t = loaded != null ? tapes[loaded] : null;
      html = t
        ? `<div class="kicker">录像带 ${loaded + 1} / ${N}</div>
           <h2>${esc(t.title)}</h2><div class="meta">${esc(t.years)}</div>
           <p>${esc(t.desc)}</p>
           <div class="ctl">
             <button type="button" data-cmd="prev" aria-label="上一盘">◀◀</button>
             <button type="button" data-cmd="stop" aria-label="停止或播放">${tv.state === 'off' ? '▶' : '■'}</button>
             <button type="button" data-cmd="next" aria-label="下一盘">▶▶</button>
             ${t.url ? `<a class="go" href="${esc(t.url)}" target="_blank" rel="noopener">打开项目 →</a>` : ''}
           </div>
           <p class="tip">点桌上的录像带换一盘。</p>`
        : '<h2>电视</h2><p>还没有录像带。</p>';
    } else if (view === 'about') {
      html = `<div class="kicker">关于我</div>
        <p>文字正在电脑屏幕上打出来。滚轮或 ↑↓ 翻页，点一下屏幕直接显示全部。</p>
        <a href="?plain=1#about">阅读纯文字版 →</a>`;
    } else if (view === 'shelf') {
      html = `<div class="kicker">书架</div><h2>在读 / 推荐</h2>
        ${books.length ? `<ul class="list">${books.map((b) => `<li>${b.url
          ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.title)} <span>${esc(b.author)}</span></a>`
          : `<div class="row">${esc(b.title)} <span>${esc(b.author)}</span></div>`}${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}</li>`).join('')}</ul>` : '<p>书架上还没有书。</p>'}`;
    } else if (view === 'credits') {
      html = `<div class="kicker">致谢</div><h2>房间里的素材</h2>${creditsHtml()}`;
    } else if (view === 'online') {
      html = `<div class="kicker">联系</div>
        <ul class="list">${links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} <span>${esc(l.handle)}</span></a></li>`).join('')}</ul>`;
    }
    panel.innerHTML = html;
    panel.hidden = !html;
  }
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.cmd) cmd(b.dataset.cmd);
  });
  backBtn.addEventListener('click', () => go('home'));

  // ---------- 素材致谢：内容是 index.html 里的 #credits（node scripts/credits_html.mjs 生成），纯文字版看到的也是这一份 ----------
  function creditsHtml() {
    const sec = $('credits');
    if (!sec) return '<p>没有找到致谢列表。</p>';
    const box = document.createElement('div');
    for (const el of sec.querySelectorAll('.intro, .credit-list')) box.append(el.cloneNode(true));
    for (const a of box.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener'; }
    return box.innerHTML;
  }
  const creditLink = document.createElement('a');
  creditLink.href = '#credits';
  creditLink.textContent = '致谢';
  creditLink.addEventListener('click', (e) => { e.preventDefault(); go('credits'); });
  help.append(' · ', creditLink);

  // ---------- 拾取：射线打到的第一个面 → 是录像带，还是在哪个热点盒子里 ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pickables = [room.root, ...screens, ...phys.filter(Boolean).map((t) => t.group)];
  if (turntable) pickables.push(turntable.group);
  const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  function pick(x, y) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld(); // 镜头这一帧可能还没渲染过
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(pickables, true)) {
      if (!shown(hit.object)) continue;
      if (music && hit.object.userData.recordPlayer) return { kind: 'music', key: 'music' };
      const ti = hit.object.userData.tape;
      if (ti != null) return { kind: 'tape', key: 'tape' + ti, i: ti };
      const name = room.hotspotAt(hit.point);
      return name ? { kind: name, key: name } : null; // 第一个可见的面：是热点就返回，不是就挡住后面的东西
    }
    return null;
  }
  function hintText(h) {
    if (h.kind === 'music') return music?.playing ? '唱片机 · 暂停配乐' : '唱片机 · 播放配乐';
    if (h.kind === 'tape') return `▶ ${tapes[h.i].title}`;
    if (h.kind === 'lamp') return light.lampT ? '台灯 · 关灯' : '台灯 · 开灯';
    if (h.kind === 'room') return light.roomT ? '屋里的灯 · 关灯' : '屋里的灯 · 开灯';
    if (h.kind === 'about' && view === 'about') return pc.typed < pc.total ? '点一下显示全部' : '';
    return HINTS[h.kind] || '';
  }
  let hover = null;
  function setHover(h, x, y) {
    if (h && h.kind === view && view !== 'about') h = null; // 已经在看它了
    if (h?.key !== hover?.key) {
      if (hover?.kind === 'tape' && phys[hover.i]) phys[hover.i].pullT = 0;
      hover = h;
      if (h?.kind === 'tape') { if (phys[h.i]?.state === 'rack') phys[h.i].pullT = 1; }
      else if (h) room.highlight(h.kind); // 移开时不清盒子，让高亮淡出
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
    const h = pick(x, y);
    if (!h) { if (view !== 'home') go('home'); return; }
    if (h.kind === 'tape') { insertTape(h.i); go('work'); }
    else if (h.kind === 'music') music?.toggle();
    else if (h.kind === 'lamp') light.lampT = light.lampT ? 0 : 1;
    else if (h.kind === 'room') light.roomT = light.roomT ? 0 : 1;
    else if (h.kind === 'about' && view === 'about') pc.finish();
    else if (h.kind !== view) go(h.kind);
    if (mouse) setHover(pick(x, y), x, y);
  }

  // ---------- 鼠标 / 触摸：单指拖动换角度，双指拉近拉远，没怎么动就算点击 ----------
  const ptrs = new Map();
  let down = null, dragging = false, pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (ptrs.size === 1) { down = { x: e.clientX, y: e.clientY }; dragging = false; } else down = null; // 第二根手指：不算点击
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
      if (pinch && view === 'home') zoom(Math.exp((before - after) * 0.005)); // 两指分开 = 拉近
      pinch = 1;
      return;
    }
    if (down && !dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
      dragging = true;
      setHover(null);
      if (view === 'home') canvas.style.cursor = 'grabbing';
    }
    if (dragging && view === 'home') {
      const k = 0.006 * (mouse ? 1 : 1.4);
      look.yawT -= (e.clientX - p.x) * k; // 像转桌上的模型：往左拖 = 镜头绕到右边，往下拖 = 镜头升高、往下看
      look.pitchT -= (e.clientY - p.y) * k;
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
    if (view === 'home') zoom(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))); // 往下滚 = 拉远
    else if (view === 'about') {
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY; // 触控板一次滚动会来很多小事件，攒够一行再翻
      while (Math.abs(wheelAcc) >= 40) { pc.scrollBy(Math.sign(wheelAcc)); wheelAcc -= Math.sign(wheelAcc) * 40; }
    }
  }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (view !== 'home') go('home'); return; }
    if (e.target.closest?.('button,a,input,textarea') && !e.target.closest('#topbar')) return; // 点过导航栏以后方向键照常换带
    if (view === 'work' && e.key === 'ArrowRight') cmd('next');
    else if (view === 'work' && e.key === 'ArrowLeft') cmd('prev');
    else if (view === 'work' && e.key === ' ') { e.preventDefault(); cmd('stop'); }
    else if (view === 'about' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); pc.scrollBy(e.key === 'ArrowDown' ? 2 : -2); }
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
  insertTape(0, { animate: false }); // 开场电视就在播第一盘，房间带着电视的光
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
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.fn(k);
      if (k >= 1) { tweens.splice(tweens.indexOf(tw), 1); tw.done?.(); }
    }
    const s = 1 - Math.exp(-dt * 12);
    light.lamp += (light.lampT - light.lamp) * s;
    light.room += (light.roomT - light.room) * s;
    tv.update(t, dt);
    pc.update(t, dt);
    turntable?.update(dt, music?.playing, music?.track);
    if (hover?.kind === 'music' && hintEl.classList.contains('show')) {
      const text = hintText(hover);
      if (hintEl.textContent !== text) hintEl.textContent = text;
    }
    room.update({ room: light.room, lamp: light.lamp, tv: tvLight(tv.color, tvTint) });
    room.U.hiK.value += ((hover && hover.kind !== 'tape' ? 1 : 0) - room.U.hiK.value) * (1 - Math.exp(-dt * 14));
    for (const tp of phys) {
      if (!tp) continue;
      tp.pull += (tp.pullT - tp.pull) * s;
      for (const m of tp.parts) m.material.uniforms.hi.value = tp.pull;
      if (tp.state === 'rack') { tp.group.position.copy(tp.home.pos); tp.group.position.y += tp.pull * 0.03; tp.group.position.z += tp.pull * 0.012; } // 悬停时往上抽出一点
    }
    updateCamera(dt);
    if (render) composer.render(dt);
  }

  // 自适应画质：前几秒帧率太低就降分辨率，再不行就关掉辉光
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

  // 调试入口（控制台里用）：__room.tick(dt) 手动推进一帧（后台标签页里动画会被浏览器降速）
  window.__room = {
    go, insertTape, cmd, tick, pick, look, light, camera, renderer, composer, room, tv, pc, turntable, grade: (k) => grade.set(k),
    get view() { return view; }, get loaded() { return loaded; }, get hover() { return hover; },
    hoverAt: (x, y) => setHover(pick(x, y), x, y), clickAt: (x, y) => click(x, y, true),
  };
}
