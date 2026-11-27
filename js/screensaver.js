// 电脑的屏保：窗外那片夜景的像素画 + 标题（图是 scripts/make_screensaver.py 生成的，assets/screensaver/）。
// js/pc.js 在没人用电脑时放它：开场就是屏保，点电脑（走到电脑前）它抖动着溶掉、露出终端；离开电脑一会儿又回来。
// 画面本身是一张 320×240 的图，这里只按 saver-fx.png 的遮罩让几样东西动起来：
//   星星一闪一闪；亮着的窗偶尔关灯、开灯；红色障碍灯慢闪；标题上隔一阵扫过一道光；双月桂徽章在提示点一起亮起
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

const BADGE_AT = 3.2; // 屏保启动后，整枚徽章出现的时刻
const SWEEP_EVERY = 9, SWEEP_DUR = 1.6; // 标题扫光：隔多久一次、扫多久

export class Screensaver {
  // files：用哪几张图。电脑界面的景窗也用这个类放不带标题的那张（scene.png / scene-fx.png，没有徽章）
  constructor(base = new URL('../assets/screensaver/', import.meta.url), { image = 'saver.png', fx = 'saver-fx.png', badge = 'saver-badge.png' } = {}) {
    this.w = 320; this.h = 240;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.ready = false;
    const load = (f) => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = new URL(f, base).href; });
    this.loaded = Promise.all([load(image), load(fx), badge ? load(badge).catch(() => null) : null])
      .then(([base_, fx, badge]) => {
        const read = (im) => { this.ctx.clearRect(0, 0, this.w, this.h); this.ctx.drawImage(im, 0, 0); return this.ctx.getImageData(0, 0, this.w, this.h).data; };
        this.base = read(base_);
        this.fx = read(fx);
        this.badge = badge ? read(badge) : null;
        this.out = this.ctx.createImageData(this.w, this.h);
        // 每个会动的像素记一下，每帧只改它们
        this.stars = []; this.wins = []; this.beacons = []; this.title = [];
        for (let i = 0, n = this.w * this.h; i < n; i++) {
          const r = this.fx[i * 4], g = this.fx[i * 4 + 1], b = this.fx[i * 4 + 2];
          if (g) this.stars.push(i, g > 200 ? 1 : 0);
          if (b) this.wins.push(i);
          if (r === 255) this.title.push(i);
          else if (r > 100) this.beacons.push(i);
        }
        let x0 = this.w, x1 = 0;
        for (const i of this.title) { const x = i % this.w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
        this.titleX = [x0, x1];
        this.ready = true;
      })
      .catch((err) => { this.failed = true; console.warn('屏保的图没加载出来，电脑上就一直是菜单', err); });
  }

  // t：屏保开始了多少秒（徽章浮现、扫光都从这儿算）；clock：一直走的时间（星星、窗灯）；mix：屏保盖住多少（0 = 全是终端，1 = 全是屏保），
  // 按 Bayer 顺序一格格出现 / 消失。画到 this.canvas，返回它（没加载好返回 null）
  frame(t, clock, mix = 1) {
    if (!this.ready) return null;
    const { w, h, base, out } = this, o = out.data;
    o.set(base);
    const put = (i, k) => { o[i * 4] = base[i * 4] * k; o[i * 4 + 1] = base[i * 4 + 1] * k; o[i * 4 + 2] = base[i * 4 + 2] * k; };
    // 星星：亮的那些在 70%–100% 之间慢慢呼吸，暗的偶尔整颗隐掉（用左边一格的天色）
    for (let j = 0; j < this.stars.length; j += 2) {
      const i = this.stars[j], s = hash(i);
      const tw = 0.5 + 0.5 * Math.sin(clock * (1.3 + 2.2 * s) + s * 40);
      if (this.stars[j + 1]) put(i, 0.7 + 0.3 * tw);
      else if (tw < 0.18) { const l = (i - 1) * 4; o[i * 4] = base[l]; o[i * 4 + 1] = base[l + 1]; o[i * 4 + 2] = base[l + 2]; }
    }
    // 窗灯：每扇窗按自己的节奏（6–20 秒一格）抽签，约 5% 的时间是关着的
    for (const i of this.wins) {
      const s = hash(i + 0.5), slot = Math.floor(clock / (6 + 14 * s) + s * 7);
      if (hash(i * 3.1 + slot) < 0.05) put(i, 0.28);
    }
    // 障碍灯：两秒一闪，各自错开
    for (const i of this.beacons) if ((clock * 0.5 + hash(i)) % 1 > 0.35) put(i, 0.35);
    // 标题扫光：一道斜着的亮带从左扫到右
    const ph = (t % SWEEP_EVERY) / SWEEP_DUR;
    if (t > 1.5 && ph < 1) {
      const [x0, x1] = this.titleX, c = x0 - 20 + (x1 - x0 + 40) * ph;
      for (const i of this.title) {
        const x = i % w, y = (i / w) | 0, d = Math.abs(x + (y - 80) * 0.45 - c);
        if (d < 5) { const k = d < 2 ? 0.55 : 0.28; o[i * 4] += (255 - o[i * 4]) * k; o[i * 4 + 1] += (250 - o[i * 4 + 1]) * k; o[i * 4 + 2] += (235 - o[i * 4 + 2]) * k; }
      }
    }
    // 月桂、文字和投影在同一帧出现。
    if (this.badge && t >= BADGE_AT) {
      const badge = this.badge;
      for (let i = 0; i < badge.length; i += 4) {
        if (badge[i + 3]) {
          o[i] = badge[i]; o[i + 1] = badge[i + 1]; o[i + 2] = badge[i + 2];
        }
      }
    }
    // 和终端之间：按 Bayer 顺序露出 / 盖上
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[(y * w + x) * 4 + 3] = bayer(x, y) < mix ? 255 : 0;
    this.ctx.putImageData(out, 0, 0);
    return this.canvas;
  }
}
