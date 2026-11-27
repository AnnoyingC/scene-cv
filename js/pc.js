// 旧电脑的屏幕：做成 PC-98 年代冒险游戏的样子（内容在 index.html #about 的 .pc-menu 里，js/content.js 读出来）。
// 它管的是简历装不下的东西：自我介绍、最近、一路走来（时间线）、怎么想问题、问答。纸质简历在桌上，作品在电视里。
//   - 画面（640 × 480 的像素格子，画布 1280 × 960 正好 2 倍；屏保 320 × 240 是 4 倍，格子对得上）：
//       左上景窗：窗外那片夜景的像素画（屏保同一张，不带标题），选不同的项切到不同的取景，一格格溶过去；星星、窗灯照样动
//       右边指令窗：现在能选的东西——菜单里的几项 / 打开的列表里的几条，下面是"在电视上播放""返回"
//       下面对话框：选中的那项先预览几行；打开以后一页页打出来（一段一页，长段按 4 行分页），▼ 表示还有下一页
//   - 三层：菜单 → 列表（时间线 / 笔记 / 问答）→ 一页文字。看文字时指令窗还列着同一层的别的项，点一下直接换过去
//   - 键盘：↑↓ 选择（看文字时是翻页），Enter / → / 空格 打开或下一页，Esc / ← / Backspace 返回上一层
//     （在菜单里按 Esc 由 room.js 退出），数字键直接打开第几项，L 切换语言
//   - 鼠标：room.js 把射线打到屏幕上的 UV 传进来（hover / click）：指令窗点哪行是哪行；点对话框 = 打开 / 显示全部 / 下一页；右上角切语言
//   - 时间线里带 data-tape 的一条，点开以后指令窗里多一行"在电视上播放"：onPlay(那个词) 交给 room.js 换带子
// 没有菜单（index.html 里没写 .pc-menu）时，把 #about 的几段字当成唯一的一项 ABOUT。
// 没人用电脑时放屏保（js/screensaver.js：窗外夜景的像素画 + 标题）：开场就是它；走到电脑前它一格格溶掉露出界面，
// 离开电脑 SAVER_IDLE 秒（一分钟）后又一格格盖回来。
import * as THREE from 'three';
import { makeCanvas } from './tapes/util.js';
import { sfx } from './sfx.js';
import { Screensaver } from './screensaver.js';
import { PAL as P, px, pxW, pxOK, bayerPatterns, dotPattern, BitmapText } from './pc-pixel.js';

const SAVER_IDLE = 60, SAVER_IN = 0.9, SAVER_OUT = 0.4; // 离开多久回到屏保；盖上、溶掉各要多久（秒）
const TYPE_CPS = 90, PREVIEW_CPS = 600;                   // 打字速度：打开的一页、预览（字 / 秒）
const CUT = 0.45;                                         // 景窗换取景：抖动溶解多久（秒）

// ---------- 版面（640 × 480 的格子） ----------
const LW = 640, LH = 480;
const SCENE = { x: 16, y: 42, w: 372, h: 258 };
const CMD = { x: 396, y: 42, w: 228, h: 258 };
const MSG = { x: 16, y: 312, w: 608, h: 140 };
const ROW0 = CMD.y + 48, ROWH = 28, ROWS = Math.floor((CMD.y + CMD.h - 12 - ROW0) / ROWH); // 指令窗：第一行的位置、行高、能放几行
const TX = MSG.x + 26, TY = MSG.y + 24, LINEH = 26, LINES = 4, TEXT = 16, TEXTW = MSG.w - 64; // 对话框里的字
// 景窗取景（scene.png 320 × 240 里的左上角；窗里放大 2 倍，取 182 × 125）：塔居中、月亮、右边近处的街区、塔在右三分之一、塔在左三分之一
// （塔在 x≈131、y 58–150：左边的取景总会带上塔，别让它只露半截）
const CW = (SCENE.w - 8) / 2, CH = (SCENE.h - 8) / 2;
const CROPS = [[40, 38], [138, 0], [138, 115], [0, 50], [88, 30]];

