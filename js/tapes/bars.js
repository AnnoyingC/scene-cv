// 彩条测试图 + 标题卡 + 时间码。
import { wrap, FONT, MONO } from './util.js';

const TOP = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
const MID = ['#0000c0', '#111111', '#c000c0', '#111111', '#00c0c0', '#111111', '#c0c0c0'];
const pad = (n) => String(n).padStart(2, '0');

export default {
  mount({ ctx, width: W, height: H, tape }) {
    ctx.font = `15px ${FONT}`;
    const lines = wrap(ctx, tape.desc, W - 48).slice(0, 2);
    return {
      frame(t) {
        const bw = W / 7, h1 = H * 0.42, h2 = H * 0.06, y0 = h1 + h2;
        TOP.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(Math.floor(i * bw), 0, Math.ceil(bw) + 1, h1); });
        MID.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(Math.floor(i * bw), h1, Math.ceil(bw) + 1, h2); });
        ctx.fillStyle = '#0d0d14';
        ctx.fillRect(0, y0, W, H - y0);
        ctx.fillStyle = tape.color;
        ctx.fillRect(24, y0 + 18, 6, 64);
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#fff';
        ctx.font = `bold 32px ${FONT}`;
        ctx.fillText(tape.title, 42, y0 + 16, W - 66);
        ctx.font = `17px ${FONT}`;
        ctx.fillStyle = '#9aa3b5';
        ctx.fillText(tape.years, 42, y0 + 58);
        ctx.font = `15px ${FONT}`;
        ctx.fillStyle = '#d6d9e2';
        lines.forEach((l, i) => ctx.fillText(l, 24, y0 + 100 + i * 21));
        const s = Math.floor(t);
        ctx.font = `bold 16px ${MONO}`;
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'right';
        ctx.fillText(`${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(Math.floor((t % 1) * 25))}`, W - 20, H - 30);
        ctx.textAlign = 'left';
        const yb = ((t * 60) % (H + 40)) - 40;
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(0, yb, W, 40);
      },
    };
  },
};
