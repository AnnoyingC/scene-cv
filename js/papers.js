// 书桌上那摞纸 = Papers（#papers）。镜头不动：点纸，整摞从桌上被拿起来举到眼前（room.js 同时把对焦拉到手里的纸上，屋子虚下去）。
// 三份文件（index.html #papers 里的 article.pp-doc，顺序 = 手里从前往后）：
//   - 报纸（data-bind="fold"）：桌上是对折的，拿起来时展开；可以有好几页，往后翻像翻报纸，绕左边立起来翻过去
//   - 会议论文（staple）：左上角一颗订书钉，往后翻 = 这一页绕着钉子掀起来、折到后面
//   - 期刊论文（clip）：别着回形针，往后翻 = 最上面那张抽出来、塞到这一份的最后
// 拿在手里时三份扇形错开（最前面那份在左，后面的往右上错开）；一份翻到最后一页再往后翻，这一份整个抽到最后面，下一份到前面来。
// 底栏的按钮直接换到某一份；纸在屏幕上太小就点一下凑近读（整页可以滚动），再点一下或 Esc 拿远；点纸外面 = 放回桌上。
// 每页纸是 .pp-page（固定 794 × 1123），打开时从内容层复制一份（js/main.js 在个人模式下可能已经换成本地的真实论文）。
import { sfx } from './sfx.js';

const A4W = 794, A4H = 1123;
const EASE = { out: 'cubic-bezier(.45,0,.9,.55)', in: 'cubic-bezier(.12,.75,.25,1)', soft: 'cubic-bezier(.2,.75,.25,1)', flip: 'cubic-bezier(.45,0,.4,1)' };
const PAD = 28; // 凑近读时纸四周留的边
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
// 手里第 k 份（0 = 最前面）相对整摞中心的位置：x、y 是纸宽、纸高的几分之几，r 度，b 亮度
const SLOTS = [{ x: -0.11, y: 0.022, r: -2.2, b: 1 }, { x: 0.06, y: -0.004, r: 1.6, b: 0.9 }, { x: 0.2, y: -0.028, r: 4.6, b: 0.82 }];
const slotAt = (k) => SLOTS[Math.min(k, SLOTS.length - 1)];
// 平时只用 2D 变换（3D 变换会让浏览器把整张纸当贴图缩放，放大读的时候字是糊的）；拿起来、放回去那一下用 tf3：纸从平躺立起来，带透视
const tf = (p) => `translate(-50%, -50%) translate(${p.x || 0}px, ${p.y || 0}px) rotate(${p.r || 0}deg) scale(${p.s})`;
const tf3 = (p) => `translate(-50%, -50%) translate(${p.x || 0}px, ${p.y || 0}px) perspective(1400px) rotate(${p.r || 0}deg) rotateX(${p.ax || 0}deg) scale(${p.s})`;

