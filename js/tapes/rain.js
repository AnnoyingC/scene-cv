// 字符雨 + 中间的标题卡。
import { FONT, MONO } from './util.js';

export default {
  mount({ ctx, width: W, height: H, tape }) {
    const size = 16, cols = Math.ceil(W / size);
    const drops = Array.from({ length: cols }, () => Math.random() * -30);
    const glyphs = [...('01アイウエオカキクケコサシスセソタチツテト' + tape.title.replace(/\s/g, ''))];
    let acc = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    return {
      frame(t, dt) {
        acc += dt;
        if (acc < 1 / 24) return; // 字符雨 24 帧就够了
        acc = 0;
        ctx.fillStyle = 'rgba(0,6,2,0.16)';
        ctx.fillRect(0, 0, W, H);
        ctx.font = `bold ${size}px ${MONO}`;
        ctx.textBaseline = 'top';
        for (let i = 0; i < cols; i++) {
          const y = drops[i] * size;
          ctx.fillStyle = Math.random() < 0.08 ? '#eaffea' : '#2bff6a';
          ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * size, y);
          drops[i] = y > H && Math.random() > 0.97 ? 0 : drops[i] + 1;
        }
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(40, H / 2 - 50, W - 80, 100);
        ctx.strokeStyle = '#2bff6a';
        ctx.lineWidth = 2;
        ctx.strokeRect(40, H / 2 - 50, W - 80, 100);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#b9ffcc';
        ctx.font = `bold 32px ${FONT}`;
        ctx.fillText(tape.title, W / 2, H / 2 - 36, W - 110);
        ctx.font = `16px ${FONT}`;
        ctx.fillStyle = '#5ee88a';
        ctx.fillText(tape.years, W / 2, H / 2 + 12);
        ctx.textAlign = 'left';
      },
    };
  },
};
