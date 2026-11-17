// 书桌上的两张打印纸 = 简历（#resume）。镜头不动：点纸，这几页纸就从桌上被拿起来，立起来举到眼前（room.js 同时把对焦拉到
// 手里的纸上，屋子虚下去）。这里负责"拿在手里"的这一段：
//   - 起点是那张纸此刻在屏幕上的位置、角度、透视（平躺在桌上 → 立起来对着人），整摞纸一起被拿起来，后面几张错开、歪一点
//   - 左右翻：→ / 右边的箭头 / 往左甩 = 最上面那张往左抽出去、塞回最底下；← / 左箭头 / 往右甩 = 最底下那张从左边抽回来盖到最上面
//   - 中文、英文在同一摞里：底下的按钮直接翻到那种语言的第一页；有 PDF 的显示下载
//   - 纸在屏幕上太小就点一下凑近读（整页可以滚动），再点一下或 Esc 拿远；点纸外面 = 放回桌上
// 纸的内容是 index.html #resume 里的 .cv-page（js/main.js 可能已经换成本地的真实简历），打开时复制一份，
// 排成固定的 794 × 1123（A4 @ 96 dpi）；一栏的字放不下就把 --fit 往小调一点（最多缩到 0.8）。
const A4W = 794, A4H = 1123;
const ROT = [-1.7, 2.3, -2.8, 1.5, -1.1]; // 第 i 张纸压在底下时歪的角度（度）
const EASE = { out: 'cubic-bezier(.45,0,.9,.55)', in: 'cubic-bezier(.12,.75,.25,1)', soft: 'cubic-bezier(.2,.75,.25,1)' };
const PAD = 28; // 凑近读时纸四周留的边
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// 平时只用 2D 变换（3D 变换会让浏览器把整张纸当贴图缩放，放大读的时候字是糊的）；
// 拿起来、放回去那一下用 tf3：纸绕自己的横轴从平躺立起来（rotateX），带透视
const tf = (p) => `translate(-50%, -50%) translate(${p.x || 0}px, ${p.y || 0}px) rotate(${p.r || 0}deg) scale(${p.sx ?? p.s}, ${p.sy ?? p.s})`;
const tf3 = (p) => `translate(-50%, -50%) translate(${p.x || 0}px, ${p.y || 0}px) perspective(1400px) rotate(${p.r || 0}deg) `
  + `rotateX(${p.ax || 0}deg) scale(${p.sx ?? p.s}, ${p.sy ?? p.s})`;

