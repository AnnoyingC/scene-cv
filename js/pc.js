// 旧电脑的屏幕：绿色荧光终端上的一个小菜单（内容在 index.html #about 的 .pc-menu 里，js/content.js 读出来）。
// 它管的是简历装不下的东西：自我介绍、最近、一路走来（时间线）、怎么想问题、问答。纸质简历在桌上，作品在电视里。
//   - 三种画面：菜单 → 列表（时间线 / 笔记 / 问答）→ 一页文字（打字机效果，可以滚动）
//   - 键盘：↑↓ 选择或滚动，Enter / → 打开，Esc / ← / Backspace 返回上一层（在菜单里按 Esc 由 room.js 退出），数字键直接打开第几项，L 切换语言
//   - 鼠标：room.js 把射线打到屏幕上的 UV 传进来（hover / click），点哪一行就是哪一行；右上角切语言 / 返回
//   - 时间线里带 data-tape 的一条，点开以后最后一行是"在电视上播放"：onPlay(那个词) 交给 room.js 换带子
// 没有菜单（index.html 里没写 .pc-menu）时就像以前一样：把 #about 的几段字打出来。
import * as THREE from 'three';
import { wrap, makeCanvas, scanlines, MONO } from './tapes/util.js';

const GREEN = '#5dff93', DIM = 'rgba(93,255,147,0.5)', BG = '#03130a';
const UI = {
  zh: {
    menu: '↑↓ 选择 · ENTER 打开 · 点一下也行', list: '↑↓ 选择 · ENTER 打开 · ESC 返回', doc: '↑↓ 滚动 · ESC 返回',
    docPlay: 'ENTER 在电视上播放 · ESC 返回', back: 'ESC 返回', updated: '更新于', play: '▶ 在电视上播放',
    hOpen: '打开', hPlay: '在电视上播放', hBack: '返回', hLang: '切换语言', hSkip: '点一下显示全部',
  },
  en: {
    menu: '↑↓ select · ENTER open · or click', list: '↑↓ select · ENTER open · ESC back', doc: '↑↓ scroll · ESC back',
    docPlay: 'ENTER play on the TV · ESC back', back: 'ESC back', updated: 'Updated', play: '▶ Play on the TV',
    hOpen: 'Open', hPlay: 'Play on the TV', hBack: 'Back', hLang: 'Switch language', hSkip: 'Click to show all',
  },
};

export class PCScreen {
  // 排版按 512 × 384 定（16px 字、22px 行高、15 行：第一行标题、最后一行提示、中间 13 行内容）；canvas 按 k 倍画，镜头凑近时字也清楚
  constructor({ name, tagline, about = [], pcMenus = [] }, { canPlay = () => false, onPlay = null } = {}, W = 1024, H = 768) {
    const k = W / 512;
    Object.assign(this, { W, H, k, pad: 20 * k, lh: 22 * k, canPlay, onPlay });
    this.canvas = makeCanvas(W, H);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.scan = scanlines(512, 384, 0.22); // 扫描线按原来的疏密，画的时候放大
    this.font = `${16 * k}px ${MONO}`;
    this.ctx.font = this.font;
    this.rows = Math.floor((H - this.pad * 2) / this.lh);
    this.body = this.rows - 2;
    this.maxW = W - this.pad * 2;
    this.title = `${(name || 'GUEST').toUpperCase()} PC · 640K OK`;
    this.menus = pcMenus;
    this.fallback = [...(tagline ? [tagline] : []), ...about];
    const want = (document.documentElement.lang || '').toLowerCase().split('-')[0];
    this.li = Math.max(0, pcMenus.findIndex((m) => m.lang.toLowerCase().split('-')[0] === want));
    this.active = false;
    this.hoverRow = -1;
    this.acc = 1;
    this.reset();
  }

