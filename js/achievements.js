// 成就（书桌房间）：像 Steam 那样，第一次在房间里找到某样东西时，右下角滑出一张"成就解锁"的卡片。
//   - 顶部导航栏一开始只看得清 About / Work / Contact；Résumé、Books、Photos 是模糊的占位、点不了（js/nav.js），
//     在房间里第一次拿起桌上的打印纸、走到书架前、凑近软木板，就解锁对应的成就，导航栏那一项随之变清楚、可以点
//   - 解锁过的记在这个浏览器里（localStorage），下次来不用重新找；存储读写不了（隐私模式等）也照常能玩，只是不记。
//     控制台里 __achievements.reset() 清掉重来
const KEY = 'scene-cv:achievements';
const HOLD = 5200; // 卡片停留多久（毫秒）
const GAP = 650; // 同时解锁好几个时，一张接一张滑出来的间隔

// route：解锁后导航栏里打开的那一项（= index.html 里 section 的 id）
export const ACHIEVEMENTS = [
  { id: 'resume', route: 'papers', title: 'Paper Trail', desc: 'Picked up the papers on the desk.', icon: 'paper' }, // id 沿用旧的：已经解锁的人不丢
  { id: 'shelf', route: 'shelf', title: 'Bookworm', desc: 'Found the bookshelf.', icon: 'book' },
  { id: 'photos', route: 'photos', title: 'Pinned Memories', desc: 'Took a closer look at the cork board.', icon: 'photo' },
];

// 徽章上的小图（24 × 24，描边用 currentColor）
const ICONS = {
  paper: '<path d="M7 3.5h7.5L18 7v13.5H7z"/><path d="M14.5 3.5V7H18"/><path d="M9.5 11h6M9.5 14h6M9.5 17h4"/><path d="M5 6v16h11" opacity=".55"/>',
  book: '<path d="M4 5.5c2.8-.9 5.5-.6 8 1 2.5-1.6 5.2-1.9 8-1v13c-2.8-.9-5.5-.6-8 1-2.5-1.6-5.2-1.9-8-1z"/><path d="M12 6.5v13"/>',
  photo: '<rect x="5" y="4.5" width="14" height="16" rx=".6" transform="rotate(-5 12 12.5)"/><path d="M7.4 6.6l9.5-.8.8 9.3-9.5.8z" opacity=".55"/><circle cx="12" cy="3.6" r="1.4"/>',
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function save(ids) {
  try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* 存不了就只在这一次里记着 */ }
}

// label(route)：导航栏上那一项叫什么（写进卡片："Now in the menu: Papers"）
export function createAchievements({ label = () => '', doc = document } = {}) {
  const got = new Set(load().filter((id) => ACHIEVEMENTS.some((a) => a.id === id)));
  const listeners = [];
  let avoid = null; // () => 要让开的区域（DOMRect），比如右下角的内容面板
  let stack = null;
  const queue = [];
  let nextAt = 0, timer = 0;

  function ensureStack() {
    if (stack?.isConnected) return stack;
    stack = doc.createElement('div');
    stack.className = 'achv-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    doc.body.append(stack);
    return stack;
  }
  // 卡片默认贴右下角；右下角有内容面板时让开它：宽屏（面板左边有地方）排在面板左边，窄屏（面板横在底下）放到面板上面。
  // 面板会变（比如换书），卡片还在的时候隔一会儿重新量一次
  function place() {
    if (!stack) return;
    const r = avoid?.();
    let right = 16, bottom = 16;
    if (r && r.width && r.height) {
      if (r.left > 380) right = innerWidth - r.left + 12;
      else if (r.top - Math.max(stack.offsetHeight, 84) - 12 > 72) bottom = innerHeight - r.top + 12;
    }
    stack.style.setProperty('--achv-right', right + 'px');
    stack.style.setProperty('--achv-bottom', bottom + 'px');
  }
  let watch = 0;
  const follow = () => {
    if (watch) return;
    watch = setInterval(() => { if (stack?.childElementCount) place(); else { clearInterval(watch); watch = 0; } }, 250);
  };
  addEventListener('resize', place);

  function toast(a) {
    const s = ensureStack();
    const el = doc.createElement('div');
    el.className = 'achv' + (a.hidden ? ' is-hidden' : '') + (s.querySelector('.achv:not(.is-out)') ? ' is-stacked' : '');
    el.innerHTML = `<div class="achv-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[a.icon] || ''}</svg></div>
      <div class="achv-text"><div class="achv-kicker">${a.hidden ? 'Hidden achievement unlocked' : 'Achievement unlocked'}</div>
      <div class="achv-title">${esc(a.title)}</div><div class="achv-desc">${esc(a.desc)}</div>
      ${a.label ? `<div class="achv-menu">Now in the menu: ${esc(a.label)}</div>` : ''}</div>`;
    s.append(el);
    place();
    follow();
    void el.offsetWidth; // 先排好起点（屏幕下面）再加 is-in，过渡才会从下面滑上来
    el.classList.add('is-in');
    setTimeout(() => {
      el.classList.remove('is-in');
      el.classList.add('is-out');
      setTimeout(() => { el.remove(); place(); }, 600);
    }, HOLD);
  }
  function pump() {
    clearTimeout(timer);
    if (!queue.length) return;
    const wait = nextAt - performance.now();
    if (wait > 0) { timer = setTimeout(pump, wait); return; }
    toast(queue.shift());
    nextAt = performance.now() + GAP;
    if (queue.length) timer = setTimeout(pump, GAP);
  }

  const api = {
    list: ACHIEVEMENTS,
    has: (id) => got.has(id),
    // 导航栏里现在还锁着的项
    lockedRoutes: () => ACHIEVEMENTS.filter((a) => a.route && !got.has(a.id)).map((a) => a.route),
    // 解锁一个成就（已经有了就什么都不做）
    unlock(id) {
      const a = ACHIEVEMENTS.find((x) => x.id === id);
      if (!a || got.has(id)) return false;
      got.add(id);
      save([...got]);
      queue.push({ ...a, label: a.route ? label(a.route) || '' : '' });
      pump();
      for (const fn of listeners) fn(a);
      return true;
    },
    // 去过某个视角（#papers / #shelf / #photos …）：解锁打开这一项的成就
    visit(route) {
      const a = ACHIEVEMENTS.find((x) => x.route === route);
      return a ? api.unlock(a.id) : false;
    },
    onUnlock(fn) { listeners.push(fn); },
    setAvoid(fn) { avoid = fn; },
    reset() { got.clear(); save([]); },
  };
  window.__achievements = api;
  return api;
}
