// 旧电脑的屏幕：绿色荧光终端，把"关于我"的文字一个字一个字打出来，可以滚动。
import * as THREE from 'three';
import { wrap, makeCanvas, scanlines, MONO } from './tapes/util.js';

export class PCScreen {
  // 排版按 512 × 384 定（16px 字、22px 行高、15 行）；canvas 按 k 倍画，屏幕大、镜头凑近时字也清楚
  constructor({ name, tagline, about }, W = 1024, H = 768) {
    const k = W / 512;
    Object.assign(this, { W, H, k, pad: 20 * k, lh: 22 * k });
    this.canvas = makeCanvas(W, H);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.scan = scanlines(512, 384, 0.22); // 扫描线按原来的疏密，画的时候放大
    this.font = `${16 * k}px ${MONO}`;
    this.ctx.font = this.font;
    const maxW = W - this.pad * 2;
    const src = [
      `${(name || 'GUEST').toUpperCase()} PC · 640K OK`, '',
      'C:\\> TYPE ABOUT.TXT', '',
      ...(tagline ? [tagline, ''] : []),
      ...about.flatMap((p) => [p, '']),
    ];
    this.lines = src.flatMap((l) => (l ? wrap(this.ctx, l, maxW) : ['']));
    this.lines.push('C:\\> ');
    this.total = this.lines.reduce((n, l) => n + l.length + 1, 0);
    this.rows = Math.floor((H - this.pad * 2) / this.lh);
    this.typed = 0;
    this.active = false;
    this.scroll = 0;
    this.follow = true;
    this.acc = 1;
  }

  setActive(on) { this.active = on; }
  finish() { this.typed = this.total; }

  shown() {
    if (this.typed <= 0) return [this.lines[0], '', 'C:\\> '];
    let left = Math.floor(this.typed);
    const out = [];
    for (const l of this.lines) {
      if (left <= 0) break;
      out.push(l.slice(0, left));
      left -= l.length + 1;
    }
    return out;
  }

  scrollBy(n) {
    const max = Math.max(0, this.shown().length - this.rows);
    this.scroll = Math.min(max, Math.max(0, this.scroll + n));
    this.follow = this.scroll >= max;
  }

  update(t, dt) {
    if (this.active && this.typed < this.total) this.typed = Math.min(this.total, this.typed + dt * 120);
    this.acc += dt;
    if (this.acc < 1 / 30) return; // 终端 30 帧够了
    this.acc = 0;
    const { ctx, W, H, k, pad, lh } = this;
    const lines = this.shown();
    const max = Math.max(0, lines.length - this.rows);
    if (this.follow) this.scroll = max;
    this.scroll = Math.min(this.scroll, max);

    ctx.fillStyle = '#03130a';
    ctx.fillRect(0, 0, W, H);
    ctx.font = this.font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#5dff93';
    ctx.shadowColor = 'rgba(60,255,130,0.7)';
    ctx.shadowBlur = 6 * k;
    const vis = lines.slice(this.scroll, this.scroll + this.rows);
    vis.forEach((l, i) => ctx.fillText(l, pad, pad + i * lh));
    if (Math.floor(t * 2.2) % 2 === 0) {
      const last = vis.length - 1;
      if (this.scroll + last === lines.length - 1) {
        const x = pad + ctx.measureText(vis[last] || '').width;
        ctx.fillRect(x + k, pad + last * lh + 2 * k, 9 * k, 16 * k);
      }
    }
    ctx.shadowBlur = 0;
    if (max > 0) {
      const h = (H - pad * 2) * (this.rows / lines.length);
      const y = pad + (H - pad * 2 - h) * (this.scroll / max);
      ctx.fillStyle = 'rgba(93,255,147,0.35)';
      ctx.fillRect(W - 8 * k, y, 3 * k, h);
    }
    ctx.drawImage(this.scan, 0, 0, W, H);
    this.texture.needsUpdate = true;
  }
}