// 屏保和界面共用的扫描线：和像素格对齐（每 4 行画布像素压暗最下面一行），加一圈暗角
function saverScan(W, H, cell) {
  const c = makeCanvas(W, H), x = c.getContext('2d');
  x.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = cell - 1; y < H; y += cell) x.fillRect(0, y, W, 1);
  const g = x.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.9);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  return c;
}
const rect = (c, x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
const box = (c, x, y, w, h, col, t = 1) => { rect(c, x, y, w, t, col); rect(c, x, y + h - t, w, t, col); rect(c, x, y, t, h, col); rect(c, x + w - t, y, t, h, col); };
const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
// PC-98 式窗框：外暗线、2 像素亮框、内暗线、一圈暖色细线，四角小方块
function frame(c, { x, y, w, h }) {
  rect(c, x - 1, y - 1, w + 2, h + 2, P.ink);
  box(c, x, y, w, h, P.cream, 2);
  box(c, x + 2, y + 2, w - 4, h - 4, P.ink);
  box(c, x + 3, y + 3, w - 6, h - 6, P.warmD);
  for (const [X, Y] of [[x - 2, y - 2], [x + w - 4, y - 2], [x - 2, y + h - 4], [x + w - 4, y + h - 4]]) { rect(c, X, Y, 6, 6, P.amber); rect(c, X + 2, Y + 2, 2, 2, P.ink); }
}

const UI = {
  zh: {
    menu: '↑↓ 选择 · ENTER 打开 · 点一下也行', list: '↑↓ 选择 · ENTER 打开 · ESC 返回', doc: '↓ ENTER 下一页 · ↑ 上一页 · ESC 返回',
    docEnd: '点右边换一条 · ESC 返回', docPlay: 'ENTER 在电视上播放 · ESC 返回', updated: '更新于', play: '在电视上播放', back: '返回',
    hOpen: '打开', hPlay: '在电视上播放', hBack: '返回', hLang: '切换语言', hSkip: '点一下显示全部', hNext: '下一页',
  },
  en: {
    menu: '↑↓ select · ENTER open · or click', list: '↑↓ select · ENTER open · ESC back', doc: '↓ ENTER next page · ↑ previous · ESC back',
    docEnd: 'Pick another on the right · ESC back', docPlay: 'ENTER play on the TV · ESC back', updated: 'Updated', play: 'Play on the TV', back: 'Back',
    hOpen: 'Open', hPlay: 'Play on the TV', hBack: 'Back', hLang: 'Switch language', hSkip: 'Click to show all', hNext: 'Next page',
  },
};

export class PCScreen {
  constructor({ name, tagline, about = [], pcMenus = [] }, { canPlay = () => false, onPlay = null } = {}, W = 1280, H = 960) {
    Object.assign(this, { W, H, canPlay, onPlay });
    this.canvas = makeCanvas(W, H);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.L = makeCanvas(LW, LH);   // 界面先画在 640 × 480 上，再放大 2 倍（不插值）
    this.lx = this.L.getContext('2d');
    this.tmp = makeCanvas(SCENE.w - 8, SCENE.h - 8); // 景窗溶解用
    this.tx = this.tmp.getContext('2d');
    this.pats = bayerPatterns(this.tx, 2);
    this.bt = new BitmapText();
    this.name = (name || 'Guest').trim();
    const fallback = [...(tagline ? [tagline] : []), ...about];
    this.menus = pcMenus.length ? pcMenus : [{
      lang: document.documentElement.lang || 'en', label: '',
      items: [{ cmd: 'ABOUT', title: 'About', updated: '', paras: fallback.length ? fallback : [this.name], entries: [] }],
    }];
    const want = (document.documentElement.lang || '').toLowerCase().split('-')[0];
    this.li = Math.max(0, this.menus.findIndex((m) => m.lang.toLowerCase().split('-')[0] === want));
    this.active = false;
    this.hoverRow = -1;
    this.hoverLang = false;
    this.clockText = null;  // 宣传片 / 截图可以把右上角的时间定死（'23:14'）；平时是本机时间
    this.acc = 1;
    this.reset();
    this.bg = this.paintBg();
    this.scene = new Screensaver(undefined, { image: 'scene.png', fx: 'scene-fx.png', badge: null });
    this.cut = { from: 0, to: null, t: 1 };
    this.saver = new Screensaver();
    this.saverScan = saverScan(W, H, W / 320);
    this.saverMix = 1;      // 屏保盖住多少：0 = 界面，1 = 屏保
    this.saverOn = true;    // 现在该不该是屏保
    this.saverStart = 0;    // 这一轮屏保从什么时候开始（徽章、扫光从这儿算）
    this.saverBack = Infinity;
    this.clock = 0;
  }
  // 宣传片 / 截图用：直接停在屏保上，t0 秒以前开始的（t0 = 10：徽章已经浮现完）
  showSaver(t0 = 0) { this.saverOn = true; this.saverMix = 1; this.saverStart = this.clock - t0; this.saverBack = Infinity; this.acc = 1; }

  get menu() { return this.menus[this.li]; }
  get ui() { return UI[(this.menu?.lang || document.documentElement.lang || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en']; }
  get top() { return this.stack[this.stack.length - 1]; }

  reset() { this.stack = [{ type: 'menu', sel: 0, scroll: 0, reveal: 0, typed: 0, pkey: '' }]; }
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.reset(); // 每次走到电脑前都从菜单开始
    this.hoverRow = -1;
    if (on) { this.saverOn = false; this.saverBack = Infinity; } // 点了屏保：唤醒
    else this.saverBack = this.clock + SAVER_IDLE;
  }

  // ---------- 内容 ----------
  // 一段一页，长段每 4 行一页
  pages(paras) {
    const out = [];
    for (const p of paras) {
      const ls = this.bt.wrap(p, TEXTW, TEXT);
      for (let i = 0; i < ls.length; i += LINES) out.push(ls.slice(i, i + LINES));
    }
    return out.length ? out : [['']];
  }
  // 预览：排成最多 4 行，后面还有就在最后一行加省略号
  fit(paras) {
    const lines = paras.flatMap((p) => this.bt.wrap(p, TEXTW, TEXT));
    if (lines.length <= LINES) return lines;
    const out = lines.slice(0, LINES);
    if (!/[.。!?！？…]$/.test(out[LINES - 1])) out[LINES - 1] = this.bt.clip(out[LINES - 1], TEXTW, TEXT, 400, true); // 断在句中才加省略号
    return out;
  }
  // 对话框里现在是什么：名牌、名牌旁边的小字（时间 / 更新于）、几行字
  message(s = this.top) {
    if (s.type === 'doc') return { tab: s.tab, tag: s.tag, lines: s.pages[s.page] };
    const it = this.menu.items[s.type === 'menu' ? s.sel : s.item];
    if (s.type === 'menu') {
      const src = it.paras.length ? it.paras : it.entries.map((e) => (e.when ? `${e.when}  ${e.title}` : `· ${e.title}`));
      return { tab: it.cmd, tag: it.updated ? `${this.ui.updated} ${it.updated}` : '', lines: this.fit(src) };
    }
    const e = it.entries[s.sel];
    return { tab: e.title, tag: e.when, lines: this.fit(e.paras.length ? e.paras : [e.title]) };
  }
  count(lines) { return lines.reduce((n, l) => n + l.length, 0); }
  // 指令窗里的几行：先是同一层的项 / 条（下标就是第几项 / 第几条），再是"在电视上播放""返回"
  rows(s = this.top) {
    const u = this.ui, items = this.menu.items;
    if (s.type === 'menu' || (s.type === 'doc' && s.entry < 0)) {
      const rows = items.map((it, i) => ({ kind: 'item', i, label: it.title, num: String(i + 1) }));
      if (s.type === 'doc') rows.push({ kind: 'back', label: u.back, gap: true });
      return rows;
    }
    const it = items[s.item], dated = it.entries.some((e) => e.when);
    const rows = it.entries.map((e, j) => ({ kind: 'entry', j, label: e.title, num: dated ? e.when : String(j + 1), when: dated }));
    if (s.type === 'doc' && s.act) rows.push({ kind: 'play', label: u.play, gap: true });
    rows.push({ kind: 'back', label: u.back, gap: !(s.type === 'doc' && s.act) });
    return rows;
  }
  cur(s = this.top) { return s.type === 'doc' ? (s.entry >= 0 ? s.entry : s.item) : s.sel; } // 高亮哪一行
  first(s, rows) { // 行多了要滚：让高亮的那行留在看得见的地方
    if (rows.length <= ROWS) return 0;
    const c = this.cur(s);
    s.scroll = Math.min(rows.length - ROWS, Math.max(0, Math.min(s.scroll || 0, c), c - ROWS + 1));
    return s.scroll;
  }
  cropFor(s = this.top) { // 景窗的取景：每项一个；列表里每条往后错一个
    const i = s.type === 'menu' ? s.sel : s.item, j = s.type === 'list' ? s.sel : s.type === 'doc' ? Math.max(0, s.entry) : 0;
    return (i + j) % CROPS.length;
  }

  // ---------- 动作 ----------
  open(i) { // 打开菜单里的第 i 项（从别的页点过来也行）
    const it = this.menu.items[i];
    if (!it) return;
    this.stack.length = 1;
    this.stack[0].sel = i;
    if (it.entries.length) this.stack.push({ type: 'list', item: i, sel: 0, scroll: 0, reveal: 0, typed: 0, pkey: '' });
    else this.stack.push({ type: 'doc', item: i, entry: -1, tab: it.cmd, tag: it.updated ? `${this.ui.updated} ${it.updated}` : '', pages: this.pages(it.paras), page: 0, typed: 0, act: null });
  }
  openEntry(j) { // 打开列表里的第 j 条（在一条里点旁边那条也走这儿）
    while (this.top.type === 'doc' && this.stack.length > 1) this.stack.pop();
    const s = this.top;
    if (s.type !== 'list') return;
    const e = this.menu.items[s.item].entries[j];
    if (!e) return;
    s.sel = j;
    const act = e.tape && this.canPlay(e.tape) ? e.tape : null;
    this.stack.push({ type: 'doc', item: s.item, entry: j, tab: e.title, tag: e.when, pages: this.pages(e.paras.length ? e.paras : [e.title]), page: 0, typed: 0, act, scroll: 0 });
  }
  pick(row) {
    const s = this.top;
    if (!row) return;
    if (row.kind === 'back') return this.back();
    if (row.kind === 'play') return this.onPlay?.(s.act);
    sfx.play('key', { gain: 0.5 });
    if (row.kind === 'item' && !(s.type === 'doc' && s.entry < 0 && s.item === row.i)) this.open(row.i);
    if (row.kind === 'entry' && !(s.type === 'doc' && s.entry === row.j)) this.openEntry(row.j);
  }
  back() {
    if (this.stack.length < 2) return false;
    sfx.play('key', { gain: 0.4, rate: 0.9 });
    this.stack.pop();
    return true;
  }
  toggleLang() {
    if (this.menus.length < 2) return;
    const items = this.menu.items, path = this.stack.slice(1).map((s) => ({ type: s.type, cmd: items[s.item].cmd, entry: s.entry ?? -1, sel: s.sel }));
    const sel0 = this.stack[0].sel;
    this.li = (this.li + 1) % this.menus.length;
    this.reset();
    this.stack[0].sel = Math.min(sel0, this.menu.items.length - 1);
    for (const p of path) { // 换了语言还停在同一页
      const i = this.menu.items.findIndex((it) => it.cmd === p.cmd);
      if (i < 0) break;
      if (p.type === 'list') { this.open(i); this.top.sel = Math.min(p.sel, this.menu.items[i].entries.length - 1); this.top.reveal = 99; }
      else if (p.entry >= 0 && this.top.type === 'list') this.openEntry(p.entry);
      else this.open(i);
      this.finish();
    }
  }
  enter() {
    const s = this.top;
    if (s.type === 'menu') return this.pick({ kind: 'item', i: s.sel });
    if (s.type === 'list') return this.pick({ kind: 'entry', j: s.sel });
    if (s.typed < this.count(s.pages[s.page])) return this.finish();
    if (s.page < s.pages.length - 1) return this.turn(1);
    if (s.act) this.onPlay?.(s.act);
  }
  move(d) {
    const s = this.top;
    if (s.type === 'doc') return this.turn(d);
    const n = s.type === 'menu' ? this.menu.items.length : this.menu.items[s.item].entries.length;
    s.sel = (s.sel + d + n) % n;
    sfx.play('tick', { gain: 0.33 });
  }
  turn(d) { // 翻页：往后翻时这页还没打完就先打完
    const s = this.top;
    if (s.type !== 'doc') return this.move(d);
    if (d > 0) {
      if (s.typed < this.count(s.pages[s.page])) return this.finish();
      if (s.page < s.pages.length - 1) { s.page++; s.typed = 0; sfx.play('tick', { gain: 0.3 }); }
    } else if (s.page > 0) { s.page--; s.typed = this.count(s.pages[s.page]); sfx.play('tick', { gain: 0.3 }); }
  }
  finish() { const s = this.top; s.typed = s.type === 'doc' ? this.count(s.pages[s.page]) : 1e9; if (s.reveal != null) s.reveal = 99; }
  scrollBy(n) { this.move(Math.sign(n)); }

  // ---------- 输入 ----------
  key(e) { // 处理了返回 true；在菜单里按 Esc 返回 false（room.js 退出电脑）
    const s = this.top, k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'PageUp' || k === 'PageDown') { this.move(k === 'ArrowDown' || k === 'PageDown' ? 1 : -1); return true; }
    if (k === 'Enter' || k === 'ArrowRight' || k === ' ') { this.enter(); return true; }
    if (k === 'Escape' || k === 'Backspace' || k === 'ArrowLeft') return this.back();
    if (k === 'l' || k === 'L') { this.toggleLang(); return this.menus.length > 1; }
    if (/^[1-9]$/.test(k)) {
      const row = this.rows(s)[Number(k) - 1];
      if (row && (row.kind === 'item' || row.kind === 'entry')) this.pick(row);
      return true;
    }
    return false;
  }
  at(uv) { // 屏幕上的一点 → 点了会做什么（row：鼠标在哪一行 / 哪一块，room.js 拿它判断提示要不要换）
    if (!uv) return null;
    const x = uv.x * LW, y = (1 - uv.y) * LH, s = this.top;
    if (y < 34 && x > LW * 0.62) return this.menus.length > 1 ? { do: 'lang', row: 'L' } : null;
    if (inside(CMD, x, y)) {
      const rows = this.rows(s), first = this.first(s, rows), r = Math.floor((y - ROW0 + 6) / ROWH), row = rows[first + r];
      if (r < 0 || r >= ROWS || !row) return null;
      const here = s.type === 'doc' && first + r === this.cur(s) && row.kind !== 'back' && row.kind !== 'play'; // 正在看的那条
      return here ? null : { do: row.kind, row: first + r };
    }
    if (inside(MSG, x, y) || inside(SCENE, x, y)) {
      if (s.type === 'menu') return { do: 'item', row: 'm' };
      if (s.type === 'list') return { do: 'entry', row: 'm' };
      if (s.typed < this.count(s.pages[s.page])) return { do: 'skip', row: 'm' };
      if (s.page < s.pages.length - 1) return { do: 'next', row: 'm' };
      return s.act ? { do: 'play', row: 'm' } : null;
    }
    return null;
  }
  hover(uv) {
    const a = this.at(uv), s = this.top;
    this.hoverRow = typeof a?.row === 'number' ? a.row : -1;
    this.hoverLang = a?.do === 'lang';
    if (this.hoverRow >= 0 && s.type !== 'doc' && (a.do === 'item' || a.do === 'entry')) s.sel = a.row; // 菜单 / 列表：鼠标停在哪行就选中哪行
  }
  click(uv) {
    const a = this.at(uv), s = this.top;
    if (!a) return;
    if (a.do === 'lang') return this.toggleLang();
    if (a.do === 'skip') return this.finish();
    if (a.do === 'next') return this.turn(1);
    if (a.do === 'play') return this.onPlay?.(s.act);
    if (a.row === 'm') return this.enter(); // 点景窗 / 对话框：打开选中的那项
    this.pick(this.rows(s)[a.row]);
  }
  hintAt(uv) { // 鼠标停在屏幕上时给 room.js 的提示
    const a = this.at(uv), u = this.ui;
    return { item: u.hOpen, entry: u.hOpen, skip: u.hSkip, next: u.hNext, back: u.hBack, lang: u.hLang, play: u.hPlay }[a?.do] || '';
  }

  // ---------- 画 ----------
  paintBg() { // 不动的部分画一次：底纹、顶条、三个窗框和底色
    const b = makeCanvas(LW, LH), c = b.getContext('2d');
    rect(c, 0, 0, LW, LH, P.ink);
    c.fillStyle = dotPattern(c, P.sky0, 2);
    c.fillRect(0, 0, LW, LH);
    rect(c, 0, 0, LW, 32, P.sky1);
    rect(c, 0, 32, LW, 1, P.haze);
    rect(c, 0, 33, LW, 1, P.ink);
    for (const r of [SCENE, CMD, MSG]) frame(c, r);
    rect(c, CMD.x + 4, CMD.y + 4, CMD.w - 8, CMD.h - 8, P.sky1);
    c.fillStyle = dotPattern(c, P.sky2, 4);
    c.fillRect(CMD.x + 4, CMD.y + 4, CMD.w - 8, CMD.h - 8);
    rect(c, MSG.x + 4, MSG.y + 4, MSG.w - 8, MSG.h - 8, P.sky1);
    return b;
  }
  label(c, str, x, y, color, s = 1, size = 13) { // 点阵字能写就用点阵字，写不了（中文等）用位图字
    if (pxOK(str)) return px(c, str, x, y, color, s);
    return this.bt.draw(c, str, x, y - (size - 7 * s) / 2 - 1, color, size, { weight: 600 });
  }
  draw(t) {
    const c = this.lx, s = this.top, u = this.ui, blink = Math.floor(t * 2.4) % 2 === 0;
    c.drawImage(this.bg, 0, 0);

    // 顶条：名字；右边时间、切语言
    if (pxOK(this.name)) px(c, this.name, 24, 10, P.cream, 2);
    else this.bt.draw(c, this.name, 24, 6, P.cream, 18, { weight: 600 });
    let rx = LW - 24;
    if (this.menus.length > 1) {
      const other = `L · ${this.menus[(this.li + 1) % this.menus.length].label}`, w = this.bt.width(other, 13, 600);
      if (this.hoverLang) rect(c, rx - w - 6, 7, w + 12, 19, P.sky3);
      this.bt.draw(c, other, rx - w, 8, this.hoverLang ? P.paper : P.lav, 13, { weight: 600 });
      rx -= w + 18;
    }
    const d = new Date(), clock = this.clockText || `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    px(c, clock, rx - pxW(clock, 2), 10, P.amber, 2);

    this.drawScene(c);
    this.drawCmd(c, s, blink);
    this.drawMsg(c, s, u, blink);

    // 脚注：按键提示
    const foot = s.type === 'menu' ? u.menu : s.type === 'list' ? u.list : s.page < s.pages.length - 1 ? u.doc : s.act ? u.docPlay : u.docEnd;
    this.bt.draw(c, foot, 24, LH - 22, P.lav, 12);
  }
  drawScene(c) {
    const want = this.cropFor();
    if (this.cut.to == null) this.cut = { from: want, to: want, t: 1 };
    else if (want !== this.cut.to) this.cut = { from: this.cut.to, to: want, t: 0 };
    const X = SCENE.x + 4, Y = SCENE.y + 4, w = SCENE.w - 8, h = SCENE.h - 8;
    const f = this.scene.ready ? this.scene.frame(this.clock, this.clock, 1) : null;
    if (f) {
      const [ax, ay] = CROPS[this.cut.from], [bx, by] = CROPS[this.cut.to];
      c.imageSmoothingEnabled = false;
      if (this.cut.t < 1) { // 新取景按 Bayer 顺序一格格盖上去
        c.drawImage(f, ax, ay, CW, CH, X, Y, w, h);
        const tx = this.tx;
        tx.imageSmoothingEnabled = false;
        tx.globalCompositeOperation = 'copy';
        tx.drawImage(f, bx, by, CW, CH, 0, 0, w, h);
        tx.globalCompositeOperation = 'destination-in';
        tx.fillStyle = this.pats[Math.round(this.cut.t * 16)];
        tx.fillRect(0, 0, w, h);
        tx.globalCompositeOperation = 'source-over';
        c.drawImage(this.tmp, X, Y);
      } else c.drawImage(f, bx, by, CW, CH, X, Y, w, h);
    } else rect(c, X, Y, w, h, P.sky1);
    // 景窗的小标签
    const tag = `SCENE ${this.cut.to + 1} · TOKYO`, tw = pxW(tag) + 12, x0 = SCENE.x + 14, y0 = SCENE.y - 6;
    rect(c, x0 - 1, y0 - 1, tw + 2, 13, P.ink);
    rect(c, x0, y0, tw, 11, P.ink);
    box(c, x0, y0, tw, 11, P.cream);
    px(c, tag, x0 + 6, y0 + 2, P.cream);
  }
  drawCmd(c, s, blink) {
    const rows = this.rows(s), first = this.first(s, rows), cur = this.cur(s);
    const head = s.type === 'menu' ? 'COMMAND' : this.menu.items[s.item].cmd;
    if (pxOK(head)) px(c, head, CMD.x + (CMD.w - pxW(head, 2)) / 2, CMD.y + 14, P.amber, 2);
    else this.bt.draw(c, head, CMD.x + (CMD.w - this.bt.width(head, 16, 600)) / 2, CMD.y + 12, P.amber, 16, { weight: 600 });
    rect(c, CMD.x + 14, CMD.y + 34, CMD.w - 28, 1, P.haze);
    // 编号那一列（时间线是年份）一样宽，标题对齐
    const numW = Math.max(0, ...rows.filter((r) => r.num).map((r) => (pxOK(r.num) ? pxW(r.num) : this.bt.width(r.num, 13, 600))));
    rows.slice(first, first + ROWS).forEach((row, k) => {
      const idx = first + k, y = ROW0 + k * ROWH;
      if (s.reveal != null && idx >= s.reveal) return; // 刚打开：一行行亮起来
      const on = (row.kind === 'item' || row.kind === 'entry') && idx === cur, hot = !on && this.hoverRow === idx;
      if (row.gap) rect(c, CMD.x + 14, y - 8, CMD.w - 28, 1, P.haze);
      if (on) { rect(c, CMD.x + 10, y - 5, CMD.w - 20, 24, P.amber); rect(c, CMD.x + 10, y + 19, CMD.w - 20, 1, P.warmD); }
      else if (hot) rect(c, CMD.x + 10, y - 5, CMD.w - 20, 24, P.sky3);
      if (on && (s.type === 'doc' || blink || !this.active)) px(c, '▶', CMD.x + 15, y + 3, P.rust);
      const x0 = CMD.x + 27;
      if (row.kind === 'back' || row.kind === 'play') {
        const col = row.kind === 'play' ? P.tower2 : hot ? P.cream : P.lav;
        px(c, row.kind === 'play' ? '▶' : '◀', x0, y + 3, col);
        this.bt.draw(c, row.label, x0 + 14, y - 1, hot ? P.paper : col, 15);
        return;
      }
      this.label(c, row.num, x0, y + 3, on ? P.ink : row.when ? P.amber : P.lav);
      const lx = x0 + numW + (row.when ? 10 : 9), lab = this.bt.clip(row.label, CMD.x + CMD.w - 14 - lx, 16);
      this.bt.draw(c, lab, lx, y - 1, on ? P.ink : hot ? P.paper : P.cream, 16);
    });
    if (rows.length > ROWS) { // 滚动条
      const h = (ROWS * ROWH) * (ROWS / rows.length), top = ROW0 - 5 + (ROWS * ROWH - h) * (first / (rows.length - ROWS));
      rect(c, CMD.x + CMD.w - 9, ROW0 - 5, 2, ROWS * ROWH, P.sky3);
      rect(c, CMD.x + CMD.w - 9, top, 2, h, P.lav);
    }
    if (s.type === 'menu') px(c, `${rows.length} ITEMS`, CMD.x + 16, CMD.y + CMD.h - 18, P.lav);
  }
  drawMsg(c, s, u, blink) {
    const { tab, tag, lines } = this.message(s), total = this.count(lines), typed = Math.min(total, s.typed);
    // 名牌：骑在对话框上沿，塔的橙色
    const tw = this.bt.width(tab, 13, 600) + 16, x0 = MSG.x + 14, y0 = MSG.y - 9;
    rect(c, x0 - 1, y0 - 1, tw + 2, 20, P.ink);
    rect(c, x0, y0, tw, 18, P.tower);
    box(c, x0, y0, tw, 18, P.paper);
    this.bt.draw(c, tab, x0 + 8, y0 + 2, P.paper, 13, { weight: 600 });
    if (tag) {
      const w = pxOK(tag) ? pxW(tag) : this.bt.width(tag, 13, 600);
      rect(c, x0 + tw + 6, MSG.y - 1, w + 10, 4, P.ink);
      this.label(c, tag, x0 + tw + 11, MSG.y - 3, P.amber);
    }
    // 字：打到哪儿画到哪儿
    let left = typed, cx = TX, cy = TY;
    lines.forEach((l, i) => {
      if (left <= 0) return;
      const n = Math.min(l.length, left);
      this.bt.draw(c, l, TX, TY + i * LINEH, P.cream, TEXT, { upto: n });
      cx = TX + this.bt.width(l.slice(0, n), TEXT) + 2;
      cy = TY + i * LINEH;
      left -= l.length;
    });
    const done = typed >= total, mx = MSG.x + MSG.w - 30, my = MSG.y + MSG.h - 24;
    if (!done && s.type === 'doc' && blink) rect(c, cx, cy + 1, 8, 16, P.amber); // 光标
    if (done) {
      const more = s.type !== 'doc' || s.page < s.pages.length - 1;
      if (more) { if (blink) px(c, '▼', mx, my, P.amber, 2); }
      else if (s.act) {
        px(c, '▶', mx + 2, my, P.tower2, 2);
        const w = this.bt.width(u.play, 13, 600);
        this.bt.draw(c, u.play, mx - 10 - w, my, P.tower2, 13, { weight: 600 });
      } else rect(c, mx + 3, my + 4, 6, 6, P.lav); // 完
    }
    if (s.type === 'doc' && s.pages.length > 1) {
      const pg = `${s.page + 1}/${s.pages.length}`;
      px(c, pg, MSG.x + MSG.w - 40 - pxW(pg) - (s.act && done && s.page === s.pages.length - 1 ? this.bt.width(u.play, 13, 600) + 14 : 0), my + 4, P.lav);
    }
  }

  // ---------- 每帧 ----------
  update(t, dt) {
    const s = this.top;
    this.clock += dt;
    if (!this.active && !this.saverOn && this.clock >= this.saverBack) { this.saverOn = true; this.saverStart = this.clock; }
    const mix0 = this.saverMix;
    this.saverMix = this.saverOn ? Math.min(1, mix0 + dt / SAVER_IN) : Math.max(0, mix0 - dt / SAVER_OUT);
    if (this.saverOn && mix0 === 0 && this.saverMix > 0) this.saverStart = this.clock;
    if (s.type === 'doc') { if (this.active) s.typed = Math.min(this.count(s.pages[s.page]), s.typed + dt * TYPE_CPS); }
    else {
      const key = `${s.type}${s.sel}`;
      if (s.pkey !== key) { s.pkey = key; s.typed = 0; }
      s.typed += dt * PREVIEW_CPS;
    }
    if (s.reveal != null && s.reveal < 99) s.reveal += dt * (this.active ? 24 : 99); // 指令一行行亮起来
    this.cut.t = Math.min(1, this.cut.t + dt / CUT);
    this.acc += dt;
    if (this.acc < 1 / 30) return; // 30 帧够了
    this.acc = 0;
    const { ctx, W, H } = this;
    const saver = this.saverMix > 0 ? this.saver.frame(this.clock - this.saverStart, this.clock, this.saverMix) : null;
    if (this.saverOn && !this.saver.ready && !this.saver.failed) { // 屏保的图还在下：先黑着，别先闪一下界面
      ctx.fillStyle = P.ink;
      ctx.fillRect(0, 0, W, H);
      this.texture.needsUpdate = true;
      return;
    }
    ctx.imageSmoothingEnabled = false;
    if (!(saver && this.saverMix >= 1)) { // 全是屏保时界面不用画
      this.draw(t);
      ctx.drawImage(this.L, 0, 0, W, H);
    }
    if (saver) ctx.drawImage(saver, 0, 0, W, H); // 屏保一格格溶掉 / 盖上
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.saverScan, 0, 0);
    this.texture.needsUpdate = true;
  }
}
