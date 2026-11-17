// 合成器波风格：条纹太阳 + 向前滚动的透视网格。
import { FONT } from './util.js';

export default {
  mount({ ctx, width: W, height: H, tape }) {
    const hz = H * 0.58, cx = W / 2;
    return {
      frame(t) {
        const sky = ctx.createLinearGradient(0, 0, 0, hz);
        sky.addColorStop(0, '#0c0221');
        sky.addColorStop(1, '#ff2e88');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, hz);

        const cy = hz - 4, R = 92;
        const sun = ctx.createLinearGradient(0, cy - R, 0, cy);
        sun.addColorStop(0, '#ffe66d');
        sun.addColorStop(1, '#ff4f9a');
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, Math.PI, 0);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = sun;
        ctx.fillRect(cx - R, cy - R, R * 2, R);
        ctx.fillStyle = sky; // 用天空的渐变挖条纹，颜色无缝
        for (let i = 0; i < 6; i++) ctx.fillRect(cx - R, cy - R * 0.55 + i * 11 + ((t * 10) % 11), R * 2, 2 + i * 0.9);
        ctx.restore();

        ctx.fillStyle = '#12021f';
        ctx.fillRect(0, hz, W, H - hz);
        ctx.strokeStyle = 'rgba(255,60,190,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = -10; i <= 10; i++) { ctx.moveTo(cx + i * 6, hz); ctx.lineTo(cx + i * 90, H); }
        for (let i = 0; i < 12; i++) {
          const z = (i + ((t * 1.2) % 1)) / 12, y = hz + (H - hz) * z * z;
          ctx.moveTo(0, y);
          ctx.lineTo(W, y);
        }
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = `bold 36px ${FONT}`;
        ctx.shadowColor = '#ff2e88';
        ctx.shadowBlur = 14;
        ctx.fillStyle = '#fff';
        ctx.fillText(tape.title, W / 2, 34, W - 40);
        ctx.shadowBlur = 0;
        ctx.font = `17px ${FONT}`;
        ctx.fillStyle = '#ffd1ec';
        ctx.fillText(tape.years, W / 2, 80);
        ctx.textAlign = 'left';
      },
    };
  },
};
