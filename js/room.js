// 3D 房间（烘焙光照版）。几何和光照由 Blender 预先算好（blender/bake_room.py → assets/baked/），这里负责交互：
//   - 开场镜头绕着书桌上的电脑转：拖动换角度（往左拖看到书架、往右拖看到唱机和软木板），滚轮 / 双指拉近拉远
//   - 点物件 → 镜头飞过去：电脑 = 关于我，电视和录像带 = 作品，书架 = 书单，记事本 = 联系
//   - 书架上的真书（js/books.js）：悬停抽出一点，点了抽出来飞到眼前翻开（#shelf/书名）；书架第二层左头藏着一本本子（彩蛋）
//   - 挂钟下面的软木板（js/photos.js）：钉着做旧的照片，点了镜头凑到板前看（#photos）
//   - 桌上的两张打印纸 = 简历（js/resume.js，#resume、#resume/en）：镜头不动，纸从桌上被拿起来举到眼前，左右换一张看；
//     对焦拉到手里的纸上，屋子虚下去
//   - 窗外（js/window-view.js）：城市全景 + 实时的天空、云、星河、雨、车流、水面涟漪
//     #about #work #shelf #online 都是真实 URL，可以分享，浏览器后退键可用；#credits 是素材致谢（镜头不动，只开面板）
//   - 点桌上的录像带：它飞进录像机，电视播放对应的画面模块；电视画面的颜色实时染色房间
//   - 点台灯 / 落地灯开关灯（切的是烘焙好的光照层的系数，不重新算光）
//   - 悬停高亮：热点盒子来自 manifest，着色器把盒子里的像素提亮
//   - 墙上的撕页日历显示今天的日期（js/calendar.js 画纸页）
//   - Bloom 辉光 + 整体滤镜（js/grade.js：默认"电影感"：暖色的晕、横向光丝、跟着镜头对焦的景深；?look=名字 选预设，?looks 显示切换按钮）；
//     帧率太低先降分辨率，再不行就关掉辉光和景深
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TV } from './tv.js';
import { PCScreen } from './pc.js';
import { paintNote } from './paint.js';
import { paintCalendar } from './calendar.js';
import { BakedRoom, loadBaked, tvLight } from './baked.js';
import { CameraPass, GradePass, StreakPass, lookPicker } from './grade.js';
import { createTurntable } from './turntable.js';
import { createBooks, readStatus } from './books.js';
import { loadSealed, unseal, unsealRemembered, forget } from './seal.js';
import { createPhotos } from './photos.js';
import { dressSleeves } from './sleeves.js';
import { createWindowView } from './window-view.js';
import { createResumeViewer } from './resume.js';

const BASE = new URL('../assets/baked/', import.meta.url).href;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = THREE.MathUtils.degToRad;
const ROUTES = ['about', 'resume', 'work', 'shelf', 'photos', 'online'];
// 界面文字用英文（书架上的书和本子是中文内容，那部分的提示仍然是中文）
const HINTS = { about: 'Computer · About me', resume: 'Printed pages · Résumé', work: 'TV · Work', shelf: 'Bookshelf · Reading list', photos: 'Cork board · Photos', online: 'Notepad · Contact' };

