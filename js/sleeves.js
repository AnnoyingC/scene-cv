// 录像带的纸盒包装（js/room.js 用）：架子上每盘录像带套着一个纸盒（烘焙的 sleeve0 …），这里按 index.html #work 里的作品
// 给纸盒画包装：书脊朝外（竖排的名字 + 一条作品颜色），封面是老式租赁录像带那种（黑底、斜着的彩条、大字的名字），
// 封底是米色的纸，印着简介和一个条形码；最后整张旧一点：边上磨白、几道折痕、一点点发黄。
// joinSleeves 把纸盒和里面的带子合成一整盒（一起抽出、一起飞进录像机），并补上纸盒上口和指扣缺口。
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
  // 从头到尾都是作品颜色：上下不留黑边（黑边看上去像彩色纸片后面露出一截黑色的带子，盒子就不像一整个了）
  x0 = at[1]; w = wd[1];
  x.fillStyle = color;
  x.fillRect(x0, 0, w, H);
  const ink = lum(color) > 0.45 ? '#16151a' : '#f4ecdc';
  x.fillStyle = ink;
  const end = CJK.test(title) ? vtext(x, title, x0 + w / 2, H * 0.11, H * 0.6, w * 0.62)
    : spineText(x, title, x0 + w / 2, H * 0.1, H * 0.56, w * 0.66, w * 0.6, 900, DISPLAY);
  if (years) {
    x.fillStyle = ink === '#16151a' ? 'rgba(22,21,26,0.7)' : 'rgba(244,236,220,0.75)';
    spineText(x, years, x0 + w / 2, Math.min(end + H * 0.04, H * 0.7), H * 0.18, w * 0.3, w * 0.24, 600, CAPS);
  }
  x.fillStyle = ink === '#16151a' ? 'rgba(22,21,26,0.62)' : 'rgba(244,236,220,0.7)';
  x.save();
  x.translate(x0 + w / 2, H * 0.94);
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
  // 都是作品颜色（稍暗）：盒子飞进录像机时转过来看得见背脊；"里面"那栏也是上口那圈纸边和盖子（joinSleeves）的颜色
  x.fillStyle = hsl(color, 0, -0.05, -0.08);
  x.fillRect(at[3], 0, wd[3], H);
  x.fillStyle = hsl(color, 0, -0.04, -0.05);
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

// 纸盒和里面的带子合成一整盒（js/room.js 用，要在 dressSleeves 之前调）：纸盒挂到 takeTapes 拆出来的那个 Group 上，
// 悬停时整盒往上抽出一截、点了整盒飞进录像机，架子上空出它的位置。
// 烘焙的纸盒上口是开着的，前后两面上沿还各有一个半圆的指扣缺口，从外面看得见里面那盘黑色的带子，像是"彩色的纸套在一盘黑带子前面"。
// 这里给每个纸盒补上顶盖、把两个缺口补平（capFor），里面的带子就看不见了，干脆藏起来（它本来就整个装在纸盒里）
export function joinSleeves(room, taken) {
  taken.forEach((t, i) => {
    const sleeves = room.byMat.get('sleeve' + i);
    if (!t || !sleeves?.length) return;
    const cap = capFor(sleeves[0]);
    if (cap) {
      room.scene.add(cap);
      sleeves.push(cap); // 记在 sleeve{i} 名下：dressSleeves 给它换上画好的包装
      for (const m of t.parts) m.visible = false;
    }
    for (const m of sleeves) t.group.attach(m);
    t.parts.push(...sleeves);
  });
  return taken;
}

