// 3D 房间（烘焙光照版）。几何和光照由 Blender 预先算好（blender/bake_room.py → assets/baked/），这里负责交互：
//   - 开场镜头绕着书桌上的电脑转：拖动换角度（往左拖看到书架、往右拖看到唱机和软木板），滚轮 / 双指拉近拉远
//   - 点物件 → 镜头飞过去：电脑 = 关于我，电视和录像带 = 作品，书架 = 书单，记事本 = 联系
//   - 书架上的真书（js/books.js）：悬停抽出一点，点了抽出来飞到眼前翻开（#shelf/书名）
//   - 挂钟下面的软木板（js/photos.js）：钉着做旧的照片，点了镜头凑到板前看（#photos）
//   - 键盘左边那摞纸 = Papers（js/papers.js，#papers、#papers/conference …）：对折的报纸压着两份论文。镜头不动，整摞从桌上被拿起来
//     举到眼前（报纸展开），左右翻；对焦拉到手里的纸上，屋子虚下去
//   - 窗外（js/window-view.js）：城市全景 + 实时的天空、云、星河、雨、车流、水面涟漪
//     #about #work #shelf #online 都是真实 URL，可以分享，浏览器后退键可用；#credits 是素材致谢（镜头不动，只开面板）
//   - 点桌上的录像带：整盒（纸盒和带子是一体的）飞进录像机，电视播放对应的画面模块；电视画面的颜色实时染色房间
//   - 成就（js/achievements.js）：第一次拿起桌上的纸、走到书架、凑近软木板，右下角弹成就卡片、导航栏打开那一项
//   - 点台灯 / 落地灯开关灯（切的是烘焙好的光照层的系数，不重新算光）
//   - 悬停高亮：热点盒子来自 manifest，着色器把盒子里的像素提亮
//   - 书桌上的木头万年历拨到今天的日期，点它会拨乱再拨回来（js/deskcal.js）
//   - 桌子左头的答录机：有没听过的留言时小红灯闪，点它把 #messages 一条条像字幕一样放出来（js/answering.js）
//   - 答录机前面的转盘电话：点它给主人写留言，发到邮箱（js/phone.js；没配表单地址就打开 Contact）
//   - Bloom 辉光 + 整体滤镜（js/grade.js：默认"电影感"：暖色的晕、横向光丝、跟着镜头对焦的景深；?look=名字 选预设，?looks 显示切换按钮）；
//     帧率太低先降分辨率，再不行就关掉辉光和景深
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TV } from './tv.js';
import { makeBoard } from './activity/board.js';
import { makeSteam } from './activity/steam.js';
import { PCScreen } from './pc.js';
import { paintNote } from './paint.js';
import { createDeskCalendar } from './deskcal.js';
import { createAnsweringMachine } from './answering.js';
import { createPhone } from './phone.js';
import { createDial } from './dial.js';
import { BakedRoom, loadBaked, tvLight } from './baked.js';
import { CameraPass, GradePass, StreakPass, lookPicker } from './grade.js';
import { createTurntable } from './turntable.js';
import { createBooks, bookName } from './books.js';
import { createPhotos } from './photos.js';
import { dressSleeves, joinSleeves } from './sleeves.js';
import { createWindowView } from './window-view.js';
import { createPapersViewer } from './papers.js';
import { sfx } from './sfx.js';
import { roomFiles, bootStage, bootDone } from './boot.js';

const BASE = new URL('../assets/baked/', import.meta.url).href;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = THREE.MathUtils.degToRad;
const ROUTES = ['about', 'papers', 'work', 'shelf', 'photos', 'online', 'phone', 'window', 'activity', 'mug'];
// 界面文字用英文（书架上的书是中文内容，书名、作者照旧）
const HINTS = { activity: 'Activity Almanac · Explore', mug: 'Mug · Watch the steam', about: 'Computer · About me', papers: 'Newspaper & papers · Papers', work: 'TV · Work', shelf: 'Bookshelf · Reading list', photos: 'Cork board · Photos', online: 'Notepad · Contact', window: 'Window · Look outside' };

