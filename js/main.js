// 入口：判断这台设备能不能跑 3D 房间，能就加载房间，不能就显示静态版。
// 和 felixrieseberg.com 的思路一样：没有 WebGL2、或者 GPU 是软件渲染（SwiftShader 等）时，3D 会卡死机器，直接给静态版。
// ?room=1 强制 3D，?plain=1 强制静态版，?scene=tower 换成城堡塔楼书房（默认是窗前书桌的房间）。
import { readContent } from './content.js';

const params = new URLSearchParams(location.search);
const forceRoom = params.has('room');
const forcePlain = params.has('plain') && !forceRoom;
const html = document.documentElement;

function detect() {
  let gl = null;
  try { gl = document.createElement('canvas').getContext('webgl2'); } catch { /* 没有 WebGL */ }
  if (!gl) return { ok: false, soft: false };
  let soft = false;
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    soft = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(name)
      || !document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  } catch { /* 拿不到显卡信息就当作正常 */ }
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { ok: true, soft };
}

function plain(reason) {
  html.classList.remove('is-room');
  html.classList.add('is-plain');
  document.getElementById('room').hidden = true;
  if (reason === 'soft') document.getElementById('try-room').hidden = false;
  // A hash is an element id, not a CSS selector; malformed input must not break fallback.
  let id = location.hash.slice(1);
  try { id = decodeURIComponent(id); } catch { /* Keep the literal id. */ }
  if (id) document.getElementById(id)?.scrollIntoView();
}

const env = detect();
if (forcePlain || !env.ok) {
  plain();
} else if (env.soft && !forceRoom) {
  plain('soft');
} else {
  html.classList.add('is-room');
  const scene = params.get('scene') === 'tower' ? './tower.js' : './room.js';
  import(scene)
    .then((m) => m.start(readContent()))
    .catch((err) => { console.error('3D 房间加载失败，改用静态版', err); plain(); });
}
