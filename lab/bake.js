// 烘焙光照实验：加载 Blender 导出的 room.glb + 四层 lightmap，在着色器里混合。
//   最终颜色 = 材质色 × ( 环境层 + 屋里灯层 × 开关 + 台灯层 × 开关 + 电视层 × 电视画面颜色 )
// 四层是分开烘焙的，所以开关灯、电视换色都不用重新算光照，每帧只是改四个系数。
// 窗外是两张预先渲染的夜景卡片（近景、远景），镜头移动时有视差。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TV } from '../js/tv.js';
import { makeCanvas } from '../js/tapes/util.js';

const BASE = '../assets/baked/';
const TAPES = [
  { kind: 'bars', color: '#e8b04a', title: '项目 A', years: '2025', desc: '烘焙光照测试' },
  { kind: 'synth', color: '#e0577a', title: '项目 B', years: '2024', desc: '烘焙光照测试' },
  { kind: 'bounce', color: '#4fa3e0', title: '项目 C', years: '2023', desc: '烘焙光照测试' },
  { kind: 'rain', color: '#59c27a', title: '项目 D', years: '2022', desc: '烘焙光照测试' },
];
const LAYERS = ['ambient', 'room', 'lamp', 'tv'];
const $ = (s) => document.querySelector(s);

const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#07080c');
const camera = new THREE.PerspectiveCamera(55, 1, 0.02, 120);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.5, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- 共享的 uniform：所有材质引用同一批对象，改一次全房间生效 ----------
const U = { useAlbedo: { value: 1 } };
for (const k of LAYERS) { U['m_' + k] = { value: null }; U['k_' + k] = { value: new THREE.Color() }; }
const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */`
  uniform vec3 albedo, ${LAYERS.map((k) => 'k_' + k).join(', ')};
  uniform sampler2D ${LAYERS.map((k) => 'm_' + k).join(', ')};
  uniform float useAlbedo;
  varying vec2 vUv;
  vec3 dec(sampler2D t) { vec3 c = texture2D(t, vUv).rgb; return c * c * c; } // 贴图里存的是立方根
  void main() {
    vec3 light = ${LAYERS.map((k) => `dec(m_${k}) * k_${k}`).join(' + ')};
    gl_FragColor = vec4(mix(vec3(0.75), albedo, useAlbedo) * light, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const bakedMaterial = (src) => new THREE.ShaderMaterial({
  uniforms: { ...U, albedo: { value: src.color.clone() } },
  vertexShader: VERT, fragmentShader: FRAG,
});

// ---------- 状态 ----------
const S = { lamp: 1, lampTarget: 1, room: 1, roomTarget: 1, view: 'full', exposure: 1, tape: -1, manifest: null };
const VIEWS = { full: '完整', ambient: '月光+城市', room: '屋里的灯', lamp: '台灯', tv: '电视', white: '白模' };
const emitters = []; // { mat, base: Color, layer }

// ---------- 镜头：站在原地转头（拖动），鼠标位置带一点视差，滚轮 / 双指缩放 ----------
const look = {
  pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: 55,
  yawT: 0, pitchT: 0, fovT: 55, yawR: [-1.3, 1.3], pitchR: [-0.75, 0.2],
  par: new THREE.Vector2(), parT: new THREE.Vector2(), home: null,
};
function setLook(c) {
  Object.assign(look, { yawT: c.yaw, pitchT: c.pitch, fovT: c.fov });
}
function initLook(c) {
  look.pos.fromArray(c.pos);
  look.yawR = c.yawRange; look.pitchR = c.pitchRange;
  look.home = c;
  Object.assign(look, { yaw: c.yaw, pitch: c.pitch, fov: c.fov });
  setLook(c);
}
{
  const ptrs = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => { ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') look.parT.set(e.clientX / innerWidth * 2 - 1, e.clientY / innerHeight * 2 - 1);
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoom((before - after) * 0.08);
      pinch = 1;
      return;
    }
    const k = (look.fov / 55) * 0.0042 * (e.pointerType === 'mouse' ? 1 : 1.4);
    look.yawT += (e.clientX - p.x) * k;   // 抓着画面拖：往右拖 = 往左看
    look.pitchT += (e.clientY - p.y) * k;
    p.x = e.clientX; p.y = e.clientY;
    clampLook();
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = 0; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') look.parT.set(0, 0); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY * 0.02); }, { passive: false });
}
function zoom(d) { look.fovT = THREE.MathUtils.clamp(look.fovT + d, 28, 70); }
function clampLook() {
  look.yawT = THREE.MathUtils.clamp(look.yawT, ...look.yawR);
  look.pitchT = THREE.MathUtils.clamp(look.pitchT, ...look.pitchR);
}
const right = new THREE.Vector3();
function updateCamera(dt) {
  const a = 1 - Math.exp(-dt * 8), b = 1 - Math.exp(-dt * 3);
  look.yaw += (look.yawT - look.yaw) * a;
  look.pitch += (look.pitchT - look.pitch) * a;
  look.fov += (look.fovT - look.fov) * a;
  look.par.lerp(look.parT, b);
  // 视差：头跟着鼠标轻轻平移几厘米，窗外近景 / 远景卡片和屋里物件之间就有了层次
  right.set(Math.cos(look.yaw), 0, -Math.sin(look.yaw));
  camera.position.copy(look.pos).addScaledVector(right, look.par.x * 0.05);
  camera.position.y -= look.par.y * 0.025;
  // 竖屏画面上下更长，稍微抬头，少露一点桌子下面的地板
  camera.rotation.set(look.pitch + Math.max(0, 0.2 * (1 - camera.aspect)), look.yaw, 0, 'YXZ');
  // 竖屏时把视角放宽，保证左右至少能看到 ~62°
  const minV = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(31)) / camera.aspect));
  const fov = Math.min(95, Math.max(look.fov, minV * look.fov / 55));
  if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// ---------- 动态物件：电视屏幕、电脑屏幕、窗外卡片（这些不烘焙，实时画） ----------
const tv = new TV();
const pcCanvas = makeCanvas(256, 192), pcCtx = pcCanvas.getContext('2d');
const pcTex = new THREE.CanvasTexture(pcCanvas);
pcTex.colorSpace = THREE.SRGBColorSpace;
function drawPC(t) {
  pcCtx.fillStyle = '#04140a';
  pcCtx.fillRect(0, 0, 256, 192);
  pcCtx.fillStyle = '#5cff9a';
  pcCtx.font = '14px ui-monospace, Menlo, monospace';
  ['BAKE.EXE  v0.2', '', 'lightmaps: 4', 'C:\\>' + (t % 1 < 0.5 ? '_' : '')].forEach((s, i) => pcCtx.fillText(s, 14, 26 + i * 20));
  pcTex.needsUpdate = true;
}
function screen(s, map) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(...s.size), new THREE.MeshBasicMaterial({ map }));
  m.position.fromArray(s.pos);
  m.position.z += 0.001;
  scene.add(m);
  return m;
}
function windowCards(view, win, textures) {
  // 卡片是从窗户中心按 hfov 渲染的，所以放在窗外 dist 米处、宽 2·dist·tan(hfov/2) 就能和窗户对上
  const t = Math.tan(THREE.MathUtils.degToRad(view.hfov / 2));
  view.cards.forEach((c, i) => {
    const w = 2 * c.dist * t, h = w / view.aspect;
    const tex = textures[i];
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      map: tex, transparent: !!c.alpha, depthWrite: !c.alpha, toneMapped: false, fog: false,
    }));
    m.position.set(win.x, win.y, win.z - c.dist);
    m.renderOrder = c.alpha ? -1 : -2;
    scene.add(m);
  });
}

function load(url, loader) { return new Promise((res, rej) => loader.load(url, res, undefined, rej)); }
async function main() {
  const [manifest, view] = await Promise.all(['manifest.json', 'view.json'].map((f) => fetch(BASE + f, { cache: 'no-store' }).then((r) => r.json())));
  S.manifest = manifest;
  const v = `?v=${encodeURIComponent(manifest.built || Date.now())}`;
  const tl = new THREE.TextureLoader();
  const [gltf, ...tex] = await Promise.all([
    load(BASE + 'room.glb' + v, new GLTFLoader()),
    ...LAYERS.map((k) => load(BASE + manifest.layers[k].file + v, tl)),
    ...view.cards.map((c) => load(BASE + c.file + `?v=${view.built}`, tl)),
  ]);
  const maps = tex.slice(0, LAYERS.length);
  maps.forEach((m, i) => {
    m.flipY = false; // glTF 的 UV 约定
    m.colorSpace = THREE.NoColorSpace; // 存的是光照数据，不是颜色，不做 sRGB 转换
    m.anisotropy = renderer.capabilities.getMaxAnisotropy();
    U['m_' + LAYERS[i]].value = m;
  });
  let meshes = 0, tris = 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const e = manifest.emitters?.[o.material.name];
    if (e) {
      // 灯泡、灯罩、灯带：自发光，亮度跟着所属那层灯的开关走
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(e.color) });
      emitters.push({ mat, base: new THREE.Color(e.color).multiplyScalar(e.power), layer: e.layer });
      o.material = mat;
    } else {
      o.material = bakedMaterial(o.material);
    }
    meshes++;
    tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  scene.add(gltf.scene);
  screen(manifest.screens.tv, tv.texture);
  screen(manifest.screens.pc, pcTex);
  windowCards(view, manifest.window, tex.slice(LAYERS.length));
  initLook(manifest.camera);

  const bytes = (f) => performance.getEntriesByType('resource').filter((e) => e.name.includes('/baked/' + f)).reduce((a, e) => a + (e.encodedBodySize || 0), 0);
  const kb = (fs) => Math.round(fs.reduce((a, f) => a + bytes(f), 0) / 1024);
  $('#info').innerHTML = [
    ['Blender', manifest.blender],
    ['烘焙', `${manifest.size}² · ${manifest.samples} spp · ${manifest.seconds ?? '?'} s`],
    ['几何', `${meshes} 个材质 · ${Math.round(tris)} 三角形 · ${kb(['room.glb'])} KB`],
    ['光照贴图', `${kb(LAYERS.map((k) => manifest.layers[k].file))} KB（${LAYERS.length} 张 JPG）`],
    ['窗外', `${kb(view.cards.map((c) => c.file))} KB（${view.cards.length} 张卡片）`],
    ['帧率', '<span id="fps">–</span>'],
  ].map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
  $('#status').remove();
  ui();
  setTape(0);
  window.__lab = { S, U, scene, camera, renderer, composer, tv, look, setLook, setTape, setView, tick };
  requestAnimationFrame(loop);
}

function toggle(id, key, name) {
  $(id).onclick = () => {
    S[key] = S[key] ? 0 : 1;
    $(id).setAttribute('aria-pressed', String(!!S[key]));
    $(id).textContent = `${name} ${S[key] ? '开' : '关'}`;
  };
}
function ui() {
  toggle('#room', 'roomTarget', '屋里灯');
  toggle('#lamp', 'lampTarget', '书桌台灯');
  $('#home').onclick = () => setLook(look.home);
  $('#tapes').innerHTML = TAPES.map((t, i) => `<button data-i="${i}"><i class="sw" style="background:${t.color}"></i>${t.title}</button>`).join('')
    + '<button data-i="-1">■ 停</button>';
  $('#tapes').onclick = (e) => { const b = e.target.closest('button'); if (b) setTape(+b.dataset.i); };
  $('#views').innerHTML = Object.entries(VIEWS).map(([k, val]) => `<button data-v="${k}">${val}</button>`).join('');
  $('#views').onclick = (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); };
  $('#exp').oninput = (e) => { S.exposure = +e.target.value; $('#expOut').textContent = S.exposure.toFixed(2); };
  setView('full');
}
function setTape(i) {
  S.tape = i;
  if (i < 0) tv.stop(); else tv.play(TAPES[i]);
  document.querySelectorAll('#tapes button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === i)));
}
function setView(val) {
  S.view = val;
  U.useAlbedo.value = val === 'white' ? 0 : 1;
  document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === val)));
}

// ---------- 每帧：只更新四个系数 ----------
// 电视光 = 画面平均色的"色相" × 亮度。画面多半是黑底，平均色很暗，所以亮度给个下限，色相保持不变。
const TV_GAIN = 3;
const tvTint = new THREE.Color();
function tvLight(out) {
  const c = tv.color, m = Math.max(c.r, c.g, c.b);
  if (m < 1e-5) return out.setScalar(0);
  const level = Math.min(1, 0.3 + Math.sqrt(m) * 1.4);
  return out.copy(c).multiplyScalar(level / m);
}
function updateLight() {
  const L = S.manifest.layers, v = S.view, on = (k) => v === 'full' || v === 'white' || v === k;
  const level = { ambient: 1, room: S.room, lamp: S.lamp };
  for (const k of ['ambient', 'room', 'lamp']) U['k_' + k].value.setScalar(on(k) ? L[k].scale * level[k] : 0);
  if (v === 'tv') U.k_tv.value.setScalar(L.tv.scale * (tv.state === 'off' ? 0 : 1)); // 单看电视层时用白光，看清烘焙结果本身
  else U.k_tv.value.copy(tvLight(tvTint)).multiplyScalar(on('tv') ? L.tv.scale * TV_GAIN : 0);
  for (const e of emitters) e.mat.color.copy(e.base).multiplyScalar(on(e.layer) ? Math.max(level[e.layer] ?? 1, 0.02) : 0.02);
  renderer.toneMappingExposure = S.exposure;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  composer.setPixelRatio(renderer.getPixelRatio());
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
let pcT = 0, frames = 0, fpsT = 0, simT = 0;
drawPC(0);
// 一帧的逻辑单独拿出来：测试时可以手动按固定步长推进（后台标签页里 requestAnimationFrame 会被降速）
function tick(dt, render = true) {
  const t = (simT += dt);
  const k = 1 - Math.exp(-dt * 12);
  S.lamp += (S.lampTarget - S.lamp) * k;
  S.room += (S.roomTarget - S.room) * k;
  tv.update(t, dt);
  if ((pcT += dt) > 0.5) { pcT = 0; drawPC(t); }
  updateLight();
  updateCamera(dt);
  if (render) composer.render();
}
function loop() {
  const dt = Math.min(clock.getDelta(), 0.1);
  tick(dt);
  frames++;
  if ((fpsT += dt) > 1) { const el = $('#fps'); if (el) el.textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }
  requestAnimationFrame(loop);
}

main().catch((e) => { console.error(e); $('#status').textContent = '加载失败：' + e.message + '（先运行 blender/render_view.py 和 blender/bake_room.py 生成 assets/baked/）'; });
