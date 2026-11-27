// 书架上的真书（js/room.js 用）。
// 烘焙脚本按 index.html 的书单给每本书建好了模型：材质 realbook{i}（书皮）+ realbook{i}_pages（书芯），书皮的 UV 横着排
// [封底 | 书脊 | 封面]；书立着、书脊朝屋里（+z）、封面朝 +x。这里负责：
//   - 书皮贴图：canvas 画书脊、封面、封底。index.html 里写了 data-cover 而且 assets/books/covers/ 里有这张图，封面就用真实的；
//     没有就按 data-style 自动画一张（literary 素净文学 / modern 粗体现代 / sea 插画海岛）
//   - 悬停：书往外抽出 2 厘米、提亮
//   - 点了：抽出来 → 飞到镜头前、转到封面朝你 → 换成实时打光的"真书"（烘焙的光照只对书架上那个位置成立）→ 封面翻开：
//     左页（封面的里侧）= 读书状态 + 这本书的代表句，右页起是划线（第一页撑满，划线少的书下面印一张阅读卡），一页放不下就翻页
//   - 合上：倒着放一遍，飞回书架
import * as THREE from 'three';
import { sfx } from './sfx.js';

const COVERS = new URL('../assets/books/covers/', import.meta.url).href;
// 书单可以是英文也可以是中文：英文字用 EB Garamond（css/style.css 的 @font-face），中文字落到后面的宋体 / 楷体上。
// pen = 钢笔写的字（读书状态、阅读卡），英文用斜体
const FONT = {
  serif: '"EB Garamond", "Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", SimSun, serif',
  pen: '"EB Garamond", "Kaiti SC", "STKaiti", KaiTi, "Songti SC", serif',
  sans: '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif',
};
const FONTS_USED = ['500 20px "EB Garamond"', 'italic 400 20px "EB Garamond"'];
// 有没有中文（日文）字：有就按中文排（竖排书脊、按字断行、书名号），没有就按英文排
const CJK = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const latin = (s) => !CJK.test(s || '');
const shortTitle = (title) => title.split(/[:：]/, 1)[0].trim() || title;
// 书名怎么写：中文加书名号，英文原样（room.js 的悬停提示也用）
export const bookName = (t) => (latin(t) ? t : `《${t}》`);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp01 = (k) => Math.min(1, Math.max(0, k));
const smooth01 = (a, b, x) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const lerp = (a, b, k) => a + (b - a) * k;

// ---------- 书的声音跟着书的分量走 ----------
// 分量：按体积估纸重（约 0.7 g/cm³，精装封板再加 15%），0 = 一百来克的薄平装，1 = 一公斤以上的厚书
const heftOf = ([w, h, t], hard) => clamp01(Math.log((w * h * t * 700 * (hard ? 1.15 : 1)) / 0.13) / Math.log(10));
// 同一个录音，书越轻：音高越高、越短，"咚"的低频越少（高通），也越小声（最轻的比最厚的小 9 dB）
function bookSfx(e, name, { gain = 1, delay = 0 } = {}) {
  const k = e.heft ?? 0.5, hp = lerp(420, 0, Math.min(1, k * 1.4));
  sfx.play(name, { gain: gain * Math.pow(10, lerp(-9, 0, k) / 20), rate: lerp(1.38, 0.94, k), hp: hp > 60 ? hp : 0, delay });
}
// 薄书合上 / 翻开时，纸页扇一下的声音（厚书几乎没有）
function pagesFan(e, delay = 0) {
  const k = e.heft ?? 0.5;
  if (k < 0.65) sfx.play('book-flip', { gain: 0.35 * (1 - k / 0.65) + 0.1, rate: lerp(1.3, 1.05, k), dur: 0.22, delay });
}

