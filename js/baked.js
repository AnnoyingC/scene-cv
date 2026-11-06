// 烘焙场景的公共部分（js/room.js 房间、js/tower.js 塔楼共用）：
//   - 下载 Blender 导出的 glb、几层光照贴图、窗外卡片（按字节报进度）
//   - 着色器：最终颜色 = 材质色（× 贴图）× Σ( 光照层 × 系数 )。房间是 环境 / 屋里灯 / 台灯 / 电视 四层，
//     塔楼是 环境 / 蜡烛 / 壁炉 / 水盆 四层（manifest.layerOrder）。每层分开烘焙，开关灯、换颜色都只是改系数
//   - 塔楼的模型有两套 UV：uv 给颜色贴图，uv1 给光照贴图；玻璃按 manifest.glass 半透明
//   - 发光体（灯泡、灯罩、灯带）、窗外视差卡片、电脑 / 电视屏幕
//   - 热点：manifest 里每个可点物件有几个盒子，用来拾取，也用来在着色器里做悬停高亮
//   - 录像带：按材质名（tape0 / label0 …）从房间里拆出来，可以单独移动
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export const LAYERS = ['ambient', 'room', 'lamp', 'tv']; // 房间的四层（manifest 没写 layerOrder 时用）
const MAX_BOXES = 16; // 一个热点最多几个盒子（着色器里的数组长度）
// Draco 解码器（塔楼的模型压缩过）：和 three 同一个 CDN、同一个版本
const DRACO = (() => {
  try { return import.meta.resolve('three/addons/libs/draco/gltf/'); } catch { return 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/'; }
})();

// ---------- 下载 ----------
// 所有文件并行下，按字节算总进度；下完交给 three 的加载器（用 blob URL）。
async function fetchAll(urls, onProgress) {
  const got = urls.map(() => 0), size = urls.map(() => 0);
  const report = () => {
    const total = size.reduce((a, b) => a + b, 0);
    onProgress?.(total ? Math.min(1, got.reduce((a, b) => a + b, 0) / total) : 0);
  };
  return Promise.all(urls.map(async (url, i) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    size[i] = Number(res.headers.get('content-length')) || 0;
    const type = res.headers.get('content-type') || '';
    if (!res.body || !size[i]) {
      const blob = await res.blob();
      got[i] = size[i] = blob.size;
      report();
      return blob;
    }
    const reader = res.body.getReader(), chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got[i] += value.length;
      report();
    }
    got[i] = size[i]; // 服务器 gzip 时 content-length 是压缩后的大小，最后对齐一下
    report();
    return new Blob(chunks, { type });
  }));
}

const textureLoader = new THREE.TextureLoader();
async function blobTexture(blob) {
  const url = URL.createObjectURL(blob);
  try { return await textureLoader.loadAsync(url); } finally { URL.revokeObjectURL(url); }
}

