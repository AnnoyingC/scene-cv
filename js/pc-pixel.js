// 电脑界面（js/pc.js）的像素零件：
//   - 调色板：和屏保同一组东京夜色（scripts/make_screensaver.py）
//   - 5×7 点阵字：标题、标签、时钟（和屏保小标题同一套字形）；只有大写字母、数字和几个符号，别的字交给位图字
//   - 位图字：系统字体画在 1 倍的格子上，alpha 一刀切去掉灰边，像老机器的 16 点阵；画好的字按 字 + 颜色 + 字号 存起来
//   - Bayer 抖动遮罩：景窗换画面时一格格溶过去
export const PAL = {
  ink: '#06070e', sky0: '#0b0c1a', sky1: '#11132a', sky2: '#181c38', sky3: '#212744', haze: '#3a3550',
  cream: '#e6d3b0', paper: '#fff0c8', amber: '#e0b45c', gold: '#ffd79a', tower: '#ee5a24', tower2: '#ff8a3d', rust: '#a8331a',
  lav: '#8a8aa6', warmD: '#6e5634',
};

const G = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.', C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.', E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#', I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#', O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....', Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..', U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.', 2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '####.|....#|....#|.###.|....#|....#|####.', 4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...', 8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ' ': '.....|.....|.....|.....|.....|.....|.....', '·': '.....|.....|.....|..#..|.....|.....|.....', '-': '.....|.....|.....|.###.|.....|.....|.....',
  ':': '.....|..#..|..#..|.....|..#..|..#..|.....', '.': '.....|.....|.....|.....|.....|.##..|.##..', '/': '....#|....#|...#.|..#..|.#...|#....|#....',
  '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.', '_': '.....|.....|.....|.....|.....|.....|#####', "'": '..#..|..#..|.#...|.....|.....|.....|.....',
  '▶': '#....|##...|###..|####.|###..|##...|#....', '◀': '....#|...##|..###|.####|..###|...##|....#', '▼': '.....|#####|.###.|..#..|.....|.....|.....',
  '↑': '..#..|.###.|#.#.#|..#..|..#..|..#..|..#..', '↓': '..#..|..#..|..#..|..#..|#.#.#|.###.|..#..',
};
const GLYPH = Object.fromEntries(Object.entries(G).map(([k, v]) => [k, v.split('|')]));

export const pxOK = (str) => [...String(str).toUpperCase()].every((c) => GLYPH[c]);
export const pxW = (str, s = 1, gap = 1) => [...String(str)].length * (5 + gap) * s - gap * s;
// 5×7 点阵字，s 倍；返回宽度
export function px(ctx, str, x, y, color, s = 1, gap = 1) {
  ctx.fillStyle = color;
  let X = Math.round(x);
  for (const ch of String(str).toUpperCase()) {
    const g = GLYPH[ch] || GLYPH[' '];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '#') ctx.fillRect(X + c * s, y + r * s, s, s);
    X += (5 + gap) * s;
  }
  return pxW(str, s, gap);
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// 17 档抖动遮罩（第 n 档：Bayer 排在前 n 的格子是实的），每格 cell × cell 像素；在 ctx 上建 pattern
export function bayerPatterns(ctx, cell = 2) {
  return Array.from({ length: 17 }, (_, n) => {
    const c = Object.assign(document.createElement('canvas'), { width: 4 * cell, height: 4 * cell }), x = c.getContext('2d');
    x.fillStyle = '#000';
    for (let i = 0; i < 16; i++) if (BAYER[i] < n) x.fillRect((i % 4) * cell, ((i / 4) | 0) * cell, cell, cell);
    return ctx.createPattern(c, 'repeat');
  });
}
// 均匀的小点阵底纹（每 step 格一个点，隔行错开）
export function dotPattern(ctx, color, step = 2) {
  const c = Object.assign(document.createElement('canvas'), { width: step, height: 2 }), x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, 1, 1);
  x.fillRect(step / 2, 1, 1, 1);
  return ctx.createPattern(c, 'repeat');
}

const SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif';
const WIDE = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const TOKENS = /[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g;
const NO_START = /^[，。、；：？！）》」』”’,.;:?!)\]]/; // 不能放在行首的标点：跟着上一个字走

export class BitmapText {
  constructor(family = SANS) {
    this.family = family;
    this.cache = new Map();
    this.s = Object.assign(document.createElement('canvas'), { width: 64, height: 32 });
    this.sx = this.s.getContext('2d', { willReadFrequently: true });
  }
  font(size, weight) { return `${weight} ${size}px ${this.family}`; }
  width(str, size = 16, weight = 400) { this.sx.font = this.font(size, weight); return this.sx.measureText(str).width; }
  get(str, color, size, weight) {
    const key = `${size}|${weight}|${color}|${str}`;
    let c = this.cache.get(key);
    if (c) return c;
    if (this.cache.size > 800) this.cache.clear();
    const w = Math.ceil(this.width(str, size, weight)) + 4, h = Math.ceil(size * 1.45) + 4;
    if (this.s.width < w || this.s.height < h) Object.assign(this.s, { width: Math.max(this.s.width, w), height: Math.max(this.s.height, h) });
    const sx = this.sx;
    sx.clearRect(0, 0, w, h);
    sx.font = this.font(size, weight);
    sx.textBaseline = 'top';
    sx.fillStyle = '#fff';
    sx.fillText(str, 2, 2);
    const im = sx.getImageData(0, 0, w, h), d = im.data;
    const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = d[i + 3] > 100 ? 255 : 0; }
    c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').putImageData(im, 0, 0);
    this.cache.set(key, c);
    return c;
  }
  // 画一行；upto：只画前几个字（打字机效果）。返回整行的宽度
  draw(ctx, str, x, y, color, size = 16, { weight = 400, upto = Infinity } = {}) {
    if (!str) return 0;
    const c = this.get(str, color, size, weight);
    let w = c.width;
    if (upto < str.length) {
      if (upto <= 0) return c.width - 4;
      w = Math.min(c.width, Math.ceil(this.width(str.slice(0, upto), size, weight)) + 2);
    }
    ctx.drawImage(c, 0, 0, w, c.height, Math.round(x) - 2, Math.round(y) - 2, w, c.height);
    return c.width - 4;
  }
  // 按宽度折行：中文一个字一个字断，英文按词断，太长的词硬断；句读不放行首
  wrap(str, maxW, size = 16, weight = 400) {
    this.sx.font = this.font(size, weight);
    const fits = (s) => this.sx.measureText(s).width <= maxW;
    const out = [];
    let line = '';
    for (let t of String(str).match(TOKENS) || []) {
      if (!WIDE.test(t) && !/^\s+$/.test(t) && !fits(t)) { // 一个词比一行还长：拆成单个字符
        for (const ch of t) { if (!fits(line + ch) && line) { out.push(line.trimEnd()); line = ''; } line += ch; }
        continue;
      }
      if (fits(line + t) || !line.trim() || (NO_START.test(t) && t.length === 1)) { line += t; continue; } // 句读可以挂在行尾
      out.push(line.trimEnd());
      line = t.trimStart();
    }
    if (line.trim()) out.push(line.trimEnd());
    return out;
  }
  // 太长就截掉，末尾加省略号；force：本来放得下也加（后面还有没显示的）
  clip(str, maxW, size = 16, weight = 400, force = false) {
    this.sx.font = this.font(size, weight);
    if (!force && this.sx.measureText(str).width <= maxW) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.sx.measureText(str.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; }
    return str.slice(0, lo).trimEnd() + '…';
  }
}