export async function start(content, { nav = null, music = null, achievements = null, personal = false } = {}) {
  const { tapes, books = [], links } = content;
  const N = tapes.length;
  $('room').hidden = false;
  const canvas = $('gl'), hintEl = $('hint'), backBtn = $('back'), panel = $('panel'), help = $('help');
  const baseTitle = content.name || document.title;
  const TITLES = { activity: `Activity Almanac · ${baseTitle}`, mug: `Mug · ${baseTitle}`, home: baseTitle, about: `About · ${baseTitle}`, papers: `Papers · ${baseTitle}`, work: `Work · ${baseTitle}`, shelf: `Books · ${baseTitle}`, photos: `Photos · ${baseTitle}`, online: `Contact · ${baseTitle}`, phone: `Telephone · ${baseTitle}`, credits: `Credits · ${baseTitle}`, window: `Window · ${baseTitle}` };

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
  const compareWindow = qs.get('window') === 'compare';
  grade.set(qs.get('look') || 'cinema');
  if (qs.has('looks')) lookPicker(grade, (k) => grade.set(k));

  // ---------- 下载 ----------
  // 网页一到 js/boot.js 就开始并行下载（模型、光照贴图、窗外夜景），进度也是它画；这里拿下好的文件
  const files = roomFiles ? await roomFiles : null;
  const data = await loadBaked(BASE, { prefetched: files });
  const room = new BakedRoom(data, { renderer, scene });
  const M = data.manifest;
  const steam = makeSteam(scene, room.byMat.get('mug.0')?.[0]);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const activity = await makeBoard(scene, renderer, M.hotspots?.shelf?.[0], personal || qs.has('usage')).catch(err => {
    console.warn('Activity board unavailable', err);
    return null;
  });
  // 左手边那面墙（画架和窗户之间）的海报和它下面几张打印的插图：烘焙时和墙一起打了光，贴图是空白的占位纸。
  // 两组海报共用模型、烘焙光照和四角胶带，清单按材质名 poster、poster_2… 指定贴图和悬停标题。
  const posterKeys = [...room.byMat.keys()].filter((k) => /^poster(_\d+)?$/.test(k));
  const tapeMeshes = [...(room.byMat.get('poster_tape') || []), ...(room.byMat.get('poster_tape_shadow') || [])]; // 四角的白胶带和它的影子
  // 小胶带在光照图上有的只占几个像素。沿着后墙法线取胶带正下方的墙面光照，保留撕边和独立的投影。
  const wallMeshes = room.byMat.get('wall') || [];
  const tapeRay = new THREE.Raycaster(undefined, new THREE.Vector3(0, 0, -1), 0, 0.05);
  for (const tape of room.byMat.get('poster_tape') || []) {
    const { position, uv1 } = tape.geometry.attributes;
    if (!uv1) continue;
    for (let i = 0; i < position.count; i++) {
      tape.localToWorld(tapeRay.ray.origin.fromBufferAttribute(position, i));
      const hit = tapeRay.intersectObjects(wallMeshes, false)[0];
      const uv = hit?.uv1 || hit?.uv;
      if (uv) uv1.setXY(i, uv.x, uv.y);
    }
    uv1.needsUpdate = true;
  }
  const posterHot = {}, posterTitles = {};
  for (const k of posterKeys) {
    for (const m of room.byMat.get(k)) m.visible = false;
    posterHot[k] = room.hotspots[k];
    delete room.hotspots[k];
  }
  for (const m of tapeMeshes) m.visible = false;
  if (posterKeys.length) {
    const manifestUrl = new URL(personal ? '../assets/posters/posters.json' : '../assets/posters-sample/posters.json', import.meta.url);
    fetch(manifestUrl, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const k of posterKeys) {
          const p = j?.[k];
          if (!p?.file) continue;
          new THREE.TextureLoader().load(new URL(p.file, manifestUrl).href, (tex) => {
            tex.flipY = false; // 和 glTF 的贴图一样（UV 的 v 是倒过来的）
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
            for (const m of room.byMat.get(k)) { m.material.uniforms.albedoMap.value = tex; m.visible = true; }
            for (const m of tapeMeshes) m.visible = true;
            posterTitles[k] = p.title || '';
            if (posterHot[k]) room.hotspots[k] = posterHot[k];
          });
        }
      })
      .catch(() => {});
  }
  // 窗外：动态的雨夜（城市全景 + 天空 + 雨，js/window-view.js）
  const windowView = await createWindowView({ base: BASE, view: data.view, win: M.window, scene, camera, renderer, blob: files?.blob })
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
  // 书桌上的木头万年历：数字方块、星期滚筒、月份条拆出来，拨到今天（过了零点自己翻）
  const deskCal = createDeskCalendar(room);
  // 桌子左头电话旁边的答录机：点它放留言（index.html #messages，别人对你的评价），镜头不动
  const answering = createAnsweringMachine(room, content.messages || [], { parent: $('room'), before: backBtn });
  // 悬停高亮打折的两件：和电脑、录像带看着一样轻（对比过 0.35 … 1 的截图）
  //   答录机：米白外壳正好在台灯底下，本来就亮，照常提亮会越过辉光的门槛，整台泛白发光、刺眼
  //   电话：黑色大件，高亮叠的那层暖色会把整台变成一块平平的灰板子，奶白的拨号盘还冒光
  const HI_SCALE = { 'answering.0': 0.6, 'phone.0': 0.5, 'phone.1': 0.5, phone_wheel: 0.5 };
  for (const [mat, k] of Object.entries(HI_SCALE)) for (const m of room.byMat.get(mat) || []) m.material.uniforms.hiS.value = k;
  // 旁边的转盘电话：给主人留言，发到邮箱（#messages 里 form.leave-message 的 action）；没配地址就打开 Contact
  // 电话转盘拆出来单独转：留言之前先拨几位号码（js/dial.js）
  const dial = createDial(room);
  const phone = M.hotspots?.phone ? createPhone({ form: document.querySelector('#messages form.leave-message'), owner: content.name, dial,
    parent: $('room'), before: backBtn, answering, openContact: () => go('online'),
    onHangUp: () => { if (view === 'phone') go(phoneReturnView); } }) : null;

  // ---------- 录像带：从房间里拆出来，可以单独移动 ----------
  // 录像机跟着电视推车绕 Y 轴转了 yaw：它的正前方是 vcrFwd，带子平躺以后也跟着转同样的角度
  const slot = new THREE.Vector3().fromArray(M.tapes.slot), vcrYaw = M.tapes.yaw || 0;
  const vcrFwd = new THREE.Vector3(Math.sin(vcrYaw), 0, Math.cos(vcrYaw));
  const FLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, vcrYaw, Math.PI / 2, 'YXZ')); // 平躺，侧标仍然朝外
  const P1 = slot.clone().addScaledVector(vcrFwd, 0.13); // 录像机口前面
  const P2 = slot.clone().addScaledVector(vcrFwd, -0.11); // 整盘推进去
  const LIFT = 0.21, UP = new THREE.Vector3(0, 1, 0); // 整盒从架子上往上提多少（盒子 19 厘米高，提过旁边几盒的顶才往外飞）
  // 纸盒和带子是一整盒（js/sleeves.js 的 joinSleeves）：悬停整盒抽出一截，点了整盒飞进录像机
  const phys = joinSleeves(room, room.takeTapes()).map((t, i) => {
    if (i >= N) { t.group.visible = false; return null; } // HTML 里的作品比架子上的带子少：多的藏起来
    for (const m of t.parts) m.userData.tape = i;
    const home = { pos: t.group.position.clone(), quat: t.group.quaternion.clone() };
    // 飞行路线：先竖着从架子上提起来，再往右前方绕到录像机口前面，最后推进去
    // （二次贝塞尔，控制点在提起来的位置上方、往录像机那边偏一点）
    const out = home.pos.clone().add(new THREE.Vector3(0, LIFT, 0));
    const ctrl = new THREE.Vector3(out.x + (P1.x - out.x) * 0.3, out.y + 0.06, Math.max(out.z, P1.z) + 0.05);
    return { ...t, i, home, out, ctrl, state: 'rack', pull: 0, pullT: 0 };
  });
  // 纸盒：按 HTML 里的作品画包装；作品比带子少，多出来的纸盒也藏起来
  dressSleeves(room, tapes);
  function placeTape(t, k) { // k：0 = 在架子上，1 = 整盒进了录像机
    const g = t.group, A0 = 0.2, A = 0.75;
    if (k < A0) { // 竖着从架子上提起来
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
    const play = () => { if (loaded === i) { sfx.play('tv-static', { gain: 0.35, dur: 0.4 }); tv.play(tapes[i]); renderPanel(); } }; // 开机一下雪花
    const load = () => {
      const t = phys[i];
      if (!t || t.state === 'in') return play(); // 架子上放不下的作品：没有实物，直接播
      if (!animate) { inside(i); return play(); }
      settle(i);
      t.state = 'flying';
      tween(t, 1.25, (k) => placeTape(t, k), () => { inside(i); sfx.play('tape-latch'); play(); }); // 塞进录像机：咔
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
  // ---------- 书架上的真书（js/books.js）----------
  const shelfBooks = createBooks({ room, scene, camera, books, frame: () => covered() });
  let pageKey = '';
  const bookSlug = (i) => shelfBooks.entry(i)?.b.title || String(i + 1);
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
  // 照片墙：个人模式（见 main.js）下本地有做旧过的真实照片（assets/photos/photos.json，不进 Git）就用它们，没有就用 index.html 里的样片
  let photoWall = null;
  (personal ? fetch(new URL('../assets/photos/photos.json', import.meta.url), { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null))
    .then((local) => {
      photoWall = createPhotos({ room, scene, photos: local?.photos?.length ? local.photos : content.photos || [] });
      if (view === 'photos') renderPanel();
    });

  // ---------- 键盘左边那摞纸 = Papers（js/papers.js）----------
  // 热点 papers 每份文件一个盒子，从下往上：期刊论文、会议论文、对折的报纸（盒子是报纸朝上那半张）。内容层里的顺序是倒过来的
  // （#papers 的第一份 = 压在最上面的报纸），所以第 i 份 ↔ 第 n-1-i 个盒子。旧的烘焙只有 resume 两个盒子，也认。
  // 镜头不凑过去：点纸，整摞从桌上被拿起来（起点 = 每份此刻在屏幕上的样子），对焦拉到手里的纸上
  const PAPERS_HOT = M.hotspots?.papers ? 'papers' : 'resume';
  const paperBoxes = M.hotspots?.[PAPERS_HOT] || [];
  const papers = paperBoxes.length ? createPapersViewer({
    docs: () => document.querySelectorAll('#papers .pp-doc'),
    top: () => nav?.height() ?? 0,
    onClose: () => go('home'),
    onTurn: (slug) => { // 换到另一份：地址跟着变（#papers = 报纸，#papers/conference …），不加历史记录
      if (view !== 'papers') return;
      const url = '#papers' + (slug ? '/' + slug : '');
      if (location.hash !== url) history.replaceState(null, '', url);
    },
  }) : null;
  if (papers) $('room').insertBefore(papers.el, backBtn);

  // ---------- 电视下面的字幕：节目带（js/tapes/show.js）一章一章地放，每章一句；下面一排小横条是章节，点了跳过去 ----------
  const zhUI = () => (document.documentElement.lang || '').toLowerCase().startsWith('zh');
  const tvSub = document.createElement('div');
  tvSub.className = 'tvsub';
  tvSub.hidden = true;
  tvSub.innerHTML = '<p class="tvsub-text" aria-live="polite"></p><div class="tvsub-nav"><span class="tvsub-dots"></span><span class="tvsub-hint"></span></div>';
  $('room').insertBefore(tvSub, backBtn);
  const subText = tvSub.querySelector('.tvsub-text'), subDots = tvSub.querySelector('.tvsub-dots'), subHint = tvSub.querySelector('.tvsub-hint');
  let subKey = '';
  const autoplay = { run: null, passes: 0 }; // 电视上正在放的节目、它已经放完了几遍
  subDots.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) tv.run?.jump?.(Number(b.dataset.i)); });
  function updateSub() {
    const cap = view === 'work' && tv.state === 'playing' ? tv.run?.caption?.() : null;
    const key = cap ? `${loaded}|${cap.i}|${cap.n}|${cap.text}` : '';
    if (key === subKey) return;
    subKey = key;
    tvSub.hidden = !cap;
    if (!cap) return;
    subText.textContent = cap.text;
    subText.classList.remove('in');
    void subText.offsetWidth; // 换一句字幕：重新淡入
    subText.classList.add('in');
    if (subDots.children.length !== cap.n) {
      subDots.replaceChildren(...Array.from({ length: cap.n }, (_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.i = i;
        b.setAttribute('aria-label', zhUI() ? `第 ${i + 1} 章` : `Chapter ${i + 1}`);
        return b;
      }));
    }
    [...subDots.children].forEach((b, i) => b.setAttribute('aria-current', String(i === cap.i)));
    subHint.textContent = zhUI() ? '↑↓ 换章 · ← → 换带' : '↑↓ chapters · ← → tapes';
  }
  const papersReq = { open: false }; // 要拿起来了（等镜头回到开场的位置）
  // 桌上那摞纸（烘焙里名字以 paper 开头的材质，烘焙时不挡光，所以藏起来桌面上没有影子）：拿起来时离开桌面，放回去时再出现
  const deskPaper = [...room.byMat].filter(([n]) => n.startsWith('paper')).flatMap(([, ms]) => ms);
  const showDeskPaper = (v) => { for (const m of deskPaper) m.visible = v; };
  const inBox = (b, p, pad = 0.01) => {
    const qx = p.x - b.c[0], qz = p.z - b.c[2], c = Math.cos(b.r), s = Math.sin(b.r);
    return Math.abs(c * qx - s * qz) <= b.h[0] + pad && Math.abs(p.y - b.c[1]) <= b.h[1] + pad && Math.abs(s * qx + c * qz) <= b.h[2] + pad;
  };
  const docBox = (i) => clamp(paperBoxes.length - 1 - i, 0, paperBoxes.length - 1); // 第 i 份文件 → 桌上第几个盒子
  const deskRects = (p = null) => (papers?.docs() || []).map((_, i) => paperRect(docBox(i), p));
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
  function syncPapersFromHash() { // 后退 / 前进到 #papers/journal 之类：换到那一份
    if (view === 'papers' && papers?.shown) papers.goTo(papers.indexForSlug(hashParts()[1]));
  }

  const light = { room: 1, roomT: 1, lamp: 1, lampT: 1 };
  const tvTint = new THREE.Color(), tvGray = new THREE.Color();
  // 电视照到屋里的光：画面的颜色往灰白里掺三成（显像管的光照在东西上没有画面本身那么艳，满屏绿字时屋里不至于一片荧光绿）
  const TV_DESAT = 0.3;
  const tvRoomLight = () => {
    tvLight(tv.color, tvTint);
    const l = 0.2126 * tvTint.r + 0.7152 * tvTint.g + 0.0722 * tvTint.b;
    return tvTint.lerp(tvGray.setScalar(l), TV_DESAT);
  };

  // ---------- 镜头 ----------
  // 开场（home）：绕着电脑转（orbit）。姿态 = 转的中心 + 方向（yaw 左右、pitch 上下，和 bake_room.py 的 CAM 一样）+ 距离 + 视角；
  // 拖动在 yawRange / pitchRange 里转，滚轮 / 双指在 distRange 里拉近拉远；镜头出了 manifest.camera.box 就往中心拉近，不会钻进墙里。
  // 点进某个物件时，按 manifest.views 里的目标点、方向、要装下的大小算出镜头位置，并给面板让出地方。
  const C = M.camera;
  const views = { ...M.views };
  if (steam) views.mug = steam.view;
  if (activity) views.activity = activity.view;
  const handset = M.hotspots?.phone?.[0];
  if (handset && phone.canTakeMessages) {
    // Aim at the rotary dial from the visitor's side of the desk. Size the shot from the actual model.
    views.phone = { target: handset.c, size: [1.35 * handset.h[0], handset.h[1] + handset.h[2]], dir: [0.18, 0.72, 0.67] };
  }
  const center0 = new THREE.Vector3().fromArray(C.target), pcPos = new THREE.Vector3().fromArray(M.screens.pc.pos);
  const look = { yaw: C.yaw, pitch: C.pitch, dist: C.dist, yawT: C.yaw, pitchT: C.pitch, distT: C.dist };
  const windowLook = { yaw: -.12, pitch: .035, dist: 1, yawT: -.12, pitchT: .035, distT: 1 };
  const activeLook = () => view === 'window' ? windowLook : look;
  const canLook = () => view === 'home' || view === 'window';
  // 往右转向唱机时镜头怎么跟着挪（见 homePose）：中心往右 33 厘米、往前 28 厘米、低 8 厘米，拉远 22 厘米，多低一点头
  // （在浏览器里比过几组，这组唱机整个露出来、挂钟和照片墙也还在画面里）；__room.turn 可以现场调
  // 往左转：中心往左挪 1.33 米、往前 95 厘米、高 5 厘米（转到头时正好落在左墙书柜的正中），稍微抬一点头——
  // 镜头像是退到屋子右前方回头看左墙：转的途中先经过左后墙角画架上的画，转到头时整个书柜在画面中间、书脊看得清，画在右边
  // （书柜在左墙上，只绕着电脑转的话书柜在画面外）。从书架（#shelf）退回开场时也回到这里，见 setView
  const TURN = { record: { dx: 0.33, dz: 0.28, dy: -0.08, back: 0.22, tilt: -0.12 },
    shelf: { dx: -1.33, dz: 0.95, dy: 0.05, back: 0, tilt: 0.04 } };
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
  function windowPose(out) {
    const win = M.window, pano = data.view.pano;
    // Stand just inside the glass, at eye level in the clear pane to the right of the centre mullion.
    out.pos.set(win.x + win.w * .125, win.y + win.h * .075, win.z - win.depth * .46);
    const halfV = Math.min(deg((camera.aspect < .8 ? 49 : 41) * windowLook.dist / 2),
      Math.atan(Math.tan(deg(46)) / camera.aspect));
    out.fov = THREE.MathUtils.radToDeg(2 * halfV);
    // Keep all four corners inside the baked panorama, including at the steepest tilt and on ultrawide screens.
    const margin = deg(3);
    const low = deg(pano.lat[0]) + margin + halfV, high = deg(pano.lat[1]) - margin - halfV;
    out.pitch = clamp(windowLook.pitch, low, high);
    windowLook.pitchT = clamp(windowLook.pitchT, low, high);
    const halfH = Math.atan2(camera.aspect * Math.tan(halfV),
      Math.cos(out.pitch) - Math.abs(Math.sin(out.pitch)) * Math.tan(halfV));
    const left = -deg(pano.lon[1]) + margin + halfH, right = -deg(pano.lon[0]) - margin - halfH;
    out.yaw = clamp(windowLook.yaw, left, right);
    windowLook.yawT = clamp(windowLook.yawT, left, right);
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
    // 往左转向左墙的书柜（yaw > 0）、往右转向矮柜上的唱机（yaw < 0）：转的中心、距离、低头按 TURN 跟着挪，转到头时整个转进画面。
    // 正对电脑的开场构图不变（正前方 ±3° 以内不动），转回来就复原。竖屏手机有自己的构图，不加
    const shelfTurn = smooth(0.05, C.yawRange[1], look.yaw) * (1 - narrow);
    const recordTurn = smooth(-0.05, -0.75, look.yaw) * (1 - narrow);
    const R = TURN.record, S = TURN.shelf;
    center.x += S.dx * shelfTurn + R.dx * recordTurn;
    center.z += S.dz * shelfTurn + R.dz * recordTurn;
    center.y += S.dy * shelfTurn + R.dy * recordTurn;
    return orbitPose(out, center, look.yaw, look.pitch + S.tilt * shelfTurn + R.tilt * recordTurn,
      look.dist * (1 - 0.32 * narrow) + S.back * shelfTurn + R.back * recordTurn);
  }
  function covered() { // 面板挡住了多少像素：宽屏在右边，窄屏在下面；top 是顶部导航栏
    const top = nav?.height() ?? 0;
    if (view === 'phone') return { w: 0, h: phone.overlayHeight, top };
    if (panel.hidden) return { w: 0, h: 0, top };
    const r = panel.getBoundingClientRect();
    return innerWidth > 600 ? { w: innerWidth - r.left + 16, h: 0, top } : { w: 0, h: innerHeight - r.top + 12, top };
  }
  function focusPose(name, out) {
    const v = views[name];
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
    const current = activeLook();
    current.yaw += (current.yawT - current.yaw) * a;
    current.pitch += (current.pitchT - current.pitch) * a;
    current.dist += (current.distT - current.dist) * a;
    par.lerp(parT, 1 - Math.exp(-dt * 3));
    goalPose(goal);
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / fly.dur);
      const e = ease(fly.t), f = fly.from;
      cur.pos.lerpVectors(f.pos, goal.pos, e);
      cur.yaw = f.yaw + angle(goal.yaw - f.yaw) * e;
      cur.pitch = f.pitch + (goal.pitch - f.pitch) * e;
      cur.fov = f.fov + (goal.fov - f.fov) * e;
      if (!(fly.t < 1)) fly = null; // 写成 !(< 1)：万一算出了 NaN 也能飞完，不会卡在半路
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
    if (view === 'window') fd = 35;
    else if (view === 'papers' && papers?.shown) fd = 0.32; // 手里拿着纸：对焦在眼前三十厘米，屋子整个虚下去
    else {
      const fp = shelfBooks?.focus() || (orbiting() ? center : focusPt.fromArray(views[view].target));
      fd = Math.max(0.15, focusPt.subVectors(fp, camera.position).dot(fwd));
    }
    lens.focus = focusSnap || !Number.isFinite(lens.focus) ? fd : lens.focus + (fd - lens.focus) * (1 - Math.exp(-dt * 6));
    focusSnap = false;
  }
  function zoom(k) {
    const current = activeLook();
    current.distT = clamp(current.distT * k, ...(view === 'window' ? [.72, 1.12] : C.distRange));
  }
  function turnLook(dx, dy) {
    const current = activeLook();
    current.yawT -= dx;
    current.pitchT -= dy;
    if (view === 'window') return; // Window bounds depend on the current FOV and are applied in windowPose.
    look.yawT = clamp(look.yawT, ...C.yawRange);
    look.pitchT = clamp(look.pitchT, ...C.pitchRange);
  }

  // ---------- 路由（URL hash ↔ 镜头） ----------
  let view = null, phoneReturnView = 'home';
  const hashParts = () => {
    let h = location.hash.slice(1);
    try { h = decodeURIComponent(h); } catch { /* 保留原样 */ }
    const k = h.indexOf('/');
    const r = k < 0 ? [h, ''] : [h.slice(0, k), h.slice(k + 1)];
    if (r[0] === 'resume') r[0] = 'papers'; // 旧地址：桌上那摞纸以前是简历
    return r;
  };
  function hasView(h) {
    if (h === 'window') return !!windowView;
    if (h === 'papers') return !!papers;
    return !!views[h];
  }
  if (/^#resume\b/.test(location.hash)) history.replaceState(null, '', '#papers'); // 旧地址：桌上那摞纸以前是简历
  const viewFromHash = () => { const [h] = hashParts(); return h === 'credits' || (ROUTES.includes(h) && hasView(h)) ? h : 'home'; };
  // 致谢只是开个面板、桌上的纸是拿起来看：镜头都还是开场那样绕着电脑，不凑过去
  const orbiting = () => view === 'home' || view === 'credits' || view === 'papers';
  function goalPose(out) {
    if (view === 'window') return windowPose(out);
    return orbiting() ? homePose(out) : focusPose(view, out);
  }
  function go(name) {
    const url = name === 'home' ? location.pathname + location.search : '#' + name;
    if ((location.hash.slice(1) || 'home') !== name) history.pushState(null, '', url);
    setView(name);
  }
  function setView(name, instant = false) {
    if (name === view) return;
    const first = view === null, prev = view;
    view = name;
    music?.closeCard?.(); // 换了视角就不再是在摆弄唱机：唱片卡片收起来
    if (name !== 'home') answering?.stop();
    if (name === 'phone') {
      phoneReturnView = prev === 'online' ? 'online' : 'home';
      phone.click();
    } else if (prev === 'phone') phone.hangUp();
    if (name !== 'shelf') shelfBooks?.close();
    if (prev === 'papers' && papers) { // 放回桌上（从现在的镜头看过去的位置）：手里的纸开始淡出、快落到桌面时，桌上那摞纸接上
      const back = papers.close(deskRects());
      setTimeout(() => { if (!papers.shown) showDeskPaper(true); }, 420);
      back.then(() => { if (!papers.shown) showDeskPaper(true); });
    }
    // 从书架退回开场：镜头退回往左转到头的位置（正对书柜），不回到点书之前转到的半路（那里正对着墙角的画）。竖屏手机往左转不挪中心，不改
    if ((prev === 'shelf' || prev === 'activity') && name === 'home' && camera.aspect >= 1.2) look.yaw = look.yawT = C.yawRange[1];
    papersReq.open = name === 'papers';
    pc.setActive(name === 'about');
    if (name === 'work' && loaded == null) insertTape(0, { animate: !instant });
    setHover(null);
    backBtn.hidden = name === 'home';
    backBtn.textContent = name === 'window' ? '← Back to desk' : '← Back';
    // The nearest glass surface is about a centimetre from the window seat.
    camera.near = name === 'window' ? .004 : .02;
    camera.updateProjectionMatrix();
    help.hidden = !canLook();
    $('desk-help').hidden = name !== 'home';
    $('window-help').hidden = name !== 'window';
    document.title = TITLES[name];
    nav?.setActive(name === 'home' ? null : name);
    renderPanel();
    achievements?.visit(name); // 第一次拿起桌上的纸、走到书架、凑近软木板：成就 + 导航栏打开那一项
    if (instant || first) fly = null;
    else startFly();
  }
  addEventListener('popstate', () => { setView(viewFromHash()); syncBookFromHash(); syncPapersFromHash(); });

  // ---------- HTML 面板 ----------
  function renderPanel() {
    let html = '';
    // 电视（#work）、电脑（#about）不弹面板：画面就在屏幕上（换录像带：点桌上的带子，或者 ← →、空格）
    if (view === 'work' || view === 'about') {
      html = '';
    // 书架（读书）和照片墙也不弹面板：点右页往后翻、点左页往回翻、点别处放下
    } else if (view === 'credits') {
      html = `<div class="kicker">Credits</div><h2>Models in this room</h2>${creditsHtml()}`;
    } else if (view === 'online') {
      html = `<div class="kicker">Contact</div>
        <ul class="list">${links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} <span>${esc(l.handle)}</span></a></li>`).join('')}</ul>`;
    }
    panel.innerHTML = html;
    panel.hidden = !html;
  }
  // Contact links still lead to the text form when opened in a new tab or without the 3D phone.
  const messageUrl = new URL('?plain=1#leave-message', document.baseURI).href;
  function openContactMessage(url) {
    if (!views.phone || url !== messageUrl) return false;
    go('phone');
    return true;
  }
  panel.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && openContactMessage(link.href)) {
      e.preventDefault();
      return;
    }
    const b = e.target.closest('button');
    if (b?.dataset.book != null) openBook(Number(b.dataset.book));
    else if (b?.dataset.cmd) cmd(b.dataset.cmd);
  });
  backBtn.addEventListener('click', () => go('home'));
  const windowLink = $('window-link');
  windowLink.hidden = !windowView;
  windowLink.addEventListener('click', (e) => { e.preventDefault(); go('window'); });
  achievements?.setAvoid(() => (panel.hidden ? null : panel.getBoundingClientRect())); // 成就卡片让开右下角的面板

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
  $('desk-help').append(' · ', creditLink);
  // 声音开关：记在 localStorage（js/sfx.js）
  const soundLink = document.createElement('a');
  soundLink.href = '#';
  const soundText = (on) => { soundLink.textContent = on ? 'Sound on' : 'Sound off'; soundLink.setAttribute('aria-pressed', String(on)); };
  soundText(sfx.on);
  soundLink.addEventListener('click', (e) => { e.preventDefault(); soundText(sfx.toggle()); });
  $('desk-help').append(' · ', soundLink);

  // ---------- 拾取：射线打到的第一个面 → 是录像带，还是在哪个热点盒子里 ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pickables = [room.root, ...screens, ...phys.filter(Boolean).map((t) => t.group), ...(shelfBooks?.groups || [])];
  if (activity) pickables.push(activity.pickPlane);
  if (turntable) pickables.push(turntable.group);
  if (deskCal) pickables.push(...deskCal.groups);
  if (answering) pickables.push(...answering.groups);
  if (dial) pickables.push(dial.group);
  if (contactNote) pickables.push(contactNote);
  const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  function pick(x, y) {
    if (view === 'window') return null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld(); // 镜头这一帧可能还没渲染过
    ray.setFromCamera(ndc, camera);
    const extra = shelfBooks?.rig ? [shelfBooks.rig] : [];
    for (const hit of ray.intersectObjects([...extra, ...pickables], true)) {
      if (!shown(hit.object)) continue;
      if (hit.object === activity?.pickPlane) {
        return view === 'activity' ? activity.hit(hit.point) : { kind: 'activity', key: 'activity' };
      }
      const matName = hit.object.material?.name;
      if (steam && (matName === 'mug.0' || matName === 'mug.1')) return { kind: 'mug', key: 'mug' };
      if (view === 'home' && windowView && (matName === 'window_glass' || matName?.startsWith('window.') || matName === 'sill')) {
        return { kind: 'window', key: 'window' };
      }
      if (hit.object === contactNote) {
        const f = contactNote.userData.frame, p = hit.point.clone().sub(f.center);
        const link = view === 'online' ? noteTex.image.linkAt(p.dot(f.right) / (2 * f.hw) + 0.5, p.dot(f.long) / (2 * f.hh) + 0.5) : null;
        return link?.url ? { kind: 'contact', key: 'contact:' + link.url, url: link.url, label: link.label, handle: link.handle }
          : { kind: 'online', key: 'online' };
      }
      if (music && hit.object.userData.recordPlayer) return { kind: 'music', key: 'music' };
      if (hit.object.userData.deskCal) return { kind: 'calendar', key: 'calendar' };
      if (hit.object.userData.answering) return { kind: 'messages', key: 'messages' };
      const ti = hit.object.userData.tape;
      if (ti != null) return { kind: 'tape', key: 'tape' + ti, i: ti };
      if (shelfBooks?.isRig(hit.object)) {
        const url = shelfBooks.linkAt(hit);
        const side = url ? null : shelfBooks.sideAt(hit);
        return { kind: 'page', key: url ? 'link:' + url : 'page-' + side, url, side };
      }
      const bi = hit.object.userData.book;
      if (bi != null) return { kind: 'book', key: 'book' + bi, i: bi };
      if (hit.object === screens[0] && view === 'work' && tv.run?.seek) return { kind: 'work', key: 'tvscreen', tvScreen: true }; // 正在放节目带：点电视 = 下一章
      if (hit.object === screens[1] && hit.uv) { // 电脑屏幕：带上 UV，菜单按它算点的是哪一行
        const a = view === 'about' ? pc.at(hit.uv) : null;
        return { kind: 'about', key: 'about' + (a ? a.do + (a.row ?? '') : ''), uv: hit.uv.clone() };
      }
      const name = room.hotspotAt(hit.point);
      if (name === PAPERS_HOT) return { kind: 'papers', key: 'papers' };
      return name ? { kind: name, key: name } : null; // 第一个可见的面：是热点就返回，不是就挡住后面的东西
    }
    return null;
  }
  function hintText(h) {
    if (h.kind === 'source' || h.kind === 'day') return h.label;
    if (h.kind === 'contact') return `${h.label} · ${h.handle || h.url}`;
    if (h.kind === 'music') return music?.cardOpen === false ? 'Record player · Pick a record' : music?.cardOpen ? 'Record player · Close' : music?.playing ? 'Record player · Pause' : 'Record player · Play';
    if (h.kind === 'tape') return `▶ ${tapes[h.i].title}`;
    if (h.kind === 'book') { const e = shelfBooks.entry(h.i); return `${bookName(e.b.title)} · ${e.b.author}`; }
    if (h.kind === 'page') {
      if (h.url) return 'Open ↗';
      const pi = shelfBooks.pageInfo();
      if (!pi) return '';
      return h.side === 'right' ? (pi.page < pi.pages ? 'Next page →' : '') : (pi.page > 1 ? '← Previous page' : '');
    }
    if (h.kind === 'calendar') return deskCal ? `Calendar · ${deskCal.label()}` : '';
    if (h.kind === 'messages') return answering?.hint() || '';
    if (h.kind === 'phone') return phone?.hint() || '';
    if (h.kind === 'art') return M.art?.title || ''; // 墙角画架上的画：只有提示（画名在 manifest.art），点了不跳转
    if (/^poster/.test(h.kind)) return posterTitles[h.kind] || ''; // 墙上的海报、插图：只有提示
    if (h.kind === 'lamp') return light.lampT ? 'Desk lamp · Turn off' : 'Desk lamp · Turn on';
    if (h.kind === 'room') return light.roomT ? 'Room light · Turn off' : 'Room light · Turn on';
    if (h.kind === 'about' && view === 'about') return pc.hintAt(h.uv);
    if (h.tvScreen) return zhUI() ? '下一章 →' : 'Next chapter →';
    return HINTS[h.kind] || '';
  }
  let hover = null;
  function setHover(h, x, y) {
    if (h && h.kind === view && view !== 'about' && !h.tvScreen) h = null; // 已经在看它了
    if (view === 'about') pc.hover(h?.kind === 'about' ? h.uv : null); // 电脑菜单：鼠标停在哪一行就选中哪一行
    if (h?.key !== hover?.key) {
      if (hover?.kind === 'tape' && phys[hover.i]) phys[hover.i].pullT = 0;
      hover = h;
      shelfBooks?.hover(h?.kind === 'book' ? h.i : null);
      if (h?.kind === 'tape') { if (phys[h.i]?.state === 'rack') phys[h.i].pullT = 1; }
      else if (h?.kind === 'book' || h?.kind === 'page') { /* 书自己抽出来提亮，不画热点盒子 */ }
      else if (h) room.highlight(h.kind === 'papers' ? PAPERS_HOT : h.kind); // 移开时不清盒子，让高亮淡出
      canvas.style.cursor = h ? 'pointer' : canLook() ? 'grab' : 'default';
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
    if (view === 'window') return;
    const h = pick(x, y);
    if (h?.kind !== 'music') music?.closeCard?.(); // 点了唱机以外的地方：唱片卡片收起来（和别的面板一样）
    if (h?.kind === 'page') {
      if (h.url) window.open(h.url, '_blank', 'noopener');
      else if (h.side) { shelfBooks.turn(h.side === 'right' ? 1 : -1); setHover(h, x, y); }
      return;
    }
    if (view === 'shelf' && h?.kind !== 'book' && closeBook()) return; // 书翻开着：点别处先合上书
    if (!h) { if (view !== 'home') go('home'); return; }
    if (h.kind === 'contact') {
      if (openContactMessage(h.url)) return;
      const link = document.createElement('a');
      link.href = h.url;
      link.hidden = true;
      if (/^https?:/i.test(h.url)) { link.target = '_blank'; link.rel = 'noopener'; }
      document.body.append(link);
      link.click();
      link.remove();
    }
    else if (h.kind === 'source') activity.choose(h.source);
    else if (h.kind === 'day') activity.chooseDay(h.day);
    else if (h.kind === 'book') openBook(h.i);
    else if (h.kind === 'tape') { insertTape(h.i); go('work'); }
    else if (h.kind === 'music') { if (music?.toggleCard) music.toggleCard(); else music?.toggle(); } // 点唱机：打开 / 收起唱片卡片
    else if (h.kind === 'calendar') deskCal?.shuffle();
    else if (h.kind === 'messages') { phone?.hangUp(); answering?.press(); }
    else if (h.kind === 'phone') {
      if (views.phone && view !== 'phone') go('phone');
      else phone?.click();
    }
    else if (h.kind === 'art' || /^poster/.test(h.kind)) return;
    else if (h.kind === 'lamp') { light.lampT = light.lampT ? 0 : 1; sfx.play('switch'); }
    else if (h.kind === 'room') { light.roomT = light.roomT ? 0 : 1; sfx.play('switch', { rate: 0.85 }); }
    else if (h.kind === 'about' && view === 'about') pc.click(h.uv);
    else if (h.tvScreen) { tv.run?.seek?.(1); sfx.play('tv-glitch'); sfx.play('tv-static', { gain: 0.25, dur: 0.25 }); }
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
      if (pinch && canLook()) zoom(Math.exp((before - after) * 0.005)); // 两指分开 = 拉近
      pinch = 1;
      return;
    }
    if (down && !dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
      dragging = true;
      setHover(null);
      if (canLook()) canvas.style.cursor = 'grabbing';
    }
    if (dragging && canLook()) {
      const k = 0.006 * (mouse ? 1 : 1.4);
      turnLook((e.clientX - p.x) * k, (e.clientY - p.y) * k);
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
    canvas.style.cursor = hover ? 'pointer' : canLook() ? 'grab' : 'default';
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
    if (canLook()) zoom(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))); // 往下滚 = 拉远
    else if (view === 'about') {
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY; // 触控板一次滚动会来很多小事件，攒够一行再翻
      while (Math.abs(wheelAcc) >= 40) { pc.scrollBy(Math.sign(wheelAcc)); wheelAcc -= Math.sign(wheelAcc) * 40; }
    }
  }, { passive: false });
  addEventListener('keydown', (e) => {
    if (view === 'activity' && !e.metaKey && !e.ctrlKey && !e.altKey && activity.keyPress(e.key)) { e.preventDefault(); return; }
    if (view === 'about' && !e.metaKey && !e.ctrlKey && !e.altKey && pc.key(e)) { e.preventDefault(); return; } // 电脑菜单：方向键、回车、Esc 返回上一层、数字、L
    if (view === 'papers' && papers?.key(e)) { e.preventDefault(); return; } // 拿着纸：← → 翻，凑近读时 Esc 先拿远
    if (e.key === 'Escape') {
      if (music?.cardOpen && music.closeCard) { music.closeCard(); return; } // 唱片卡片开着：Esc 先收起它
      if (closeBook()) return;
      if (answering?.playing) { answering.stop(); return; } // 答录机在放留言：Esc 先停下
      if (phone?.open) { phone.hangUp(); return; } // 电话拿着：Esc 挂断
      if (view !== 'home') go('home');
      return;
    }
    if (e.target.closest?.('button,a,input,textarea') && !e.target.closest('#topbar')) return; // 点过导航栏以后方向键照常换带
    if (view === 'window' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      turnLook((Number(e.key === 'ArrowRight') - Number(e.key === 'ArrowLeft')) * .07,
        (Number(e.key === 'ArrowDown') - Number(e.key === 'ArrowUp')) * .07);
      return;
    }
    if (view === 'shelf' && shelfBooks?.current() != null && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) cmd(e.key === 'ArrowRight' ? 'read-next' : 'read-prev');
    else if (view === 'work' && e.key === 'ArrowRight') cmd('next');
    else if (view === 'work' && e.key === 'ArrowLeft') cmd('prev');
    else if (view === 'work' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && tv.run?.seek) { e.preventDefault(); tv.run.seek(e.key === 'ArrowDown' ? 1 : -1); sfx.play('tv-glitch'); } // 节目带：换章
    else if (view === 'work' && e.key === ' ') { e.preventDefault(); cmd('stop'); }
  });

  // ---------- 尺寸 ----------
  function resize() {
    const w = innerWidth, h = innerHeight;
    if (!w || !h) return; // 窗口被收起（宽或高是 0）：别算，0/0 的宽高比会让镜头变成 NaN
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
    updateSub();
    // 节目带放完一遍就换下一盘：打开网站以后电视一直在放，四个项目轮流来（用户自己点了别的带子也接着往下轮）
    if (tv.run !== autoplay.run) { autoplay.run = tv.run; autoplay.passes = tv.run?.passes ?? 0; }
    else if (tv.run && tv.run.passes > autoplay.passes && N > 1) { autoplay.passes = tv.run.passes; insertTape((loaded ?? 0) + 1); }
    pc.update(t, dt);
    turntable?.update(dt, music?.playing, music?.track);
    sfx.mix({ tv: !tv.run ? 0 : view === 'work' ? 1 : 0.35, record: !!music?.playing }); // 电视放节目：低低的背景音乐（点进电视时大一点）；唱机放歌时让开
    deskCal?.update(dt);
    answering?.update(dt);
    dial?.update(dt);
    if ((hover?.kind === 'messages' || hover?.kind === 'phone') && hintEl.classList.contains('show')) { const text = hintText(hover); if (hintEl.textContent !== text) hintEl.textContent = text; }
    if (hover?.kind === 'music' && hintEl.classList.contains('show')) {
      const text = hintText(hover);
      if (hintEl.textContent !== text) hintEl.textContent = text;
    }
    room.update({ room: light.room, lamp: light.lamp, tv: tvRoomLight() });
    room.U.hiK.value += ((hover && hover.kind !== 'tape' ? 1 : 0) - room.U.hiK.value) * (1 - Math.exp(-dt * 14));
    for (const tp of phys) {
      if (!tp) continue;
      tp.pull += (tp.pullT - tp.pull) * s;
      for (const m of tp.parts) m.material.uniforms.hi.value = tp.pull;
      if (tp.state === 'rack') { tp.group.position.copy(tp.home.pos); tp.group.position.y += tp.pull * 0.04; } // 悬停时整盒往上抽出一截
    }
    updateCamera(dt);
    activity?.tick(reduceMotion.matches ? 1.5 : t, light.room);
    steam?.tick(reduceMotion.matches ? 2 : t, camera);
    // 镜头回到开场的位置（从别的视角过来时要先飞回来）就把纸拿起来：起点按镜头到位时纸在屏幕上的样子算
    if (papersReq.open && view === 'papers' && (!fly || fly.t > 0.75)) {
      papersReq.open = false;
      if (papers.open(papers.indexForSlug(hashParts()[1]), deskRects(goal))) showDeskPaper(false);
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
    if (frames === 0) bootDone();
    if (frames < 150 && ++frames > 30) {
      slow += dt;
      if (frames === 150 && slow / 120 > 1 / 28) {
        if (dpr > 1) { dpr = 1; renderer.setPixelRatio(1); composer.setPixelRatio(1); resize(); frames = 1; slow = 0; }
        else { bloom.enabled = false; grade.lighten(); }
      }
    }
  }
  // 第一帧要编译所有着色器（主线程会卡一下）：先让进度上的这行字画出来
  bootStage('compiling shaders');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  renderer.setAnimationLoop(frame);

  if (compareWindow) {
    const review = $('window-compare'), group = review.querySelector('[role="group"]');
    const status = review.querySelector('[role="status"]');
    review.hidden = false;
    const enableComparison = async () => {
      if (!windowView) throw new Error('Window panorama unavailable');
      const select = await windowView.streetComparison();
      const buttons = group.querySelectorAll('[data-window]');
      const show = (variant) => {
        select(variant === 'street');
        for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.window === variant));
      };
      for (const b of buttons) b.onclick = () => show(b.dataset.window);
      show('original');
      group.hidden = false;
      status.textContent = '';
    };
    enableComparison().catch((err) => {
      status.textContent = '窗景对比加载失败，请刷新重试。 / Reload to retry.';
      console.warn('Window lighting comparison', err);
    });
  }

  // 唱片：房间出来就放（js/music.js 的 autoplay；浏览器要等访客第一次操作才让出声）。底部 Sound 关着就不放，关掉 Sound 唱片也停
  music?.autoplay?.({ allowed: () => sfx.on });
  sfx.onChange((on) => music?.mute?.(!on));

  // 调试入口（控制台里用）：__room.tick(dt) 手动推进一帧（后台标签页里动画会被浏览器降速）
  window.__room = {
    go, insertTape, cmd, tick, pick, look, light, camera, renderer, composer, room, tv, pc, turntable, answering, phone, dial, grade: (k) => grade.set(k), lens, streak, books: shelfBooks, openBook, windowView, turn: TURN, papers, paperRect, deskRects,
    get photos() { return photoWall; },
    get view() { return view; }, get loaded() { return loaded; }, get hover() { return hover; },
    hoverAt: (x, y) => setHover(pick(x, y), x, y), clickAt: (x, y) => click(x, y, true),
  };
}
