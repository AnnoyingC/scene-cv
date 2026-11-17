// 用代码画的贴图：书桌上记事本的纸面（写联系方式）。
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
  const toText = x.getTransform().inverse(), linkAreas = [];
  x.fillStyle = '#1f3b6e'; // 和桌上那支笔一个颜色
  x.textBaseline = 'alphabetic';
  x.font = `bold 44px ${HAND}`;
  x.fillText('Contact me', 80, top + gap - 12);
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
    linkAreas.push({ left: 74, right, top: y - 36, bottom: y + 8, link: l });
  });
  if (name) {
    x.font = `30px ${HAND}`;
    x.textAlign = 'right';
    x.fillText(`— ${name}`, right, top + gap * (links.length + 3) - 12);
  }
  x.restore();
  // 用画字时的坐标记录点击区域，纸面外观和排版不变。UV 的原点在左下，canvas 在左上。
  c.linkAt = (u, v) => {
    const px = u * W, py = (1 - v) * H;
    const tx = toText.a * px + toText.c * py + toText.e;
    const ty = toText.b * px + toText.d * py + toText.f;
    return linkAreas.find((a) => tx >= a.left && tx <= a.right && ty >= a.top && ty <= a.bottom)?.link || null;
  };
  return c;
}