// ---------- canvas 小工具 ----------
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  return c;
}
// 纸的颗粒：一层很淡的随机斑点
function grain(ctx, x, y, w, h, amount = 0.05, seed = 7) {
  const r = rnd(seed);
  const n = Math.round((w * h) / 90);
  for (let i = 0; i < n; i++) {
    const v = r() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${v},${v},${v},${amount * r()})`;
    ctx.fillRect(x + r() * w, y + r() * h, 1 + r() * 1.5, 1 + r() * 1.5);
  }
}
// 竖排：一个字一行，(x, y) = 第一个字的上沿中点；字太多放不下时自动缩小。返回写到了哪里
function vtext(ctx, s, x, y, size, maxH, font, gap = 1.12) {
  const chars = [...s].filter((ch) => ch.trim());
  const sz = Math.min(size, maxH / Math.max(1, chars.length * gap));
  ctx.font = font.replace('{}', sz.toFixed(1) + 'px');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let yy = y;
  for (const ch of chars) {
    if ('·・/'.includes(ch)) { ctx.fillText(ch === '/' ? '|' : '·', x, yy + sz * 0.45); yy += sz * 0.8; continue; }
    ctx.fillText(ch, x, yy + sz / 2);
    yy += sz * gap;
  }
  return yy;
}
// 书脊上的字：中文竖排（一个字一行）；英文横着写、整行转 90°，从上往下读（英文书的书脊都这么印）。字太长放不下时缩小
function spineText(ctx, s, x, y, size, maxH, font) {
  if (!latin(s)) return vtext(ctx, s, x, y, size, maxH, font);
  ctx.font = font.replace('{}', size.toFixed(1) + 'px');
  const w = ctx.measureText(s).width, sz = w > maxH ? size * (maxH / w) : size;
  ctx.font = font.replace('{}', sz.toFixed(1) + 'px');
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(s, 0, 0);
  ctx.restore();
  return y + Math.min(w, maxH);
}
// 横排自动换行：中文按字断行，英文按词断行。返回最后一行的底（align = 'center' 时 x 是中线）
const NO_START = '，。、；：！？）」』》〉”’…—,.;:!?)';
const tokens = (s) => s.match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]|[^\s\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]+\s*|\s+/g) || [];
function lines(ctx, s, maxW) {
  let line = '';
  const out = [];
  for (const tk of tokens(s)) {
    // 标点不放在行首：超出一点也挂在上一行末尾
    if (ctx.measureText((line + tk).trimEnd()).width > maxW && line.trim() && !NO_START.includes(tk.trim())) { out.push(line.trimEnd()); line = tk.trimStart(); continue; }
    line += tk;
  }
  if (line.trim()) out.push(line.trimEnd());
  return out;
}
function wrap(ctx, s, x, y, maxW, lh, maxLines = 99) {
  const out = lines(ctx, s, maxW).slice(0, maxLines);
  out.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
  return y + out.length * lh;
}
// 封面上的书名：一行放不下就换行，最多 maxLines 行；还放不下就整体缩小。返回用的字号和排好的行
function fitTitle(ctx, s, maxW, size, maxLines, font) {
  let fs = size, out;
  for (;;) {
    ctx.font = font.replace('{}', fs.toFixed(1) + 'px');
    out = lines(ctx, s, maxW);
    const loneArticle = out.length > 1 && /^(?:the|an?)$/i.test(out[0]);
    if ((!loneArticle && out.length <= maxLines && out.every((l) => ctx.measureText(l).width <= maxW)) || fs < size * 0.4) return { fs, out };
    fs *= 0.92;
  }
}
const hex = (c, a = 1) => {
  const v = new THREE.Color(c);
  return `rgba(${Math.round(v.r * 255)},${Math.round(v.g * 255)},${Math.round(v.b * 255)},${a})`;
};
function avgColor(img) {
  const c = canvas(8, 8), x = c.getContext('2d');
  x.drawImage(img, 0, 0, 8, 8);
  const d = x.getImageData(0, 0, 8, 8).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return new THREE.Color(r / n / 255, g / n / 255, b / n / 255).convertSRGBToLinear();
}

// ---------- 书皮：[封底 | 书脊 | 封面]，高 1024 像素 ----------
// b = content.books 里的一本；dims = [宽, 高, 厚]（米）；img = 真实封面（可以没有）
function paintJacket(b, dims, img = null) {
  const [w, h, t] = dims;
  const H = 1024, s = H / h, W = (2 * w + t) * s;
  const c = canvas(W, H), x = c.getContext('2d');
  const bw = w * s, sw = t * s, fx = bw + sw; // 封底宽、书脊宽、封面从哪里开始
  const base = img ? avgColor(img) : new THREE.Color(b.color || '#8a5a2b');
  const bg = '#' + base.getHexString();
  // WCAG relative luminance uses linear RGB. THREE.Color already stores linear values.
  const luminance = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const spineInk = blackContrast >= whiteContrast ? '#000000' : '#ffffff';
  const ink = (!img && b.ink) || spineInk;
  x.fillStyle = bg;
  x.fillRect(0, 0, W, H);
  const style = img ? 'image' : b.style;
  const title = b.title || 'Untitled', author = b.author || '';

  if (style === 'image') {
    const r = Math.min(bw / img.width, H / img.height); // Preserve the lettering at the edges of the original jacket.
    x.drawImage(img, fx + (bw - img.width * r) / 2, (H - img.height * r) / 2, img.width * r, img.height * r);
  } else if (style === 'modern') {
    const gold = ink;
    x.strokeStyle = hex(gold, 0.85);
    x.lineWidth = 3;
    x.strokeRect(fx + bw * 0.07, H * 0.05, bw * 0.86, H * 0.9);
    x.beginPath(); // 标志：一个圆环 + 中间一点
    x.arc(fx + bw / 2, H * 0.24, bw * 0.08, 0, Math.PI * 2);
    x.stroke();
    x.fillStyle = gold;
    x.beginPath();
    x.arc(fx + bw / 2, H * 0.24, bw * 0.018, 0, Math.PI * 2);
    x.fill();
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    let fs, below;
    if (latin(title)) {
      const t = fitTitle(x, title.toUpperCase(), bw * 0.76, bw * 0.12, 3, `700 {} ${FONT.sans}`);
      fs = t.fs;
      const lh = fs * 1.08, y0 = H * 0.50 - ((t.out.length - 1) * lh) / 2;
      t.out.forEach((l, i) => x.fillText(l, fx + bw / 2, y0 + i * lh));
      below = y0 + (t.out.length - 1) * lh;
    } else {
      fs = Math.min(bw * 0.15, (bw * 0.78) / Math.max(1, [...title].length));
      x.font = `700 ${fs}px ${FONT.sans}`;
      x.fillText(title, fx + bw / 2, H * 0.45);
      below = H * 0.45;
    }
    x.fillRect(fx + bw * 0.35, below + fs * 0.8, bw * 0.3, 2);
    x.font = `400 ${bw * 0.045}px ${FONT.sans}`;
    x.fillText(author, fx + bw / 2, H * 0.86);
  } else if (style === 'sea') {
    const sea = new THREE.Color(bg);
    const sky = x.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, hex(sea.clone().lerp(new THREE.Color('#fff8e8'), 0.75)));
    sky.addColorStop(1, hex(sea.clone().lerp(new THREE.Color('#fff8e8'), 0.35)));
    x.fillStyle = sky;
    x.fillRect(fx, 0, bw, H * 0.55);
    x.fillStyle = hex('#fff2c8', 0.95); // 太阳
    x.beginPath(); x.arc(fx + bw * 0.78, H * 0.2, bw * 0.07, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#e8cf95'; // 沙滩
    x.beginPath(); x.ellipse(fx + bw * 0.5, H * 0.56, bw * 0.3, H * 0.035, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#4f8a52'; // 小山
    x.beginPath(); x.ellipse(fx + bw * 0.42, H * 0.55, bw * 0.15, H * 0.06, 0, Math.PI, 0); x.fill();
    x.strokeStyle = '#6b4a2b'; // 椰子树
    x.lineWidth = bw * 0.015;
    x.beginPath(); x.moveTo(fx + bw * 0.6, H * 0.55); x.quadraticCurveTo(fx + bw * 0.62, H * 0.47, fx + bw * 0.58, H * 0.4); x.stroke();
    x.strokeStyle = '#3f7a44';
    x.lineWidth = bw * 0.012;
    for (const a of [-2.6, -2.0, -1.2, -0.5, 0.2]) {
      x.beginPath();
      x.moveTo(fx + bw * 0.58, H * 0.4);
      x.quadraticCurveTo(fx + bw * (0.58 + Math.cos(a) * 0.06), H * (0.4 + Math.sin(a) * 0.03 - 0.02), fx + bw * (0.58 + Math.cos(a) * 0.11), H * (0.4 + Math.sin(a) * 0.04 + 0.03));
      x.stroke();
    }
    x.strokeStyle = hex('#ffffff', 0.5); // 浪
    x.lineWidth = 2;
    for (let k = 0; k < 7; k++) {
      const yy = H * (0.62 + k * 0.045);
      x.beginPath();
      for (let u = 0; u <= 1.001; u += 0.05) x.lineTo(fx + bw * u, yy + Math.sin(u * 18 + k) * 3);
      x.stroke();
    }
    x.fillStyle = hex('#f6c35b', 0.9); // 两条小鱼
    for (const [u, v, d] of [[0.3, 0.78, 1], [0.66, 0.88, -1]]) {
      x.beginPath(); x.ellipse(fx + bw * u, H * v, bw * 0.04, H * 0.012, 0, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.moveTo(fx + bw * (u - d * 0.04), H * v); x.lineTo(fx + bw * (u - d * 0.065), H * (v - 0.012)); x.lineTo(fx + bw * (u - d * 0.065), H * (v + 0.012)); x.fill();
    }
    x.fillStyle = ink;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    let below = H * 0.09;
    if (latin(title)) {
      const t = fitTitle(x, title, bw * 0.8, bw * 0.1, 2, `800 {} ${FONT.sans}`);
      t.out.forEach((l, i) => x.fillText(l, fx + bw / 2, H * 0.08 + i * t.fs * 1.1));
      below = H * 0.08 + (t.out.length - 1) * t.fs * 1.1;
    } else {
      const fs = Math.min(bw * 0.13, (bw * 0.8) / Math.max(1, [...title].length));
      x.font = `800 ${fs}px ${FONT.sans}`;
      x.fillText(title, fx + bw / 2, H * 0.09);
    }
    x.font = `400 ${bw * 0.04}px ${FONT.sans}`;
    x.fillStyle = hex('#1f3d55');
    x.fillText(author, fx + bw / 2, below + H * 0.06);
  } else { // literary：米白的纸，竖排书名，淡墨远山，一方红印
    grain(x, fx, 0, bw, H, 0.06, 11);
    const r = rnd(5);
    for (let k = 0; k < 3; k++) { // 远山：三层越来越深的山脊线
      x.fillStyle = hex(ink, 0.05 + k * 0.035);
      x.beginPath();
      x.moveTo(fx, H);
      let yy = H * (0.66 + k * 0.08);
      for (let u = 0; u <= 1.001; u += 0.04) {
        yy += (r() - 0.5) * H * 0.03;
        x.lineTo(fx + bw * u, yy - Math.sin(u * 3 + k) * H * 0.03);
      }
      x.lineTo(fx + bw, H);
      x.fill();
    }
    x.fillStyle = hex('#ffffff', 0.8); // 雪点
    for (let k = 0; k < 60; k++) { x.beginPath(); x.arc(fx + r() * bw, r() * H * 0.9, 1 + r() * 2.5, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = ink;
    if (latin(title)) { // 英文：书名左对齐排在上面，作者斜体在下面
      x.textAlign = 'left';
      x.textBaseline = 'alphabetic';
      const t = fitTitle(x, title, bw * 0.74, bw * 0.11, 4, `500 {} ${FONT.serif}`);
      const lh = t.fs * 1.12;
      t.out.forEach((l, i) => x.fillText(l, fx + bw * 0.13, H * 0.14 + i * lh));
      x.fillStyle = hex(ink, 0.75);
      x.font = `italic 400 ${bw * 0.055}px ${FONT.serif}`;
      x.fillText(author, fx + bw * 0.13, H * 0.14 + (t.out.length - 1) * lh + bw * 0.12, bw * 0.74);
      x.textAlign = 'center';
      x.textBaseline = 'middle';
    } else {
      const fs = bw * 0.16;
      vtext(x, title, fx + bw * 0.78, H * 0.1, fs, H * 0.45, `500 {} ${FONT.serif}`);
      x.fillStyle = hex(ink, 0.75);
      vtext(x, author, fx + bw * 0.62, H * 0.12, bw * 0.05, H * 0.3, `400 {} ${FONT.serif}`);
    }
    x.fillStyle = '#b23a2a'; // 红印
    x.fillRect(fx + bw * 0.71, H * 0.6, bw * 0.12, bw * 0.12);
    x.fillStyle = '#f4ead8';
    x.font = `700 ${bw * 0.08}px ${FONT.serif}`;
    x.fillText([...title.replace(/^(?:the|an?)\s+/i, '')][0], fx + bw * 0.77, H * 0.6 + bw * 0.06);
  }

  // 封底：几行很淡的"简介"、一个条形码
  x.fillStyle = hex(ink, 0.18);
  for (let k = 0; k < 7; k++) x.fillRect(bw * 0.18, H * (0.3 + k * 0.035), bw * (k === 6 ? 0.4 : 0.64), H * 0.008);
  x.fillStyle = '#f6f2ea';
  x.fillRect(bw * 0.12, H * 0.82, bw * 0.3, H * 0.09);
  x.fillStyle = '#111';
  const rb = rnd(title.length * 13 + 3);
  for (let px = bw * 0.14; px < bw * 0.4; px += 2 + Math.floor(rb() * 3)) x.fillRect(px, H * 0.83, 1 + Math.floor(rb() * 2), H * 0.06);

  // 书脊：深一点的同色 + 竖排书名、作者，下面一个小记号
  x.fillStyle = bg;
  x.fillRect(bw, 0, sw, H);
  const shade = x.createLinearGradient(bw, 0, fx, 0); // 书脊有一点弧度：两边暗中间亮
  shade.addColorStop(0, 'rgba(0,0,0,0.22)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  shade.addColorStop(1, 'rgba(0,0,0,0.22)');
  x.fillStyle = shade;
  x.fillRect(bw, 0, sw, H);
  x.fillStyle = spineInk;
  const font = style === 'modern' || style === 'sea' ? `700 {} ${FONT.sans}` : `600 {} ${FONT.serif}`;
  const end = spineText(x, shortTitle(title), bw + sw / 2, H * 0.06, latin(title) ? sw * 0.74 : sw * 0.62, H * 0.68, font);
  x.fillStyle = spineInk;
  // 作者：<span class="by" data-spine> 写了就印它；中文取第一个词（[法]雨果 → 雨果）；英文取姓（Bob Iger → Iger；两个人取第一个人的姓）
  const who = b.spine || (latin(author) ? author.split(/[/&,]| and /)[0].trim().split(/\s+/).pop() || '' : author.split(/[\s/]+/)[0]);
  spineText(x, who, bw + sw / 2, end + H * 0.025, sw * 0.42, H * 0.15, `400 {} ${FONT.serif}`);
  x.fillStyle = hex(ink, 0.6);
  x.fillRect(bw + sw * 0.3, H * 0.92, sw * 0.4, sw * 0.4);
  return c;
}

// ---------- 书页 ----------
const PAPER = '#f4eddc', PEN = '#1f2a44', PRINT = '#2a2622';
function paper(w, h, seed) {
  const c = canvas(w, h), x = c.getContext('2d');
  x.fillStyle = PAPER;
  x.fillRect(0, 0, w, h);
  const g = x.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8); // 纸边微微发黄
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(120,90,40,0.12)');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  grain(x, 0, 0, w, h, 0.05, seed);
  return { c, x };
}
// 订口的阴影：靠书脊那一边暗下去（side = 'left' / 'right'：书脊在这一页的哪一边）
function gutter(x, W, H, side) {
  const g = side === 'left' ? x.createLinearGradient(0, 0, W * 0.16, 0) : x.createLinearGradient(W, 0, W * 0.84, 0);
  g.addColorStop(0, 'rgba(60,40,20,0.32)');
  g.addColorStop(0.35, 'rgba(60,40,20,0.1)');
  g.addColorStop(1, 'rgba(60,40,20,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
}
// 读书状态：Finished Nov 2024 / Reading · 46%。data-read 写读完的月份（"Nov 2024"），只知道读完了写 "done"
export function readStatus(b) {
  if (b.read) return ['done', '读完'].includes(b.read) ? 'Finished' : `Finished ${b.read}`;
  if (b.progress != null) return b.progress < 3 ? 'Just started' : `Reading · ${Math.round(b.progress)}%`;
  return '';
}
// 左页：封面里侧。上面一行钢笔写的读书状态；中间单独印这本书的标志句（blockquote.key），没有就退回到感想（p）
function paintEndpaper(b, ratio) {
  const H = 1280, W = H * ratio;
  const { c, x } = paper(W, H, 21);
  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  const status = readStatus(b);
  if (status) {
    x.fillStyle = PEN;
    x.font = `italic 400 ${W * 0.05}px ${FONT.pen}`;
    x.fillText(status, W * 0.12, H * 0.12);
    x.fillRect(W * 0.12, H * 0.135, Math.min(W * 0.5, x.measureText(status).width), 2);
  }
  const line = b.key || b.note || '';
  if (line) {
    // 字号跟着句子长短走：短句印得大一点。先量出要几行，整段在页面中间偏上竖直居中
    const n = latin(line) ? line.length / 2.3 : [...line].length; // 英文按字母数折算：大约 2.3 个字母顶一个汉字宽
    const fs = W * (n <= 12 ? 0.085 : n <= 30 ? 0.07 : n <= 60 ? 0.06 : 0.052), lh = fs * 1.62;
    x.font = `500 ${fs}px ${FONT.serif}`;
    const probe = canvas(4, 4).getContext('2d');
    probe.font = x.font;
    const rows = wrap(probe, line, 0, 0, W * 0.7, lh, 14) / lh;
    let y = Math.max(H * 0.26, H * 0.47 - (rows * lh) / 2) + fs;
    x.font = `400 ${W * 0.16}px ${FONT.serif}`; // 一个大大的红色引号
    x.fillStyle = 'rgba(178,58,42,0.55)';
    x.fillText('“', W * 0.09, y - fs * 0.15);
    x.font = `500 ${fs}px ${FONT.serif}`;
    x.fillStyle = PRINT;
    y = wrap(x, line, W * 0.16, y, W * 0.7, lh, 14);
    x.font = `400 ${W * 0.036}px ${FONT.serif}`;
    x.fillStyle = 'rgba(42,38,34,0.6)';
    x.textAlign = 'right';
    x.fillText(latin(b.title) ? `— ${shortTitle(b.title)}` : `——《${b.title}》`, W * 0.86, y + fs * 0.4, W * 0.72);
  }
  gutter(x, W, H, 'right');
  return c;
}
// 划线页：一页放得下几条就放几条，放不下的挪到下一页（翻开后的第一页上面印着书名，放得少一点）。
// 翻开后的第一个跨页要是满的：右页划线不多时字放大、条与条之间拉开，把这一页撑满；
// 只有零星一两条的书，右页下半截再印一张阅读卡（出版社、划了几条、读到哪里），不让右页空着
const QUOTE = { size: 0.046, lh: 1.63, gap: 0.045, top: 0.09, firstTop: 0.28, bottom: 0.89, card: 0.3 };
const quoteFont = (W, s) => `400 ${W * QUOTE.size * s}px ${FONT.serif}`;
const probeCtx = (() => { let p; return () => (p ||= canvas(4, 4).getContext('2d')); })();
// Break on measured lines. Each fragment keeps its original quote's punctuation and spacing.
function layoutQuotes(b, ratio) {
  const H = 1280, W = H * ratio;
  const firstSpace = H * (QUOTE.bottom - QUOTE.firstTop), gap = H * QUOTE.gap;
  const quotes = b.quotes || [];
  const measure = (scale) => {
    const ctx = probeCtx();
    ctx.font = quoteFont(W, scale);
    return quotes.map(q => lines(ctx, q, W * 0.7)).filter(rows => rows.length);
  };
  const leading = (scale) => W * QUOTE.size * scale * QUOTE.lh;
  const height = (blocks, scale) => blocks.reduce((sum, rows) => sum + rows.length * leading(scale), 0)
    + gap * Math.max(0, blocks.length - 1);
  let scale = 1, blocks = measure(scale);
  const natural = height(blocks, scale);
  const card = natural < firstSpace * 0.45 && !!(b.publisher || b.marks || b.read || b.progress != null);
  const available = firstSpace - (card ? H * (QUOTE.card + 0.03) : 0);
  if (natural <= available) {
    for (let step = 1; blocks.length && step <= 8; step++) {
      const next = 1 + step * 0.05, larger = measure(next);
      if (height(larger, next) > available) break;
      scale = next;
      blocks = larger;
    }
    const extra = (available - height(blocks, scale)) / Math.max(1, blocks.length);
    return [{ first: true, items: blocks.map(rows => ({ rows })), scale, card, gap: gap + Math.min(H * 0.06, extra) }];
  }
  let page = { first: true, items: [] }, remaining = firstSpace;
  const pages = [page], lh = leading(1);
  for (const rows of blocks) {
    let start = 0;
    while (start < rows.length) {
      const padding = page.items.length ? gap : 0;
      let count = Math.min(rows.length - start, Math.floor((remaining - padding) / lh));
      if (!page.items.length) count = Math.max(1, count);
      // Keep two lines together on either side of a break when possible.
      if (count > 2 && rows.length - start - count === 1) count--;
      if (count <= 0 || (count === 1 && rows.length - start > 1 && page.items.length)) {
        page = { items: [] };
        pages.push(page);
        remaining = H * (QUOTE.bottom - QUOTE.top);
        continue;
      }
      page.items.push({ rows: rows.slice(start, start + count), continued: start > 0 });
      remaining -= padding + count * lh;
      start += count;
    }
  }
  return pages;
}
// 阅读卡：像图书馆的借书卡，几行横线，右边一个红色的圆章（读完 / 在读）
function paintCard(x, b, W, H, y0, h) {
  const x0 = W * 0.13, w = W * 0.74;
  x.save();
  x.strokeStyle = 'rgba(42,38,34,0.55)';
  x.lineWidth = 2;
  x.strokeRect(x0, y0, w, h);
  x.lineWidth = 1;
  x.strokeRect(x0 + 6, y0 + 6, w - 12, h - 12);
  x.fillStyle = 'rgba(42,38,34,0.75)';
  x.textAlign = 'center';
  x.textBaseline = 'alphabetic';
  x.font = `500 ${W * 0.036}px ${FONT.serif}`;
  x.fillText('R E A D I N G   C A R D', x0 + w / 2, y0 + h * 0.15);
  const rows = [['Title', b.title], ['Author', b.author], ['Publisher', b.publisher], ['Highlights', b.marks ? String(b.marks) : ''], ['Status', readStatus(b)]]
    .filter(([, v]) => v);
  const rh = (h * 0.76) / Math.max(4, rows.length), ry = y0 + h * 0.22;
  x.textAlign = 'left';
  const labelX = x0 + w * 0.07;
  const labelFont = `400 ${W * 0.028}px ${FONT.sans}`;
  x.font = labelFont;
  const valueX = labelX + Math.max(0, ...rows.map(([label]) => x.measureText(label.toUpperCase()).width)) + w * 0.05;
  rows.forEach(([k, v], i) => {
    const yy = ry + rh * (i + 0.72);
    x.fillStyle = 'rgba(42,38,34,0.55)';
    x.font = labelFont;
    x.fillText(k.toUpperCase(), labelX, yy);
    x.fillStyle = PEN;
    x.font = `italic 400 ${W * 0.044}px ${FONT.pen}`;
    x.fillText(v, valueX, yy, x0 + w * 0.94 - valueX);
    x.fillStyle = 'rgba(42,38,34,0.18)';
    x.fillRect(x0 + w * 0.05, yy + rh * 0.22, w * 0.9, 1);
  });
  if (b.read || b.progress != null) { // 圆章
    const cx = x0 + w * 0.88, cy = y0 + h * 0.14, r = Math.min(w * 0.075, h * 0.1);
    x.translate(cx, cy);
    x.rotate(-0.25);
    x.strokeStyle = 'rgba(178,40,32,0.6)';
    x.fillStyle = 'rgba(178,40,32,0.6)';
    x.lineWidth = 4;
    x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 1.5;
    x.beginPath(); x.arc(0, 0, r * 0.84, 0, Math.PI * 2); x.stroke();
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    const word = b.read ? 'READ' : 'READING';
    x.font = `700 ${r * 0.62}px ${FONT.serif}`;
    x.font = `700 ${Math.min(r * 0.62, (r * 1.45 * r * 0.62) / x.measureText(word).width)}px ${FONT.serif}`; // 圈里放得下
    x.fillText(word, 0, 0);
  }
  x.restore();
}
// 一页划线。page：layoutQuotes 排好的一页；no：页码；side：这一页在左边还是右边（订口在另一边）
function paintQuotes(b, ratio, page, no, side = 'right') {
  const H = 1280, W = H * ratio;
  const { c, x } = paper(W, H, 33 + no * 7);
  x.textBaseline = 'alphabetic';
  let y = H * QUOTE.top;
  if (page.first) {
    x.fillStyle = PRINT;
    x.textAlign = 'center';
    const title = fitTitle(x, b.title, W * 0.8, W * 0.06, 2, `500 {} ${FONT.serif}`);
    const lineHeight = title.fs * 1.08;
    const offset = (title.out.length - 1) * lineHeight / 2;
    title.out.forEach((line, i) => x.fillText(line, W / 2, H * 0.12 - offset + i * lineHeight));
    x.font = `400 ${W * 0.034}px ${FONT.serif}`;
    x.fillStyle = 'rgba(42,38,34,0.7)';
    x.fillText(b.author, W / 2, H * 0.165 + offset, W * 0.8);
    x.fillRect(W * 0.42, H * 0.19 + offset, W * 0.16, 1.5);
    y = H * QUOTE.firstTop;
  }
  const x0 = side === 'right' ? W * 0.17 : W * 0.14, k = page.scale || 1, gap = page.gap || H * QUOTE.gap;
  x.textAlign = 'left';
  const fs = W * QUOTE.size * k, lh = fs * QUOTE.lh;
  for (const it of page.items) {
    if (!it.continued) {
      x.font = `400 ${fs * 1.95}px ${FONT.serif}`;
      x.fillStyle = 'rgba(178,58,42,0.75)';
      x.fillText('“', x0 - fs * 1.5, y + fs * 1.3);
    }
    x.fillStyle = PRINT;
    x.font = quoteFont(W, k);
    it.rows.forEach((line, i) => x.fillText(line, x0, y + fs + i * lh));
    y += lh * it.rows.length + gap;
  }
  if (page.card) {
    const h = page.items.length ? H * QUOTE.card : H * 0.6; // 一条划线都没有：阅读卡占满书名下面那一大块
    paintCard(x, b, W, H, page.items.length ? H * (QUOTE.bottom - QUOTE.card) : H * 0.26, h);
  }
  x.textAlign = 'center';
  x.font = `400 ${W * 0.03}px ${FONT.serif}`;
  x.fillStyle = 'rgba(42,38,34,0.5)';
  x.fillText(String(no), W / 2, H * 0.95);
  gutter(x, W, H, side === 'right' ? 'left' : 'right');
  return c;
}
// 最后一页正好落在左边时，右边留一张空白页
function paintBlank(ratio, side) {
  const H = 1280, W = H * ratio;
  const { c, x } = paper(W, H, 77);
  gutter(x, W, H, side === 'right' ? 'left' : 'right');
  return c;
}
// 书芯的三个切口：一条条纸边
function paintEdges() {
  const c = canvas(64, 256), x = c.getContext('2d');
  x.fillStyle = '#ebe2cb';
  x.fillRect(0, 0, 64, 256);
  for (let k = 0; k < 64; k += 2) {
    x.fillStyle = `rgba(120,100,70,${0.05 + ((k * 37) % 7) / 60})`;
    x.fillRect(k, 0, 1, 256);
  }
  return c;
}

const tex = (c, srgb = true) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};
// BoxGeometry 第 f 个面（px, nx, py, ny, pz, nz）的 UV 改成 u0 + u·du
function remapFace(g, f, u0, du) {
  const uv = g.attributes.uv;
  for (let k = f * 4; k < f * 4 + 4; k++) uv.setX(k, u0 + uv.getX(k) * du);
}

// ---------- 可以翻开的书（实时打光） ----------
// 本地坐标和烘焙的书一样：中心在原点，x = 厚（封面朝 +x），y = 高，z = 宽（书脊朝 +z）。
// 封面挂在书脊那条边上（x = t/2，z = w/2）绕 y 轴转开；翻到底时封面的里侧（左页）和书芯的第一页（右页）都朝 +x
class OpenBook {
  constructor(dims, kind, jacketTex, leftTex, rightTex) {
    const [w, h, t] = dims;
    const hard = kind === 'hard';
    const bt = hard ? 0.0025 : 0.0009, o = hard ? 0.003 : 0.0006;
    const W = 2 * w + t;
    this.dims = dims;
    this.group = new THREE.Group();
    this.mats = [];
    const std = (opt) => { const m = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, transparent: true, ...opt }); this.mats.push(m); return m; };
    const cover = std({ map: jacketTex });
    const inner = std({ map: leftTex });
    const edgeTex = tex(paintEdges());
    const edges = std({ map: edgeTex, color: 0xffffff });
    const first = std({ map: rightTex });
    this.inner = inner; // 左页（封面里侧）和右页的材质：翻页时换贴图
    this.first = first;
    const plainPaper = std({ color: new THREE.Color(PAPER) });

    // 封底那块板：外面朝 -x
    const gb = new THREE.BoxGeometry(bt, h, w);
    remapFace(gb, 1, 0, w / W);
    for (const f of [0, 2, 3, 4, 5]) remapFace(gb, f, (w + t / 2) / W, 0);
    const back = new THREE.Mesh(gb, cover);
    back.position.set(-t / 2 + bt / 2, 0, 0);
    this.group.add(back);
    // 书脊
    const gs = new THREE.BoxGeometry(t - 2 * bt, h, bt);
    remapFace(gs, 4, w / W, t / W);
    for (const f of [0, 1, 2, 3, 5]) remapFace(gs, f, (w + t / 2) / W, 0);
    const spine = new THREE.Mesh(gs, cover);
    spine.position.set(0, 0, w / 2 - bt / 2);
    this.group.add(spine);
    // 书芯：+x 面是第一页（右页），上下和切口是纸边
    const pages = new THREE.Mesh(new THREE.BoxGeometry(t - 2 * bt, h - 2 * o, w - o - bt), [plainPaper, plainPaper, edges, edges, plainPaper, edges]);
    pages.position.set(0, 0, (o - bt) / 2);
    this.group.add(pages);
    // 第一页单独一张纸，盖在书芯上：靠书脊那边往下弯进订口，中间微微鼓起（翻开的书页不是平的）
    const pw = w - o - bt, ph = h - 2 * o;
    const sheet = new THREE.PlaneGeometry(pw, ph, 32, 1);
    sheet.rotateY(Math.PI / 2); // 法线朝 +x；平面的 u 方向从 +z（书脊）到 -z（切口）
    const P = sheet.attributes.position;
    for (let k = 0; k < P.count; k++) {
      const u = (pw / 2 - P.getZ(k)) / pw; // 0 = 书脊，1 = 切口
      P.setX(k, -0.0045 * Math.exp(-u / 0.06) + 0.0018 * Math.sin(Math.PI * Math.min(1, u * 1.15)));
    }
    sheet.computeVertexNormals();
    this.pages = new THREE.Mesh(sheet, first);
    // 合着的时候这张纸压平、藏在书芯面下面（不然鼓起来的地方会顶穿薄薄的平装封面）；封面翻开了它才松开、鼓起来
    this.sheetX = [t / 2 - bt - 0.0004, t / 2 - bt + 0.0006];
    this.pages.position.z = (o - bt) / 2;
    this.group.add(this.pages);
    this.bulge = (u) => -0.0045 * Math.exp(-u / 0.06) + 0.0018 * Math.sin(Math.PI * Math.min(1, u * 1.15)); // 和上面那张纸一样的弯法

    // 翻页的那一张纸：沿宽度分 N 段，每帧按翻到哪里重新摆。正面（+x）是右页，背面是翻过去以后的左页（贴图左右镜像）
    const N = 28;
    const pos = new THREE.BufferAttribute(new Float32Array((N + 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const nor = new THREE.BufferAttribute(new Float32Array((N + 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const uvF = new Float32Array((N + 1) * 2 * 2), uvB = new Float32Array((N + 1) * 2 * 2), idx = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      uvF.set([u, 0, u, 1], i * 4);
      uvB.set([1 - u, 0, 1 - u, 1], i * 4);
      if (i < N) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); } // 正面法线朝 +x
    }
    const geo = (uv) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', pos);
      g.setAttribute('normal', nor);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    };
    this.leafF = std({ map: rightTex, side: THREE.FrontSide });
    this.leafB = std({ map: leftTex, side: THREE.BackSide });
    this.leaf = new THREE.Group();
    this.leafGeo = geo(uvF);
    this.leaf.add(new THREE.Mesh(this.leafGeo, this.leafF), new THREE.Mesh(geo(uvB), this.leafB));
    for (const m of this.leaf.children) m.frustumCulled = false; // 形状每帧在变，包围球不准
    this.leaf.visible = false;
    this.group.add(this.leaf);
    // 翻页纸的摆法：书脊那条边在订口（z = w/2 - bt），从躺在右边书芯上（比右页高一点点）翻到躺在左页上（左页是封面里侧，
    // 比书芯高出两块封板）；靠书脊的部分先翻过去、纸边落在后面，纸就弯起来
    this.leafN = N;
    this.leafPw = pw;
    this.leafPh = ph;
    this.leafZ = w / 2 - bt;
    this.leafX = [this.sheetX[1] + 0.0004, t / 2 + bt + 0.0007];
    // 封面：挂在铰链上。外面（+x）= 封面，里面（-x）= 左页
    this.hinge = new THREE.Group();
    this.hinge.position.set(t / 2, 0, w / 2);
    const gf = new THREE.BoxGeometry(bt, h, w);
    remapFace(gf, 0, (w + t) / W, w / W);
    for (const f of [2, 3, 4, 5]) remapFace(gf, f, (w + t / 2) / W, 0);
    const front = new THREE.Mesh(gf, [cover, inner, cover, cover, cover, cover]);
    front.position.set(-bt / 2, 0, -w / 2);
    this.front = front;
    this.hinge.add(front);
    this.group.add(this.hinge);
    this.openness = 0; // 抽书时就使用合上的姿态，和合书放回时一致。
    this.group.visible = false;
  }
  set openness(k) {
    this.hinge.rotation.y = -Math.PI * 0.985 * k;
    const s = smooth01(0.12, 0.6, k); // 封面让开了，第一页才松开、鼓起来
    this.pages.visible = k > 0; // 两个书模型在途中交叉淡化，合着时不画被封面挡住的内页。
    this.pages.scale.x = Math.max(0.02, s);
    this.pages.position.x = this.sheetX[0] + (this.sheetX[1] - this.sheetX[0]) * s;
  }
  // 翻页：p = 0 躺在右边，1 躺在左边；null = 收起来
  setLeaf(p) {
    this.leaf.visible = p != null;
    if (p == null) return;
    const N = this.leafN, ds = this.leafPw / N, end = Math.PI * 0.985, L = 0.6;
    const P = this.leafGeo.attributes.position, Nn = this.leafGeo.attributes.normal;
    let x = this.leafX[0] + (this.leafX[1] - this.leafX[0]) * smooth01(0, 1, p), z = this.leafZ;
    const h2 = this.leafPh / 2;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const phi = end * smooth01(0, 1, p * (1 + L) - L * u); // 这一段转了多少：靠书脊的先转
      const off = this.bulge(u) * (1 - p) * 1.0; // 刚翻起来时跟右页一样弯，翻过去以后压平
      const nx = Math.cos(phi), nz = Math.sin(phi);  // 这一段正面的法线
      P.setXYZ(i * 2, x + nx * off, -h2, z + nz * off);
      P.setXYZ(i * 2 + 1, x + nx * off, h2, z + nz * off);
      Nn.setXYZ(i * 2, nx, 0, nz);
      Nn.setXYZ(i * 2 + 1, nx, 0, nz);
      x += Math.sin(phi) * ds; // 往下一段走：方向 (sin φ, 0, -cos φ)
      z -= Math.cos(phi) * ds;
    }
    P.needsUpdate = Nn.needsUpdate = true;
  }
  set opacity(a) { for (const m of this.mats) { m.opacity = a; m.depthWrite = a > 0.99; } }
  dispose() {
    this.group.traverse((o) => o.geometry?.dispose());
    for (const m of this.mats) { m.map?.dispose(); m.dispose(); }
  }
}

// ---------- 主体 ----------
// room：BakedRoom；scene / camera；books：content.books；
// frame()：面板、导航栏挡住了多少像素（和 room.js 的 covered() 一样）
export function createBooks({ room, scene, camera, books, frame = () => ({ w: 0, h: 0, top: 0 }) }) {
  const M = room.manifest.books;
  if (!M) return null;
  const entries = [];
  // 书柜朝向（绕 Y 轴）：书往 OUT 方向抽出来；书自己的朝向是 SHELF_ROT（旧的 manifest 没有 yaw = 正面朝 +z）
  const yaw = M.yaw ?? 0;
  const OUT = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const SHELF_ROT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const loadImg = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });

  // 书架上的每本书：拆出来、换上画好的书皮
  M.items.forEach((it) => {
    const b = books[it.i];
    const taken = room.takeParts([[`realbook${it.i}`, `realbook${it.i}_pages`]])[0];
    if (!b || !taken) return;
    const e = { kind: 'book', i: entries.length, mat: `realbook${it.i}`, b, dims: it.size, real: [...it.size], hard: it.kind === 'hard', ...taken };
    if (b.size?.length === 3) e.real = b.size; // 翻开的书照真实尺寸（书架上的模型可能为了放进那一层截过）
    e.heft = heftOf(e.real, e.hard);
    e.jacket = tex(paintJacket(b, e.dims));
    e.jacket.flipY = false; // glTF 的 UV 约定
    setJacket(e, e.jacket);
    if (b.cover) loadImg(COVERS + b.cover).then((img) => { // 有真实封面：书皮重画
      if (!img) return;
      e.img = img;
      const t2 = tex(paintJacket(b, e.dims, img));
      t2.flipY = false;
      setJacket(e, t2);
      e.jacket.dispose();
      e.jacket = t2;
    });
    entries.push(e);
  });
  // 以前书架第二层左头平放着一本本子，现在去掉了；room.glb 重新烘焙之前它还在模型里，先藏起来
  for (const n of ['secretbook', 'secretbook_pages']) for (const m of room.byMat.get(n) || []) m.visible = false;
  function setJacket(e, map) {
    for (const m of e.parts) {
      if (m.material.name !== e.mat) continue;
      // 书皮的反照率压到 0.78（纸和铜版纸大约这么白）：白封面的书在书架灯下不至于亮到泛光
      const mat = room.material(new THREE.Color(0.78, 0.78, 0.78), { map, uv1: !!m.geometry.attributes.uv1 });
      mat.name = m.material.name;
      m.material.dispose?.();
      m.material = mat;
    }
  }
  // 书皮上的英文字体（EB Garamond）加载好以前画的是后备字体：加载好了把没有真实封面的书皮重画一遍
  Promise.all(FONTS_USED.map((f) => document.fonts?.load(f).catch(() => null))).then(() => {
    for (const e of entries) {
      if (e.img) continue;
      const t2 = tex(paintJacket(e.b, e.dims));
      t2.flipY = false;
      setJacket(e, t2);
      e.jacket.dispose();
      e.jacket = t2;
    }
  });
  for (const e of entries) {
    e.homeRot ||= SHELF_ROT.clone();
    e.pull = 0; e.pullT = 0;
    e.state = 'shelf';
    for (const m of e.parts) m.userData.book = e.i;
  }

  // 实时打光：只照亮翻开的书（房间的材质是烘焙的，不吃灯）
  const key = new THREE.PointLight(0xffd9a8, 0.42, 0, 2); // 像书桌台灯：离书半米，左上方，光从一边往另一边暗下去
  const fill = new THREE.HemisphereLight(0xffe9cc, 0x2a2018, 0.35);
  key.visible = fill.visible = false;
  scene.add(key, fill);

  let cur = null;      // 正在看（或正在拿出来 / 放回去）的那本
  let queued = null;   // 换书：等这本放回去再拿下一本
  let rig = null;      // 实时的书
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  const qTarget = new THREE.Quaternion(), qGoal = new THREE.Quaternion(), qId = new THREE.Quaternion(), basis = new THREE.Matrix4();
  const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.14), negF = new THREE.Vector3(), negR = new THREE.Vector3();
  const readPos = new THREE.Vector3();

  // 镜头前看书的位置：书的高度占没被面板挡住那块画面的 6 成，摆在那块画面的正中
  function readingPose(e, k) {
    const [w, h] = e.real;
    camera.getWorldDirection(fwd);
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), th = tv * camera.aspect;
    const f = frame(), fw = Math.max(0.35, 1 - f.w / innerWidth), fh = Math.max(0.35, 1 - (f.h + f.top) / innerHeight);
    const spread = w * (1 + k); // 合着是一本宽，翻开是两本宽
    const d = Math.max(h / (2 * tv * fh * 0.62), spread / (2 * th * fw * 0.8));
    const nx = -f.w / innerWidth, ny = (f.h - f.top) / innerHeight; // 往没被挡的那块挪
    readPos.copy(camera.position).addScaledVector(fwd, d).addScaledVector(right, nx * d * th).addScaledVector(up, ny * d * tv);
    // 书的 x（封面）朝镜头、y 朝上、z（书脊）朝镜头的左边；再往后仰一点，像捧在手里
    basis.makeBasis(negF.copy(fwd).negate(), up, negR.copy(right).negate());
    qTarget.setFromRotationMatrix(basis).multiply(qTilt);
    return d;
  }

  function startOpen(e) {
    bookSfx(e, 'book-place', { gain: 0.5 }); // 从书架上抽出来：书蹭着书滑出来，比放回去轻
    cur = e;
    e.state = 'out';
    e.t = 0;
    e.from = e.group.position.clone();
  }
  let pageCache = new Map(); // 这本书画好的页：页号 → 贴图（翻到才画）
  function pageTex(i) {
    if (!pageCache.has(i)) pageCache.set(i, tex(cur.pageList[i]()));
    return pageCache.get(i);
  }
  function buildRig(e) {
    rig?.dispose();
    rig?.group.removeFromParent();
    for (const t of pageCache.values()) t.dispose();
    pageCache = new Map();
    const ratio = e.real[0] / e.real[1];
    let links = [];
    // 这本书的每一页：0 = 左页（标志句），1 = 右页（书名 + 第一页划线），往后左、右、左、右……凑成双数，两页一个跨页
    const qp = layoutQuotes(e.b, ratio);
    e.pageList = [() => paintEndpaper(e.b, ratio), ...qp.map((pg, k) => () => paintQuotes(e.b, ratio, pg, k + 1, k % 2 ? 'left' : 'right'))];
    if (e.pageList.length % 2) e.pageList.push(() => paintBlank(ratio, 'right'));
    e.spreads = e.pageList.length / 2;
    e.spread = 0;
    e.flip = null;
    e.flipQueue = 0;
    const jacket = tex(paintJacket(e.b, e.real, e.img));
    rig = new OpenBook(e.real, e.hard ? 'hard' : 'soft', jacket, pageTex(0), pageTex(1));
    rig.pages.userData.links = links;
    rig.group.traverse((o) => { o.userData.rig = true; });
    scene.add(rig.group);
  }

  // ---------- 翻页 ----------
  // 往后翻：翻页纸正面 = 现在的右页、背面 = 下一个跨页的左页；底下的右页马上换成下一个跨页的右页（被翻页纸盖着）。
  // 往前翻：倒过来，翻页纸从左边翻回右边。翻完把左页 / 右页的贴图换好，收起翻页纸
  const FLIP = 0.8;
  function startFlip(e, d) {
    sfx.play('book-flip', { gain: 0.6, rate: lerp(1.12, 0.96, e.heft ?? 0.5) }); // 翻页：纸越薄越脆
    const s = e.spread, to = s + d;
    if (d > 0) {
      rig.leafF.map = pageTex(2 * s + 1);
      rig.leafB.map = pageTex(2 * to);
      rig.first.map = pageTex(2 * to + 1);
    } else {
      rig.leafF.map = pageTex(2 * to + 1);
      rig.leafB.map = pageTex(2 * s);
      rig.inner.map = pageTex(2 * to);
    }
    e.flip = { d, to, t: 0 };
    rig.setLeaf(d > 0 ? 0 : 1);
  }
  function finishFlip(e) {
    const f = e.flip;
    if (f.d > 0) rig.inner.map = pageTex(2 * f.to);
    else rig.first.map = pageTex(2 * f.to + 1);
    rig.setLeaf(null);
    e.spread = f.to;
    e.flip = null;
  }
  function stepFlip(e, dt) {
    const f = e.flip;
    f.t += dt;
    const k = clamp01(f.t / FLIP);
    rig.setLeaf(f.d > 0 ? k : 1 - k);
    if (k < 1) return;
    finishFlip(e);
    const q = e.flipQueue; // 翻页途中又按了一次：接着翻
    e.flipQueue = 0;
    if (q && e.spread + q >= 0 && e.spread + q < e.spreads) startFlip(e, q);
  }

  // 实时的书有多"实"：0 = 只看得到烘焙的书，1 = 只看得到实时的书（拿下来、放回去的路上交叉淡入淡出）
  function fade(e, a) {
    rig.opacity = a;
    rig.group.visible = a > 0;
    e.group.visible = a < 1;
    key.visible = fill.visible = a > 0;
    for (const m of e.parts) {
      m.material.transparent = a > 0;
      m.material.depthWrite = a <= 0;
      m.material.uniforms.opacity.value = 1 - a;
    }
  }
  // 路上：实时的书跟着烘焙的书走（书自己的朝向 = 组的朝向 · homeRot）
  function follow(e) {
    rig.group.position.copy(e.group.position);
    rig.group.quaternion.copy(e.group.quaternion).multiply(e.homeRot);
  }
  function bezier(out, a, b, k) { // 二次贝塞尔：控制点在两头的中点往上 8 厘米
    const m = tmp.lerpVectors(a, b, 0.5);
    m.y += 0.08;
    const s = 1 - k;
    return out.set(s * s * a.x + 2 * s * k * m.x + k * k * b.x, s * s * a.y + 2 * s * k * m.y + k * k * b.y, s * s * a.z + 2 * s * k * m.z + k * k * b.z);
  }
  const smooth = (a, b, x) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };

  function update(dt) {
    for (const e of entries) {
      if (e.state === 'shelf') {
        e.pull += (e.pullT - e.pull) * (1 - Math.exp(-dt * 12));
        e.group.position.copy(e.home);
        e.group.position.addScaledVector(OUT, e.pull * 0.022);
        for (const m of e.parts) m.material.uniforms.hi.value = e.pull * 0.5;
      }
    }
    if (!cur) return;
    const e = cur;
    e.t += dt;
    const outPos = tmp2.copy(e.home);
    outPos.addScaledVector(OUT, e.dims[0] * 0.8);
    // 拆出来的组在书架上没有旋转，书自己的朝向是 homeRot：组要转到 qTarget · homeRot⁻¹，书才是 qTarget
    const qFly = (k) => { qGoal.copy(e.homeRot).invert().premultiply(qTarget); e.group.quaternion.slerpQuaternions(qId, qGoal, k); };
    switch (e.state) {
      case 'out': { // 从书架上抽出来
        const k = ease(clamp01(e.t / 0.32));
        e.group.position.lerpVectors(e.from, outPos, k);
        for (const m of e.parts) m.material.uniforms.hi.value = 0.5 * (1 - k);
        if (k >= 1) { e.state = 'fly'; e.t = 0; e.from.copy(outPos); buildRig(e); }
        break;
      }
      case 'fly': { // 飞到镜头前、转到封面朝你；路上换成实时打光的书
        readingPose(e, 0);
        const k = ease(clamp01(e.t / 0.85));
        bezier(e.group.position, e.from, readPos, k);
        qFly(k);
        follow(e);
        placeLight();
        fade(e, smooth(0.12, 0.45, k));
        if (k >= 1) { e.state = 'open'; e.t = 0; bookSfx(e, 'book-open', { gain: 0.65 }); pagesFan(e, 0.08); }
        break;
      }
      case 'open':
      case 'opened': {
        const kOpen = e.openK = e.state === 'open' ? ease(clamp01(e.t / 0.95)) : 1;
        readingPose(e, kOpen);
        placeRig(e, kOpen);
        rig.openness = kOpen;
        if (e.state === 'open' && e.t >= 0.95) { e.state = 'opened'; e.t = 0; }
        if (e.flip) stepFlip(e, dt);
        break;
      }
      case 'close': { // 合上
        const k = e.closeFrom * (1 - ease(clamp01(e.t / 0.6)));
        readingPose(e, k);
        placeRig(e, k);
        rig.openness = k;
        if (k <= 0) { e.state = 'back'; e.t = 0; e.from = readPos.clone(); }
        break;
      }
      case 'back': { // 飞回书架；快到的时候换回烘焙的书
        readingPose(e, 0);
        const k = ease(clamp01(e.t / 0.7));
        bezier(e.group.position, e.from, outPos, k);
        qFly(1 - k);
        follow(e);
        placeLight();
        fade(e, 1 - smooth(0.5, 0.85, k));
        if (k >= 1) { e.state = 'in'; e.t = 0; e.from = outPos.clone(); }
        break;
      }
      case 'in': {
        const k = ease(clamp01(e.t / 0.3));
        e.group.position.lerpVectors(e.from, e.home, k);
        e.group.quaternion.identity();
        if (k >= 1) {
          e.state = 'shelf'; e.pull = 0; e.pullT = 0;
          bookSfx(e, 'book-place', { gain: 0.8 }); // 放回书架
          cur = null;
          const q = queued;
          queued = null;
          if (q != null) startOpen(entries[q]);
        }
        break;
      }
    }
  }
  // 灯：从镜头左上方、离书三十来厘米的地方打过来
  function placeLight() {
    key.position.copy(readPos).addScaledVector(up, 0.32).addScaledVector(right, -0.3).addScaledVector(fwd, -0.3);
  }
  // 翻开时整本书往左挪半本，书脊落在画面正中
  function placeRig(e, k) {
    const w = e.real[0];
    rig.group.quaternion.copy(qTarget);
    rig.group.position.copy(readPos).sub(tmp.set(0, 0, (w / 2) * k).applyQuaternion(qTarget));
    placeLight();
  }

  const reading = () => cur && ['open', 'opened'].includes(cur.state);
  return {
    entries,
    groups: entries.map((e) => e.group),
    get rig() { return rig?.group || null; },
    update,
    // 书架上悬停：i = null 收回去
    hover(i) { for (const e of entries) e.pullT = e.i === i && e.state === 'shelf' && cur !== e ? 1 : 0; },
    open(i) {
      const e = entries[i];
      if (!e) return;
      if (cur === e) { if (['close', 'back', 'in'].includes(e.state)) queued = i; return; }
      if (cur) { queued = i; this.close(); return; }
      startOpen(e);
    },
    close() {
      if (!cur) return;
      queued = queued === cur.i ? null : queued;
      const e = cur;
      if (e.state === 'out') { e.state = 'in'; e.t = 0; e.from = e.group.position.clone(); }
      else if (e.state === 'fly') { e.state = 'back'; e.t = 0; e.from = e.group.position.clone(); }
      else if (['open', 'opened'].includes(e.state)) {
        if (e.flip) finishFlip(e);
        e.flipQueue = 0;
        e.closeFrom = e.openK || 0; e.state = 'close'; e.t = 0;
        bookSfx(e, 'book-close', { gain: 0.9, delay: 0.35 }); // 合上：厚精装"啪"，薄平装只是轻轻一拍
        pagesFan(e, 0.27);
      }
    },
    step(d) {
      const n = entries.filter((e) => e.kind === 'book').length;
      if (!cur || cur.kind !== 'book' || !n) return;
      this.open((cur.i + d + n) % n);
    },
    // 正在看的那本（拿出来、翻开、放回去途中都算）；null = 没有
    current: () => (cur && !['close', 'back', 'in'].includes(cur.state) ? cur.i : queued),
    entry: (i) => entries[i],
    // 景深对焦：正在看书时对着书
    focus: () => (cur && ['fly', 'open', 'opened', 'close'].includes(cur.state) ? (rig?.group.visible ? rig.group.position : cur.group.position) : null),
    // 翻页：d = 1 往后、-1 往前。返回 true = 翻了；false = 已经翻到头（room.js 就换一本）；null = 书还没翻开，先不动
    turn(d) {
      if (!cur || ['close', 'back', 'in'].includes(cur.state)) return false;
      if (cur.state !== 'opened' || !cur.spreads) return null;
      const e = cur, at = e.flip ? e.flip.to : e.spread;
      if (at + d < 0 || at + d >= e.spreads) return false;
      if (e.flip) e.flipQueue = d;
      else startFlip(e, d);
      return true;
    },
    // 正在看的那本翻到第几个跨页（从 1 数）、一共几个；没在看书 = null
    pageInfo: () => (cur && reading() && cur.spreads ? { page: (cur.flip ? cur.flip.to : cur.spread) + 1, pages: cur.spreads } : null),
    // 点到的是左页还是右页（看点在书脊哪一边）
    sideAt(hit) {
      if (!rig || !reading() || !hit?.point) return null;
      return rig.group.worldToLocal(hit.point.clone()).z > cur.real[0] / 2 ? 'left' : 'right';
    },
    // 直接翻到第 page 页所在的跨页（一次翻过去）
    turnTo(page) {
      if (!cur || cur.state !== 'opened' || cur.flip || !cur.spreads) return false;
      const to = Math.max(0, Math.min(cur.spreads - 1, Math.floor(page / 2)));
      if (to === cur.spread) return false;
      startFlip(cur, to - cur.spread);
      return true;
    },
    // 点到翻开的书页：页上的链接
    linkAt(hit) {
      const links = hit?.object?.userData?.links;
      if (!links || !hit.uv || hit.face?.materialIndex !== 0 || !reading()) return null;
      const { x: u, y: v } = hit.uv;
      return links.find((l) => u >= l.u0 && u <= l.u1 && v >= l.v0 && v <= l.v1)?.url || null;
    },
    isRig: (o) => !!o?.userData?.rig,
  };
}
