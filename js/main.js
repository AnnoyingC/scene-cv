// 入口：判断这台设备能不能跑 3D 房间，能就加载房间，不能就显示静态版。
// 和 felixrieseberg.com 的思路一样：没有 WebGL2、或者 GPU 是软件渲染（SwiftShader 等）时，3D 会卡死机器，直接给静态版。
// ?room=1 强制 3D，?plain=1 强制静态版。
import { readContent, bookTitle } from './content.js';
import { createNav } from './nav.js';
import { createMusicPlayer } from './music.js';
import { MUSIC_TRACKS } from './music-tracks.js';
import { createAchievements } from './achievements.js';

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
  nav.unlockAll(); // 纯文字版没有可找的东西：导航栏全部打开
  html.classList.remove('is-room');
  html.classList.add('is-plain');
  document.getElementById('room').hidden = true;
  if (reason === 'soft') document.getElementById('try-room').hidden = false;
  // A hash is an element id, not a CSS selector; malformed input must not break fallback.
  let id = location.hash.slice(1);
  try { id = decodeURIComponent(id); } catch { /* Keep the literal id. */ }
  if (id) document.getElementById(id)?.scrollIntoView();
}

// 只在本地的个人内容（这几个文件夹不进 Git，公开仓库里 index.html 是样例）：有就换进内容层，没有就照样用样例。
//   assets/resume/resume.html         真实简历的几页纸 → #resume（3D 版每次拿起纸都从内容层复制，纯文字版直接显示）
//   assets/resume/contact.html        真实联系方式的几个 <li> → #online 的列表（记事本、联系面板、纯文字版）
//   assets/books/covers/covers.json   书名 → 真实封面的文件名 → #shelf 那本书的 data-cover
// 3D 场景等这几样换好了再读内容层
const local = (path, as) => fetch(new URL(path, import.meta.url), { cache: 'no-cache' })
  .then((r) => (r.ok ? r[as]() : null)).catch(() => null);
const personal = Promise.all([
  local('../assets/resume/resume.html', 'text').then((html) => {
    const deck = document.querySelector('#resume .cv-deck');
    if (!html || !deck) return;
    const t = document.createElement('template');
    t.innerHTML = html;
    const pages = t.content.querySelectorAll('.cv-page');
    if (pages.length) deck.replaceChildren(...pages);
  }),
  local('../assets/resume/contact.html', 'text').then((html) => {
    const list = document.querySelector('#online .links');
    if (!html || !list) return;
    const t = document.createElement('template');
    t.innerHTML = html;
    const items = t.content.querySelectorAll('li');
    if (items.length) list.replaceChildren(...items);
  }),
  local('../assets/books/covers/covers.json', 'json').then((map) => {
    if (!map || typeof map !== 'object') return;
    for (const li of document.querySelectorAll('#shelf li')) {
      const file = map[bookTitle(li)];
      if (typeof file === 'string' && file) li.dataset.cover = file;
    }
  }),
]);

const env = detect();
const mode = forcePlain || !env.ok ? 'plain' : env.soft && !forceRoom ? 'soft' : 'room';
// 成就（js/achievements.js）：导航栏里还没找到的几项先上锁，在房间里找到了才打开
const achievements = mode === 'room' ? createAchievements({ label: (route) => nav.label(route) }) : null;
const nav = createNav(document, { locked: achievements?.lockedRoutes() ?? [] }); // 和下面加的 is-room / is-plain 在同一帧里生效，不会闪
achievements?.onUnlock((a) => { if (a.route) nav.unlock(a.route); });
if (mode !== 'room') {
  plain(mode === 'soft' ? 'soft' : undefined);
} else {
  html.classList.add('is-room');
  // 没配曲目（js/music-tracks.js 是空的）就不放播放器，唱机上的唱片空着
  const music = MUSIC_TRACKS.length ? createMusicPlayer({ vinyl: true, collapsed: true, lang: 'en' }) : null; // 唱片卡片收着，点唱机才打开；界面英文
  import('./room.js')
    .then((m) => personal.then(() => m.start(readContent(), { nav, music, achievements })))
    .catch((err) => { music?.destroy(); console.error('3D 房间加载失败，改用静态版', err); plain(); });
}
