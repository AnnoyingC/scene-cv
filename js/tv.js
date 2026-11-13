// 电视：一块 canvas 当屏幕贴图。播放录像带 = 挂载一个画面模块，每帧画到 canvas 上。
// 每帧还会算出画面的平均颜色，房间里的电视灯用它染色（换一盘蓝色带子，房间就泛蓝）。
// 塔楼的水盆也用它当水面画面：关掉扫描线、屏幕字和雪花（scan / osd / noise = false）。
import * as THREE from 'three';
import PROGRAMS from './tapes/index.js';
import { makeCanvas, scanlines, MONO } from './tapes/util.js';

export class TV {
  constructor(W = 512, H = 384, { scan = true, osd = true, noise = true, warmup = 0.5 } = {}) {
    this.W = W;
    this.H = H;
    this.opts = { scan, osd, noise, warmup };
    this.canvas = makeCanvas(W, H);
    this.ctx = this.canvas.getContext('2d');
    this.prog = makeCanvas(W, H); // 画面模块自己的画布，再合成到屏幕上（这样扫描线不会被拖影累积）
    this.pctx = this.prog.getContext('2d');
    this.noise = makeCanvas(128, 96);
    this.nctx = this.noise.getContext('2d');
    this.nimg = this.nctx.createImageData(128, 96);
    this.scan = scanlines(W, H);
    this.sample = makeCanvas(4, 3);
    this.sctx = this.sample.getContext('2d', { willReadFrequently: true });
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.color = new THREE.Color(0, 0, 0);
    this._c = new THREE.Color();
    this.state = 'off'; // off | static | playing
    this.tape = null;
    this.run = null;
    this.osd = null;
    this.idleDrawn = false;
  }

  play(tape) {
    this.run?.stop?.();
    this.run = null;
    this.tape = tape;
    this.state = 'static';
    this.left = this.opts.warmup;
    this.osd = this.opts.osd ? { text: '▶ PLAY', left: 2.5 } : null;
    this.idleDrawn = false;
  }

  stop() {
    if (this.state === 'off') return;
    this.run?.stop?.();
    this.run = null;
    this.state = 'off';
    this.osd = this.opts.osd ? { text: '■ STOP', left: 1.2 } : null;
    this.idleDrawn = false;
  }

  update(t, dt) {
    const { ctx, W, H } = this;
    if (this.state === 'off' && this.idleDrawn && !this.osd) {
      this.color.multiplyScalar(Math.exp(-dt * 10));
      return;
    }
    if (this.state === 'static') {
      this.left -= dt;
      this.drawStatic();
      if (this.left <= 0) {
        const P = PROGRAMS[this.tape.kind] || PROGRAMS.bars;
        this.pctx.setTransform(1, 0, 0, 1, 0, 0);
        this.pctx.clearRect(0, 0, W, H);
        this.run = P.mount({ canvas: this.prog, ctx: this.pctx, width: W, height: H, tape: this.tape });
        this.state = 'playing';
        this.t0 = t;
      }
    }
    if (this.state === 'playing') {
      this.pctx.save();
      this.run.frame(t - this.t0, dt);
      this.pctx.restore();
      ctx.drawImage(this.prog, 0, 0);
    } else if (this.state === 'off') {
      ctx.fillStyle = '#07090a';
      ctx.fillRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, 'rgba(255,255,255,0.06)');
      g.addColorStop(0.5, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      this.idleDrawn = true;
    }
    if (this.state !== 'off' && this.opts.scan) ctx.drawImage(this.scan, 0, 0);
    if (this.osd) {
      this.osd.left -= dt;
      if (this.osd.left <= 0) this.osd = null;
      else {
        ctx.font = `bold 26px ${MONO}`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#000';
        ctx.fillText(this.osd.text, 26, 24);
        ctx.fillStyle = '#7dff7d';
        ctx.fillText(this.osd.text, 24, 22);
      }
    }
    this.texture.needsUpdate = true;

    // 画面平均色 → 电视灯颜色
    this.sctx.drawImage(this.canvas, 0, 0, 4, 3);
    const d = this.sctx.getImageData(0, 0, 4, 3).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = (d.length / 4) * 255;
    if (this.state === 'off') this._c.setRGB(0, 0, 0);
    else this._c.setRGB(r / n, g / n, b / n, THREE.SRGBColorSpace);
    this.color.lerp(this._c, 1 - Math.exp(-dt * 10));
  }

  drawStatic() {
    if (!this.opts.noise) { // 水面：慢慢暗下去，等新画面浮上来
      this.ctx.fillStyle = 'rgba(4,8,14,0.25)';
      this.ctx.fillRect(0, 0, this.W, this.H);
      return;
    }
    const d = this.nimg.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    this.nctx.putImageData(this.nimg, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.noise, 0, 0, this.W, this.H);
    this.ctx.imageSmoothingEnabled = true;
  }
}