// 一份里的每张纸怎么翻。姿势 = [平移 x%, 平移 y%, 绕轴转的角度, 纸面里的小歪斜]（函数列表一样才能插值）
//   o 转轴经过的点；up 立起来朝人、侧着只剩一条线（到这儿就换到最后面）；rest(d) 没翻的第 d 张（错开一点，钉住的那头对齐）；back() 翻到后面以后（null = 塞回最底下）
const STAPLE_AT = [44, 44]; // 订书钉压着的那一点（纸的本地像素坐标）：翻页时纸绕着它转，抬起来的角离它不能比纸还远
const BIND = {
  staple: { o: `${STAPLE_AT[0]}px ${STAPLE_AT[1]}px`, rot: 'rotate3d(1, -1, 0, ', up: [0, 0, 89, 0], rest: (d, j) => [0, 0, 0, j * 0.6], back: () => [-0.5, 0.4, 0, -0.9] }, // 钉住的纸各自歪多少是固定的：前面那张翻走，后面的不跟着动
  clip: { o: '0 0', rot: 'rotateY(', up: [-80, 4, 0, -9], rest: (d) => [[0, 1.2, -0.9, 0.6][d % 4], -d * 0.45, 0, [0, 1.5, -1.1, 0.8][d % 4]], back: null },
  fold: { o: '0 50%', rot: 'rotateY(', up: [0, 0, -89, 0], rest: () => [0, 0, 0, 0], back: () => [0.3, 0.25, 0, 0.4] },
};
const leafTf = (B, [tx, ty, a, r]) => `translate(${tx}%, ${ty}%) ${B.rot}${a}deg) rotate(${r}deg)`;
const TABS = { y: 'rgba(250, 210, 70, 0.94)', p: 'rgba(240, 140, 165, 0.92)', b: 'rgba(120, 180, 225, 0.92)', g: 'rgba(150, 205, 120, 0.92)' };
const STAPLE = '<svg class="ppx-bind staple" viewBox="0 0 40 10" aria-hidden="true"><defs><linearGradient id="ppx-st" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f6f6"/><stop offset=".55" stop-color="#b7bbc0"/><stop offset="1" stop-color="#767a80"/></linearGradient></defs><rect x="2.5" y="5.4" width="36" height="2.8" rx="1.2" fill="rgba(0,0,0,.35)"/><rect x="2" y="3.6" width="36" height="2.8" rx="1.2" fill="url(#ppx-st)"/></svg>';
const CLIP_PATH = 'M8,20 L8,56 A4,4 0 0 0 16,56 L16,10 A6,6 0 0 0 4,10 L4,62 A8,8 0 0 0 20,62 L20,26';
const CLIP_ON = 'rotate(3deg)', CLIP_OFF = 'translate(-26px, -128px) rotate(-16deg)'; // 回形针夹着 / 取下来拿在一边
const CLIP = `<svg class="ppx-bind clip" viewBox="0 0 24 72" aria-hidden="true"><defs><linearGradient id="ppx-pw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8b9096"/><stop offset=".5" stop-color="#f2f4f6"/><stop offset="1" stop-color="#8b9096"/></linearGradient></defs><path d="${CLIP_PATH}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.8" stroke-linecap="round" transform="translate(.8 1)"/><path d="${CLIP_PATH}" fill="none" stroke="url(#ppx-pw)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

export function createPapersViewer({ docs: getDocs, top = () => 0, onClose, onTurn }) {
  const el = document.createElement('div');
  el.className = 'ppx';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Papers');
  el.innerHTML = `<div class="ppx-scrim"></div>
    <div class="ppx-stage"><div class="ppx-deck"></div></div>
    <button type="button" class="ppx-arrow prev" aria-label="Previous page">‹</button>
    <button type="button" class="ppx-arrow next" aria-label="Next page">›</button>
    <div class="ppx-bar">
      <div class="ppx-docs" role="group" aria-label="Document"></div>
      <span class="ppx-count" aria-live="polite"></span>
      <button type="button" class="ppx-tool ppx-zoom">Read closer</button>
      <a class="ppx-tool ppx-pdf" target="_blank" rel="noopener" hidden>PDF ↓</a>
      <span class="ppx-tip">← → turn pages · click outside to put them down</span>
    </div>`;
  const q = (s) => el.querySelector(s);
  const stage = q('.ppx-stage'), deck = q('.ppx-deck'), docsEl = q('.ppx-docs'), countEl = q('.ppx-count');
  const zoomBtn = q('.ppx-zoom'), pdfA = q('.ppx-pdf'), prevBtn = q('.ppx-arrow.prev'), nextBtn = q('.ppx-arrow.next');

  let src = [], docs = [], front = 0, S = 1, Z = 1, zoom = false, shown = false, closing = null;
  let chain = Promise.resolve(), pending = 0;

  // ---------- 从内容层复制 ----------
  const pageCopy = (p, look = '') => { // look：'is-through' 背面透过来的字（镜像），'is-ghost' 翻起来那一角的背面（反射已经镜像过了）
    const c = p.cloneNode(true);
    for (const img of c.querySelectorAll('img')) img.loading = 'eager';
    if (look) { c.classList.add(look); c.setAttribute('aria-hidden', 'true'); }
    return c;
  };
  const div = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
  function face(cls, page, mirror) {
    const f = document.createElement('div');
    f.className = 'ppx-face ' + cls;
    if (page) f.append(pageCopy(page, mirror ? 'is-through' : ''));
    return f;
  }
  function build() {
    const list = [...getDocs()];
    const pages = list.map((d) => [...d.querySelectorAll('.pp-page')]);
    const flat = pages.flat();
    if (flat.length === src.length && flat.every((p, i) => p === src[i])) return;
    src = flat;
    let offset = 0;
    docs = list.map((d, i) => {
      const bind = BIND[d.dataset.bind] ? d.dataset.bind : 'clip';
      const B = BIND[bind], ps = pages[i];
      const w = document.createElement('div');
      w.className = 'ppx-doc is-' + bind;
      const leaves = ps.map((p, j) => {
        const L = document.createElement('div');
        L.className = 'ppx-leaf';
        L.style.transformOrigin = B.o;
        if (bind === 'fold' && j === 0) { // 报纸头版：上半张不动，下半张绕中线折到后面（桌上是对折的）
          const top = document.createElement('div'), bot = document.createElement('div');
          top.className = 'ppx-half top';
          bot.className = 'ppx-half bot';
          top.append(face('front', p));
          bot.append(face('front', p), face('back', p, true));
          L.append(top, bot);
          L.half = bot;
        } else {
          const front = face('front', p);
          L.append(front, face('back', p, true));
          if (bind === 'staple') { // 抬起一角：折线这边的纸面压一道暗、翻起来的那一角是纸背（带高光），下面那张沿折线落一道影子
            const crease = div('ppx-shade crease'), under = div('ppx-shade under'), wrap = div('ppx-flapw'), flap = div('ppx-flap'), shine = div('ppx-shade');
            front.append(crease, under);
            flap.append(pageCopy(p, 'is-ghost'), shine);
            wrap.append(flap);
            wrap.hidden = true;
            L.append(wrap);
            L.fold = { front, crease, under, wrap, flap, shine };
          }
        }
        return L;
      });
      // 伸出纸边的便利贴：data-tabs="页:颜色:字|…"
      (d.dataset.tabs || '').split('|').filter(Boolean).forEach((t, k) => {
        const [pg, color, label] = t.split(':');
        const L = leaves[Number(pg) - 1];
        if (!L) return;
        const s = document.createElement('span');
        s.className = 'ppx-tab';
        s.textContent = label || '';
        s.style.top = 15 + k * 10 + '%';
        s.style.background = TABS[color] || TABS.y;
        L.append(s);
      });
      w.append(...leaves);
      if (bind === 'staple') w.insertAdjacentHTML('beforeend', STAPLE);
      if (bind === 'clip') w.insertAdjacentHTML('beforeend', CLIP);
      const label = d.dataset.label || `Document ${i + 1}`;
      const D = { el: w, bind, B, leaves, n: leaves.length, page: 0, offset, label, slug: (d.dataset.slug || label).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        pdf: d.dataset.pdf ? new URL(d.dataset.pdf, document.baseURI).href : '' };
      offset += leaves.length;
      return D;
    });
    deck.replaceChildren(...docs.map((D) => D.el));
    docs.forEach((D) => layoutLeaves(D));
    docsEl.replaceChildren(...docs.map((D, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = D.label;
      b.dataset.doc = k;
      return b;
    }));
    docsEl.hidden = docs.length < 2;
    front = clamp(front, 0, Math.max(0, docs.length - 1));
  }
  const total = () => docs.reduce((a, D) => a + D.n, 0);

  // ---------- 一份里面的纸 ----------
  function backPose(D, j) { return D.B.back ? D.B.back(j) : D.B.rest(D.n - D.page + (D.page - 1 - j)); }
  function layoutLeaves(D, skip = null) {
    D.leaves.forEach((L, j) => {
      const flipped = j < D.page;
      L.classList.toggle('is-current', j === D.page);
      L.setAttribute('aria-hidden', j === D.page ? 'false' : 'true');
      if (L === skip) return;
      L.style.zIndex = String(flipped ? 1 + j : 60 - (j - D.page));
      const p = flipped ? backPose(D, j) : D.B.rest(j - D.page, j);
      L.style.transform = leafTf(D.B, D.loose ? [p[0] * 2.4, p[1] * 1.6 + (j % 2 ? 0.5 : -0.3), p[2], p[3] * 2.6 + (j % 2 ? 0.9 : -0.7)] : p);
    });
  }
  function setPage(D, p) { // 不要动画，直接到第 p 页（这份在后面、看不见的时候用）
    D.page = clamp(p, 0, D.n - 1);
    D.loose = false;
    for (const L of D.leaves) unfold(L);
    const clip = D.el.querySelector('.ppx-bind.clip');
    if (clip) { for (const a of clip.getAnimations()) a.cancel(); clip.style.transform = CLIP_ON; }
    for (const L of D.leaves) L.style.transition = 'none';
    layoutLeaves(D);
    void D.el.offsetWidth;
    for (const L of D.leaves) L.style.transition = '';
  }
  async function move(L, a, b, ms, easing = EASE.flip, delay = 0) {
    const x = L.animate([{ transform: a }, { transform: b }], { duration: ms, easing, delay, fill: 'both' });
    try { await x.finished; } finally { L.style.transform = b; x.cancel(); }
  }
  // 订书钉：先把右下角抬起来（二维折纸：折线 = 原来的角和手拉到的地方连线的中垂线，折线那一边的纸用 clip-path 裁掉，
  // 翻起来的部分是同一块纸沿折线的镜像，画成纸背；思路同 StPageFlip、peel.js，钉子 = peel.js 的 constraint），
  // 角还没停稳，整张就绕着钉子朝人这边慢慢立起来，卷着的角跟着放平；立到侧着只剩一条线的那一刻，直接放到这一份的最后面。
  // 后面不再转回来：绕钉子那条斜线转的时候，纸的右上角、左下角会扫出这摞纸的边，藏在后面转也会从上沿冒出来，
  // 看着像翻过去以后又被抽出来落了一次。往回翻：从侧着的那条线出现，平平地落到最上面，不卷角。
  // 报纸一样，只是绕左边（像翻报纸），也不抬角
  const RECT = [[0, 0], [A4W, 0], [A4W, A4H], [0, A4H]];
  const A0 = [A4W, A4H]; // 抬起来的是右下角
  const A_LIFT = [A0[0] - 230, A0[1] - 185]; // 抬起一角
  const half = (poly, M, n, sign) => { // 多边形和半平面 sign·(X − M)·n ≥ 0 的交（Sutherland–Hodgman）
    const d = (p) => sign * ((p[0] - M[0]) * n[0] + (p[1] - M[1]) * n[1]), out = [];
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length], da = d(a), db = d(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    });
    return out;
  };
  const poly = (p) => (p.length < 3 ? 'polygon(0 0, 0 0, 0 0)' : `polygon(${p.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(', ')})`);
  function foldTo(L, below, P) { // 右下角拉到 P：画出这一刻的折纸
    const F = L.fold;
    let nx = A0[0] - P[0], ny = A0[1] - P[1];
    const len = Math.hypot(nx, ny);
    if (len < 0.5) { unfold(L); return; }
    nx /= len; ny /= len;
    const M = [(A0[0] + P[0]) / 2, (A0[1] + P[1]) / 2], k = 2 * (M[0] * nx + M[1] * ny), ang = (Math.atan2(ny, nx) * 180) / Math.PI;
    const line = (a) => `translate(${M[0]}px, ${M[1]}px) rotate(${a}deg) translate(0, -2000px)`; // 阴影条：左边对齐折线
    L.classList.add('is-folding');
    F.wrap.hidden = false;
    F.front.style.clipPath = poly(half(RECT, M, [nx, ny], -1));
    F.flap.style.clipPath = poly(half(RECT, M, [nx, ny], 1));
    F.flap.style.transform = `matrix(${1 - 2 * nx * nx}, ${-2 * nx * ny}, ${-2 * nx * ny}, ${1 - 2 * ny * ny}, ${k * nx}, ${k * ny})`;
    F.shine.style.transform = line(ang);
    F.crease.style.transform = line(ang + 180);
    F.crease.style.opacity = F.shine.style.opacity = String(Math.min(1, len / 120));
    if (below?.fold) { below.classList.add('is-under'); below.fold.under.style.transform = line(ang); below.fold.under.style.opacity = String(Math.min(1, len / 160)); }
  }
  function unfold(L) {
    const F = L.fold;
    if (!F) return;
    L.classList.remove('is-folding', 'is-under');
    F.wrap.hidden = true;
    F.front.style.clipPath = F.flap.style.clipPath = '';
  }
  let epoch = 0; // 放回桌上 / 重新拿起来时加一：还在跑的折纸动画就停下
  const ease = { out: (t) => 1 - (1 - t) ** 3, inOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2), in: (t) => t ** 3 };
  function tween(ms, fn, e = ease.inOut) {
    const ep = epoch;
    if (reduce) ms = 1;
    return new Promise((done) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (ep !== epoch) return done(false);
        const t = Math.min(1, (now - t0) / ms);
        fn(e(t));
        if (t < 1) requestAnimationFrame(tick); else done(true);
      };
      requestAnimationFrame(tick);
    });
  }
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const lean = (L, a, b, ms, easing, delay = 0) => move(L, a, b, reduce ? 1 : ms, easing, reduce ? 0 : delay);
  async function standTurn(D, dir) { // 订书钉、报纸：立起来翻过去（订书钉先抬起一角）
    const ep = epoch, T = (p) => leafTf(D.B, p), UP = T(D.B.up);
    if (dir > 0) {
      const j = D.page, L = D.leaves[j], below = D.leaves[j + 1], curly = !!L.fold;
      L.style.transition = 'none';
      L.style.zIndex = '100';
      sfx.play('book-flip', { gain: 0.45, rate: curly ? 1.1 : 0.9 });
      // 订书钉：一共 0.9 秒，前四成抬角；第三成起整张开始立起来（和抬角叠着，中间不停顿），角跟着放平
      const total = curly ? 900 : 620, rise = curly ? 0.3 : 0, flat = lerp(A_LIFT, A0, 0.7);
      const turning = lean(L, L.style.transform, UP, total * (1 - rise), 'cubic-bezier(.4,0,.72,.4)', total * rise);
      const curling = curly ? tween(total, (t) => foldTo(L, below, t < 0.4 ? lerp(A0, A_LIFT, ease.out(t / 0.4)) : lerp(A_LIFT, flat, ease.inOut((t - 0.4) / 0.6))), (t) => t)
        : Promise.resolve(true);
      const [ok] = await Promise.all([curling, turning]);
      if (!ok || ep !== epoch) return;
      unfold(L);
      below && unfold(below);
      D.page++;
      layoutLeaves(D, L);
      L.style.zIndex = String(1 + j);
      L.style.transform = T(backPose(D, j)); // 侧着只剩一条线：直接放到最后面
      changed();
      void L.offsetWidth;
      L.style.transition = '';
    } else {
      const j = D.page - 1, L = D.leaves[j];
      L.style.transition = 'none';
      sfx.play('book-flip', { gain: 0.4, rate: 0.95 });
      L.style.zIndex = '100'; // 从后面直接拿到最上面：立着、侧着只剩一条线，再平平地落下来
      D.page--;
      layoutLeaves(D, L);
      changed();
      await lean(L, UP, T(D.B.rest(0, j)), 560, 'cubic-bezier(.25,.55,.35,1)');
      if (ep !== epoch) return;
      L.style.zIndex = '60';
      L.style.transition = '';
    }
    layoutLeaves(D);
  }
  // 回形针：先把回形针取下来（往上抽出、拿在一边，几张纸松开一点），首页抽出来塞到最后一张后面；
  // 塞进去的同时其余几张理齐、回形针跟着夹回去，只落位一次
  async function clipTurn(D, dir) {
    const ep = epoch, clip = D.el.querySelector('.ppx-bind.clip'), up = leafTf(D.B, D.B.up);
    const slide = async (a, b, ms, easing) => {
      const x = clip.animate([{ transform: a }, { transform: b }], { duration: reduce ? 1 : ms, easing, fill: 'forwards' });
      try { await x.finished; } finally { clip.style.transform = b; x.cancel(); }
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
    sfx.play('tick', { gain: 0.5, rate: 1.35 });
    await slide(clip.style.transform || CLIP_ON, CLIP_OFF, 240, EASE.out);
    if (ep !== epoch) return;
    D.loose = true;
    layoutLeaves(D);
    sfx.play('paper', { gain: 0.35, rate: 1.25 });
    const j = dir > 0 ? D.page : D.page - 1, L = D.leaves[j];
    L.style.transition = 'none';
    L.style.zIndex = dir > 0 ? '100' : '0';
    await move(L, L.style.transform, up, reduce ? 1 : 300, EASE.out); // 抽出来
    if (ep !== epoch) return;
    D.page += dir > 0 ? 1 : -1;
    L.style.zIndex = dir > 0 ? '0' : '100';
    D.loose = false; // 塞回去的同时，其余几张理齐
    layoutLeaves(D, L);
    changed();
    const home = move(L, up, leafTf(D.B, dir > 0 ? backPose(D, j) : D.B.rest(0)), reduce ? 1 : 360, EASE.in);
    await wait(170);
    if (ep !== epoch) return;
    const back = slide(CLIP_OFF, CLIP_ON, 300, 'cubic-bezier(.3,1.35,.55,1)'); // 回形针跟着夹回去
    await Promise.all([home, back]);
    if (ep !== epoch) return;
    sfx.play('tick', { gain: 0.55, rate: 1.1 });
    L.style.transition = '';
    L.style.zIndex = dir > 0 ? String(1 + j) : '60';
    layoutLeaves(D);
  }
  const turnLeaf = (D, dir) => (D.bind === 'clip' ? clipTurn(D, dir) : standTurn(D, dir)); // 这一份里往后（dir > 0）/ 往前翻一张

  // ---------- 摆放 ----------
  function layout() {
    const t = top() + 10, barH = 66, W = innerWidth, H = innerHeight - t - barH;
    el.style.setProperty('--top', t + 'px');
    el.style.setProperty('--bottom', barH + 'px');
    const side = W > 700 ? 96 : 12;
    S = Math.max(0.2, Math.min(1.1, (H - 48) / A4H, (W - 2 * side) / (A4W * 1.34))); // 三份扇形错开也放得下
    Z = Math.max(S * 1.3, Math.min(1.35, Math.max(1, (W - 2 * side) / A4W))); // 凑近读：字差不多 15 像素以上
    if (zoom) {
      const w = A4W * Z + 2 * PAD;
      deck.style.width = w > stage.clientWidth ? w + 'px' : '100%';
      deck.style.height = A4H * Z + 2 * PAD + 'px';
    } else deck.style.width = deck.style.height = '';
  }
  const slotOf = (i) => (i - front + docs.length) % docs.length;
  function pose(i) { // 第 i 份现在该在哪
    if (zoom) return { s: Z, b: 1, o: i === front ? 1 : 0 };
    const k = slotOf(i), sl = slotAt(k);
    return { x: sl.x * A4W * S, y: sl.y * A4H * S, r: sl.r, s: S, b: sl.b, o: k < SLOTS.length ? 1 : 0 };
  }
  function apply(D, p) {
    D.pose = p;
    D.el.style.transform = tf(p);
    D.el.style.filter = p.b < 1 ? `brightness(${p.b})` : '';
    D.el.style.opacity = String(p.o ?? 1);
  }
  function render(skip = null) {
    docs.forEach((D, i) => {
      const k = slotOf(i);
      D.el.style.zIndex = String(docs.length - k);
      D.el.classList.toggle('is-front', k === 0);
      D.el.setAttribute('aria-hidden', k ? 'true' : 'false');
      if (D !== skip) apply(D, pose(i));
    });
    ui();
  }
  function instant(fn) { // 不要 CSS 过渡，直接到位
    for (const D of docs) D.el.style.transition = 'none';
    fn();
    void deck.offsetWidth;
    for (const D of docs) D.el.style.transition = '';
  }
  function ui() {
    const D = docs[front];
    countEl.textContent = D ? `${D.offset + D.page + 1} / ${total()}` : '';
    for (const b of docsEl.children) b.setAttribute('aria-pressed', String(Number(b.dataset.doc) === front));
    prevBtn.disabled = nextBtn.disabled = total() < 2;
    zoomBtn.textContent = zoom ? 'Hold back' : 'Read closer';
    pdfA.hidden = !D?.pdf;
    if (D?.pdf) pdfA.href = D.pdf;
  }
  let lastSlug = null;
  const changed = () => {
    ui();
    const slug = front === 0 ? '' : docs[front]?.slug ?? '';
    if (slug !== lastSlug) { lastSlug = slug; onTurn?.(slug); }
  };

  // ---------- 换一份 ----------
  const outPose = () => ({ ...pose(front), x: pose(front).x - A4W * S * 0.8 - 40, y: pose(front).y + 24 * S, r: -9, b: 1 });
  async function cycle(dir, landAt = null) { // 最前面那份抽到最后面（dir > 0），或者最后面那份抽回来盖到最前面
    const N = docs.length;
    if (N < 2) return;
    if (dir > 0) {
      const D = docs[front], from = D.el.style.transform, mid = outPose();
      D.el.style.transition = 'none';
      D.el.style.zIndex = String(N + 1);
      D.el.style.filter = '';
      front = (front + 1) % N;
      if (landAt != null) setPage(docs[front], landAt);
      render(D);
      changed();
      try {
        await D.el.animate([{ transform: from }, { transform: tf(mid) }], { duration: 300, easing: EASE.out }).finished;
        D.el.style.zIndex = '0';
        setPage(D, 0);
        const end = pose(docs.indexOf(D));
        apply(D, end);
        await D.el.animate([{ transform: tf(mid), filter: 'brightness(1)' }, { transform: tf(end), filter: `brightness(${end.b})` }], { duration: 380, easing: EASE.in }).finished;
        D.el.style.zIndex = String(N - slotOf(docs.indexOf(D)));
      } finally { D.el.style.transition = ''; }
    } else {
      const i = (front - 1 + N) % N, D = docs[i], from = D.el.style.transform;
      setPage(D, landAt ?? D.n - 1);
      D.el.style.transition = 'none';
      D.el.style.zIndex = '0';
      const mid = { ...outPose(), y: pose(front).y + 24 * S };
      try {
        await D.el.animate([{ transform: from }, { transform: tf(mid) }], { duration: 300, easing: EASE.out }).finished;
        front = i;
        D.el.style.zIndex = String(N + 1);
        render(D);
        changed();
        const end = pose(i);
        apply(D, end);
        await D.el.animate([{ transform: tf(mid), filter: 'brightness(1)' }, { transform: tf(end), filter: 'brightness(1)' }], { duration: 380, easing: EASE.in }).finished;
        D.el.style.zIndex = String(N);
      } finally { D.el.style.transition = ''; }
    }
  }
  async function flip(dir) {
    if (!shown || !docs.length) return;
    const D = docs[front];
    if (zoom) { // 凑近读的时候：直接换，从翻的方向滑进来
      if (dir > 0) { if (D.page < D.n - 1) setPage(D, D.page + 1); else { front = (front + 1) % docs.length; setPage(docs[front], 0); } }
      else if (D.page > 0) setPage(D, D.page - 1); else { front = (front - 1 + docs.length) % docs.length; setPage(docs[front], docs[front].n - 1); }
      render();
      stage.scrollTo({ top: 0, left: (stage.scrollWidth - stage.clientWidth) / 2 });
      changed();
      const E = docs[front], p = pose(front);
      await E.el.animate([{ opacity: 0, transform: tf({ ...p, x: 60 * dir }) }, { opacity: 1, transform: tf(p) }], { duration: 280, easing: EASE.soft }).finished;
      return;
    }
    if (dir > 0 && D.page < D.n - 1) return turnLeaf(D, 1);
    if (dir < 0 && D.page > 0) return turnLeaf(D, -1);
    return cycle(dir);
  }
  function queue(fn) {
    pending++;
    chain = chain.then(fn).catch(() => {}).then(() => { pending--; });
  }
  function step(dir) {
    if (!shown || closing || total() < 2 || pending > 2) return;
    queue(() => flip(dir));
  }
  function goTo(i) { // 换到第 i 份的第一页
    if (!shown || !docs.length) return;
    i = clamp(i, 0, docs.length - 1);
    queue(async () => {
      while (front !== i && shown) {
        const N = docs.length, fwd = (i - front + N) % N;
        if (zoom) { front = i; setPage(docs[i], 0); render(); changed(); break; }
        await cycle(fwd <= N - fwd ? 1 : -1, 0);
      }
      const D = docs[front];
      while (shown && D.page > 0) await turnLeaf(D, -1);
    });
  }

  // ---------- 凑近读 / 拿远 ----------
  function setZoom(want, e = null) {
    if (!shown || closing || want === zoom || !docs.length) return;
    const D = docs[front], r0 = D.el.getBoundingClientRect();
    const u = e ? clamp((e.clientX - r0.left) / r0.width, 0, 1) : 0.5, v = e ? clamp((e.clientY - r0.top) / r0.height, 0, 1) : 0;
    zoom = want;
    el.classList.toggle('is-zoom', zoom);
    instant(() => {
      layout();
      render();
      if (zoom) { // 点的那一处留在指针底下
        const st = stage.getBoundingClientRect();
        const px = e ? e.clientX - st.left : stage.clientWidth / 2, py = e ? e.clientY - st.top : PAD;
        stage.scrollLeft = deck.offsetWidth / 2 - (A4W * Z) / 2 + u * A4W * Z - px;
        stage.scrollTop = PAD + v * A4H * Z - py;
      }
    });
    const r1 = D.el.getBoundingClientRect(), p = pose(front), k = r0.width / r1.width; // FLIP：从原来的大小、位置过渡过去
    const dx = r0.left + r0.width / 2 - (r1.left + r1.width / 2), dy = r0.top + r0.height / 2 - (r1.top + r1.height / 2);
    D.el.animate([{ transform: tf({ ...p, x: dx, y: dy, s: p.s * k }) }, { transform: tf(p) }], { duration: 420, easing: EASE.soft });
    ui();
  }

  // ---------- 拿起来 / 放回去 ----------
  // rects[i]：桌上第 i 份在屏幕上的样子（room.js 算）：中心 x、y，宽 w、高 h（透视压扁以后的），上沿的方向 rot（度）。
  // 报纸的 rect 是对折以后朝上的那半张
  function deskPose(rect, half) {
    const dr = deck.getBoundingClientRect(), hRef = half ? A4H / 2 : A4H, s = rect.w / A4W;
    const f = clamp(rect.h / rect.w / (hRef / A4W), 0.06, 1);
    let x = rect.x - (dr.left + dr.width / 2), y = rect.y - (dr.top + dr.height / 2);
    if (half) { // rect 的中心是上半张的中心；整张纸的中心在它下面四分之一页（跟着纸的方向转、跟着躺平压扁）
      const d = (A4H / 4) * s * f, a = (rect.rot * Math.PI) / 180;
      x -= Math.sin(a) * d;
      y += Math.cos(a) * d;
    }
    return { x, y, r: rect.rot, ax: (Math.acos(f) * 180) / Math.PI, s, b: 0.8 };
  }
  const FOLDED = 'rotateX(-179.5deg)';
  function stopAll() {
    epoch++;
    for (const D of docs) {
      for (const a of D.el.getAnimations({ subtree: true })) a.cancel();
      for (const L of D.leaves) L.style.transition = '';
    }
    chain = Promise.resolve();
    pending = 0;
  }
  function open(at = 0, rects = []) {
    build();
    if (!docs.length) return false;
    sfx.play('paper');
    stopAll();
    closing = null;
    shown = true;
    el.hidden = false;
    el.classList.remove('is-closing', 'is-zoom');
    zoom = false;
    front = clamp(at, 0, docs.length - 1);
    for (const D of docs) setPage(D, 0);
    lastSlug = null;
    instant(() => { layout(); render(); });
    requestAnimationFrame(() => el.classList.add('is-open'));
    // 整摞一起从桌上拿起来：压在最上面的报纸先离开桌面，展开；底下的跟着
    docs.forEach((D, i) => {
      const k = slotOf(i), p = pose(i);
      if (p.o === 0) return;
      const rect = rects[i], start = rect ? deskPose(rect, D.bind === 'fold') : null;
      const a = start || { ...p, y: (p.y || 0) + 40, s: p.s * 0.96 };
      D.el.animate([
        { transform: tf3(a), filter: `brightness(${start ? 0.8 : 1})`, opacity: start ? 0.35 : 0 },
        { opacity: 1, offset: 0.2 },
        { transform: tf3({ ...p, ax: 0 }), filter: `brightness(${p.b})`, opacity: 1 },
      ], { duration: start ? 780 : 420, delay: k * 50, easing: EASE.soft, fill: 'backwards' });
      if (D.leaves[0]?.half) D.leaves[0].half.animate([{ transform: FOLDED }, { transform: FOLDED, offset: 0.25 }, { transform: 'rotateX(0deg)' }],
        { duration: start ? 900 : 1, delay: k * 50, easing: EASE.soft, fill: 'backwards' });
    });
    changed();
    return true;
  }
  function close(rects = []) {
    if (!shown) return closing || Promise.resolve();
    shown = false;
    sfx.play('paper', { gain: 0.6, rate: 1.1 });
    stopAll();
    el.classList.remove('is-open');
    el.classList.add('is-closing');
    const anims = [];
    docs.forEach((D, i) => {
      if (D.el.style.opacity === '0') return;
      const k = slotOf(i), p = D.pose || pose(i), rect = rects[i];
      const target = rect ? deskPose(rect, D.bind === 'fold') : { ...p, y: (p.y || 0) + 40, s: p.s * 0.96 };
      anims.push(D.el.animate([
        { transform: tf3({ ...p, ax: 0 }), opacity: 1 },
        { opacity: 1, offset: 0.7 },
        { transform: tf3(target), filter: 'brightness(0.8)', opacity: 0 },
      ], { duration: rect ? 580 : 320, delay: (docs.length - 1 - k) * 30, easing: EASE.soft, fill: 'forwards' }));
      if (D.leaves[0]?.half) anims.push(D.leaves[0].half.animate([{ transform: 'rotateX(0deg)' }, { transform: FOLDED, offset: 0.75 }, { transform: FOLDED }],
        { duration: rect ? 580 : 1, easing: EASE.soft, fill: 'forwards' }));
    });
    const done = closing = Promise.all(anims.map((a) => a.finished)).catch(() => {}).then(() => {
      if (shown || closing !== done) return; // 放到一半又拿起来了
      for (const a of anims) a.cancel();
      el.hidden = true;
      el.classList.remove('is-closing', 'is-zoom');
      zoom = false;
      closing = null;
    });
    return done;
  }

  // ---------- 鼠标 / 触摸 ----------
  let drag = null;
  deck.addEventListener('pointerdown', (e) => {
    const w = e.target.closest('.ppx-doc');
    drag = null;
    if (!w || e.button !== 0 || closing) return;
    if (zoom) { drag = { zoom: true, x: e.clientX, y: e.clientY }; return; } // 凑近读时拖动 = 选字、滚动，只认点击
    const D = docs[front];
    if (w !== D?.el || pending) return;
    drag = { D, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, moved: false };
    try { w.setPointerCapture(e.pointerId); } catch { /* 这个指针已经松开了 */ }
  });
  deck.addEventListener('pointermove', (e) => {
    if (!drag || drag.zoom || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 6) { drag.moved = true; drag.D.el.style.transition = 'none'; }
    if (!drag.moved) return;
    drag.dx = dx;
    const p = pose(front);
    drag.D.el.style.transform = tf({ ...p, x: p.x + dx * 0.35, y: p.y + Math.abs(dx) * 0.03, r: p.r + dx * 0.008 });
  });
  const release = (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.zoom) {
      if (e.type === 'pointerup' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && (getSelection()?.isCollapsed ?? true)
        && !e.target.closest('a')) setZoom(false, e);
      return;
    }
    if (!d.moved) { if (e.type === 'pointerup' && !e.target.closest('a')) setZoom(true, e); return; }
    d.D.el.style.transition = '';
    render();
    const v = d.dx / Math.max(1, performance.now() - d.t);
    if (d.dx < -90 || (d.dx < -30 && v < -0.5)) step(1);
    else if (d.dx > 90 || (d.dx > 30 && v > 0.5)) step(-1);
  };
  deck.addEventListener('pointerup', release);
  deck.addEventListener('pointercancel', release);
  stage.addEventListener('click', (e) => { // 点纸外面：凑近读时先拿远，否则放回桌上
    if (e.target.closest('.ppx-doc') || !shown || closing) return;
    if (zoom) setZoom(false);
    else onClose?.();
  });
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  zoomBtn.addEventListener('click', () => setZoom(!zoom));
  docsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) goTo(Number(b.dataset.doc));
  });
  addEventListener('resize', () => { if (shown) instant(() => { layout(); render(); }); });

  // 键盘（room.js 转过来）：处理了返回 true
  function key(e) {
    if (!shown) return false;
    if (e.key === 'ArrowRight') { step(1); return true; }
    if (e.key === 'ArrowLeft') { step(-1); return true; }
    if (e.key === 'Escape' && zoom) { setZoom(false); return true; }
    if (zoom && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes(e.key)) {
      const big = e.key === 'PageDown' || e.key === 'PageUp' || e.key === ' ';
      stage.scrollBy({ top: (e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 1) * (big ? stage.clientHeight * 0.85 : 90), behavior: 'smooth' });
      return true;
    }
    return false;
  }

  return {
    el, open, close, step, goTo, key,
    docs: () => (build(), docs.map(({ label, slug }) => ({ label, slug }))),
    indexForSlug: (slug) => { build(); const i = docs.findIndex((D) => D.slug === (slug || '')); return i < 0 ? 0 : i; },
    docIndex: () => front,
    get shown() { return shown; },
    get zoomed() { return zoom; },
  };
}