export async function loadBaked(base, { onProgress, glb = 'room.glb' } = {}) {
  const json = (f) => fetch(base + f, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${base + f}（先运行 blender/ 里的窗外渲染和烘焙脚本）`);
    return r.json();
  });
  const [manifest, view] = await Promise.all([json('manifest.json'), json('view.json')]);
  const layers = manifest.layerOrder || LAYERS;
  const files = [
    [glb, manifest.built],
    ...layers.map((k) => [manifest.layers[k].file, manifest.built]),
    ...view.cards.map((c) => [c.file, view.built]),
  ];
  const blobs = await fetchAll(files.map(([f, v]) => `${base}${f}?v=${encodeURIComponent(v || '')}`), onProgress);
  const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO));
  const gltf = await loader.parseAsync(await blobs[0].arrayBuffer(), base);
  const tex = await Promise.all(blobs.slice(1).map(blobTexture));
  const sizes = Object.fromEntries(files.map(([f], i) => [f, blobs[i].size]));
  return { manifest, view, gltf, layers, maps: tex.slice(0, layers.length), cards: tex.slice(layers.length), sizes };
}

// ---------- 着色器（按光照层列表生成）----------
// 宏：USE_UV1 = 光照贴图用第二套 UV；USE_ALBEDO_MAP = 有颜色贴图；USE_DECAL = 贴花（记事本 / 羊皮纸上的字）；
// USE_CUTOUT = 镂空（颜色贴图的透明部分不画，比如植物的叶片卡片；只有 manifest.cutout 里列出的材质才开）
function shaders(layers) {
  const vert = /* glsl */`
  varying vec2 vUv;
  varying vec3 vPos;
  #ifdef USE_ALBEDO_MAP
    varying vec2 vMapUv;
  #endif
  #ifdef USE_DECAL
    attribute vec2 decalUv;
    varying vec2 vDecal;
  #endif
  void main() {
    #ifdef USE_UV1
      vUv = uv1;
    #else
      vUv = uv;
    #endif
    #ifdef USE_ALBEDO_MAP
      vMapUv = uv;
    #endif
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPos = wp.xyz;
    #ifdef USE_DECAL
      vDecal = decalUv;
    #endif
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
  const frag = /* glsl */`
  uniform vec3 albedo, emissive, ${layers.map((k) => 'k_' + k).join(', ')};
  uniform sampler2D ${layers.map((k) => 'm_' + k).join(', ')};
  uniform float useAlbedo, hi, hiK, opacity;
  uniform vec3 hiC[${MAX_BOXES}], hiH[${MAX_BOXES}];
  uniform float hiR[${MAX_BOXES}];
  uniform int hiN;
  varying vec2 vUv;
  varying vec3 vPos;
  #ifdef USE_ALBEDO_MAP
    uniform sampler2D albedoMap;
    varying vec2 vMapUv;
  #endif
  #ifdef USE_DECAL
    uniform sampler2D decal;
    varying vec2 vDecal;
  #endif
  vec3 dec(sampler2D t) { vec3 c = texture2D(t, vUv).rgb; return c * c * c; } // 贴图里存的是立方根
  // 在不在第 i 个热点盒子里（盒子可以绕 Y 轴转）；边缘留 6 毫米的过渡，不会切出硬边
  float inBox(int i) {
    vec3 q = vPos - hiC[i];
    float c = cos(hiR[i]), s = sin(hiR[i]);
    vec3 l = abs(vec3(c * q.x - s * q.z, q.y, s * q.x + c * q.z)) - hiH[i];
    return 1.0 - smoothstep(0.0, 0.006, max(l.x, max(l.y, l.z)));
  }
  void main() {
    vec3 light = ${layers.map((k) => `dec(m_${k}) * k_${k}`).join(' + ')};
    float hb = 0.0;
    for (int i = 0; i < ${MAX_BOXES}; i++) { if (i >= hiN) break; hb = max(hb, inBox(i)); }
    float h = max(hi, hb * hiK); // hi：单个物件自己的高亮（录像带、水晶）；hb：热点盒子
    vec3 base = mix(vec3(0.75), albedo, useAlbedo);
    #ifdef USE_ALBEDO_MAP
      vec4 tex = texture2D(albedoMap, vMapUv);
      #ifdef USE_CUTOUT
        if (tex.a < 0.5) discard;
      #endif
      base *= mix(vec3(1.0), tex.rgb, useAlbedo);
    #endif
    #ifdef USE_DECAL
      base *= texture2D(decal, vDecal).rgb;
    #endif
    // 高亮 = 亮一点 + 叠一层暖色。叠加的部分不乘反照率，黑色的电视、录像带也看得出来
    gl_FragColor = vec4(base * light * (1.0 + 0.45 * h) + h * vec3(0.03, 0.022, 0.012) + emissive, opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
  return { vert, frag };
}

// 电视光 = 画面平均色的"色相" × 亮度。画面多半是黑底，平均色很暗，所以亮度给个下限，色相保持不变。
export const TV_GAIN = 3;
export function tvLight(color, out) {
  const m = Math.max(color.r, color.g, color.b);
  if (m < 1e-5) return out.setScalar(0);
  const level = Math.min(1, 0.3 + Math.sqrt(m) * 1.4);
  return out.copy(color).multiplyScalar((level / m) * TV_GAIN);
}

// ---------- 场景 ----------
export class BakedRoom {
  constructor(data, { renderer, scene }) {
    const { manifest, view, gltf, maps, cards } = data;
    this.manifest = manifest;
    this.scene = scene;
    this.layers = data.layers || LAYERS;
    this.sh = shaders(this.layers);
    const aniso = this.aniso = renderer.capabilities.getMaxAnisotropy();
    const U = this.U = {
      useAlbedo: { value: 1 }, hiK: { value: 0 }, hiN: { value: 0 },
      hiC: { value: [...Array(MAX_BOXES)].map(() => new THREE.Vector3()) },
      hiH: { value: [...Array(MAX_BOXES)].map(() => new THREE.Vector3()) },
      hiR: { value: new Array(MAX_BOXES).fill(0) },
    };
    this.layers.forEach((k, i) => {
      const m = maps[i];
      m.flipY = false;                    // glTF 的 UV 约定
      m.colorSpace = THREE.NoColorSpace;  // 存的是光照数据，不是颜色
      m.anisotropy = aniso;
      U['m_' + k] = { value: m };
      U['k_' + k] = { value: new THREE.Color() };
    });

    const tints = manifest.tints || {}, glass = manifest.glass || {};
    const cutout = new Set(manifest.cutout || []); // 镂空的材质（叶片），没列的照旧
    this.byMat = new Map(); // 材质名 → [mesh]
    this.emitters = [];     // { name, mat, base, power, layer }
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.material, name = src.name;
      const e = manifest.emitters?.[name];
      if (e) {
        const map = e.map ? (src.emissiveMap || src.map) : null;
        const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(e.color), map });
        this.emitters.push({ name, mat, base: new THREE.Color(e.color).multiplyScalar(e.power), power: e.power, layer: e.layer });
        o.material = mat;
      } else {
        const map = src.map || null;
        if (map) map.anisotropy = aniso;
        // 颜色：有贴图的素材 = 贴图（× 烘焙脚本记下的染色）；没贴图的 = 材质色
        const color = tints[name] ? new THREE.Color(tints[name]) : map ? new THREE.Color(1, 1, 1) : src.color;
        const mat = o.material = this.material(color, { map, uv1: !!o.geometry.attributes.uv1, cutout: !!map && cutout.has(name) });
        if (glass[name] != null) {
          mat.transparent = true;
          mat.depthWrite = false;
          mat.uniforms.opacity.value = glass[name];
        }
      }
      o.material.name = name;
      if (!this.byMat.has(name)) this.byMat.set(name, []);
      this.byMat.get(name).push(o);
    });
    this.root = gltf.scene;
    scene.add(gltf.scene);
    this.cards = this.windowCards(view, manifest.window, cards, aniso);
  }

  // decal：贴花内容；map：颜色贴图；uv1：光照贴图用第二套 UV；cutout：贴图透明的地方镂空，两面都画（叶片只有一层）
  material(color, { decal = null, map = null, uv1 = false, cutout = false } = {}) {
    const defines = {};
    if (decal) defines.USE_DECAL = '';
    if (map) defines.USE_ALBEDO_MAP = '';
    if (uv1) defines.USE_UV1 = '';
    if (cutout) defines.USE_CUTOUT = '';
    return new THREE.ShaderMaterial({
      side: cutout ? THREE.DoubleSide : THREE.FrontSide,
      uniforms: {
        ...this.U, albedo: { value: color.clone() }, hi: { value: 0 }, opacity: { value: 1 }, emissive: { value: new THREE.Color(0) },
        ...(decal ? { decal: { value: decal } } : {}), ...(map ? { albedoMap: { value: map } } : {}),
      },
      vertexShader: this.sh.vert, fragmentShader: this.sh.frag, defines,
    });
  }

  // 每帧调用：levels = { 层名: 数字 0..1 或 THREE.Color }；solo = 只看某一层（实验页用）
  // 发光体跟着自己那一层：数字 = 亮度；颜色 = 直接用这个颜色（水盆的符文随项目变色）
  setLevels(levels, solo = null) {
    const L = this.manifest.layers, U = this.U, on = (k) => !solo || solo === k;
    for (const k of this.layers) {
      const v = on(k) ? (levels[k] ?? (k === 'ambient' ? 1 : 0)) : 0;
      if (v.isColor) U['k_' + k].value.copy(v).multiplyScalar(L[k].scale);
      else U['k_' + k].value.setScalar(L[k].scale * v);
    }
    for (const e of this.emitters) {
      const v = on(e.layer) ? (levels[e.layer] ?? 1) : 0;
      if (v.isColor) e.mat.color.copy(v).multiplyScalar(e.power);
      else e.mat.color.copy(e.base).multiplyScalar(Math.max(v, 0.02));
    }
  }

  // 房间用的老接口：levels = { room, lamp } 0..1；tv = 电视光颜色（已经染好色、乘好增益），null = 电视关
  update({ room = 1, lamp = 1, tv = null, solo = null } = {}) {
    this.setLevels({ ambient: 1, room, lamp, tv: tv || 0 }, solo);
  }

  // ---------- 热点 ----------
  get hotspots() { return this.manifest.hotspots || {}; }
  hotspotAt(p, pad = 0.01) {
    for (const [name, boxes] of Object.entries(this.hotspots)) {
      for (const b of boxes) {
        const qx = p.x - b.c[0], qy = p.y - b.c[1], qz = p.z - b.c[2];
        const c = Math.cos(b.r), s = Math.sin(b.r);
        if (Math.abs(c * qx - s * qz) <= b.h[0] + pad && Math.abs(qy) <= b.h[1] + pad && Math.abs(s * qx + c * qz) <= b.h[2] + pad) return name;
      }
    }
    return null;
  }
  // 着色器里高亮这个热点的盒子（强度 hiK 由调用方做渐变）
  highlight(name) {
    const boxes = (name && this.hotspots[name]) || [];
    const n = Math.min(MAX_BOXES, boxes.length);
    this.U.hiN.value = n;
    for (let i = 0; i < n; i++) {
      this.U.hiC.value[i].fromArray(boxes[i].c);
      this.U.hiH.value[i].fromArray(boxes[i].h);
      this.U.hiR.value[i] = boxes[i].r;
    }
  }

  // ---------- 屏幕：贴在 manifest 记下的位置，前移 1 毫米 ----------
  screen(name, map) {
    const s = this.manifest.screens[name];
    const m = new THREE.Mesh(new THREE.PlaneGeometry(...s.size), new THREE.MeshBasicMaterial({ map }));
    m.position.fromArray(s.pos);
    m.position.z += 0.001;
    this.scene.add(m);
    return m;
  }

  // ---------- 窗外：卡片是从窗户中心按 hfov 渲染的，放在窗外 dist 米处、宽 2·dist·tan(hfov/2) 就能和窗户对上 ----------
  windowCards(view, win, textures, aniso) {
    const t = Math.tan(THREE.MathUtils.degToRad(view.hfov / 2));
    return view.cards.map((c, i) => {
      const w = 2 * c.dist * t, h = w / view.aspect;
      const tex = textures[i];
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = aniso;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
        map: tex, transparent: !!c.alpha, depthWrite: !c.alpha, toneMapped: false, fog: false,
      }));
      m.position.set(win.x, win.y, win.z - c.dist);
      m.renderOrder = c.alpha ? -1 : -2;
      this.scene.add(m);
      return m;
    });
  }

  // ---------- 贴花：把某个材质朝上的那个面复制一份，贴上 canvas 画的内容（光照照样用烘焙的）----------
  // 用在记事本上：纸面写联系方式。up 是纸的"上方"大致朝哪（默认朝窗户，即 -z）。
  decal(matName, texture, up = new THREE.Vector3(0, 0, -1)) {
    const src = this.byMat.get(matName)?.[0];
    if (!src) return null;
    const g = src.geometry, P = g.attributes.position, UV = g.attributes.uv1 || g.attributes.uv;
    const idx = g.index ? g.index.array : [...Array(P.count).keys()];
    const v = (i) => new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(src.matrixWorld);
    const tris = [];
    let top = -Infinity;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const A = v(a), B = v(b), C = v(c);
      const n = new THREE.Vector3().crossVectors(B.clone().sub(A), C.clone().sub(A)).normalize();
      if (n.y < 0.98) continue;
      const y = (A.y + B.y + C.y) / 3;
      tris.push({ ids: [a, b, c], pts: [A, B, C], y });
      top = Math.max(top, y);
    }
    const face = tris.filter((t) => t.y > top - 1e-4);
    if (!face.length) return null;
    // 纸面的四个角 → 中心、"上"方向（长边里朝 up 的那个方向）、"右"方向
    const corners = [];
    for (const t of face) for (const p of t.pts) if (!corners.some((q) => q.distanceTo(p) < 1e-5)) corners.push(p);
    const center = corners.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(corners.length);
    const edges = corners.slice(1).map((p) => p.clone().sub(corners[0])).sort((a, b) => a.length() - b.length());
    const long = edges[1].clone().normalize(); // edges[2] 是对角线
    if (long.dot(up) < 0) long.negate();
    const right = new THREE.Vector3().crossVectors(long, new THREE.Vector3(0, 1, 0)).normalize();
    let hw = 0, hh = 0;
    for (const p of corners) {
      const d = p.clone().sub(center);
      hw = Math.max(hw, Math.abs(d.dot(right)));
      hh = Math.max(hh, Math.abs(d.dot(long)));
    }
    const pos = [], uv = [], duv = [];
    for (const t of face) {
      t.ids.forEach((id, k) => {
        const p = t.pts[k], d = p.clone().sub(center);
        pos.push(p.x, p.y + 0.0004, p.z);
        uv.push(UV.getX(id), UV.getY(id));
        duv.push(d.dot(right) / (2 * hw) + 0.5, d.dot(long) / (2 * hh) + 0.5);
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('decalUv', new THREE.Float32BufferAttribute(duv, 2));
    const mat = this.material(new THREE.Color(1, 1, 1), { decal: texture });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    const mesh = new THREE.Mesh(geo, mat);
    // 纸面的坐标系和光照贴图坐标，留给要让纸动起来的效果用（塔楼里揉纸投火）
    mesh.userData.frame = {
      center, right, long, hw, hh,
      face: face.map((t) => ({ pts: t.pts, uv: t.ids.map((id) => new THREE.Vector2(UV.getX(id), UV.getY(id))) })),
    };
    this.scene.add(mesh);
    return mesh;
  }

  // ---------- 拆零件：每组材质名拆成一个以它们中心为原点的 Group，可以单独移动（水晶、棋子）----------
  takeParts(groups) {
    return groups.map((names) => {
      const parts = [].concat(...[].concat(names).map((n) => this.byMat.get(n) || []));
      if (!parts.length) return null;
      const box = new THREE.Box3();
      for (const m of parts) box.expandByObject(m);
      const group = new THREE.Group();
      box.getCenter(group.position);
      this.scene.add(group);
      group.updateMatrixWorld(true);
      for (const m of parts) group.attach(m);
      return { group, parts, home: group.position.clone() };
    });
  }

  // ---------- 录像带：tape{i} + label{i} 两个材质拆出来，放进一个以带子中心为原点的 Group ----------
  takeTapes() {
    const out = [];
    for (let i = 0; i < (this.manifest.tapes?.count ?? 0); i++) {
      const body = this.byMat.get('tape' + i), label = this.byMat.get('label' + i);
      if (!body) break;
      const parts = [...body, ...(label || [])];
      const center = new THREE.Box3().setFromObject(body[0]).getCenter(new THREE.Vector3());
      const group = new THREE.Group();
      group.position.copy(center);
      this.scene.add(group);
      group.updateMatrixWorld(true);
      for (const m of parts) group.attach(m);
      out.push({ group, parts, body: body[0], label: label?.[0] || null });
    }
    return out;
  }
}
