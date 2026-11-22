// 开场：网页一到就并行下载 3D 房间的大文件，同时在 #boot 上显示一个旧电脑样式的进度（和桌上那台电脑一个颜色）。
// - index.html 直接加载这个文件，它不 import 别的模块，所以不用等 main.js → room.js → three.js 一层层加载完才开始下载
// - index.html 头部的小脚本已经判断过这台设备用 3D 房间还是纯文字版（<html data-mode>）；不是 room 就什么都不下
// - js/room.js 用 roomFiles 拿这些文件（js/baked.js、js/window-view.js），拿到一个用一个
// - 进度后面铺着开场镜头的一张静帧（assets/baked/first.webp，scripts/capture-first.mjs 截的），压暗、虚化；
//   第一帧画出来以后 room.js 调 bootDone()：静帧变亮、对上焦，和进度一起淡出，露出真的房间
const html = document.documentElement;
const BASE = new URL('../assets/baked/', import.meta.url).href;
const MB = 1e6;

const el = document.getElementById('boot');
const $ = (sel) => el?.querySelector(sel);
const logEl = $('.boot-log span');
// 三行：模型、光照贴图、窗外夜景（index.html 里先画好空的，版面一开始就是最后的样子）
const rows = Object.fromEntries(['model', 'light', 'view'].map((k) => {
  const row = $(`[data-row="${k}"]`);
  return [k, { row, name: row?.querySelector('b'), bar: row?.querySelector('i'), val: row?.querySelector('em'), files: [] }];
}));
const total = { bar: $('[data-row="total"] i'), val: $('[data-row="total"] em') };

const files = [];
let started = 0, bytes = [], frame = 0;
const recv = (n) => { const t = performance.now(); bytes.push([t, n]); while (bytes[0][0] < t - 1500) bytes.shift(); };

export const roomFiles = html.dataset.mode === 'room' && el ? start() : null;
roomFiles?.catch(() => log('download failed · showing the text version'));

async function start() {
  log('reading manifest');
  // Draco 解码器（模型是 Draco 压缩的）：先下进浏览器缓存，js/baked.js 解析模型时直接用（CDN 上带版本号，缓存一年）
  try {
    const draco = import.meta.resolve('three/addons/libs/draco/gltf/');
    for (const f of ['draco_wasm_wrapper.js', 'draco_decoder.wasm']) fetch(draco + f).catch(() => {});
  } catch { /* 没有 import map 就算了，解析时再下 */ }
  const json = (f) => fetch(BASE + f, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${BASE + f}`);
    return r.json();
  });
  const [manifest, view] = await Promise.all([json('manifest.json'), json('view.json')]);
  const byName = new Map();
  const add = (k, file, version) => { if (file && !byName.has(file)) byName.set(file, track(k, file, version)); };
  add('model', 'room.glb', manifest.built);
  for (const k of manifest.layerOrder || Object.keys(manifest.layers)) add('light', manifest.layers[k].file, manifest.built);
  for (const c of view.cards || []) add('view', c.file, view.built);
  for (const L of view.pano?.layers || []) { add('view', L.file, view.built); add('view', L.data, view.built); }
  started = performance.now();
  for (const [k, r] of Object.entries(rows)) {
    if (!r.files.length) { if (r.row) r.row.hidden = true; continue; }
    if (r.name && r.files.length > 1) r.name.textContent += ` ×${r.files.length}`;
  }
  log(`fetching ${byName.size} files in parallel`);
  Promise.all([...byName.values()].map((f) => f.blob)).then(() => log('unpacking the room'), () => {});
  draw();
  return { manifest, view, blob: (file) => byName.get(file)?.blob ?? null };
}

// 一个文件：边下边记字节数（服务器 gzip 时 content-length 是压缩后的大小，下完以前进度最多算到 99%）
function track(k, file, version) {
  const f = { file, got: 0, size: 0, done: false, failed: false };
  files.push(f);
  rows[k].files.push(f);
  f.blob = (async () => {
    const res = await fetch(`${BASE}${file}?v=${encodeURIComponent(version || '')}`);
    if (!res.ok) throw new Error(`${res.status} ${file}`);
    f.size = Number(res.headers.get('content-length')) || 0;
    const type = res.headers.get('content-type') || '';
    let blob;
    if (!res.body) blob = await res.blob();
    else {
      const reader = res.body.getReader(), chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        f.got += value.length;
        recv(value.length);
        draw();
      }
      blob = new Blob(chunks, { type });
    }
    f.got = f.size = blob.size;
    f.done = true;
    draw();
    return blob;
  })();
  f.blob.catch(() => { f.failed = true; draw(); }); // 失败由用它的地方处理（room.js 改用纯文字版，窗外失败就不画）
  return f;
}

const fmt = (n) => (n / MB).toFixed(1);
function sum(list) {
  let got = 0, size = 0;
  for (const f of list) { size += f.size; got += f.done ? f.size : Math.min(f.got, f.size * 0.99); }
  return { got, size, k: size ? got / size : 0, done: list.length > 0 && list.every((f) => f.done), failed: list.some((f) => f.failed) };
}
function paint(r, s, text) {
  if (r.bar) r.bar.style.width = `${(s.k * 100).toFixed(1)}%`;
  if (r.val) r.val.textContent = text;
}
// 一帧最多更新一次（一个文件一秒能读到几十上百块）
function draw() {
  if (frame || !el) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const r of Object.values(rows)) {
      if (!r.files.length) continue;
      const s = sum(r.files);
      paint(r, s, s.failed ? 'ERR' : s.done ? `OK ${fmt(s.size)} MB` : s.size ? `${fmt(s.got)}/${fmt(s.size)} MB` : '…');
    }
    const s = sum(files);
    const rate = bytes.length && performance.now() - started > 400 ? bytes.reduce((a, [, n]) => a + n, 0) / 1.5 / MB : 0;
    paint(total, s, s.done ? '100%' : `${Math.floor(s.k * 100)}%${rate ? ` ${rate.toFixed(1)}MB/s` : ''}`);
  });
}

function log(text) { if (logEl) logEl.textContent = text; }

// room.js：下载完以后的几步（解析模型、编译着色器）也写在最后一行
export function bootStage(text) { log(text); }

// room.js：第一帧画好了
export function bootDone() {
  if (!el) return;
  log('ready');
  el.classList.add('done');
  setTimeout(() => el.remove(), 1200);
}