export function createResumeViewer({ pages, top = () => 0, onClose, onTurn }) {
  const el = document.createElement('div');
  el.className = 'cvx';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Résumé');
  el.innerHTML = `<div class="cvx-scrim"></div>
    <div class="cvx-stage"><div class="cvx-deck"></div></div>
    <button type="button" class="cvx-arrow prev" aria-label="Previous page">‹</button>
    <button type="button" class="cvx-arrow next" aria-label="Next page">›</button>
    <div class="cvx-bar">
      <div class="cvx-langs" role="group" aria-label="Language"></div>
      <span class="cvx-count" aria-live="polite"></span>
      <button type="button" class="cvx-tool cvx-zoom">Read closer</button>
      <a class="cvx-tool cvx-pdf" target="_blank" rel="noopener" hidden>PDF ↓</a>
      <span class="cvx-tip">← → turn pages · click outside to put them down</span>
    </div>`;
  const q = (s) => el.querySelector(s);
  const stage = q('.cvx-stage'), deck = q('.cvx-deck'), langsEl = q('.cvx-langs'), countEl = q('.cvx-count');
  const zoomBtn = q('.cvx-zoom'), pdfA = q('.cvx-pdf'), prevBtn = q('.cvx-arrow.prev'), nextBtn = q('.cvx-arrow.next');

  let src = [], sheets = [], langs = [], fitted = false;
  let cur = 0, S = 1, Z = 1, zoom = false, shown = false, closing = null;
  let chain = Promise.resolve(), pending = 0;

  // ---------- 纸：从内容层复制 ----------
  function build() {
    const list = [...pages()];
    if (list.length === src.length && list.every((p, i) => p === src[i])) return;
    src = list;
    sheets = list.map((p) => {
      const s = document.createElement('div');
      s.className = 'cvx-sheet';
      const page = p.cloneNode(true);
      for (const img of page.querySelectorAll('img')) img.loading = 'eager';
      s.append(page);
      return s;
    });
    deck.replaceChildren(...sheets);
    langs = [];
    list.forEach((p, i) => {
      const code = (p.getAttribute('lang') || '').toLowerCase();
      let L = langs.find((l) => l.code === code);
      if (!L) {
        L = { code, slug: langs.length ? code.split('-')[0] || String(langs.length + 1) : '', label: p.dataset.label || p.getAttribute('lang') || '简历', first: i, pdf: '' };
        langs.push(L);
      }
      if (!L.pdf && p.dataset.pdf) L.pdf = new URL(p.dataset.pdf, document.baseURI).href;
    });
    langsEl.replaceChildren(...langs.map((L, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = L.label;
      b.dataset.lang = k;
      return b;
    }));
    langsEl.hidden = langs.length < 2;
    cur = clamp(cur, 0, Math.max(0, sheets.length - 1));
    fitted = false;
  }
  const langAt = (i) => Math.max(0, langs.findIndex((L) => L.code === (src[i]?.getAttribute('lang') || '').toLowerCase()));

  // 一栏的字超出纸的下沿：整页的字号一点点缩小（只在纸显示出来以后量得到）
  function fit() {
    for (const s of sheets) {
      const page = s.firstElementChild;
      const over = () => { // 哪一栏的底超过了纸的下边距（offset 量的是排版尺寸，不受缩放影响）
        const limit = page.clientHeight - parseFloat(getComputedStyle(page).paddingBottom);
        return [...page.children].some((c) => c.offsetTop + c.scrollHeight > limit + 1);
      };
      let f = 1;
      page.style.setProperty('--fit', '1');
      while (f > 0.8 && over()) { f -= 0.02; page.style.setProperty('--fit', f.toFixed(2)); }
    }
    fitted = true;
  }

  // ---------- 摆放 ----------
  function layout() {
    const t = top() + 10, barH = 66, W = innerWidth, H = innerHeight - t - barH;
    el.style.setProperty('--top', t + 'px');
    el.style.setProperty('--bottom', barH + 'px');
    const side = W > 700 ? 96 : 12;
    S = Math.max(0.2, Math.min(1.2, (H - 36) / A4H, (W - 2 * side) / A4W)); // 整张纸放得下，还给后面错开的纸留一点边
    Z = Math.max(S * 1.3, Math.min(1.35, Math.max(1, (W - 2 * side) / A4W))); // 凑近读：字差不多 15 像素以上
    if (zoom) {
      const w = A4W * Z + 2 * PAD; // 放得下就跟着舞台宽（竖滚动条出来以后舞台会窄一点，别多出横滚动条）
      deck.style.width = w > stage.clientWidth ? w + 'px' : '100%';
      deck.style.height = A4H * Z + 2 * PAD + 'px';
    } else deck.style.width = deck.style.height = '';
  }
  function pose(i, d) { // 第 i 张纸在这摞里的第 d 层（0 = 最上面）
    if (zoom) return { s: Z, b: 1, o: d ? 0 : 1 };
    const k = Math.min(d, 3), sx = [0, 1, -0.7, 0.5][k], sy = [0, -1, -1.6, -2.2][k];
    return { x: sx * 18 * S, y: sy * 12 * S, r: d ? ROT[i % ROT.length] : 0, s: S, b: 1 - 0.07 * k, o: d > 3 ? 0 : 1 };
  }
  function apply(s, p) {
    s.pose = p;
    s.style.transform = tf(p);
    s.style.filter = p.b < 1 ? `brightness(${p.b})` : '';
    s.style.opacity = String(p.o ?? 1);
  }
  const depth = (i) => (i - cur + sheets.length) % sheets.length;
  function render(skip = null) {
    const n = sheets.length;
    sheets.forEach((s, i) => {
      const d = depth(i);
      s.style.zIndex = String(n - d);
      s.classList.toggle('is-front', d === 0);
      s.setAttribute('aria-hidden', d ? 'true' : 'false');
      if (s !== skip) apply(s, pose(i, d));
    });
    ui();
  }
  function instant(fn) { // 不要 CSS 过渡，直接到位
    for (const s of sheets) s.style.transition = 'none';
    fn();
    void deck.offsetWidth;
    for (const s of sheets) s.style.transition = '';
  }
  function ui() {
    const n = sheets.length, li = langAt(cur), L = langs[li];
    countEl.textContent = n ? `${cur + 1} / ${n}` : '';
    for (const b of langsEl.children) b.setAttribute('aria-pressed', String(Number(b.dataset.lang) === li));
    prevBtn.disabled = nextBtn.disabled = n < 2;
    zoomBtn.textContent = zoom ? 'Hold back' : 'Read closer';
    pdfA.hidden = !L?.pdf;
    if (L?.pdf) pdfA.href = L.pdf;
  }
  const changed = () => onTurn?.(langs[langAt(cur)]?.slug ?? '');

  // ---------- 翻页 ----------
  const outPose = () => ({ x: -(A4W * S * 0.8) - 40, y: 24 * S, r: -9, s: S, b: 1 });
  async function flip(dir) {
    const n = sheets.length;
    if (n < 2 || !shown) return;
    if (zoom) { // 凑近读的时候：直接换一张，从翻的方向滑进来
      cur = (cur + dir + n) % n;
      render();
      stage.scrollTo({ top: 0, left: (stage.scrollWidth - stage.clientWidth) / 2 });
      changed();
      const s = sheets[cur], p = pose(cur, 0);
      await s.animate([{ opacity: 0, transform: tf({ ...p, x: 60 * dir }) }, { opacity: 1, transform: tf(p) }], { duration: 280, easing: EASE.soft }).finished;
      return;
    }
    const i = dir > 0 ? cur : (cur - 1 + n) % n, s = sheets[i], from = s.style.transform, mid = outPose();
    s.style.transition = 'none';
    cur = dir > 0 ? (cur + 1) % n : i;
    render(s); // 其余的纸各挪一层（CSS 过渡）
    changed();
    s.style.zIndex = dir > 0 ? String(n + 1) : '0'; // 往外抽的时候：往后翻的那张在最上面，往前翻的那张从最底下抽出来
    s.style.filter = '';
    s.pose = mid;
    s.style.transform = tf(mid);
    try {
      await s.animate([{ transform: from }, { transform: tf(mid) }], { duration: 300, easing: EASE.out }).finished;
      s.style.zIndex = dir > 0 ? '0' : String(n + 1);
      const end = pose(i, depth(i));
      apply(s, end);
      await s.animate([{ transform: tf(mid), filter: 'brightness(1)' }, { transform: tf(end), filter: `brightness(${end.b})` }], { duration: 380, easing: EASE.in }).finished;
      s.style.zIndex = String(n - depth(i));
    } finally {
      s.style.transition = '';
    }
  }
  function queue(fn) {
    pending++;
    chain = chain.then(fn).catch(() => {}).then(() => { pending--; });
  }
  function step(dir) {
    if (!shown || closing || sheets.length < 2 || pending > 2) return;
    queue(() => flip(dir));
  }
  function goTo(i) {
    if (!shown || !sheets.length) return;
    i = clamp(i, 0, sheets.length - 1);
    queue(async () => {
      while (cur !== i && shown) {
        const n = sheets.length, fwd = (i - cur + n) % n;
        await flip(fwd <= n - fwd ? 1 : -1);
      }
    });
  }

  // ---------- 凑近读 / 拿远 ----------
  function setZoom(want, e = null) {
    if (!shown || closing || want === zoom || !sheets.length) return;
    const s = sheets[cur], r0 = s.getBoundingClientRect();
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
    // FLIP：从原来的大小、位置过渡过去
    const r1 = s.getBoundingClientRect(), p = pose(cur, 0), k = r0.width / r1.width;
    const dx = r0.left + r0.width / 2 - (r1.left + r1.width / 2), dy = r0.top + r0.height / 2 - (r1.top + r1.height / 2);
    s.animate([{ transform: tf({ ...p, x: dx, y: dy, s: p.s * k }) }, { transform: tf(p) }], { duration: 420, easing: EASE.soft });
    ui();
  }

  // ---------- 拿起来 / 放回去 ----------
  // from / to：桌上那张纸在屏幕上的样子（room.js 算）：中心 x、y，宽 w、高 h（透视压扁以后的），上沿的方向 rot（度）
  function deskPose(rect) {
    const dr = deck.getBoundingClientRect();
    const f = clamp(rect.h / rect.w / (A4H / A4W), 0.06, 1);
    return { x: rect.x - (dr.left + dr.width / 2), y: rect.y - (dr.top + dr.height / 2), r: rect.rot, ax: (Math.acos(f) * 180) / Math.PI, s: rect.w / A4W, b: 0.8 };
  }
  function stopAll() {
    for (const s of sheets) for (const a of s.getAnimations()) a.cancel();
    chain = Promise.resolve();
    pending = 0;
  }
  function open(i = 0, from = null) {
    build();
    if (!sheets.length) return false;
    stopAll();
    closing = null;
    shown = true;
    el.hidden = false;
    el.classList.remove('is-closing', 'is-zoom');
    zoom = false;
    if (!fitted) fit();
    cur = clamp(i, 0, sheets.length - 1);
    instant(() => { layout(); render(); });
    requestAnimationFrame(() => el.classList.add('is-open'));
    // 整摞纸一起从桌上被拿起来：最上面那张先离开桌面，底下的跟着
    const start = from ? deskPose(from) : null;
    sheets.forEach((s, k) => {
      const d = depth(k), p = pose(k, d);
      if (p.o === 0) return;
      const a = start ? { ...start, r: start.r + d * 0.6 } : { ...p, y: (p.y || 0) + 40, s: p.s * 0.96 };
      s.animate([
        { transform: tf3(a), filter: `brightness(${start ? 0.8 : 1})`, opacity: start ? 0.35 : 0 },
        { opacity: 1, offset: 0.2 },
        { transform: tf3(p), filter: `brightness(${p.b})`, opacity: 1 },
      ], { duration: start ? 760 : 420, delay: d * 45, easing: EASE.soft, fill: 'backwards' });
    });
    changed();
    return true;
  }
  function close(to = null) {
    if (!shown) return closing || Promise.resolve();
    shown = false;
    stopAll();
    el.classList.remove('is-open');
    el.classList.add('is-closing');
    const end = to ? deskPose(to) : null, anims = [];
    sheets.forEach((s, k) => {
      const d = depth(k);
      if (s.style.opacity === '0') return;
      const p = s.pose || pose(k, d), target = end ? { ...end, r: end.r + d * 0.6 } : { ...p, y: (p.y || 0) + 40, s: p.s * 0.96 };
      anims.push(s.animate([
        { transform: tf3(p), opacity: 1 },
        { opacity: 1, offset: 0.7 },
        { transform: tf3(target), filter: 'brightness(0.8)', opacity: 0 },
      ], { duration: end ? 560 : 320, delay: (sheets.length - 1 - d) * 30, easing: EASE.soft, fill: 'forwards' }));
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
    const s = e.target.closest('.cvx-sheet');
    drag = null;
    if (!s || e.button !== 0 || closing) return;
    if (zoom) { drag = { zoom: true, x: e.clientX, y: e.clientY }; return; } // 凑近读时拖动 = 选字、滚动，只认点击
    if (s !== sheets[cur] || pending) return;
    drag = { s, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, moved: false };
    try { s.setPointerCapture(e.pointerId); } catch { /* 这个指针已经松开了 */ }
  });
  deck.addEventListener('pointermove', (e) => {
    if (!drag || drag.zoom || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 6) { drag.moved = true; drag.s.style.transition = 'none'; }
    if (!drag.moved) return;
    drag.dx = dx;
    const p = pose(cur, 0);
    drag.s.style.transform = tf({ ...p, x: dx, y: Math.abs(dx) * 0.05, r: dx * 0.014 });
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
    const v = d.dx / Math.max(1, performance.now() - d.t);
    if (d.dx < -90 || (d.dx < -30 && v < -0.5)) return step(1); // 从拖到的地方接着往左抽出去
    d.s.style.transition = '';
    if (d.dx > 90 || (d.dx > 30 && v > 0.5)) step(-1);
    else render();
  };
  deck.addEventListener('pointerup', release);
  deck.addEventListener('pointercancel', release);
  stage.addEventListener('click', (e) => { // 点纸外面：凑近读时先拿远，否则放回桌上
    if (e.target.closest('.cvx-sheet') || !shown || closing) return;
    if (zoom) setZoom(false);
    else onClose?.();
  });
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  zoomBtn.addEventListener('click', () => setZoom(!zoom));
  langsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) goTo(langs[Number(b.dataset.lang)]?.first ?? 0);
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
    langs: () => (build(), langs),
    indexForSlug: (slug) => (build(), langs.find((L) => L.slug === (slug || ''))?.first ?? 0),
    langIndex: () => langAt(cur),
    langAt: (i) => (build(), langAt(i)),
    get shown() { return shown; },
    get zoomed() { return zoom; },
  };
}
