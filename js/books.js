// 书架上的真书和彩蛋本子（js/room.js 用）。
// 烘焙脚本按 index.html 的书单给每本书建好了模型：材质 realbook{i}（书皮）+ realbook{i}_pages（书芯），书皮的 UV 横着排
// [封底 | 书脊 | 封面]；书立着、书脊朝屋里（+z）、封面朝 +x。彩蛋本子是 secretbook，平放在书架第二层左头。这里负责：
//   - 书皮贴图：canvas 画书脊、封面、封底。index.html 里写了 data-cover 而且 assets/books/covers/ 里有这张图，封面就用真实的；
//     没有就按 data-style 自动画一张（literary 素净文学 / modern 粗体现代 / sea 插画海岛）
//   - 悬停：书往外抽出 2 厘米、提亮
//   - 点了：抽出来 → 飞到镜头前、转到封面朝你 → 换成实时打光的"真书"（烘焙的光照只对书架上那个位置成立）→ 封面翻开：
//     左页（封面的里侧）= 读书状态 + 这本书的代表句，右页起是划线（第一页撑满，划线少的书下面印一张阅读卡），一页放不下就翻页
//   - 彩蛋本子：第一个跨页是一句俏皮话 + 目录（点目录翻到那一篇），往后是文章全文；上了锁的那篇是马赛克，口令解开（js/seal.js）才重画成正文
//   - 合上：倒着放一遍，飞回书架
import * as THREE from 'three';

