// 屏保风格：标题在屏幕里弹来弹去，碰边就换颜色。
import { wrap, FONT } from './util.js';

export default {
  mount({ ctx, width: W, height: H, tape }) {
    ctx.font = `bold 38px ${FONT}`;
    const bw = Math.min(W - 40, ctx.measureText(tape.title).width + 36), bh = 64, floor = H - 80;
    ctx.font = `15px ${FONT}`;
    const lines = wrap(ctx, tape.desc, W - 40).slice(0, 2);
    let x = 30, y = 40, vx = 110, vy = 80, hue = 200;
    return {
      frame(t, dt) {
        x += vx * dt;
        y += vy * dt;
        if (x < 0) { x = 0; vx = Math.abs(vx); hue += 70; }
        if (x + bw > W) { x = W - bw; vx = -Math.abs(vx); hue += 70; }
        if (y < 0) { y = 0; vy = Math.abs(vy); hue += 70; }
        if (y + bh > floor) { y = floor - bh; vy = -Math.abs(vy); hue += 70; }

        ctx.fillStyle = '#06060c';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = `hsl(${hue % 360} 85% 62%)`;
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, 12);
        ctx.fill();
        ctx.fillStyle = '#06060c';
        ctx.font = `bold 38px ${FONT}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(tape.title, x + bw / 2, y + bh / 2 + 1, bw - 24);
        ctx.textAlign = 'left';

        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(0, floor, W, 1);
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#c9cbd6';
        ctx.font = `16px ${FONT}`;
        ctx.fillText(tape.years, 20, floor + 12);
        ctx.fillStyle = '#8f93a3';
        ctx.font = `15px ${FONT}`;
        lines.forEach((l, i) => ctx.fillText(l, 20, floor + 36 + i * 19));
      },
    };
  },
};