export async function start(content, { nav = null, music = null } = {}) {
  const { tapes, books = [], writing = [], links } = content;
  const N = tapes.length;
  $('room').hidden = false;
  const canvas = $('gl'), hintEl = $('hint'), backBtn = $('back'), panel = $('panel'), help = $('help'), loading = $('loading');
  const baseTitle = content.name || document.title;
  const TITLES = { home: baseTitle, about: `About · ${baseTitle}`, resume: `Résumé · ${baseTitle}`, work: `Work · ${baseTitle}`, shelf: `Books · ${baseTitle}`, photos: `Photos · ${baseTitle}`, online: `Contact · ${baseTitle}`, credits: `Credits · ${baseTitle}` };

  // ---------- 渲染器 ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#07080c');
  const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 120);
  // 画布自带的抗锯齿管不到 EffectComposer 的离屏缓冲：CameraPass 代替 RenderPass，场景先画进它自己的多重采样 HDR 缓冲，
  // 顺路做白平衡和景深（js/grade.js），再交给后面的辉光、调色
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(dpr);
  const lens = new CameraPass({ renderer, scene, camera, samples: Math.min(4, renderer.capabilities.maxSamples) });
  composer.addPass(lens);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.5, 0.9);
  composer.addPass(bloom);
  const streak = new StreakPass(); // 亮光点的横向拉丝光（只有"电影感"开着）
  composer.addPass(streak);
  composer.addPass(new OutputPass());
  const grade = new GradePass({ renderer, bloom, lens, streak, camera }); // 调色接在 OutputPass 后面（处理的是 sRGB 画面）
  composer.addPass(grade);
  const qs = new URLSearchParams(location.search);
  grade.set(qs.get('look') || 'cinema');
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
  // 窗外：动态的雨夜（城市全景 + 天空 + 雨，js/window-view.js）；下载占进度条的 95% → 99%
  const windowView = await createWindowView({ base: BASE, view: data.view, win: M.window, scene, camera, renderer, onProgress: (k) => progress(0.95 + k * 0.04) })
    .catch((err) => { console.warn('窗外的动态夜景加载失败', err); return null; });
  const turntable = createTurntable(room, music?.track);

  // ---------- 实时画的东西：电视、电脑屏幕、记事本纸面 ----------
  const tv = new TV();
  // 电脑上的菜单：时间线里的一条可以"在电视上播放"——按 data-tape 的词找标题里有它的那盘带子
  const tapeIndex = (key) => tapes.findIndex((t) => t.title.toLowerCase().includes(String(key).toLowerCase()));
  const pc = new PCScreen(content, {
    canPlay: (key) => tapeIndex(key) >= 0,
    onPlay: (key) => { const i = tapeIndex(key); if (i >= 0) { insertTape(i); go('work'); } },
  });
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
  const contactNote = room.decal('notepad', noteTex);
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
  const LIFT = 0.21, UP = new THREE.Vector3(0, 1, 0); // 从纸盒里抽出来要往上提多少（纸盒 19 厘米长）
  const phys = room.takeTapes().map((t, i) => {
    if (i >= N) { t.group.visible = false; return null; } // HTML 里的作品比架子上的带子少：多的藏起来
    for (const m of t.parts) m.userData.tape = i;
    const home = { pos: t.group.position.clone(), quat: t.group.quaternion.clone() };
    // 飞行路线：先从纸盒上口竖着抽出来（纸盒留在架子上），再往右前方绕到录像机口前面，最后推进去
    // （二次贝塞尔，控制点在抽出来的位置上方、往录像机那边偏一点）
    const out = home.pos.clone().add(new THREE.Vector3(0, LIFT, 0));
    const ctrl = new THREE.Vector3(out.x + (P1.x - out.x) * 0.3, out.y + 0.06, Math.max(out.z, P1.z) + 0.05);
    return { ...t, i, home, out, ctrl, state: 'rack', pull: 0, pullT: 0 };
  });
  // 架子上的纸盒：按 HTML 里的作品画包装；作品比带子少，多出来的纸盒也藏起来
  dressSleeves(room, tapes);
  function placeTape(t, k) { // k：0 = 在架子上，1 = 整盘进了录像机
    const g = t.group, A0 = 0.2, A = 0.75;
    if (k < A0) { // 竖着从纸盒里抽出来
      g.position.copy(t.home.pos).addScaledVector(UP, LIFT * ease(k / A0));
      g.quaternion.copy(t.home.quat);
    } else if (k < A) {
      const e = ease((k - A0) / (A - A0)), u = 1 - e;
      g.position.copy(t.out).multiplyScalar(u * u).addScaledVector(t.ctrl, 2 * u * e).addScaledVector(P1, e * e);
      g.quaternion.slerpQuaternions(t.home.quat, FLAT, smooth(0.1, 0.85, e));
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
    if (c === 'book-close') return closeBook();
    if (c === 'photos-reset') return photoWall?.reset();
    if (c === 'seal-forget' && sealedEssay) { // 锁回去：忘掉这台设备上记住的钥匙
      forget(sealedEssay.sealed);
      shelfBooks?.setUnsealed(sealedEssay.sealed, null);
      seal.state = 'locked';
      return renderPanel();
    }
    if (c === 'page-next' || c === 'page-prev') { shelfBooks?.turn(c === 'page-next' ? 1 : -1); return renderPanel(); }
    if (c === 'read-next' || c === 'read-prev') { // 方向键：先翻页，翻到头了换一本
      const d = c === 'read-next' ? 1 : -1, r = shelfBooks?.turn(d);
      if (r === false) return cmd(d > 0 ? 'book-next' : 'book-prev');
      return renderPanel();
    }
    if (c === 'book-next' || c === 'book-prev') {
      shelfBooks?.step(c === 'book-next' ? 1 : -1);
      const i = shelfBooks?.current();
      if (i != null) history.replaceState(null, '', '#shelf/' + encodeURIComponent(bookSlug(i)));
      return renderPanel();
    }
    if (c === 'next') insertTape((loaded ?? -1) + 1);
    else if (c === 'prev') insertTape((loaded ?? 1) - 1);
    else if (c === 'stop') {
      if (tv.state !== 'off') tv.stop();
      else if (loaded != null) tv.play(tapes[loaded]);
      renderPanel();
    }
  }

  // ---------- 灯 ----------
  // ---------- 书架上的真书 + 彩蛋本子（js/books.js）----------
  const shelfBooks = createBooks({ room, scene, camera, books, writing, frame: () => covered() });
  let pageKey = '';
  // 本子里上了锁的那篇：密文先加载好；这台设备记住过口令就直接解开
  const sealedEssay = writing.find((w) => w.sealed);
  const seal = { box: null, state: sealedEssay ? 'locked' : 'none', err: '' }; // state：locked / open / none
  if (sealedEssay) loadSealed(sealedEssay.sealed).then(async (box) => {
    seal.box = box;
    const doc = box && await unsealRemembered(sealedEssay.sealed, box);
    if (doc) { shelfBooks?.setUnsealed(sealedEssay.sealed, doc); seal.state = 'open'; renderPanel(); }
  });
  async function tryUnlock(pass, remember) {
    if (!seal.box) { seal.err = '这一篇还没有封好的密文（作者要先运行 npm run seal）'; return renderPanel(); }
    try {
      const doc = await unseal(sealedEssay.sealed, seal.box, pass, remember);
      shelfBooks?.setUnsealed(sealedEssay.sealed, doc);
      seal.state = 'open';
      seal.err = '';
    } catch {
      seal.err = '口令不对';
    }
    renderPanel();
    if (seal.state !== 'open') panel.querySelector('input[name=pass]')?.focus();
  }
  const bookSlug = (i) => (shelfBooks.entry(i)?.kind === 'secret' ? 'writing' : shelfBooks.entry(i)?.b.title || String(i + 1));
  function openBook(i, push = true) {
    if (!shelfBooks?.entry(i)) return;
    if (view !== 'shelf') setView('shelf');
    shelfBooks.open(i);
    const url = '#shelf/' + encodeURIComponent(bookSlug(i));
    if (location.hash !== url) history[push ? 'pushState' : 'replaceState'](null, '', url);
    renderPanel();
  }
  function closeBook() {
    if (shelfBooks?.current() == null) return false;
    shelfBooks.close();
    if (hashParts()[1]) history.pushState(null, '', '#shelf');
    renderPanel();
    return true;
  }
  function syncBookFromHash() { // 地址里的书名 → 翻开那本；地址里没有书名 → 合上
    if (!shelfBooks) return;
    const [h, slug] = hashParts();
    const i = h === 'shelf' && slug ? shelfBooks.entries.findIndex((e, k) => bookSlug(k) === slug || String(k + 1) === slug) : -1;
    if (i >= 0) { if (shelfBooks.current() !== i) shelfBooks.open(i); } else shelfBooks.close();
    renderPanel();
  }

  // ---------- 照片墙（js/photos.js）----------
  // 照片墙：本地有做旧过的真实照片（assets/photos/photos.json，不进 Git）就用它们，没有就用 index.html 里的占位照片
  let photoWall = null;
  fetch(new URL('../assets/photos/photos.json', import.meta.url), { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((local) => {
      photoWall = createPhotos({ room, scene, photos: local?.photos?.length ? local.photos : content.photos || [] });
      if (view === 'photos') renderPanel();
    });

  // ---------- 桌上的两张打印纸 = 简历（js/resume.js）----------
  // 热点 resume 每张纸一个盒子，后一个压在上面：最上面那张是第一种语言（中文），底下那张是第二种（English）。
  // 镜头不凑过去：点纸，这几页纸从桌上被拿起来（起点 = 那张纸此刻在屏幕上的样子），对焦拉到手里的纸上
  const paperBoxes = M.hotspots?.resume || [];
  const resume = paperBoxes.length ? createResumeViewer({
    pages: () => document.querySelectorAll('#resume .cv-page'),
    top: () => nav?.height() ?? 0,
    onClose: () => go('home'),
    onTurn: (slug) => { // 翻到另一种语言：地址跟着变（#resume = 第一种，#resume/en = 第二种），不加历史记录
      if (view !== 'resume') return;
      const url = '#resume' + (slug ? '/' + slug : '');
      if (location.hash !== url) history.replaceState(null, '', url);
    },
  }) : null;
  if (resume) $('room').insertBefore(resume.el, backBtn);
  const resumeReq = { open: false, paper: null }; // 要拿起来了（等镜头回到开场的位置）；从哪张纸拿起来
  const inBox = (b, p, pad = 0.01) => {
    const qx = p.x - b.c[0], qz = p.z - b.c[2], c = Math.cos(b.r), s = Math.sin(b.r);
    return Math.abs(c * qx - s * qz) <= b.h[0] + pad && Math.abs(p.y - b.c[1]) <= b.h[1] + pad && Math.abs(s * qx + c * qz) <= b.h[2] + pad;
  };
  const paperAt = (p) => { for (let k = paperBoxes.length - 1; k >= 0; k--) if (inBox(paperBoxes[k], p)) return k; return paperBoxes.length - 1; };
  const paperLang = (k) => Math.min(paperBoxes.length - 1 - k, Math.max(0, (resume?.langs().length ?? 1) - 1)); // 第 k 张纸 → 第几种语言
  const langPaper = (li) => Math.max(0, paperBoxes.length - 1 - li);
  // 桌上第 k 张纸在屏幕上的样子：中心、宽、高（透视压扁的）、上沿朝哪（度）。pose 给了就按那个镜头姿态算
  const projCam = new THREE.PerspectiveCamera(), projV = new THREE.Vector3();
  function paperRect(k, p = null) {
    const b = paperBoxes[k];
    if (!b) return null;
    projCam.copy(camera);
    if (p) {
      projCam.position.copy(p.pos);
      projCam.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
      projCam.fov = p.fov;
      projCam.updateProjectionMatrix();
    }
    projCam.updateMatrixWorld();
    const c = Math.cos(b.r), s = Math.sin(b.r), hw = b.h[0] - 0.004, hh = b.h[2] - 0.004, r = canvas.getBoundingClientRect();
    const at = (qx, qz) => { // 纸面本地坐标（qz = -hh 是纸的上沿，朝后墙）→ 屏幕
      projV.set(b.c[0] + c * qx + s * qz, b.c[1] + b.h[1], b.c[2] - s * qx + c * qz).project(projCam);
      return [r.left + ((projV.x + 1) / 2) * r.width, r.top + ((1 - projV.y) / 2) * r.height];
    };
    const T = at(0, -hh), B = at(0, hh), L = at(-hw, 0), R = at(hw, 0);
    return {
      x: (T[0] + B[0]) / 2, y: (T[1] + B[1]) / 2, w: Math.hypot(R[0] - L[0], R[1] - L[1]), h: Math.hypot(T[0] - B[0], T[1] - B[1]),
      rot: THREE.MathUtils.radToDeg(Math.atan2(T[0] - B[0], B[1] - T[1])),
    };
  }
  function openResume(k) { // 点了桌上第 k 张纸
    const slug = resume.langs()[paperLang(k)]?.slug || '';
    const url = '#resume' + (slug ? '/' + slug : '');
    if (location.hash !== url) history.pushState(null, '', url);
    setView('resume');
    resumeReq.paper = k;
  }
  function syncResumeFromHash() { // 后退 / 前进到 #resume/en 之类：翻到那种语言
    if (view === 'resume' && resume?.shown) resume.goTo(resume.indexForSlug(hashParts()[1]));
  }

  const light = { room: 1, roomT: 1, lamp: 1, lampT: 1 };
  const tvTint = new THREE.Color();

  // ---------- 镜头 ----------
  // 开场（home）：绕着电脑转（orbit）。姿态 = 转的中心 + 方向（yaw 左右、pitch 上下，和 bake_room.py 的 CAM 一样）+ 距离 + 视角；
  // 拖动在 yawRange / pitchRange 里转，滚轮 / 双指在 distRange 里拉近拉远；镜头出了 manifest.camera.box 就往中心拉近，不会钻进墙里。
  // 点进某个物件时，按 manifest.views 里的目标点、方向、要装下的大小算出镜头位置，并给面板让出地方。
  const C = M.camera;
  const center0 = new THREE.Vector3().fromArray(C.target), pcPos = new THREE.Vector3().fromArray(M.screens.pc.pos);
  const look = { yaw: C.yaw, pitch: C.pitch, dist: C.dist, yawT: C.yaw, pitchT: C.pitch, distT: C.dist };
  // 往右转向唱机时镜头怎么跟着挪（见 homePose）：中心往右 33 厘米、往前 28 厘米、低 8 厘米，拉远 22 厘米，多低一点头
  // （在浏览器里比过几组，这组唱机整个露出来、挂钟和照片墙也还在画面里）；__room.turn 可以现场调
  const TURN = { record: { dx: 0.33, dz: 0.28, dy: -0.08, back: 0.22, tilt: -0.12 } };
  const par = new THREE.Vector2(), parT = new THREE.Vector2(); // 鼠标视差
  const pose = () => ({ pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: C.fov });
  const cur = pose(), goal = pose();
  let fly = null;
  const right = new THREE.Vector3(), up = new THREE.Vector3(), dirV = new THREE.Vector3(), fwd = new THREE.Vector3(), center = new THREE.Vector3();
  const focusPt = new THREE.Vector3();
  let focusSnap = true; // 第一帧直接对准，不从默认距离慢慢拉过来
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
    // 往左转向书柜（yaw > 0）：转的中心跟着往左挪 15 厘米、镜头往后拉一点，书柜整个转进画面、书大一点好点；
    // 往右转向矮柜上的唱机（yaw < 0）：中心往右前方挪、镜头往后拉一点、稍微低头，唱机整个转进画面。
    // 正对电脑的开场构图不变（正前方 ±3° 以内不动），转回来就复原。竖屏手机有自己的构图，不加
    const shelfTurn = smooth(0.05, 0.6, look.yaw) * (1 - narrow);
    const recordTurn = smooth(-0.05, -0.75, look.yaw) * (1 - narrow);
    const T = TURN.record;
    center.x += -0.15 * shelfTurn + T.dx * recordTurn;
    center.z += T.dz * recordTurn;
    center.y += T.dy * recordTurn;
    return orbitPose(out, center, look.yaw, look.pitch + T.tilt * recordTurn,
      look.dist * (1 - 0.32 * narrow) + 0.18 * shelfTurn + T.back * recordTurn);
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
    const from = { pos: cur.pos.clone(), yaw: cur.yaw, pitch: cur.pitch, fov: cur.fov }, to = goalPose(pose());
    const d = from.pos.distanceTo(to.pos);
    // 镜头本来就在那儿（开场 ↔ 致谢 / 简历）：不用飞
    if (d < 0.005 && Math.abs(angle(to.yaw - from.yaw)) < 0.005 && Math.abs(to.pitch - from.pitch) < 0.005) { fly = null; return; }
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
    // 对焦：开场对着转的中心（电脑），点进物件就对着那个物件；量的是沿视线方向的距离（焦平面和画面平行）。
    // 换目标时焦点慢慢跟过去，飞行途中就像摄影师在拉焦
    fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    let fd;
    if (view === 'resume' && resume?.shown) fd = 0.32; // 手里拿着纸：对焦在眼前三十厘米，屋子整个虚下去
    else {
      const fp = shelfBooks?.focus() || (orbiting() ? center : focusPt.fromArray(M.views[view].target));
      fd = Math.max(0.15, focusPt.subVectors(fp, camera.position).dot(fwd));
    }
    lens.focus = focusSnap ? fd : lens.focus + (fd - lens.focus) * (1 - Math.exp(-dt * 6));
    focusSnap = false;
  }
  const zoom = (k) => { look.distT = clamp(look.distT * k, ...C.distRange); }; // k > 1 拉远，k < 1 拉近
  function clampLook() {
    look.yawT = clamp(look.yawT, ...C.yawRange);
    look.pitchT = clamp(look.pitchT, ...C.pitchRange);
  }

  // ---------- 路由（URL hash ↔ 镜头） ----------
  let view = null;
  const hashParts = () => {
    let h = location.hash.slice(1);
    try { h = decodeURIComponent(h); } catch { /* 保留原样 */ }
    const k = h.indexOf('/');
    return k < 0 ? [h, ''] : [h.slice(0, k), h.slice(k + 1)];
  };
  const hasView = (h) => (h === 'resume' ? !!resume : !!M.views?.[h]); // 简历没有镜头视角：纸拿到眼前来
  const viewFromHash = () => { const [h] = hashParts(); return h === 'credits' || (ROUTES.includes(h) && hasView(h)) ? h : 'home'; };
  // 致谢只是开个面板、简历是把纸拿起来：镜头都还是开场那样绕着电脑，不凑过去
  const orbiting = () => view === 'home' || view === 'credits' || view === 'resume';
  const goalPose = (out) => (orbiting() ? homePose(out) : focusPose(view, out));
  function go(name) {
    const url = name === 'home' ? location.pathname + location.search : '#' + name;
    if ((location.hash.slice(1) || 'home') !== name) history.pushState(null, '', url);
    setView(name);
  }
  function setView(name, instant = false) {
    if (name === view) return;
    const first = view === null, prev = view;
    view = name;
    if (name !== 'shelf') shelfBooks?.close();
    if (prev === 'resume' && resume) resume.close(paperRect(langPaper(resume.langIndex()))); // 放回桌上（从现在的镜头看过去的位置）
    resumeReq.open = name === 'resume';
    resumeReq.paper = null;
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
  addEventListener('popstate', () => { setView(viewFromHash()); syncBookFromHash(); syncResumeFromHash(); });

  // ---------- HTML 面板 ----------
  function renderPanel() {
    let html = '';
    // 电视（#work）、电脑（#about）不弹面板：画面就在屏幕上（换录像带：点桌上的带子，或者 ← →、空格）
    if (view === 'work' || view === 'about') {
      html = '';
    } else if (view === 'shelf') {
      const bi = shelfBooks?.current(), e = bi != null ? shelfBooks.entry(bi) : null;
      if (e?.kind === 'secret') {
        const pi = shelfBooks.pageInfo();
        html = `<div class="kicker">书架 · 一本本子</div><h2>写过的东西</h2>
          <ul class="list">${writing.map((w) => `<li><div class="row">${esc(w.title)}${w.sub ? ` <span>${esc(w.sub)}</span>` : ''}${w.sealed
            ? ` <span>${seal.state === 'open' ? '已解开' : '🔒 上了锁'}</span>` : ''}</div></li>`).join('')}</ul>
          ${pi && pi.pages > 1 ? `<div class="ctl pages">
            <button type="button" data-cmd="page-prev" ${pi.page > 1 ? '' : 'disabled'}>上一页</button>
            <span class="meta">第 ${pi.page} / ${pi.pages} 页</span>
            <button type="button" data-cmd="page-next" ${pi.page < pi.pages ? '' : 'disabled'}>下一页</button>
          </div>` : ''}
          ${seal.state === 'locked' ? `<form class="unlock">
            <p>《${esc(sealedEssay.title)}》打了马赛克：只有作者有口令。</p>
            <input type="text" name="username" value="scenecv-notebook" autocomplete="username" hidden>
            <input type="password" name="pass" placeholder="口令" autocomplete="current-password" required>
            <label class="remember"><input type="checkbox" name="remember"> 记住这台设备</label>
            <button type="submit">打开</button>
            ${seal.err ? `<p class="err" role="alert">${esc(seal.err)}</p>` : ''}
          </form>` : ''}
          <div class="ctl">
            <button type="button" data-cmd="book-close">合上</button>
            ${seal.state === 'open' ? '<button type="button" data-cmd="seal-forget">锁回去</button>' : ''}
          </div>
          <p class="tip">点目录直接翻到那一篇，点书页翻页（← → 也行），Esc 合上。</p>`;
      } else if (e) {
        const b = e.b, n = shelfBooks.entries.filter((x) => x.kind === 'book').length, pi = shelfBooks.pageInfo();
        html = `<div class="kicker">书架 · ${bi + 1} / ${n}</div>
          <h2>${esc(b.title)}</h2><div class="meta">${esc(b.author)}${readStatus(b) ? ` · ${esc(readStatus(b))}` : ''}</div>
          ${b.key || b.note ? `<p>${esc(b.key || b.note)}</p>` : ''}
          ${pi && pi.pages > 1 ? `<div class="ctl pages">
            <button type="button" data-cmd="page-prev" ${pi.page > 1 ? '' : 'disabled'}>上一页</button>
            <span class="meta">第 ${pi.page} / ${pi.pages} 页</span>
            <button type="button" data-cmd="page-next" ${pi.page < pi.pages ? '' : 'disabled'}>下一页</button>
          </div>` : ''}
          <div class="ctl">
            <button type="button" data-cmd="book-prev" aria-label="上一本">◀ 上一本</button>
            <button type="button" data-cmd="book-close">合上</button>
            <button type="button" data-cmd="book-next" aria-label="下一本">下一本 ▶</button>
            ${b.url ? `<a class="go" href="${esc(b.url)}" target="_blank" rel="noopener">去看看 →</a>` : ''}
          </div>
          <p class="tip">左页是这本书的代表句，后面是我的划线。点右页往后翻、点左页往回翻；← → 翻页，翻到头换一本，Esc 合上。</p>`;
      } else {
        html = `<div class="kicker">书架</div><h2>读过的书</h2>
          ${books.length ? `<ul class="list">${books.map((b, k) => `<li><button type="button" class="row" data-book="${k}">${esc(b.title)} <span>${esc(b.author)}</span></button></li>`).join('')}</ul>
          <p class="tip">点书架上的书，或者点这里的书名，把书拿下来翻开。</p>` : '<p>书架上还没有书。</p>'}`;
      }
    } else if (view === 'photos') {
      html = photoWall ? `<div class="kicker">Cork board · Photos</div>
        <p>Drag a photo to move it; it lands on top of the pile. This browser remembers how you arrange them.</p>
        <div class="ctl"><button type="button" data-cmd="photos-reset">Reset layout</button></div>` : '';
    } else if (view === 'credits') {
      html = `<div class="kicker">Credits</div><h2>Models in this room</h2>${creditsHtml()}`;
    } else if (view === 'online') {
      html = `<div class="kicker">Contact</div>
        <ul class="list">${links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} <span>${esc(l.handle)}</span></a></li>`).join('')}</ul>`;
    }
    panel.innerHTML = html;
    panel.hidden = !html;
  }
  panel.addEventListener('submit', (e) => { // 本子：输入口令解开
    e.preventDefault();
    const f = e.target;
    if (f.matches('form.unlock')) tryUnlock(f.pass.value, f.remember.checked);
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.book != null) openBook(Number(b.dataset.book));
    else if (b?.dataset.cmd) cmd(b.dataset.cmd);
  });
  backBtn.addEventListener('click', () => go('home'));

  // ---------- 素材致谢：内容是 index.html 里的 #credits（node scripts/credits_html.mjs 生成），纯文字版看到的也是这一份 ----------
  function creditsHtml() {
    const sec = $('credits');
    if (!sec) return '<p>No credits list found.</p>';
    const box = document.createElement('div');
    for (const el of sec.querySelectorAll('.intro, .credit-list')) box.append(el.cloneNode(true));
    for (const a of box.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener'; }
    return box.innerHTML;
  }
  const creditLink = document.createElement('a');
  creditLink.href = '#credits';
  creditLink.textContent = 'Credits';
  creditLink.addEventListener('click', (e) => { e.preventDefault(); go('credits'); });
  help.append(' · ', creditLink);

  // ---------- 拾取：射线打到的第一个面 → 是录像带，还是在哪个热点盒子里 ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pickables = [room.root, ...screens, ...phys.filter(Boolean).map((t) => t.group), ...(shelfBooks?.groups || [])];
  if (turntable) pickables.push(turntable.group);
  if (contactNote) pickables.push(contactNote);
  const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  function pick(x, y) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld(); // 镜头这一帧可能还没渲染过
    ray.setFromCamera(ndc, camera);
    const extra = shelfBooks?.rig ? [shelfBooks.rig] : [];
    for (const hit of ray.intersectObjects([...extra, ...pickables], true)) {
      if (!shown(hit.object)) continue;
      if (hit.object === contactNote) {
        const f = contactNote.userData.frame, p = hit.point.clone().sub(f.center);
        const link = view === 'online' ? noteTex.image.linkAt(p.dot(f.right) / (2 * f.hw) + 0.5, p.dot(f.long) / (2 * f.hh) + 0.5) : null;
        return link?.url ? { kind: 'contact', key: 'contact:' + link.url, url: link.url, label: link.label, handle: link.handle }
          : { kind: 'online', key: 'online' };
      }
      if (music && hit.object.userData.recordPlayer) return { kind: 'music', key: 'music' };
      const ti = hit.object.userData.tape;
      if (ti != null) return { kind: 'tape', key: 'tape' + ti, i: ti };
      if (shelfBooks?.isRig(hit.object)) {
        const url = shelfBooks.linkAt(hit), side = url ? null : shelfBooks.sideAt(hit);
        const locked = !url && seal.state === 'locked' && shelfBooks.lockedAt(hit);
        const toc = url || locked ? null : shelfBooks.tocAt(hit); // 本子的目录：点一条翻到那一篇
        return { kind: 'page', key: url ? 'link:' + url : locked ? 'locked' : toc != null ? 'toc' + toc : 'page-' + side, url, side, locked, toc };
      }
      const bi = hit.object.userData.book;
      if (bi != null) return { kind: 'book', key: 'book' + bi, i: bi };
      if (hit.object === screens[1] && hit.uv) { // 电脑屏幕：带上 UV，菜单按它算点的是哪一行
        const a = view === 'about' ? pc.at(hit.uv) : null;
        return { kind: 'about', key: 'about' + (a ? a.do + (a.row ?? '') : ''), uv: hit.uv.clone() };
      }
      const name = room.hotspotAt(hit.point);
      if (name === 'resume') { const k = paperAt(hit.point); return { kind: 'resume', key: 'resume' + k, paper: k }; }
      return name ? { kind: name, key: name } : null; // 第一个可见的面：是热点就返回，不是就挡住后面的东西
    }
    return null;
  }
  function hintText(h) {
    if (h.kind === 'contact') return `${h.label} · ${h.handle || h.url}`;
    if (h.kind === 'music') return music?.cardOpen === false ? 'Record player · Pick a record' : music?.cardOpen ? 'Record player · Close' : music?.playing ? 'Record player · Pause' : 'Record player · Play';
    if (h.kind === 'tape') return `▶ ${tapes[h.i].title}`;
    if (h.kind === 'book') { const e = shelfBooks.entry(h.i); return e.kind === 'secret' ? '一本没写书名的本子' : `《${e.b.title}》 · ${e.b.author}`; }
    if (h.kind === 'page') {
      if (h.url) return '打开这篇 ↗';
      if (h.locked) return '🔒 仅作者可阅 · 输入口令';
      if (h.toc != null) return '翻到这一篇 →';
      const pi = shelfBooks.pageInfo();
      if (!pi) return '';
      return h.side === 'right' ? (pi.page < pi.pages ? '下一页 →' : '') : (pi.page > 1 ? '← 上一页' : '');
    }
    if (h.kind === 'resume' && h.paper != null) {
      const L = resume?.langs()[paperLang(h.paper)];
      return L && resume.langs().length > 1 ? `Printed pages · Résumé (${L.label})` : HINTS.resume;
    }
    if (h.kind === 'lamp') return light.lampT ? 'Desk lamp · Turn off' : 'Desk lamp · Turn on';
    if (h.kind === 'room') return light.roomT ? 'Room light · Turn off' : 'Room light · Turn on';
    if (h.kind === 'about' && view === 'about') return pc.hintAt(h.uv);
    return HINTS[h.kind] || '';
  }
  let hover = null;
  function setHover(h, x, y) {
    if (h && h.kind === view && view !== 'about') h = null; // 已经在看它了
    if (view === 'about') pc.hover(h?.kind === 'about' ? h.uv : null); // 电脑菜单：鼠标停在哪一行就选中哪一行
    if (h?.key !== hover?.key) {
      if (hover?.kind === 'tape' && phys[hover.i]) phys[hover.i].pullT = 0;
      hover = h;
      shelfBooks?.hover(h?.kind === 'book' ? h.i : null);
      if (h?.kind === 'tape') { if (phys[h.i]?.state === 'rack') phys[h.i].pullT = 1; }
      else if (h?.kind === 'book' || h?.kind === 'page') { /* 书自己抽出来提亮，不画热点盒子 */ }
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
    if (h?.kind === 'page') {
      if (h.url) window.open(h.url, '_blank', 'noopener');
      else if (h.locked) panel.querySelector('input[name=pass]')?.focus();
      else if (h.toc != null) { shelfBooks.turnTo(h.toc); renderPanel(); }
      else if (h.side) { shelfBooks.turn(h.side === 'right' ? 1 : -1); renderPanel(); setHover(h, x, y); }
      return;
    }
    if (view === 'shelf' && h?.kind !== 'book' && closeBook()) return; // 书翻开着：点别处先合上书
    if (!h) { if (view !== 'home') go('home'); return; }
    if (h.kind === 'contact') {
      const link = document.createElement('a');
      link.href = h.url;
      link.hidden = true;
      if (/^https?:/i.test(h.url)) { link.target = '_blank'; link.rel = 'noopener'; }
      document.body.append(link);
      link.click();
      link.remove();
    }
    else if (h.kind === 'book') openBook(h.i);
    else if (h.kind === 'tape') { insertTape(h.i); go('work'); }
    else if (h.kind === 'music') { if (music?.toggleCard) music.toggleCard(); else music?.toggle(); } // 点唱机：打开 / 收起唱片卡片
    else if (h.kind === 'lamp') light.lampT = light.lampT ? 0 : 1;
    else if (h.kind === 'room') light.roomT = light.roomT ? 0 : 1;
    else if (h.kind === 'about' && view === 'about') pc.click(h.uv);
    else if (h.kind === 'resume') openResume(h.paper ?? paperBoxes.length - 1);
    else if (h.kind !== view) go(h.kind);
    if (mouse) setHover(pick(x, y), x, y);
  }

  // ---------- 鼠标 / 触摸：单指拖动换角度，双指拉近拉远，没怎么动就算点击 ----------
  const ptrs = new Map();
  let down = null, dragging = false, pinch = 0, photoDrag = false;
  const rayAt = (x, y) => { // 屏幕上的一点 → 射线（照片墙拖照片用）
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    ray.setFromCamera(ndc, camera);
    return ray;
  };
  canvas.addEventListener('pointerdown', (e) => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (ptrs.size === 1) { down = { x: e.clientX, y: e.clientY }; dragging = false; } else down = null; // 第二根手指：不算点击
    // 凑近软木板的时候：按在照片上 = 拿起这张照片
    if (ptrs.size === 1 && view === 'photos' && photoWall?.grab(rayAt(e.clientX, e.clientY))) { photoDrag = true; canvas.style.cursor = 'grabbing'; }
  });
  canvas.addEventListener('pointermove', (e) => {
    const mouse = e.pointerType === 'mouse';
    if (mouse) parT.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    const p = ptrs.get(e.pointerId);
    if (!p) {
      if (mouse) setHover(pick(e.clientX, e.clientY), e.clientX, e.clientY);
      if (mouse && view === 'photos' && photoWall?.hit(rayAt(e.clientX, e.clientY))) canvas.style.cursor = 'grab';
      return;
    }
    if (photoDrag) { // 拖着照片走
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) dragging = true;
      photoWall?.drag(rayAt(e.clientX, e.clientY));
      p.x = e.clientX; p.y = e.clientY;
      return;
    }
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
    if (photoDrag && !ptrs.has(e.pointerId)) return;
    if (photoDrag) { photoWall?.drop(); photoDrag = false; if (dragging) { ptrs.delete(e.pointerId); down = null; dragging = false; canvas.style.cursor = 'grab'; return; } }
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
    if (view === 'about' && !e.metaKey && !e.ctrlKey && !e.altKey && pc.key(e)) { e.preventDefault(); return; } // 电脑菜单：方向键、回车、Esc 返回上一层、数字、L
    if (view === 'resume' && resume?.key(e)) { e.preventDefault(); return; } // 拿着简历：← → 换一张，凑近读时 Esc 先拿远
    if (e.key === 'Escape') { if (closeBook()) return; if (view !== 'home') go('home'); return; }
    if (e.target.closest?.('button,a,input,textarea') && !e.target.closest('#topbar')) return; // 点过导航栏以后方向键照常换带
    if (view === 'shelf' && shelfBooks?.current() != null && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) cmd(e.key === 'ArrowRight' ? 'read-next' : 'read-prev');
    else if (view === 'work' && e.key === 'ArrowRight') cmd('next');
    else if (view === 'work' && e.key === 'ArrowLeft') cmd('prev');
    else if (view === 'work' && e.key === ' ') { e.preventDefault(); cmd('stop'); }
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
  syncBookFromHash();
  // 顶部导航栏：点一项和点对应的物件走同一个 go()；悬停时高亮那个物件
  nav?.bind({
    go, routes: ROUTES.filter(hasView), current: () => view,
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
      if (tp.state === 'rack') { tp.group.position.copy(tp.home.pos); tp.group.position.y += tp.pull * 0.04; } // 悬停时从纸盒里往上抽出一截
    }
    updateCamera(dt);
    // 镜头回到开场的位置（从别的视角过来时要先飞回来）就把纸拿起来：起点按镜头到位时纸在屏幕上的样子算
    if (resumeReq.open && view === 'resume' && (!fly || fly.t > 0.75)) {
      resumeReq.open = false;
      const at = resume.indexForSlug(hashParts()[1]);
      resume.open(at, paperRect(resumeReq.paper ?? langPaper(resume.langAt(at)), goal));
    }
    shelfBooks?.update(dt);
    const pk = view === 'shelf' ? JSON.stringify(shelfBooks?.pageInfo() ?? null) : ''; // 书翻开了 / 翻到别的页：面板上的页码跟着变
    if (pk !== pageKey) { pageKey = pk; if (view === 'shelf') renderPanel(); }
    photoWall?.update(light.room, dt);
    windowView?.update(dt);
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
        else { bloom.enabled = false; grade.lighten(); }
      }
    }
  }
  renderer.setAnimationLoop(frame);

  // 调试入口（控制台里用）：__room.tick(dt) 手动推进一帧（后台标签页里动画会被浏览器降速）
  window.__room = {
    go, insertTape, cmd, tick, pick, look, light, camera, renderer, composer, room, tv, pc, turntable, grade: (k) => grade.set(k), lens, streak, books: shelfBooks, openBook, windowView, turn: TURN, resume, paperRect,
    get photos() { return photoWall; },
    get view() { return view; }, get loaded() { return loaded; }, get hover() { return hover; },
    hoverAt: (x, y) => setHover(pick(x, y), x, y), clickAt: (x, y) => click(x, y, true),
  };
}
