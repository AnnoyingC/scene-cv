// 用代码画的贴图：记事本纸面、塔楼书桌上的羊皮纸（都写联系方式）。
import { makeCanvas } from './tapes/util.js';

const HAND = '"Bradley Hand","Segoe Print","Kaiti SC","STKaiti","KaiTi","Kaiti TC",cursive';
const PAPER = '#ddd5c2'; // 和 bake_room.py 里 notepad 材质的颜色一致，贴花边缘看不出接缝

// 横线本：标题 + 每条联系方式一行，最下面署名。纸面比例 15 × 21 厘米。
export function paintNote({ name, links }, W = 512, H = 717) {
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = PAPER;
  x.fillRect(0, 0, W, H);
  const top = 150, gap = 52;
  x.strokeStyle = 'rgba(70,110,170,0.32)';
  x.lineWidth = 2;
  for (let y = top; y < H - 20; y += gap) {
    x.beginPath();
    x.moveTo(0, y);
    x.lineTo(W, y);
    x.stroke();
  }
  x.strokeStyle = 'rgba(190,60,60,0.35)';
  x.beginPath();
  x.moveTo(62, 0);
  x.lineTo(62, H);
  x.stroke();

  x.save();
  x.rotate(-0.012);
  x.fillStyle = '#1f3b6e'; // 和桌上那支笔一个颜色
  x.textBaseline = 'alphabetic';
  x.font = `bold 44px ${HAND}`;
  x.fillText('联系我 ✎', 80, top + gap - 12);
  const fit = (s, maxW, size) => {
    do { x.font = `${size}px ${HAND}`; } while (x.measureText(s).width > maxW && --size > 16);
  };
  // 桌上那支笔斜压在纸的右侧（约 0.85 宽度以外），字都写在它左边
  const right = W * 0.84;
  links.forEach((l, i) => {
    const y = top + gap * (i + 2) - 12;
    const handle = l.handle || l.url.replace(/^https?:\/\//, '').replace(/^mailto:/, '');
    fit(l.label, 140, 32);
    x.fillText(l.label, 80, y);
    fit(handle, right - 230, 30);
    x.fillText(handle, 230, y);
  });
  if (name) {
    x.font = `30px ${HAND}`;
    x.textAlign = 'right';
    x.fillText(`— ${name}`, right, top + gap * (links.length + 3) - 12);
  }
  x.restore();
  return c;
}

// 羊皮纸：纸色和 bake_tower.py 里 parchment 材质一致，边缘做旧发暗；墨水字。红色火漆印是 3D 模型，在纸外面。
// 纸面 30 × 40 厘米。鹅毛笔和墨水瓶在纸的右上方，所以字靠左写。
export const PARCHMENT = '#d9c49a';
export function paintParchment({ name, links }, W = 512, H = 683) {
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = PARCHMENT;
  x.fillRect(0, 0, W, H);
  // 做旧：几块淡淡的污渍 + 四周发暗
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const px = rnd() * W, py = rnd() * H, r = 20 + rnd() * 90;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(120,85,40,${0.05 + rnd() * 0.07})`);
    g.addColorStop(1, 'rgba(120,85,40,0)');
    x.fillStyle = g;
    x.fillRect(px - r, py - r, r * 2, r * 2);
  }
  const v = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.62);
  v.addColorStop(0, 'rgba(90,60,25,0)');
  v.addColorStop(1, 'rgba(90,60,25,0.42)');
  x.fillStyle = v;
  x.fillRect(0, 0, W, H);

  const ink = '#2a1c12';
  x.fillStyle = ink;
  x.textBaseline = 'alphabetic';
  const fit = (s, maxW, size, bold = '') => {
    do { x.font = `${bold}${size}px ${HAND}`; } while (x.measureText(s).width > maxW && --size > 14);
  };
  const left = 56, right = W * 0.78;
  x.save();
  x.rotate(0.008);
  fit('寄信给我', right - left, 50, 'bold ');
  x.fillText('寄信给我', left, 118);
  // 标题下一道手画的墨线
  x.strokeStyle = 'rgba(42,28,18,0.75)';
  x.lineWidth = 2.5;
  x.beginPath();
  x.moveTo(left, 136);
  x.bezierCurveTo(left + 120, 130, left + 220, 142, right, 134);
  x.stroke();
  const top = 205, gap = Math.min(70, (H - 330) / Math.max(1, links.length));
  links.forEach((l, i) => {
    const y = top + gap * i;
    const handle = l.handle || l.url.replace(/^https?:\/\//, '').replace(/^mailto:/, '');
    x.fillStyle = 'rgba(42,28,18,0.6)';
    fit(l.label, 150, 26);
    x.fillText(l.label, left, y);
    x.fillStyle = ink;
    fit(handle, W - left - 40, 32);
    x.fillText(handle, left, y + 32);
  });
  if (name) {
    fit(`— ${name}`, right - left, 34);
    x.textAlign = 'right';
    x.fillText(`— ${name}`, right, H - 92);
  }
  x.restore();
  return c;
}