  get menu() { return this.menus[this.li]; }
  get ui() { return UI[(this.menu?.lang || document.documentElement.lang || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en']; }
  get top() { return this.stack[this.stack.length - 1]; }
  // room.js 用：还在打字吗
  get typed() { return this.top.type === 'doc' ? this.top.typed : 1; }
  get total() { return this.top.type === 'doc' ? this.top.total : 1; }

  reset() {
    this.stack = this.menu ? [{ type: 'menu', sel: 0, scroll: 0, reveal: 0 }] : [this.doc('ABOUT.TXT', this.fallback)];
  }
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.reset(); // 每次走到电脑前都从菜单开始
    this.hoverRow = -1;
  }

  // ---------- 画面 ----------
  // 一页文字：lines 是排好版的行 { t, dim, act }；typed 是已经打出来的字数
  doc(file, paras, { pre = [], act = null, cmd = '', entry = -1 } = {}) {
    this.ctx.font = this.font;
    const w = this.maxW - 10 * this.k, lines = pre.flatMap((l) => wrap(this.ctx, l.t, w).map((t) => ({ ...l, t })));
    paras.forEach((p, i) => {
      if (i || pre.length) lines.push({ t: '' });
      for (const l of wrap(this.ctx, p, w)) lines.push({ t: l });
    });
    if (act) lines.push({ t: '' }, { t: this.ui.play, act });
    const total = lines.reduce((n, l) => n + l.t.length + 1, 0);
    return { type: 'doc', file, lines, typed: 0, total, scroll: 0, follow: true, act, cmd, entry };
  }
  open(i) { // 打开菜单里的第 i 项
    const it = this.menu?.items[i];
    if (!it) return;
    if (it.entries.length) this.stack.push({ type: 'list', cmd: it.cmd, item: i, sel: 0, scroll: 0, reveal: 0 });
    else {
      const pre = it.updated ? [{ t: `${this.ui.updated} ${it.updated}`, dim: true }] : [];
      this.stack.push(this.doc(`TYPE ${it.cmd}.TXT`, it.paras, { pre, cmd: it.cmd }));
    }
  }
  openEntry(s, j) { // 打开列表里的第 j 条
    const it = this.menu.items[s.item], e = it.entries[j];
    if (!e) return;
    const pre = [{ t: e.title }, ...(e.when ? [{ t: e.when, dim: true }] : [])];
    const act = e.tape && this.canPlay(e.tape) ? e.tape : null;
    this.stack.push(this.doc(`${it.cmd}.EXE › ${j + 1}/${it.entries.length}`, e.paras, { pre, act, cmd: it.cmd, entry: j }));
  }
  back() {
    if (this.stack.length < 2) return false;
    this.stack.pop();
    return true;
  }
  toggleLang() {
    if (this.menus.length < 2) return;
    const path = this.stack.map((s) => ({ ...s }));
    this.li = (this.li + 1) % this.menus.length;
    this.reset();
    for (const s of path.slice(1)) { // 换了语言还停在同一页
      const i = this.menu.items.findIndex((it) => it.cmd === s.cmd);
      if (i < 0) break;
      if (s.type === 'list') { this.stack[0].sel = i; this.open(i); Object.assign(this.top, { sel: s.sel, scroll: s.scroll, reveal: 99 }); }
      else if (s.entry >= 0 && this.top.type === 'list') this.openEntry(this.top, s.entry);
      else { this.stack[0].sel = i; this.open(i); }
      if (this.top.type === 'doc') this.top.typed = this.top.total;
    }
  }
  items(s = this.top) { // 菜单 / 列表里的一行行
    if (s.type === 'menu') return this.menu.items.map((it, i) => ({ num: String(i + 1), key: it.cmd, label: it.title }));
    const it = this.menu.items[s.item];
    const ask = it.entries.every((e) => !e.when);
    return it.entries.map((e, j) => ({ num: e.when || (ask ? String(j + 1) : ''), key: '', label: e.title }));
  }
  enter() {
    const s = this.top;
    if (s.type === 'menu') return this.open(s.sel);
    if (s.type === 'list') return this.openEntry(s, s.sel);
    if (s.typed < s.total) return this.finish();
    if (s.act) this.onPlay?.(s.act);
  }
  move(d) {
    const s = this.top;
    if (s.type === 'doc') return this.scrollBy(d);
    const n = this.items(s).length;
    s.sel = (s.sel + d + n) % n;
    this.keep(s);
  }
  keep(s) { // 选中的那行留在可见范围里（菜单上面空一行）
    const off = s.type === 'menu' ? 1 : 0, vis = this.body - off;
    if (s.sel < s.scroll) s.scroll = s.sel;
    if (s.sel >= s.scroll + vis) s.scroll = s.sel - vis + 1;
  }
  finish() { const s = this.top; if (s.type === 'doc') s.typed = s.total; }
  scrollBy(n) {
    const s = this.top;
    if (s.type !== 'doc') return this.move(Math.sign(n));
    const max = Math.max(0, this.shown(s).length - this.body);
    s.scroll = Math.min(max, Math.max(0, s.scroll + n));
    s.follow = s.scroll >= max;
  }
  shown(s) { // 打字打到哪儿了：已经出现的行
    let left = Math.floor(s.typed);
    const out = [];
    for (const l of s.lines) {
      if (left <= 0) break;
      out.push({ ...l, t: l.t.slice(0, left), done: left >= l.t.length });
      left -= l.t.length + 1;
    }
    return out;
  }

  // ---------- 输入 ----------
  key(e) { // 处理了返回 true；在菜单里按 Esc 返回 false（room.js 退出电脑）
    const s = this.top, k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown') { this.move(k === 'ArrowDown' ? 1 : -1); return true; }
    if (k === 'PageUp' || k === 'PageDown') { this.scrollBy((k === 'PageDown' ? 1 : -1) * (this.body - 2)); return true; }
    if (k === 'Enter' || k === 'ArrowRight' || (k === ' ' && s.type !== 'doc')) { this.enter(); return true; }
    if (k === ' ') { if (s.typed < s.total) this.finish(); else this.scrollBy(this.body - 2); return true; }
    if (k === 'Escape' || k === 'Backspace' || k === 'ArrowLeft') return this.back();
    if (k === 'l' || k === 'L') { this.toggleLang(); return this.menus.length > 1; }
    if (/^[1-9]$/.test(k) && s.type !== 'doc') {
      const i = Number(k) - 1;
      if (i < this.items(s).length) { s.sel = i; this.keep(s); this.enter(); }
      return true;
    }
    return false;
  }
  at(uv) { // 屏幕上的一点 → 哪一行、点了会做什么
    if (!uv) return null;
    const x = uv.x * this.W, y = (1 - uv.y) * this.H, row = Math.floor((y - this.pad) / this.lh), s = this.top;
    if (row <= 0) {
      if (x < this.W * 0.6) return null;
      if (this.stack.length > 1) return { do: 'back' };
      return this.menus.length > 1 ? { do: 'lang' } : null;
    }
    if (row >= this.rows - 1) return null;
    if (s.type === 'doc') {
      if (s.typed < s.total) return { do: 'skip' };
      const l = this.shown(s)[s.scroll + row - 1];
      return l?.act ? { do: 'play', row } : null;
    }
    const off = s.type === 'menu' ? 1 : 0, i = s.scroll + row - 1 - off;
    return i >= 0 && i < this.items(s).length ? { do: 'open', i, row } : null;
  }
  hover(uv) {
    const a = this.at(uv);
    this.hoverRow = a?.row ?? (a?.do === 'back' || a?.do === 'lang' ? -2 : -1); // -2 = 右上角
    if (a?.do === 'open') { this.top.sel = a.i; }
  }
  click(uv) {
    const a = this.at(uv);
    if (!a) return;
    if (a.do === 'skip') this.finish();
    else if (a.do === 'back') this.back();
    else if (a.do === 'lang') this.toggleLang();
    else if (a.do === 'play') this.onPlay?.(this.top.act);
    else if (a.do === 'open') { this.top.sel = a.i; this.enter(); }
  }
  hintAt(uv) { // 鼠标停在屏幕上时给 room.js 的提示
    const a = this.at(uv), u = this.ui;
    return { skip: u.hSkip, back: u.hBack, lang: u.hLang, play: u.hPlay, open: u.hOpen }[a?.do] || '';
  }

  // ---------- 每帧 ----------
  update(t, dt) {
    const s = this.top;
    if (this.active && s.type === 'doc' && s.typed < s.total) s.typed = Math.min(s.total, s.typed + dt * 160);
    if (s.reveal != null && s.reveal < 99) s.reveal += dt * (this.active ? 24 : 99); // 菜单一行行亮起来
    this.acc += dt;
    if (this.acc < 1 / 30) return; // 终端 30 帧够了
    this.acc = 0;
    const { ctx, W, H, k, pad, lh } = this, u = this.ui;
    const y = (r) => pad + r * lh;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.font = this.font;
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(60,255,130,0.7)';
    ctx.shadowBlur = 6 * k;
    const text = (str, x, r, { color = GREEN, inv = false, right = false } = {}) => {
      const w = ctx.measureText(str).width, X = right ? W - pad - w : x;
      if (inv) {
        ctx.fillStyle = GREEN;
        ctx.fillRect(pad - 4 * k, y(r) - 2 * k, W - pad * 2 + 8 * k, lh);
        ctx.shadowBlur = 0;
        ctx.fillStyle = BG;
        ctx.fillText(str, X, y(r) + 1 * k);
        ctx.shadowBlur = 6 * k;
      } else {
        ctx.fillStyle = color;
        ctx.fillText(str, X, y(r) + 1 * k);
      }
      return X + w;
    };
    const clip = (str, maxW) => { // 太长就截掉，末尾加省略号
      if (ctx.measureText(str).width <= maxW) return str;
      let lo = 0, hi = str.length;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(str.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; }
      return str.slice(0, lo) + '…';
    };
    const rule = (r) => { ctx.fillStyle = DIM; ctx.fillRect(pad, y(r) - 3 * k, W - pad * 2, 1.5 * k); };

    // 第一行：在哪儿 + 右边的切语言 / 返回；最后一行：按键提示
    const head = s.type === 'menu' ? this.title : `C:\\> ${s.type === 'list' ? `${s.cmd}.EXE` : s.file}`;
    const other = this.menus.length > 1 ? this.menus[(this.li + 1) % this.menus.length].label : '';
    const rightTxt = this.stack.length > 1 ? u.back : other ? `L · ${other}` : '';
    const rw = rightTxt ? ctx.measureText(rightTxt).width + 16 * k : 0;
    text(clip(head, this.maxW - rw), pad, 0);
    if (rightTxt) text(rightTxt, 0, 0, { color: this.hoverRow === -2 ? GREEN : DIM, right: true });
    rule(1);
    rule(this.rows - 1);
    const foot = s.type === 'menu' ? u.menu : s.type === 'list' ? u.list : s.act && s.typed >= s.total ? u.docPlay : u.doc;
    text(clip(foot, this.maxW), pad, this.rows - 1, { color: DIM });

    if (s.type === 'doc') {
      const lines = this.shown(s), max = Math.max(0, lines.length - this.body);
      if (s.follow) s.scroll = max;
      s.scroll = Math.min(s.scroll, max);
      const vis = lines.slice(s.scroll, s.scroll + this.body);
      vis.forEach((l, i) => {
        const r = i + 1;
        if (l.act && l.done) text(l.t, pad, r, { inv: true });
        else text(l.t, pad, r, { color: l.dim ? DIM : GREEN });
      });
      if (Math.floor(t * 2.2) % 2 === 0 && this.active && s.typed < s.total && vis.length) { // 光标
        const last = vis.length - 1;
        ctx.fillStyle = GREEN;
        ctx.fillRect(pad + ctx.measureText(vis[last].t).width + k, y(last + 1) + 2 * k, 9 * k, 16 * k);
      }
      if (max > 0) {
        const h = (this.body * lh) * (this.body / lines.length), top = y(1) + (this.body * lh - h) * (s.scroll / max);
        ctx.fillStyle = 'rgba(93,255,147,0.35)';
        ctx.fillRect(W - 8 * k, top, 3 * k, h);
      }
    } else {
      const rows = this.items(s), off = s.type === 'menu' ? 1 : 0, vis = this.body - off;
      const numW = Math.max(...rows.map((r) => ctx.measureText(r.num).width)), keyW = Math.max(0, ...rows.map((r) => ctx.measureText(r.key).width));
      rows.slice(s.scroll, s.scroll + vis).forEach((row, i) => {
        const j = s.scroll + i, r = i + 1 + off;
        if (j >= s.reveal) return;
        const inv = j === s.sel && (this.active || s.type === 'menu');
        const x1 = pad + 6 * k + numW + 16 * k, x2 = x1 + (keyW ? keyW + 18 * k : 0);
        text(row.num, pad + 6 * k, r, { color: inv ? GREEN : DIM, inv });
        if (inv) { // 反白那一行：整行一起反白，后面的字画在反白条上
          ctx.shadowBlur = 0;
          ctx.fillStyle = BG;
          if (row.key) ctx.fillText(row.key, x1, y(r) + k);
          ctx.fillText(clip(row.label, W - pad - x2), x2, y(r) + k);
          ctx.shadowBlur = 6 * k;
        } else {
          if (row.key) text(row.key, x1, r);
          text(clip(row.label, W - pad - x2), x2, r, { color: row.key ? DIM : GREEN });
        }
      });
      if (rows.length > vis) {
        const h = (vis * lh) * (vis / rows.length), top = y(1 + off) + (vis * lh - h) * (s.scroll / (rows.length - vis));
        ctx.fillStyle = 'rgba(93,255,147,0.35)';
        ctx.fillRect(W - 8 * k, top, 3 * k, h);
      }
    }
    ctx.shadowBlur = 0;
    ctx.drawImage(this.scan, 0, 0, W, H);
    this.texture.needsUpdate = true;
  }
}
