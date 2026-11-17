// 节目带里"代码画的动画"章节（js/tapes/show.js 的 type: "anim"）。每个动画是一个函数：
//   (ctx, t, dur, { tape, c, tr, lang, media, cover, contain, tracking }) → 画这一章第 t 秒的一帧；画布按 512 × 384 排版
//     tape     这盘带子（tape.color 是 index.html 里的 data-color）
//     c        节目单里的这一章（可以在里面放自己的字段）；tr(v) 把 { zh, en } 按页面语言取出来
//     media    这一章 media 里列的图 / 视频；cover / contain 把它们铺满 / 放进一个框里；tracking 画一段没信号的雪花
// 写好以后在最下面注册，节目单里写 { "type": "anim", "anim": "名字", "dur": 秒数 }。
// 名字找不到时这一章显示雪花，不会报错。
import { FONT, MONO } from './util.js';

const W = 512, H = 384;
const clamp01 = (k) => Math.min(1, Math.max(0, k));
const out = (k) => 1 - Math.pow(1 - clamp01(k), 3);

// 例子：柱子一根根长出来，最后一根用带子的颜色。c.bars 是数字（0–100），c.labels 是柱子下面的字
function sampleChart(ctx, t, dur, { tape, c, tr }) {
  ctx.fillStyle = '#0f1416';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e8eef2';
  ctx.font = `700 22px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(tr(c.heading) || '', 32, 52);
  const bars = c.bars || [30, 45, 60, 85], labels = (c.labels || []).map(tr);
  const gap = 18, bw = (W - 64 - gap * (bars.length - 1)) / bars.length, base = 318;
  bars.forEach((v, i) => {
    const k = out((t - 0.4 - i * 0.35) / 1.2), h = (base - 96) * (v / 100) * k, x = 32 + i * (bw + gap);
    ctx.fillStyle = i === bars.length - 1 ? tape.color || '#e8b04a' : 'rgba(232,238,242,0.28)';
    ctx.fillRect(x, base - h, bw, h);
    ctx.fillStyle = '#e8eef2';
    ctx.font = `600 15px ${MONO}`;
    ctx.textAlign = 'center';
    if (k > 0.05) ctx.fillText(String(Math.round(v * k)), x + bw / 2, base - h - 10);
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = 'rgba(232,238,242,0.7)';
    ctx.fillText(labels[i] || '', x + bw / 2, base + 24);
  });
}

export default {
  'sample-chart': sampleChart,
};