// 盖子 + 补缺口，一个网格三块平面（世界坐标；架子没转过，纸盒的包围盒就是它的外形）：
//   - 顶盖：最上沿往下 0.4 毫米，纸边压在它外面一圈。颜色是"里面"那栏（取上沿朝上的纸边的 UV）
//   - 前后两面的缺口：贴着外表面往里 0.3 毫米竖一块，纸盒的外表面挡住它，只在缺口那里露出来。
//     颜色贴图坐标按那一面上最大的三角形外推（纸盒那一面的 UV 是 x、y 的一次函数，外推是准的），书脊上的字和颜色接得上
//   - 光照（uv1）每块一个值：取那一面上缺口正下方几毫米处的烘焙光（顶盖用前面的，看上去和书脊顶上一样亮）
function capFor(sleeve) {
  const g = sleeve.geometry, P = g.attributes.position, UV = g.attributes.uv, UV1 = g.attributes.uv1;
  if (!UV) return null;
  sleeve.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(sleeve), mid = box.getCenter(new THREE.Vector3()), top = box.max.y;
  const idx = g.index ? g.index.array : [...Array(P.count).keys()];
  const tris = [];
  for (let t = 0; t < idx.length; t += 3) {
    const ids = [idx[t], idx[t + 1], idx[t + 2]];
    const pts = ids.map((i) => new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(sleeve.matrixWorld));
    const n = new THREE.Vector3().crossVectors(pts[1].clone().sub(pts[0]), pts[2].clone().sub(pts[0]));
    const area = n.length() / 2;
    if (area < 1e-8) continue;
    tris.push({ ids, pts, n: n.normalize(), area, c: pts[0].clone().add(pts[1]).add(pts[2]).divideScalar(3) });
  }
  // 三角形里 (x, y) 处的重心坐标（朝 ±z 的面用）；clamp = 落到三角形外面时拉回三角形里
  const bary = ([A, B, C], x, y, clamp = false) => {
    const ax = B.x - A.x, ay = B.y - A.y, bx = C.x - A.x, by = C.y - A.y, px = x - A.x, py = y - A.y, d = ax * by - bx * ay;
    let v = (px * by - bx * py) / d, w = (ax * py - px * ay) / d, u = 1 - v - w;
    if (clamp) { [u, v, w] = [u, v, w].map((k) => Math.max(0, k)); const s = u + v + w; u /= s; v /= s; w /= s; }
    return [u, v, w];
  };
  const at = (attr, t, wt) => [0, 1].map((k) => t.ids.reduce((s, id, j) => s + wt[j] * (k ? attr.getY(id) : attr.getX(id)), 0));
  const dist = (t, x, y) => { const wt = bary(t.pts, x, y, true); return Math.hypot(t.pts.reduce((s, p, j) => s + wt[j] * p.x, 0) - x, t.pts.reduce((s, p, j) => s + wt[j] * p.y, 0) - y); };
  const W = box.max.x - box.min.x, d = 0.0002;
  const pos = [], uv = [], uv1 = [], index = [];
  const quad = (corners, uvs, l1, flip) => {
    const k = pos.length / 3;
    corners.forEach((p, j) => { pos.push(...p); uv.push(...uvs[j]); uv1.push(...l1); });
    index.push(...(flip ? [k, k + 2, k + 1, k, k + 3, k + 2] : [k, k + 1, k + 2, k, k + 2, k + 3]));
  };
  let topLight = null;
  for (const s of [1, -1]) { // 前面（书脊，+z）、后面（背脊，-z）
    const face = tris.filter((t) => t.n.z * s > 0.95 && (t.c.z - mid.z) * s > 0);
    if (!face.length) continue;
    // 缺口有多深：这一面中间那一截外表面最高到哪
    let reach = -Infinity;
    for (const t of face) for (const p of t.pts) if (Math.abs(p.x - mid.x) < W * 0.25) reach = Math.max(reach, p.y);
    const depth = top - reach, sy = top - Math.max(depth, 0) - 0.004;
    const near = face.reduce((a, t) => (dist(t, mid.x, sy) < dist(a, mid.x, sy) ? t : a));
    const l1 = UV1 ? at(UV1, near, bary(near.pts, mid.x, sy, true)) : [0, 0];
    if (s > 0) topLight = l1;
    if (!(depth > 0.001)) continue; // 这一面没有缺口
    const big = face.reduce((a, t) => (t.area > a.area ? t : a));
    const z = (s > 0 ? box.max.z : box.min.z) - s * 0.0003, y0 = reach - 0.001, y1 = top - 0.0004;
    const corners = [[box.min.x + d, y0, z], [box.max.x - d, y0, z], [box.max.x - d, y1, z], [box.min.x + d, y1, z]];
    quad(corners, corners.map(([x, y]) => at(UV, big, bary(big.pts, x, y))), l1, s < 0);
  }
  // 顶盖的颜色：上沿朝上的纸边里最大的一个三角形的 UV（落在"里面"那栏）
  const rim = tris.filter((t) => t.n.y > 0.9 && Math.min(...t.pts.map((p) => p.y)) > top - 0.002);
  if (!rim.length) return null;
  const r = rim.reduce((a, t) => (t.area > a.area ? t : a)), ruv = at(UV, r, [1 / 3, 1 / 3, 1 / 3]);
  const y = top - 0.0004;
  quad([[box.min.x + d, y, box.min.z + d], [box.max.x - d, y, box.min.z + d], [box.max.x - d, y, box.max.z - d], [box.min.x + d, y, box.max.z - d]],
    [ruv, ruv, ruv, ruv], topLight || at(UV1 || UV, r, [1 / 3, 1 / 3, 1 / 3]), true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (UV1) geo.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  geo.setIndex(index);
  const cap = new THREE.Mesh(geo, sleeve.material);
  cap.name = sleeve.name + '_cap';
  return cap;
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
