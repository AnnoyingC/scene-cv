// 入口：用 3D 房间还是静态版，index.html 头部的小脚本已经判断过了（<html data-mode="room | soft | plain">），这里照着走。
// 3D 的话 js/boot.js 那时已经开始下载房间的大文件，这里加载 room.js 把房间搭起来；搭不起来就改用静态版。
import { readContent, bookTitle } from './content.js';
import { createNav } from './nav.js';
import { createMusicPlayer } from './music.js';
import { MUSIC_TRACKS } from './music-tracks.js';
import { createAchievements } from './achievements.js';

const html = document.documentElement;

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

// 只在本地的个人内容（这几个文件夹不进 Git，公开仓库里 index.html 是样例）：打开个人模式时有就换进内容层，没有就照样用样例。
//   assets/resume/resume.html         真实简历的几页纸 → #resume（3D 版每次拿起纸都从内容层复制，纯文字版直接显示）
//   assets/resume/contact.html        真实联系方式的几个 <li> → #online 的列表（记事本、联系面板、纯文字版）
//   assets/books/books.html           真实书单的 <li>（和样例一样多、一样的顺序和尺寸：房间是按样例的尺寸烘焙的）→ #shelf 的列表
//   assets/books/covers/covers.json   书名 → 真实封面的文件名 → #shelf 那本书的 data-cover
//   assets/photos/photos.json         做旧过的真实照片 → 照片墙（js/room.js 读）
// 个人模式默认关着：本地预览和公开的 GitHub 版一模一样（全是样例），不会一半真一半假。
// 网址加 ?personal，或者 <html data-personal>（个人网站的构建脚本会加上）才打开。
// 3D 场景等这几样换好了再读内容层
const PERSONAL = new URLSearchParams(location.search).has('personal') || document.documentElement.hasAttribute('data-personal');
const local = (path, as) => (PERSONAL ? fetch(new URL(path, import.meta.url), { cache: 'no-cache' })
  .then((r) => (r.ok ? r[as]() : null)).catch(() => null) : Promise.resolve(null));
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
  // 封面按书名对：先换好书单再对封面
  Promise.all([local('../assets/books/books.html', 'text').then((html) => {
    const list = document.querySelector('#shelf .books');
    if (!html || !list) return;
    const t = document.createElement('template');
    t.innerHTML = html;
    const items = t.content.querySelectorAll('li');
    if (items.length) list.replaceChildren(...items);
  }), local('../assets/books/covers/covers.json', 'json')]).then(([, map]) => {
    if (!map || typeof map !== 'object') return;
    for (const li of document.querySelectorAll('#shelf li')) {
      const file = map[bookTitle(li)];
      if (typeof file === 'string' && file) li.dataset.cover = file;
    }
  }),
]);

const mode = html.dataset.mode || 'plain';
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
    .then((m) => personal.then(() => m.start(readContent(), { nav, music, achievements, personal: PERSONAL })))
    .catch((err) => { music?.destroy(); console.error('3D 房间加载失败，改用静态版', err); plain(); });
}
