// 录像带的纸盒包装（js/room.js 用）：架子上每盘录像带套着一个纸盒（烘焙的 sleeve0 …），这里按 index.html #work 里的作品
// 给纸盒画包装：书脊朝外（竖排的名字 + 一条作品颜色），封面是老式租赁录像带那种（黑底、斜着的彩条、大字的名字），
// 封底是米色的纸，印着简介和一个条形码；最后整张旧一点：边上磨白、几道折痕、一点点发黄。
// 纸盒的 UV 是烘焙脚本排的：一张图横着排 [封底 | 书脊 | 封面 | 背脊 | 里面]，各栏宽度在 manifest.tapes.sleeve.cols（米）
import * as THREE from 'three';

const SANS = '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif';
// 英文界面的字体（css/style.css 里的 @font-face）：封面大字 Playfair Display，标签 Cinzel，正文 EB Garamond；中文落到后面的字体上
const DISPLAY = `"Playfair Display", "Songti SC", ${SANS}`, CAPS = `"Cinzel", "Songti SC", ${SANS}`, BODY = `"EB Garamond", "Songti SC", ${SANS}`;
const CJK = /[\u3400-\u9fff]/;
const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const hsl = (c, dh = 0, ds = 0, dl = 0) => {
  const h = {};
  new THREE.Color(c).getHSL(h);
  return `hsl(${((h.h + dh) % 1 + 1) % 1 * 360},${Math.min(100, Math.max(0, (h.s + ds) * 100))}%,${Math.min(100, Math.max(0, (h.l + dl) * 100))}%)`;
};
const lum = (c) => { const v = new THREE.Color(c); return 0.2126 * v.r + 0.7152 * v.g + 0.0722 * v.b; };

// 一行字缩到放得下
function fitText(x, s, maxW, size, weight = 800, family = DISPLAY) {
  let fs = size;
  x.font = `${weight} ${fs}px ${family}`;
  while (fs > 8 && x.measureText(s).width > maxW) { fs -= 2; x.font = `${weight} ${fs}px ${family}`; }
  return fs;
}
// 书脊上的英文：整行转 90°（从上往下读，和真的录像带书脊一样），放不下就缩小
function spineText(x, s, cx, y0, maxLen, maxH, size, weight, family) {
  let fs = size;
  x.font = `${weight} ${fs}px ${family}`;
  while (fs > 8 && (x.measureText(s).width > maxLen || fs > maxH)) { fs -= 1; x.font = `${weight} ${fs}px ${family}`; }
  const len = x.measureText(s).width;
  x.save();
  x.translate(cx, y0);
  x.rotate(Math.PI / 2);
  x.textAlign = 'left';
  x.textBaseline = 'middle';
  x.fillText(s, 0, 0);
  x.restore();
  return y0 + len;
}
// 横排自动换行（中文按字断），返回写到了哪里
function wrap(x, s, x0, y, maxW, lh, maxLines) {
  let line = '', n = 0;
  for (const ch of s) {
    if (x.measureText(line + ch).width > maxW && line) {
      if (++n > maxLines) return y;
      x.fillText(line, x0, y);
      y += lh;
      line = '';
    }
    line += ch;
  }
  if (line && n < maxLines) { x.fillText(line, x0, y); y += lh; }
  return y;
}
// 竖排：一个字一行，字太多就缩小
function vtext(x, s, cx, y0, maxH, size, weight = 800, family = SANS) {
  const chars = [...s].filter((ch) => ch.trim());
  const fs = Math.min(size, maxH / Math.max(1, chars.length * 1.08));
  x.font = `${weight} ${fs}px ${family}`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  chars.forEach((ch, k) => x.fillText(ch, cx, y0 + fs * (0.55 + k * 1.08)));
  return y0 + fs * 1.08 * chars.length;
}

