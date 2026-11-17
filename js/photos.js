// 照片墙：挂钟下面的软木板（js/room.js 用）。点软木板，镜头凑到板前（#photos），照片就钉在板上看，不另外弹相册。
//   - 板面先盖一层程序画的软木（盖住素材自带的那几张照片），再把照片（blender/age_photos.py 做旧过的）散着钉上去：
//     微微歪着、互相压着一点、各有一颗图钉、底下一点投影；角是卷起来的（网格真的翘起来，翘起来的地方明暗跟着变）
//   - 凑近看的时候可以拖动照片：按住的那张提起来、放到最上面，松手落下。摆好的位置记在这个浏览器里（localStorage），
//     下次来还是这样；面板里"摆回原样"清掉
//   - 板面的中心、大小、朝向来自 manifest.photos（烘焙脚本量的）。这些是后加的面片，没有烘焙光照：亮度跟着屋里的灯走
import * as THREE from 'three';

const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) % 2147483646 + 1; };
const STORE = 'scenecv.photos.layout';

// 软木：棕色底，上面一层层深浅不一的小颗粒，边上暗一点
function paintCork(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#a36f45';
  x.fillRect(0, 0, w, h);
  const r = rnd(41);
  for (let i = 0; i < (w * h) / 6; i++) {
    const t = r();
    const col = t < 0.45 ? [92, 58, 34] : t < 0.8 ? [176, 128, 84] : [210, 165, 112];
    x.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.25 + r() * 0.45})`;
    const s = 0.8 + r() * 2.6;
    x.fillRect(r() * w, r() * h, s, s * (0.6 + r() * 0.8));
  }
  for (let i = 0; i < 40; i++) { // 几个图钉留下的小孔
    x.fillStyle = 'rgba(40,24,12,0.55)';
    x.beginPath();
    x.arc(r() * w, r() * h, 1.2 + r() * 1.2, 0, Math.PI * 2);
    x.fill();
  }
  const g = x.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.62);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(30,15,5,0.35)');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  return c;
}
// 投影：中间深、四边慢慢淡掉的一块
function paintShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 10, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return c;
}

// 一张照片的网格：w × h 米，角卷起来。curls = [{ cx, cy, lift, r }]：cx/cy = ±1（哪个角），lift = 翘多高（米），r = 卷的范围（占短边的比例）。
// 顺手按法线算一层顶点颜色当光照：光从左上前方来，翘起来的地方有亮有暗
const LIGHT = new THREE.Vector3(-0.35, 0.55, 0.76).normalize();
function curledPlane(w, h, curls, wave) {
  const g = new THREE.PlaneGeometry(w, h, 18, 18);
  const P = g.attributes.position, m = Math.min(w, h);
  for (let k = 0; k < P.count; k++) {
    const x = P.getX(k), y = P.getY(k);
    let z = wave * Math.sin((x / w) * 5.1 + 1.3) * Math.sin((y / h) * 3.7 + 0.4); // 整张纸有一点点不平
    for (const c of curls) {
      const d = Math.hypot(x - (c.cx * w) / 2, y - (c.cy * h) / 2) / (c.r * m);
      if (d < 1) z += c.lift * (1 - d) ** 2.2;
    }
    P.setZ(k, z);
  }
  g.computeVertexNormals();
  const N = g.attributes.normal, col = new Float32Array(P.count * 3), n = new THREE.Vector3();
  for (let k = 0; k < P.count; k++) {
    n.fromBufferAttribute(N, k);
    const v = THREE.MathUtils.clamp(0.9 + 0.85 * (n.dot(LIGHT) - LIGHT.z), 0.5, 1.15);
    col.set([v, v, v * 0.98], k * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function createPhotos({ room, scene, photos = [] }) {
  const P = room.manifest.photos;
  if (!P || !photos.length) return null;

  const group = new THREE.Group();
  const right = new THREE.Vector3().fromArray(P.right), normal = new THREE.Vector3().fromArray(P.normal), up = new THREE.Vector3(0, 1, 0);
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal)); // 面片的 +z = 板面朝屋里的方向
  group.position.fromArray(P.center);
  scene.add(group);
  group.updateMatrixWorld(true);
  const [bw, bh] = P.size;
  const lit = []; // 跟着屋里的灯变亮变暗的材质：[材质, 本身的颜色]

  // 软木：盖住板面（留出一圈木框）
  const corkTex = new THREE.CanvasTexture(paintCork(1024, 512));
  corkTex.colorSpace = THREE.SRGBColorSpace;
  corkTex.anisotropy = 8;
  const corkMat = new THREE.MeshBasicMaterial({ map: corkTex });
  lit.push([corkMat, new THREE.Color(1, 1, 1)]);
  const inset = bw * 0.048; // 木框的宽度跟着板子一起缩放
  const cork = new THREE.Mesh(new THREE.PlaneGeometry(bw - inset, bh - inset), corkMat);
  cork.position.z = 0.0025;
  group.add(cork);
  const UW = bw - inset - 0.07, UH = bh - inset - 0.05; // 照片中心能放的范围

  // 默认摆法：两排，互相压着一点，微微歪着；位置和角度由照片的文件名定（换顺序不乱）
  const list = photos.slice(0, 12), n = list.length;
  const rows = n <= 4 ? 1 : 2, cols = Math.ceil(n / rows), step = (UW * 0.88) / cols; // 往中间收一点，留出一圈软木
  const L = Math.min(0.19, step * 1.35); // 照片长边：比间距大一截，相邻的照片互相压住一点
  function home(i, src) {
    // 照片列表里写了位置（x、y 是板面上的米，rot 弧度，order 越大越靠上）就照它摆
    const p = list[i];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y, rot: p.rot || 0, order: p.order ?? i };
    const r = rnd(hash(src));
    const row = Math.floor(i / cols), col = i - row * cols, inRow = row === rows - 1 ? n - row * cols : cols;
    const x0 = (col - (inRow - 1) / 2) * step;
    return {
      x: x0 + (r() - 0.5) * step * 0.25,
      y: (rows === 1 ? 0 : (row === 0 ? 1 : -1) * UH * 0.22) + (r() - 0.5) * UH * 0.12,
      rot: (r() - 0.5) * 0.24,
      order: i,
    };
  }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { saved = {}; }

  const loader = new THREE.TextureLoader();
  const pin = new THREE.SphereGeometry(0.0045, 14, 10);
  const pinMat = new THREE.MeshBasicMaterial({ depthWrite: false }); // 和照片一样靠先后顺序叠：压在上面的照片盖得住下面那张的图钉
  lit.push([pinMat, new THREE.Color('#c0392b').multiplyScalar(1.6)]);
  const shadowTex = new THREE.CanvasTexture(paintShadow());
  const items = [];
  list.forEach((p, i) => {
    const src = p.board || p.src;
    const it = { src, ...home(i, src), ...(saved[src] || {}), lift: 0, liftT: 0, w: L, h: L / 1.3 };
    const r = rnd(hash(src) + 7);
    it.curls = [{ cx: r() < 0.5 ? -1 : 1, cy: -1, lift: 0.009 + r() * 0.012, r: 0.4 + r() * 0.2 }];
    if (r() < 0.5) it.curls.push({ cx: it.curls[0].cx * -1, cy: r() < 0.6 ? -1 : 1, lift: 0.005 + r() * 0.008, r: 0.3 + r() * 0.15 });
    it.wave = 0.0008 + r() * 0.0012;
    it.g = new THREE.Group();
    it.mat = new THREE.MeshBasicMaterial({ vertexColors: true, depthWrite: false });
    it.mesh = new THREE.Mesh(new THREE.PlaneGeometry(it.w, it.h), it.mat);
    it.mesh.visible = false; // 图片到了再显示
    it.mesh.userData.photo = it;
    it.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false });
    it.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), it.shadowMat);
    it.shadow.visible = false;
    it.pin = new THREE.Mesh(pin, pinMat);
    it.g.add(it.shadow, it.mesh, it.pin);
    group.add(it.g);
    items.push(it);
    loader.load(src, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const a = tex.image.width / tex.image.height;
      // 横的：长边 L；竖的：高 L，但不高过两排各自能占的高度
      if (a >= 1) { it.w = L; it.h = L / a; } else { it.h = Math.min(L, UH * 0.56); it.w = it.h * a; }
      it.mesh.geometry.dispose();
      it.mesh.geometry = curledPlane(it.w, it.h, it.curls, it.wave);
      it.mat.map = tex;
      it.mat.needsUpdate = true;
      lit.push([it.mat, new THREE.Color(1.15, 1.15, 1.15)]); // 相纸比软木亮一点，照片里的东西看得清
      it.mesh.visible = it.shadow.visible = true;
      place(it);
    }, undefined, () => { it.pin.visible = false; });
  });

  // 摆到位置上：叠放的先后用 renderOrder 决定（照片之间不写深度，后画的盖住先画的，卷起来的角不会戳穿上面那张）
  function place(it) {
    it.g.position.set(it.x, it.y, 0.0045 + it.order * 0.0004 + it.lift * 0.025);
    it.g.rotation.z = it.rot;
    const s = 1 + it.lift * 0.03;
    it.g.scale.set(s, s, 1);
    it.shadow.position.set(0.003 + it.lift * 0.008, -0.004 - it.lift * 0.012, -0.0004);
    it.shadow.scale.set(it.w * (1.1 + it.lift * 0.06), it.h * (1.13 + it.lift * 0.06), 1);
    it.shadowMat.opacity = 0.5 - it.lift * 0.15;
    it.pin.position.set(0, it.h * 0.4, 0.004);
    it.pin.visible = it.mesh.visible && it.lift < 0.5; // 拿起来的时候图钉拔掉了
    const base = 10 + it.order * 3 + (it.lift > 0.01 ? 1000 : 0);
    it.shadow.renderOrder = base;
    it.mesh.renderOrder = base + 1;
    it.pin.renderOrder = base + 2;
  }
  const restack = () => { items.sort((a, b) => a.order - b.order).forEach((it, k) => { it.order = k; place(it); }); };
  items.forEach(place);
  restack();

  // ---------- 拖动 ----------
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, group.position);
  const hitP = new THREE.Vector3();
  let held = null;
  const pickOne = (ray) => {
    const hits = ray.intersectObjects(items.filter((it) => it.mesh.visible).map((it) => it.mesh), false);
    let best = null;
    for (const h of hits) { const it = h.object.userData.photo; if (!best || it.order > best.order) best = it; } // 看得见的是叠在最上面的那张
    return best;
  };
  const local = (ray) => (ray.ray.intersectPlane(plane, hitP) ? group.worldToLocal(hitP.clone()) : null);
  function save() {
    const out = {};
    for (const it of items) out[it.src] = { x: +it.x.toFixed(4), y: +it.y.toFixed(4), rot: +it.rot.toFixed(3), order: it.order };
    try { localStorage.setItem(STORE, JSON.stringify(out)); } catch { /* 隐私模式：不记 */ }
  }

  return {
    group,
    // 指着的地方有没有照片（光标变成手）
    hit: (ray) => !!pickOne(ray),
    // 按下：拿起最上面那张，放到最上层
    grab(ray) {
      const it = pickOne(ray), p = it && local(ray);
      if (!p) return false;
      held = { it, dx: it.x - p.x, dy: it.y - p.y };
      it.order = items.length;
      it.liftT = 1;
      restack();
      return true;
    },
    drag(ray) {
      const p = held && local(ray);
      if (!p) return;
      const it = held.it;
      it.x = THREE.MathUtils.clamp(p.x + held.dx, -UW / 2 - 0.01, UW / 2 + 0.01);
      it.y = THREE.MathUtils.clamp(p.y + held.dy, -UH / 2, UH / 2);
      place(it);
    },
    drop() {
      if (!held) return;
      held.it.liftT = 0;
      held = null;
      save();
    },
    holding: () => !!held,
    // 摆回原样
    reset() {
      try { localStorage.removeItem(STORE); } catch { /* 无所谓 */ }
      items.forEach((it) => { Object.assign(it, home(list.findIndex((p) => (p.board || p.src) === it.src), it.src)); });
      restack();
    },
    // 亮度：大致和板子在屋里灯光下的亮度一样（roomLight 0..1 = 屋里的灯）；顺便把拿起 / 放下的动作做平滑
    update(roomLight, dt = 0.016) {
      const k = 0.075 + 0.24 * roomLight;
      for (const [m, base] of lit) m.color.copy(base).multiplyScalar(k);
      for (const it of items) {
        if (Math.abs(it.liftT - it.lift) < 1e-3) continue;
        it.lift += (it.liftT - it.lift) * (1 - Math.exp(-dt * 16));
        if (Math.abs(it.liftT - it.lift) < 1e-3) it.lift = it.liftT;
        place(it);
      }
    },
  };
}