const COVERS = new URL('../assets/books/covers/', import.meta.url).href;
const FONT = {
  serif: '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", SimSun, serif',
  kai: '"Kaiti SC", "STKaiti", KaiTi, "Songti SC", serif',
  sans: '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif',
};
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const clamp01 = (k) => Math.min(1, Math.max(0, k));
const smooth01 = (a, b, x) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

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
// 横排自动换行（中文按字断行），返回最后一行的底
const NO_START = '，。、；：！？）」』》〉”’…—,.;:!?)';
function wrap(ctx, s, x, y, maxW, lh, maxLines = 99) {
  let line = '', lines = 0;
  const out = [];
  for (const ch of s) {
    // 标点不放在行首：超出一点也挂在上一行末尾
    if (ctx.measureText(line + ch).width > maxW && line && !NO_START.includes(ch)) { out.push(line); line = ''; }
    line += ch;
  }
  if (line) out.push(line);
  for (const l of out.slice(0, maxLines)) { ctx.fillText(l, x, y + lines * lh); lines++; }
  return y + lines * lh;
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
  let bg = b.color || '#8a5a2b', ink = b.ink || '#f2ead8';
  if (img) { // 真实封面：书脊和封底取封面的平均色，字用黑或白
    const avg = avgColor(img), lum = avg.r * 0.2126 + avg.g * 0.7152 + avg.b * 0.0722;
    bg = '#' + avg.clone().convertLinearToSRGB().getHexString();
    ink = lum > 0.35 ? '#1d1d1d' : '#f4efe4';
  }
  x.fillStyle = bg;
  x.fillRect(0, 0, W, H);
  const style = img ? 'image' : b.style;
  const title = b.title || '无题', author = b.author || '';

  if (style === 'image') {
    const r = Math.max(bw / img.width, H / img.height); // 铺满封面，多的裁掉
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
    const fs = Math.min(bw * 0.15, (bw * 0.78) / Math.max(1, [...title].length));
    x.font = `700 ${fs}px ${FONT.sans}`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(title, fx + bw / 2, H * 0.45);
    x.fillRect(fx + bw * 0.35, H * 0.45 + fs * 0.8, bw * 0.3, 2);
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
    const fs = Math.min(bw * 0.13, (bw * 0.8) / Math.max(1, [...title].length));
    x.font = `800 ${fs}px ${FONT.sans}`;
    x.fillText(title, fx + bw / 2, H * 0.09);
    x.font = `400 ${bw * 0.04}px ${FONT.sans}`;
    x.fillStyle = hex('#1f3d55');
    x.fillText(author, fx + bw / 2, H * 0.15);
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
    const fs = bw * 0.16;
    vtext(x, title, fx + bw * 0.78, H * 0.1, fs, H * 0.45, `500 {} ${FONT.serif}`);
    x.fillStyle = hex(ink, 0.75);
    vtext(x, author, fx + bw * 0.62, H * 0.12, bw * 0.05, H * 0.3, `400 {} ${FONT.serif}`);
    x.fillStyle = '#b23a2a'; // 红印
    x.fillRect(fx + bw * 0.71, H * 0.6, bw * 0.12, bw * 0.12);
    x.fillStyle = '#f4ead8';
    x.font = `700 ${bw * 0.08}px ${FONT.serif}`;
    x.fillText([...title][0], fx + bw * 0.77, H * 0.6 + bw * 0.06);
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
  x.fillStyle = ink;
  const font = style === 'modern' || style === 'sea' ? `700 {} ${FONT.sans}` : `500 {} ${FONT.serif}`;
  const end = vtext(x, title, bw + sw / 2, H * 0.06, sw * 0.62, H * 0.5, font);
  x.fillStyle = hex(ink, 0.75);
  vtext(x, author.split(/[\s/]+/)[0], bw + sw / 2, end + H * 0.04, sw * 0.36, H * 0.25, `400 {} ${FONT.serif}`);
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
// 读书状态：读完于 2024 年 11 月 / 在读 · 46%（room.js 的面板也用）
export function readStatus(b) {
  if (b.read) return b.read === '读完' ? '读完' : `读完于 ${b.read}`;
  if (b.progress != null) return b.progress < 3 ? '刚开始读' : `在读 · 读到 ${Math.round(b.progress)}%`;
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
    x.font = `400 ${W * 0.046}px ${FONT.kai}`;
    x.fillText(status, W * 0.12, H * 0.12);
    x.fillRect(W * 0.12, H * 0.135, Math.min(W * 0.5, x.measureText(status).width), 2);
  }
  const line = b.key || b.note || '';
  if (line) {
    // 字号跟着句子长短走：短句印得大一点。先量出要几行，整段在页面中间偏上竖直居中
    const n = [...line].length;
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
    x.fillText(`——《${b.title}》`, W * 0.86, y + fs * 0.4);
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
// 一条划线在字号倍数 s 下有多高（像素）
function quoteH(q, W, s) {
  const x = probeCtx();
  x.font = quoteFont(W, s);
  return wrap(x, q, 0, 0, W * 0.7, W * QUOTE.size * s * QUOTE.lh, 99);
}
function layoutQuotes(b, ratio) {
  const H = 1280, W = H * ratio, gap = H * QUOTE.gap;
  const pages = [{ first: true, items: [] }];
  let y = H * QUOTE.firstTop;
  for (const q of b.quotes || []) {
    // 一条很长的划线：字缩小一点，保证一整页放得下（不截断）
    let s = 1;
    while (s > 0.7 && quoteH(q, W, s) > H * (QUOTE.bottom - QUOTE.top)) s -= 0.05;
    const hq = quoteH(q, W, s);
    if (y + hq > H * QUOTE.bottom && pages.at(-1).items.length) { pages.push({ first: false, items: [] }); y = H * QUOTE.top; }
    pages.at(-1).items.push({ q, s });
    y += hq + gap;
  }
  // 第一页撑满：先看要不要印阅读卡，再把字放大到刚好排满（最多 1.4 倍），剩下的空隙匀到条与条之间
  const p0 = pages[0], top = H * QUOTE.firstTop;
  const natural = p0.items.reduce((h, it) => h + quoteH(it.q, W, it.s), 0) + gap * Math.max(0, p0.items.length - 1);
  p0.card = natural < (H * QUOTE.bottom - top) * 0.45 && (b.publisher || b.marks || b.read || b.progress != null);
  const bottom = H * (p0.card ? QUOTE.bottom - QUOTE.card - 0.03 : QUOTE.bottom);
  const height = (k) => p0.items.reduce((h, it) => h + quoteH(it.q, W, it.s * k), 0) + gap * Math.max(0, p0.items.length - 1);
  let k = 1;
  if (p0.items.length) while (k < 1.4 && height(k + 0.05) <= bottom - top) k += 0.05;
  p0.scale = k;
  const spare = p0.items.length ? bottom - top - height(k) : 0;
  p0.gap = gap + Math.min(H * 0.06, spare / Math.max(1, p0.items.length));
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
  x.fillText('阅 读 卡', x0 + w / 2, y0 + h * 0.15);
  const rows = [['书名', `《${b.title}》`], ['作者', b.author], ['出版', b.publisher], ['划线', b.marks ? `${b.marks} 条` : ''], ['状态', readStatus(b)]]
    .filter(([, v]) => v);
  const rh = (h * 0.76) / Math.max(4, rows.length), ry = y0 + h * 0.22;
  x.textAlign = 'left';
  rows.forEach(([k, v], i) => {
    const yy = ry + rh * (i + 0.72);
    x.fillStyle = 'rgba(42,38,34,0.55)';
    x.font = `400 ${W * 0.03}px ${FONT.sans}`;
    x.fillText(k, x0 + w * 0.07, yy);
    x.fillStyle = PEN;
    x.font = `400 ${W * 0.042}px ${FONT.kai}`;
    x.fillText(v, x0 + w * 0.22, yy, w * 0.72);
    x.fillStyle = 'rgba(42,38,34,0.18)';
    x.fillRect(x0 + w * 0.05, yy + rh * 0.22, w * 0.9, 1);
  });
  if (b.read || b.progress != null) { // 圆章
    const cx = x0 + w * 0.8, cy = y0 + h * 0.62, r = W * 0.085;
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
    x.font = `700 ${r * 0.62}px ${FONT.serif}`;
    x.fillText(b.read ? '读完' : '在读', 0, 0);
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
    x.font = `500 ${W * 0.06}px ${FONT.serif}`;
    x.fillText(b.title, W / 2, H * 0.12);
    x.font = `400 ${W * 0.034}px ${FONT.serif}`;
    x.fillStyle = 'rgba(42,38,34,0.7)';
    x.fillText(b.author, W / 2, H * 0.165);
    x.fillRect(W * 0.42, H * 0.19, W * 0.16, 1.5);
    y = H * QUOTE.firstTop;
  }
  const x0 = side === 'right' ? W * 0.17 : W * 0.14, k = page.scale || 1, gap = page.gap || H * QUOTE.gap;
  x.textAlign = 'left';
  for (const it of page.items) {
    const s = it.s * k, fs = W * QUOTE.size * s;
    x.font = `400 ${fs * 1.95}px ${FONT.serif}`;
    x.fillStyle = 'rgba(178,58,42,0.75)';
    x.fillText('“', x0 - fs * 1.5, y + fs * 1.3);
    x.fillStyle = PRINT;
    x.font = quoteFont(W, s);
    y = wrap(x, it.q, x0, y + fs, W * 0.7, fs * QUOTE.lh, 99) - fs + gap; // y 是这一条的顶，第一行的基线在 y + 字号
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
// 彩蛋本子：牛皮纸封面
function paintKraft(dims) {
  const [w, h, t] = dims;
  const H = 1024, s = H / h, W = (2 * w + t) * s;
  const c = canvas(W, H), x = c.getContext('2d');
  x.fillStyle = '#a67c52';
  x.fillRect(0, 0, W, H);
  grain(x, 0, 0, W, H, 0.12, 4);
  const fx = (w + t) * s, bw = w * s;
  x.strokeStyle = 'rgba(40,25,10,0.55)'; // 封面上随手画的一颗星
  x.lineWidth = 3;
  x.beginPath();
  for (let k = 0; k <= 5; k++) {
    const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5;
    x.lineTo(fx + bw * 0.72 + Math.cos(a) * bw * 0.07, H * 0.18 + Math.sin(a) * bw * 0.07);
  }
  x.stroke();
  x.fillStyle = 'rgba(40,25,10,0.5)';
  x.fillRect(fx + bw * 0.15, H * 0.12, bw * 0.4, 2);
  x.fillRect(fx + bw * 0.15, H * 0.16, bw * 0.3, 2);
  return c;
}
// ---------- 彩蛋本子里的文章 ----------
// 本子的纸：米白、浅蓝的横线，钢笔手写（楷体）。翻开的第一个跨页：左页是第一篇的开头，右页是第二篇的开头
// （上了锁就是一层厚马赛克）；往后翻先接着第一篇，再接着第二篇
const ESSAY = { size: 0.046, lh: 0.078, top: 0.1, openerTop: 0.27, bottom: 0.9, x0: 0.12, x1: 0.88 };
// 一段字断成几行（中文按字断，标点不放行首）
function breakLines(ctx, s, maxW) {
  const out = [];
  let line = '';
  for (const ch of s) {
    if (ctx.measureText(line + ch).width > maxW && line && !NO_START.includes(ch)) { out.push(line); line = ''; }
    line += ch;
  }
  if (line) out.push(line);
  return out;
}
// 一篇文章排成一页页：每页是若干行 { text, kind: p / q / h }；第一页上面留出标题的位置
function layoutEssay(doc, ratio) {
  const H = 1280, W = H * ratio, fs = W * ESSAY.size, lh = W * ESSAY.lh;
  const x = probeCtx();
  const pages = [[]];
  let y = H * ESSAY.openerTop;
  const put = (row, h) => {
    if (y + h > H * ESSAY.bottom) { pages.push([]); y = H * ESSAY.top; }
    pages.at(-1).push(row);
    y += h;
  };
  for (const blk of doc.blocks || []) {
    if (blk.t === 'h') {
      x.font = `600 ${fs * 1.12}px ${FONT.kai}`;
      if (pages.at(-1).length) put({ text: '', kind: 'gap' }, lh * 0.5);
      for (const l of breakLines(x, blk.text, W * (ESSAY.x1 - ESSAY.x0))) put({ text: l, kind: 'h' }, lh);
      continue;
    }
    const q = blk.t === 'q';
    x.font = `400 ${fs}px ${FONT.kai}`;
    const indent = q ? fs * 1.5 : 0;
    const lines = breakLines(x, (q ? '' : '\u3000\u3000') + blk.text, W * (ESSAY.x1 - ESSAY.x0) - indent);
    for (const l of lines) put({ text: l, kind: q ? 'q' : 'p' }, lh);
  }
  return pages;
}
// 本子的一页纸：横线对着行距
function notebookPaper(W, H, seed, side) {
  const { c, x } = paper(W, H, seed);
  const lh = W * ESSAY.lh;
  x.fillStyle = 'rgba(70,110,160,0.16)';
  for (let y = H * ESSAY.top + lh * 0.28; y < H * 0.95; y += lh) x.fillRect(W * 0.06, y, W * 0.88, 1.5);
  x.fillStyle = 'rgba(190,70,60,0.18)'; // 订口那边一条竖的红线
  x.fillRect(side === 'right' ? W * 0.085 : W * 0.915, 0, 1.5, H);
  return { c, x };
}
function essayHeader(x, doc, W, H, opener, sealed) {
  x.textBaseline = 'alphabetic';
  if (opener) {
    x.fillStyle = PEN;
    x.textAlign = 'left';
    x.font = `400 ${W * 0.078}px ${FONT.kai}`;
    x.fillText(doc.title, W * ESSAY.x0, H * 0.15);
    if (doc.sub) {
      x.font = `400 ${W * 0.04}px ${FONT.kai}`;
      x.fillStyle = 'rgba(31,42,68,0.6)';
      x.fillText(doc.sub, W * ESSAY.x0, H * 0.2);
    }
    x.fillStyle = 'rgba(31,42,68,0.45)';
    x.fillRect(W * ESSAY.x0, H * 0.218, W * 0.22, 2);
  } else { // 接着上一页：页眉上一行小字
    x.fillStyle = 'rgba(31,42,68,0.45)';
    x.textAlign = 'center';
    x.font = `400 ${W * 0.032}px ${FONT.kai}`;
    x.fillText(`${doc.title}${sealed ? '' : '（续）'}`, W / 2, H * 0.06);
  }
}
// 文章的一页。rows = layoutEssay 排好的一页；no = 本子的页码
function paintEssay(doc, rows, ratio, side, no, opener) {
  const H = 1280, W = H * ratio, fs = W * ESSAY.size, lh = W * ESSAY.lh;
  const { c, x } = notebookPaper(W, H, 60 + no * 5, side);
  essayHeader(x, doc, W, H, opener, false);
  let y = H * (opener ? ESSAY.openerTop : ESSAY.top);
  x.textAlign = 'left';
  for (const r of rows) {
    if (r.kind === 'gap') { y += lh * 0.5; continue; }
    x.font = r.kind === 'h' ? `600 ${fs * 1.12}px ${FONT.kai}` : `400 ${fs}px ${FONT.kai}`;
    x.fillStyle = r.kind === 'q' ? 'rgba(31,42,68,0.72)' : PEN;
    x.fillText(r.text, W * ESSAY.x0 + (r.kind === 'q' ? fs * 1.5 : 0), y);
    y += lh;
  }
  x.textAlign = 'center';
  x.font = `400 ${W * 0.03}px ${FONT.kai}`;
  x.fillStyle = 'rgba(31,42,68,0.45)';
  x.fillText(String(no), W / 2, H * 0.965);
  gutter(x, W, H, side === 'right' ? 'left' : 'right');
  return c;
}
// 上了锁的一页：正文那一块铺满一格格的马赛克——按本子的行来排，有字的那半行深、行与行之间浅，每格深浅随机，
// 和正文内容没有任何关系（正文只在密文里）；盖一个红色的章
function paintMosaic(doc, ratio, side, no, opener) {
  const H = 1280, W = H * ratio, lh = W * ESSAY.lh;
  const { c, x } = notebookPaper(W, H, 90 + no * 3, side);
  const ink = [31, 42, 68], pap = [236, 228, 210], r = rnd(1234 + no * 77);
  const cw = W / 19, ch = lh / 2, x0 = W * 0.08, x1 = W * 0.92, cols = Math.ceil((x1 - x0) / cw);
  const mix = (k) => `rgb(${pap.map((v, i) => Math.round(v * (1 - k) + ink[i] * k)).join(',')})`;
  let par = 0;
  for (let y = H * (opener ? ESSAY.openerTop - 0.035 : ESSAY.top - 0.035); y + lh <= H * (ESSAY.bottom + 0.02); y += lh) {
    const short = r() < 0.16, len = short ? Math.floor(cols * (0.25 + r() * 0.5)) : cols, from = par === 0 ? 2 : 0;
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < cols; k++) {
        const text = k >= from && k < len;
        const v = text ? (row === 0 ? 0.32 + r() * 0.42 : 0.14 + r() * 0.28) : 0.04 + r() * 0.08;
        x.fillStyle = mix(v);
        x.fillRect(x0 + k * cw, y + row * ch, Math.ceil(cw) + 0.5, Math.ceil(ch) + 0.5);
      }
    }
    par = short ? 0 : par + 1;
  }
  essayHeader(x, doc, W, H, opener, true);
  // 红章：上了锁
  x.save();
  x.translate(W * 0.62, H * (opener ? 0.58 : 0.5));
  x.rotate(-0.18);
  x.strokeStyle = x.fillStyle = 'rgba(178,34,28,0.82)';
  x.lineWidth = 5;
  const bw = W * 0.5, bh = W * 0.19;
  x.strokeRect(-bw / 2, -bh / 2, bw, bh);
  x.lineWidth = 2;
  x.strokeRect(-bw / 2 + 8, -bh / 2 + 8, bw - 16, bh - 16);
  x.lineWidth = 5; // 一把小锁
  x.beginPath();
  x.arc(-bw * 0.36, -bh * 0.06, bh * 0.15, Math.PI, 0);
  x.stroke();
  x.fillRect(-bw * 0.36 - bh * 0.2, -bh * 0.06, bh * 0.4, bh * 0.3);
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `700 ${bh * 0.3}px ${FONT.serif}`;
  x.fillText('仅作者可阅', bw * 0.12, 0);
  x.restore();
  x.textAlign = 'center';
  x.textBaseline = 'alphabetic';
  x.font = `400 ${W * 0.03}px ${FONT.kai}`;
  x.fillStyle = 'rgba(31,42,68,0.45)';
  x.fillText(String(no), W / 2, H * 0.965);
  gutter(x, W, H, side === 'right' ? 'left' : 'right');
  return c;
}
// 本子第一页（左）：一句俏皮话
function paintNotebookHello(ratio) {
  const H = 1280, W = H * ratio;
  const { c, x } = notebookPaper(W, H, 51, 'left');
  x.textBaseline = 'alphabetic';
  x.textAlign = 'left';
  x.fillStyle = 'rgba(31,42,68,0.6)';
  x.font = `400 ${W * 0.045}px ${FONT.kai}`;
  x.fillText('写过的一些东西', W * ESSAY.x0, H * 0.2);
  x.fillStyle = PEN;
  x.font = `400 ${W * 0.09}px ${FONT.kai}`;
  x.fillText('这都被你', W * ESSAY.x0, H * 0.42);
  x.fillText('找到了。', W * (ESSAY.x0 + 0.2), H * 0.42 + W * 0.13);
  x.strokeStyle = 'rgba(31,42,68,0.55)'; // 随手画的一颗星
  x.lineWidth = 3;
  x.beginPath();
  const cx = W * 0.74, cy = H * 0.68, R = W * 0.07;
  for (let k = 0; k <= 5; k++) {
    const a1 = -Math.PI / 2 + k * (Math.PI * 4) / 5;
    x[k ? 'lineTo' : 'moveTo'](cx + Math.cos(a1) * R, cy + Math.sin(a1) * R);
  }
  x.stroke();
  gutter(x, W, H, 'right');
  return c;
}
// 本子第二页（右）：目录。每一条记下在页面上的矩形，点了翻到那一篇（toc = [{ title, sub, page, locked }]）
function paintToc(toc, ratio) {
  const H = 1280, W = H * ratio;
  const { c, x } = notebookPaper(W, H, 52, 'right');
  const links = [];
  x.textBaseline = 'alphabetic';
  x.fillStyle = PEN;
  x.textAlign = 'left';
  x.font = `400 ${W * 0.07}px ${FONT.kai}`;
  x.fillText('目录', W * 0.16, H * 0.17);
  x.fillStyle = 'rgba(31,42,68,0.45)';
  x.fillRect(W * 0.16, H * 0.19, W * 0.14, 2);
  let y = H * 0.32;
  toc.forEach((t, i) => {
    x.fillStyle = PEN;
    x.textAlign = 'left';
    x.font = `400 ${W * 0.055}px ${FONT.kai}`;
    const label = `${'一二三四五六七八九十'[i] || i + 1}、${t.title}`;
    x.fillText(label, W * 0.16, y, W * 0.56);
    const tw = Math.min(x.measureText(label).width, W * 0.56);
    x.font = `400 ${W * 0.045}px ${FONT.kai}`;
    x.textAlign = 'right';
    x.fillText(String(t.page), W * 0.86, y);
    x.fillStyle = 'rgba(31,42,68,0.35)'; // 点点引线
    for (let d = W * 0.16 + tw + W * 0.03; d < W * 0.8; d += W * 0.025) x.fillRect(d, y - 4, 3, 3);
    let y2 = y + W * 0.06;
    if (t.sub || t.locked) {
      x.textAlign = 'left';
      x.font = `400 ${W * 0.036}px ${FONT.kai}`;
      x.fillStyle = t.locked ? 'rgba(178,34,28,0.75)' : 'rgba(31,42,68,0.55)';
      x.fillText([t.sub, t.locked ? '上了锁 · 仅作者可阅' : ''].filter(Boolean).join('　'), W * 0.2, y2);
      y2 += W * 0.04;
    }
    links.push({ u0: 0.12, u1: 0.9, v0: 1 - (y2 + W * 0.02) / H, v1: 1 - (y - W * 0.07) / H, page: t.page - 1 });
    y = y2 + H * 0.07;
  });
  gutter(x, W, H, 'left');
  return { c, links };
}
// 本子的全部页：第一个跨页 = 俏皮话 + 目录；翻过去是第一篇全文，接着是第二篇（上了锁就是两页马赛克），依次往后。凑成双数
// opened：上了锁的那几篇解开以后的正文（密文地址 → { title, sub, blocks }）
function notebookPages(writing, opened, ratio) {
  const docs = writing.map((w) => (w.sealed ? (opened.get(w.sealed) ? { ...opened.get(w.sealed), title: w.title, sub: w.sub } : null) : w));
  const lay = docs.map((d) => (d ? layoutEssay(d, ratio) : null));
  const seq = [{ kind: 'hello' }, { kind: 'toc' }], starts = [];
  writing.forEach((w, i) => {
    starts[i] = seq.length;
    if (lay[i]) lay[i].forEach((_, k) => seq.push({ kind: 'essay', i, k }));
    else seq.push({ kind: 'mosaic', i, k: 0 }, { kind: 'mosaic', i, k: 1 });
  });
  if (seq.length % 2) seq.push(null);
  const toc = writing.map((w, i) => ({ title: w.title, sub: w.sub, page: starts[i] + 1, locked: !!w.sealed && !lay[i] }));
  return seq.map((it, n) => {
    const side = n % 2 ? 'right' : 'left';
    if (!it) return () => paintBlank(ratio, side);
    if (it.kind === 'hello') return () => paintNotebookHello(ratio);
    if (it.kind === 'toc') {
      const f = () => { const r = paintToc(toc, ratio); f.links = r.links; return r.c; };
      return f;
    }
    const w = writing[it.i];
    if (it.kind === 'mosaic') return Object.assign(() => paintMosaic(w, ratio, side, n + 1, it.k === 0), { locked: w.sealed });
    return () => paintEssay(docs[it.i], lay[it.i][it.k], ratio, side, n + 1, it.k === 0);
  });
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
    this.pages.position.set(this.sheetX[0], 0, (o - bt) / 2);
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
    this.group.visible = false;
  }
  set openness(k) {
    this.hinge.rotation.y = -Math.PI * 0.985 * k;
    const s = smooth01(0.12, 0.6, k); // 封面让开了，第一页才松开、鼓起来
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
// room：BakedRoom；scene / camera；books：content.books；writing：content.writing；
// frame()：面板、导航栏挡住了多少像素（和 room.js 的 covered() 一样）
export function createBooks({ room, scene, camera, books, writing = [], frame = () => ({ w: 0, h: 0, top: 0 }) }) {
  const M = room.manifest.books;
  if (!M) return null;
  const entries = [];
  const loadImg = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });

  // 书架上的每本书：拆出来、换上画好的书皮
  M.items.forEach((it) => {
    const b = books[it.i];
    const taken = room.takeParts([[`realbook${it.i}`, `realbook${it.i}_pages`]])[0];
    if (!b || !taken) return;
    const e = { kind: 'book', i: entries.length, mat: `realbook${it.i}`, b, dims: it.size, real: [...it.size], hard: it.kind === 'hard', ...taken };
    if (b.size?.length === 3) e.real = b.size; // 翻开的书照真实尺寸（书架上的模型可能为了放进那一层截过）
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
  // 彩蛋本子
  if (M.secret && writing.length) {
    const taken = room.takeParts([['secretbook', 'secretbook_pages']])[0];
    if (taken) {
      const s = M.secret;
      const e = { kind: 'secret', i: entries.length, mat: 'secretbook', b: { title: '一本没写书名的本子', author: '' }, dims: s.size, real: s.size, hard: false, ...taken };
      e.home = taken.group.position.clone();
      e.homeRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2); // 平放：书的 x（厚度）朝上
      e.jacket = tex(paintKraft(s.size));
      e.jacket.flipY = false;
      setJacket(e, e.jacket);
      entries.push(e);
    }
  }
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
  for (const e of entries) {
    e.homeRot ||= new THREE.Quaternion();
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
    cur = e;
    e.state = 'out';
    e.t = 0;
    e.from = e.group.position.clone();
  }
  const opened = new Map();  // 上了锁的文章解开以后的正文：密文地址 → { title, sub, blocks }
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
    if (e.kind === 'secret') {
      e.pageList = notebookPages(writing, opened, ratio);
    } else {
      const qp = layoutQuotes(e.b, ratio);
      e.pageList = [() => paintEndpaper(e.b, ratio), ...qp.map((pg, k) => () => paintQuotes(e.b, ratio, pg, k + 1, k % 2 ? 'left' : 'right'))];
      if (e.pageList.length % 2) e.pageList.push(() => paintBlank(ratio, 'right'));
    }
    e.spreads = e.pageList.length / 2;
    e.spread = 0;
    e.flip = null;
    e.flipQueue = 0;
    const jacket = tex(e.kind === 'secret' ? paintKraft(e.real) : paintJacket(e.b, e.real, e.img));
    rig = new OpenBook(e.real, e.hard ? 'hard' : 'soft', jacket, pageTex(0), pageTex(1));
    rig.pages.userData.links = links;
    rig.group.traverse((o) => { o.userData.rig = true; });
    scene.add(rig.group);
  }

  // 本子开着的时候解开了（或者锁回去了）：页重新排、重新画，停在原来那个跨页
  function refreshPages(e) {
    if (e.flip) finishFlip(e);
    e.pageList = notebookPages(writing, opened, e.real[0] / e.real[1]);
    e.spreads = e.pageList.length / 2;
    e.spread = Math.min(e.spread, e.spreads - 1);
    for (const t of pageCache.values()) t.dispose();
    pageCache = new Map();
    rig.inner.map = pageTex(2 * e.spread);
    rig.first.map = pageTex(2 * e.spread + 1);
  }

  // ---------- 翻页 ----------
  // 往后翻：翻页纸正面 = 现在的右页、背面 = 下一个跨页的左页；底下的右页马上换成下一个跨页的右页（被翻页纸盖着）。
  // 往前翻：倒过来，翻页纸从左边翻回右边。翻完把左页 / 右页的贴图换好，收起翻页纸
  const FLIP = 0.8;
  function startFlip(e, d) {
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
        e.group.position.z += e.pull * 0.022;
        for (const m of e.parts) m.material.uniforms.hi.value = e.pull * 0.5;
      }
    }
    if (!cur) return;
    const e = cur;
    e.t += dt;
    const outPos = tmp2.copy(e.home);
    outPos.z += e.kind === 'secret' ? e.dims[0] * 0.75 : e.dims[0] * 0.8;
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
        if (k >= 1) { e.state = 'open'; e.t = 0; }
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
    // 上了锁的文章：解开了就把正文交进来（doc = null 锁回去），本子开着就马上重画
    setUnsealed(url, doc) {
      if (doc) opened.set(url, doc);
      else opened.delete(url);
      if (cur?.kind === 'secret' && rig && ['open', 'opened'].includes(cur.state)) refreshPages(cur);
    },
    // 点到的这一页是不是马赛克（上了锁）：是就返回密文地址
    lockedAt(hit) {
      const side = this.sideAt(hit);
      if (!side || cur?.kind !== 'secret' || cur.flip) return null;
      return cur.pageList?.[2 * cur.spread + (side === 'right' ? 1 : 0)]?.locked || null;
    },
    // 点到本子的目录：返回要翻到第几页（从 0 数）；没点到目录 = null
    tocAt(hit) {
      if (cur?.kind !== 'secret' || !rig || hit?.object !== rig.pages || !hit.uv || cur.flip || cur.state !== 'opened') return null;
      const links = cur.pageList?.[2 * cur.spread + 1]?.links;
      const { x: u, y: v } = hit.uv;
      return links?.find((l) => u >= l.u0 && u <= l.u1 && v >= l.v0 && v <= l.v1)?.page ?? null;
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