function paintSleeve(t, i, cols, len) {
  const H = 1024, ppm = H / len, W = Math.round(cols.reduce((a, b) => a + b, 0) * ppm);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const at = cols.map((_, k) => cols.slice(0, k).reduce((a, b) => a + b, 0) * ppm), wd = cols.map((w) => w * ppm);
  const color = t.color || '#e8b04a', r = rnd(97 + i * 131);
  const title = t.title || `作品 ${i + 1}`, years = t.years || '', desc = t.desc || '';

  // ---------- 封面（第 3 栏）----------
  let x0 = at[2], w = wd[2];
  x.fillStyle = '#17161a';
  x.fillRect(x0, 0, w, H);
  x.save();
  x.beginPath();
  x.rect(x0, 0, w, H);
  x.clip();
  for (let k = 0; k < 5; k++) { // 斜着的彩条：作品颜色往两边转一点色相
    x.fillStyle = hsl(color, (k - 2) * 0.05, 0.05, (k - 2) * 0.03);
    const y = H * 0.56 + k * H * 0.045;
    x.beginPath();
    x.moveTo(x0 - 10, y + w * 0.35);
    x.lineTo(x0 + w + 10, y - w * 0.35);
    x.lineTo(x0 + w + 10, y - w * 0.35 + H * 0.038);
    x.lineTo(x0 - 10, y + w * 0.35 + H * 0.038);
    x.closePath();
    x.fill();
  }
  x.restore();
  x.strokeStyle = 'rgba(240,232,214,0.85)'; // 左上角 VHS 小标
  x.lineWidth = 3;
  x.strokeRect(x0 + w * 0.08, H * 0.04, w * 0.24, H * 0.045);
  x.fillStyle = 'rgba(240,232,214,0.9)';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `700 ${H * 0.028}px ${CAPS}`;
  x.fillText('VHS', x0 + w * 0.2, H * 0.0625);
  x.textAlign = 'right';
  x.font = `600 ${H * 0.02}px ${CAPS}`;
  x.fillText(`No.${String(i + 1).padStart(2, '0')}`, x0 + w * 0.92, H * 0.0625);
  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  x.fillStyle = '#f2e9d6';
  const fs = fitText(x, title, w * 0.84, H * 0.1, 900);
  x.fillText(title, x0 + w * 0.08, H * 0.24 + fs * 0.35);
  x.fillStyle = hsl(color, 0, 0, 0.12);
  x.font = `600 ${H * 0.024}px ${CAPS}`;
  x.fillText(years, x0 + w * 0.08, H * 0.24 + fs * 0.35 + H * 0.05);
  x.fillStyle = 'rgba(242,233,214,0.78)';
  x.font = `500 ${H * 0.024}px ${BODY}`;
  wrap(x, desc, x0 + w * 0.08, H * 0.4, w * 0.84, H * 0.033, 5);
  x.fillStyle = 'rgba(242,233,214,0.55)';
  x.font = `600 ${H * 0.018}px ${CAPS}`;
  x.fillText('Work · VHS', x0 + w * 0.08, H * 0.95);

  // ---------- 书脊（第 2 栏，朝外）----------
  x0 = at[1]; w = wd[1];
  x.fillStyle = color;
  x.fillRect(x0, 0, w, H);
  x.fillStyle = '#17161a';
  x.fillRect(x0, 0, w, H * 0.07);
  x.fillRect(x0, H * 0.9, w, H * 0.1);
  const ink = lum(color) > 0.45 ? '#16151a' : '#f4ecdc';
  x.fillStyle = ink;
  const end = CJK.test(title) ? vtext(x, title, x0 + w / 2, H * 0.11, H * 0.6, w * 0.62)
    : spineText(x, title, x0 + w / 2, H * 0.1, H * 0.56, w * 0.66, w * 0.6, 900, DISPLAY);
  if (years) {
    x.fillStyle = ink === '#16151a' ? 'rgba(22,21,26,0.7)' : 'rgba(244,236,220,0.75)';
    spineText(x, years, x0 + w / 2, Math.min(end + H * 0.04, H * 0.7), H * 0.18, w * 0.3, w * 0.24, 600, CAPS);
  }
  x.fillStyle = 'rgba(240,232,214,0.9)';
  x.save();
  x.translate(x0 + w / 2, H * 0.95);
  x.rotate(-Math.PI / 2);
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `700 ${w * 0.36}px ${CAPS}`;
  x.fillText('VHS', 0, 0);
  x.restore();

  // ---------- 封底（第 1 栏）----------
  x0 = at[0]; w = wd[0];
  x.fillStyle = '#ebe3d0';
  x.fillRect(x0, 0, w, H);
  x.fillStyle = color;
  x.fillRect(x0, 0, w, H * 0.035);
  x.fillStyle = '#26231f';
  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  fitText(x, title, w * 0.84, H * 0.045, 800);
  x.fillText(title, x0 + w * 0.08, H * 0.11);
  x.font = `500 ${H * 0.023}px ${BODY}`;
  x.fillStyle = 'rgba(38,35,31,0.85)';
  wrap(x, desc, x0 + w * 0.08, H * 0.17, w * 0.84, H * 0.033, 9);
  x.fillStyle = '#111'; // 条形码
  let bx = x0 + w * 0.08;
  while (bx < x0 + w * 0.5) { const bw = 1.5 + Math.floor(r() * 3) * 1.5; x.fillRect(bx, H * 0.84, bw, H * 0.07); bx += bw + 1.5 + r() * 3; }
  x.font = `600 ${H * 0.016}px ${CAPS}`;
  x.fillStyle = 'rgba(38,35,31,0.7)';
  x.fillText(years ? `© ${years}` : '©', x0 + w * 0.58, H * 0.9);

  // ---------- 背脊（第 4 栏，朝里）、里面（第 5 栏）----------
  x.fillStyle = '#1d1c20';
  x.fillRect(at[3], 0, wd[3], H);
  x.fillStyle = color;
  x.fillRect(at[3] + wd[3] * 0.42, 0, wd[3] * 0.16, H);
  x.fillStyle = '#8a7d68';
  x.fillRect(at[4], 0, wd[4], H);

  // ---------- 旧一点 ----------
  for (let k = 0; k < 4; k++) { // 每栏的边（纸盒的棱）磨白
    const g = x.createLinearGradient(at[k], 0, at[k] + wd[k], 0);
    g.addColorStop(0, 'rgba(235,225,205,0.28)');
    g.addColorStop(0.05, 'rgba(235,225,205,0)');
    g.addColorStop(0.95, 'rgba(235,225,205,0)');
    g.addColorStop(1, 'rgba(235,225,205,0.28)');
    x.fillStyle = g;
    x.fillRect(at[k], 0, wd[k], H);
  }
  for (const yy of [0, H]) { // 上下两头也磨白
    const g = x.createLinearGradient(0, yy, 0, yy === 0 ? H * 0.03 : H * 0.97);
    g.addColorStop(0, 'rgba(235,225,205,0.35)');
    g.addColorStop(1, 'rgba(235,225,205,0)');
    x.fillStyle = g;
    x.fillRect(0, yy === 0 ? 0 : H * 0.97, W, H * 0.03);
  }
  x.lineCap = 'round';
  for (let k = 0; k < 26; k++) { // 擦痕
    x.strokeStyle = `rgba(240,232,214,${0.06 + r() * 0.12})`;
    x.lineWidth = 0.8 + r() * 1.6;
    const sx = r() * W, sy = r() * H, a = r() * Math.PI, l = 8 + r() * 40;
    x.beginPath();
    x.moveTo(sx, sy);
    x.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l);
    x.stroke();
  }
  for (let k = 0; k < 2; k++) { // 折痕
    const y = H * (0.2 + r() * 0.6);
    x.strokeStyle = 'rgba(250,244,230,0.18)';
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(at[0], y);
    x.lineTo(at[4], y + (r() - 0.5) * 20);
    x.stroke();
  }
  x.fillStyle = 'rgba(150,110,40,0.07)'; // 一点点发黄
  x.fillRect(0, 0, W, H);
  return c;
}

export function dressSleeves(room, tapes) {
  // 字体（css/style.css 的 @font-face）要先加载好，canvas 才画得出来；没加载成功就用后备字体
  const fonts = ['900 40px "Playfair Display"', '700 20px "Cinzel"', '500 20px "EB Garamond"'];
  return Promise.all(fonts.map((f) => document.fonts?.load(f).catch(() => null))).then(() => paintAll(room, tapes));
}
function paintAll(room, tapes) {
  const S = room.manifest.tapes?.sleeve;
  const n = room.manifest.tapes?.count ?? 0;
  for (let i = 0; i < n; i++) {
    const meshes = room.byMat.get('sleeve' + i) || [];
    const t = tapes[i];
    if (!t || !S) { for (const m of meshes) m.visible = !!S && !!t; continue; }
    const tex = new THREE.CanvasTexture(paintSleeve(t, i, S.cols, S.len));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.flipY = false; // glTF 的 UV 约定
    for (const m of meshes) {
      const mat = room.material(new THREE.Color(0.82, 0.82, 0.82), { map: tex, uv1: !!m.geometry.attributes.uv1 });
      mat.name = m.material.name;
      m.material.dispose?.();
      m.material = mat;
    }
  }
}
