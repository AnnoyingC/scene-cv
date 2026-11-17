// 节目带：一盘录像带是一档几十秒的小节目，一章一章地放，放完从头再来。
// 节目单是一个 JSON（assets/tapes/<名字>/show.json），index.html #work 的 li 写 data-tape="show" data-show="节目单的路径"。
// 章节种类（type）：
//   title    片头卡：和纸盒封面一个样子（黑底、斜着的彩条、大字的带子名字），kicker 是上面一行小字，line 是名字下面一行；
//            cover 是封面的底纹：一张图的路径，或者 { "anim": 动画名, "t": 第几秒 }（拿那段动画的一帧）；压暗以后垫在彩条和字下面。图缺了就是纯黑底。
//            { "logo": 图的路径 }：不当底纹，原样放在右上角（公司 logo 这类）
//   anim     代码画的动画，anim 是名字（见 js/tapes/anims.js）；rate 是快放几倍（dur 写实际放的秒数）
//   number   数字卡：items = [{ value: "85%+", label }]，数字从 0 数上去；写了 from（"18.6%"）就从 from 数到 value
//   image    一张图，慢慢推近：src，label 是左上角的小字
//   wipe     前后对比：一条竖线从左扫到右，扫过的地方换成 after：before / after，labels = [前, 后]
//   split    左右分屏：left / right（各是 { src, label }，src 可以是图或视频）
//   video    一段视频：src 写一个或几个（mp4 / webm），静音循环；label 是左上角的小字（真机实拍写清楚），speed 是快放了几倍（标在旁边），
//            fit: "contain" 时整个画面放进来、上下留黑边（宽银幕的素材），默认铺满裁掉
//   compare  左右对比：上面打出指令 prompt（kicker 是上面一行小字），中间 left / right 两段视频，
//            到 reveal 秒亮出两边的判定 verdict（ok: true 打勾、加一圈带子颜色的框，false 打叉）
//   end      片尾卡：line 是一行总结；也可以有 cover
// anim 章节也可以带 media（一组图 / 视频的路径），画的时候按顺序交给动画；hold: true 时视频放完停在最后一帧（compare 默认这样）。
// 一章用到的图 / 视频加载失败（比如只在本地的素材，公开仓库里没有）：这一章直接跳过。
// 每章 dur 是秒数；sub 是这一章的字幕（js/room.js 显示在电视下面）；tag: true 时左下角标"示意动画"。
// 写给人看的字段都可以写成 { "zh": …, "en": … }，按 <html lang> 选。图、视频的路径相对节目单。
// 画面按 512 × 384 排版，别的尺寸整体缩放。
import { FONT, MONO, wrap } from './util.js';
import ANIMS from './anims.js';

const LW = 512, LH = 384;
const EXPOSURE = '#dedede'; // sRGB 0.87 ≈ 线性 0.73，低于辉光门槛 0.78（白平衡把红色再乘 1.02 也还在下面）
const SERIF = `"Playfair Display", "Songti SC", ${FONT}`, CAPS = `"Cinzel", "Songti SC", ${FONT}`;
const lang = () => ((document.documentElement.lang || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en');
export const tr = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v[lang()] ?? v.en ?? v.zh ?? '' : v ?? '');
const ease = (k) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
const clamp01 = (k) => Math.min(1, Math.max(0, k));

// ---------- 节目单：同一个 URL 只下载一次 ----------
const shows = new Map();
function load(url) {
  if (!shows.has(url)) {
    shows.set(url, fetch(url, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`节目单 ${r.status}`);
      return r.json();
    }).then((s) => {
      const abs = (p) => (p ? new URL(p, url).href : '');
      const srcs = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean).map(abs);
      s.chapters = (s.chapters || []).filter((c) => c.dur > 0).map((c) => ({
        ...c,
        src: c.src && srcs(c.src), before: c.before && srcs(c.before), after: c.after && srcs(c.after),
        left: c.left && { ...c.left, src: srcs(c.left.src) }, right: c.right && { ...c.right, src: srcs(c.right.src) },
        media: c.media && c.media.map(abs),
        cover: c.cover && (typeof c.cover === 'string' || Array.isArray(c.cover) ? srcs(c.cover) : c.cover.logo ? { logo: srcs(c.cover.logo) } : c.cover),
      }));
      return s;
    }));
  }
  return shows.get(url);
}

// ---------- 图和视频 ----------
const isVideo = (u) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u);
function makeMedia(srcs) {
  if (!srcs?.length) return null;
  if (isVideo(srcs[0])) {
    const v = document.createElement('video');
    Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'metadata', crossOrigin: 'anonymous' });
    v.src = srcs.find((s) => v.canPlayType(/\.webm/i.test(s) ? 'video/webm' : 'video/mp4')) || srcs[0];
    return v;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = srcs[0];
  return img;
}
const mediaSize = (m) => (m instanceof HTMLVideoElement ? [m.videoWidth, m.videoHeight] : [m?.naturalWidth || 0, m?.naturalHeight || 0]);
const ready = (m) => (m instanceof HTMLVideoElement ? m.readyState >= 2 : !!m?.complete && m.naturalWidth > 0);
// 铺满 (x, y, w, h)，多出来的裁掉；zoom > 1 往中间推近
function cover(ctx, m, x, y, w, h, zoom = 1) {
  const [mw, mh] = mediaSize(m);
  if (!mw || !ready(m)) return false;
  const s = Math.max(w / mw, h / mh) * zoom, dw = mw * s, dh = mh * s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(m, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
  return true;
}
function contain(ctx, m, x, y, w, h, clear = false) { // 整个画面放进 (x, y, w, h)，空出来的地方是黑的（clear：不填黑，logo 用）；返回画面的上沿
  const [mw, mh] = mediaSize(m);
  if (!mw || !ready(m)) return null;
  const s = Math.min(w / mw, h / mh), dw = mw * s, dh = mh * s;
  if (!clear) { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); }
  ctx.drawImage(m, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  return y + (h - dh) / 2;
}
function tracking(ctx, t, x = 0, y = 0, w = LW, h = LH) { // 还没加载好：录像带对不上磁迹的那种灰条
  ctx.fillStyle = '#101216';
  ctx.fillRect(x, y, w, h);
  for (let i = 0; i < 6; i++) {
    const yy = y + (((t * 90 + i * 71) % h) + h) % h;
    ctx.fillStyle = `rgba(200,205,215,${0.05 + (i % 3) * 0.03})`;
    ctx.fillRect(x, yy, w, 3 + (i % 2) * 5);
  }
}
function label(ctx, text, x, y, align = 'left') { // 角上的小标签
  if (!text) return;
  ctx.font = `700 12px ${FONT}`;
  const w = ctx.measureText(text).width + 14;
  const X = align === 'right' ? x - w : x;
  ctx.fillStyle = 'rgba(8,8,10,0.72)';
  ctx.fillRect(X, y, w, 20);
  ctx.fillStyle = '#f2e9d6';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, X + 7, y + 10.5);
}

// ---------- 章节画法 ----------
function stripes(ctx, color, y0, k, span = 1) { // 纸盒封面上那几道斜彩条（k：从左边划进来的进度；span：最多划到画面宽度的几成）
  const hues = [-0.1, -0.05, 0, 0.05, 0.1];
  hues.forEach((dh, i) => {
    ctx.fillStyle = shift(color, dh, (i - 2) * 0.03);
    const y = y0 + i * 17, reach = -40 + (LW * span + 80) * ease(k * 1.4 - i * 0.08);
    ctx.beginPath();
    ctx.moveTo(-40, y + 70);
    ctx.lineTo(reach, y + 70 - (reach + 40) * 0.27);
    ctx.lineTo(reach, y + 70 - (reach + 40) * 0.27 + 14);
    ctx.lineTo(-40, y + 84);
    ctx.closePath();
    ctx.fill();
  });
}
function shift(color, dh, dl) { // 颜色转一点色相、调一点亮度
  const m = /^#?([\da-f]{6})$/i.exec(color || '') || [0, 'e8b04a'];
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return `hsl(${((h * 60 + dh * 360) % 360 + 360) % 360},${Math.round(s * 100)}%,${Math.round(Math.min(92, Math.max(8, (l + dl) * 100)))}%)`;
}
function fitFont(ctx, text, maxW, size, weight, family) {
  let fs = size;
  ctx.font = `${weight} ${fs}px ${family}`;
  while (fs > 12 && ctx.measureText(text).width > maxW) ctx.font = `${weight} ${(fs -= 2)}px ${family}`;
  return fs;
}
function titleCard(ctx, c, t, tape, end = false, bg = null, badge = null) {
  ctx.fillStyle = '#17161a';
  ctx.fillRect(0, 0, LW, LH);
  const pic = bg ? bg() : false;
  if (pic) { // 有封面图：整张压暗、去掉一点颜色，只当底纹；彩条和字照旧在最上面
    ctx.fillStyle = 'rgba(16,15,19,0.5)';
    ctx.fillRect(0, 0, LW, LH);
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = 'rgba(128,128,128,0.2)';
    ctx.fillRect(0, 0, LW, LH);
    ctx.globalCompositeOperation = 'source-over';
  }
  stripes(ctx, tape.color, end ? 250 : 236, end ? 1 : t / 1.2);
  if (badge) { ctx.globalAlpha = ease((t - 0.2) / 0.6); badge(); ctx.globalAlpha = 1; }
  if (pic) { ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 10; }
  ctx.globalAlpha = ease((t - 0.3) / 0.6);
  ctx.strokeStyle = 'rgba(240,232,214,0.85)'; // 左上角 VHS 小标，和纸盒一样
  ctx.lineWidth = 2;
  ctx.strokeRect(34, 30, 64, 24);
  ctx.fillStyle = '#f2e9d6';
  ctx.textBaseline = 'middle';
  ctx.font = `700 15px ${CAPS}`;
  ctx.fillText('VHS', 47, 43);
  ctx.font = `600 13px ${CAPS}`;
  ctx.fillText(end ? '■ END OF TAPE' : tr(c.kicker), 112, 43);
  ctx.textBaseline = 'alphabetic';
  const name = tape.title || '';
  const fs = fitFont(ctx, name, LW - 68, 64, 900, SERIF);
  ctx.globalAlpha = ease((t - 0.45) / 0.7);
  ctx.fillText(name, 34, 120 + fs * 0.35);
  ctx.font = `600 15px ${CAPS}`;
  ctx.fillStyle = shift(tape.color, 0, 0.12);
  ctx.fillText(tape.years || '', 36, 150 + fs * 0.35);
  ctx.globalAlpha = ease((t - 0.8) / 0.7);
  ctx.fillStyle = 'rgba(242,233,214,0.85)';
  fitFont(ctx, tr(c.line), LW - 72, 19, 500, FONT);
  ctx.fillText(tr(c.line), 36, 182 + fs * 0.35);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}
function parseNum(v) { // "10,000+" → ['', 10000, '+', 千分位, 小数位]
  const m = /^([^\d]*)([\d,]*\.?\d+)(.*)$/.exec(String(v));
  if (!m) return null;
  const dec = (m[2].split('.')[1] || '').length;
  return [m[1], parseFloat(m[2].replace(/,/g, '')), m[3], m[2].includes(','), dec];
}
function numberCard(ctx, c, t, tape) {
  ctx.fillStyle = '#0f1416';
  ctx.fillRect(0, 0, LW, LH);
  const items = (c.items || []).slice(0, 2), n = items.length;
  items.forEach((it, i) => {
    const p = parseNum(tr(it.value)), f = it.from != null ? parseNum(tr(it.from)) : null, k = ease((t - 0.2 - i * 0.35) / 1.6);
    let s = tr(it.value);
    if (p) {
      const v = (f ? f[1] : 0) + (p[1] - (f ? f[1] : 0)) * k;
      s = p[0] + (p[3] ? v.toLocaleString('en-US', { minimumFractionDigits: p[4], maximumFractionDigits: p[4] }) : v.toFixed(p[4])) + (k >= 1 ? p[2] : '');
    }
    const cy = n === 1 ? 190 : 120 + i * 150;
    ctx.globalAlpha = clamp01((t - i * 0.35) / 0.4);
    ctx.textAlign = 'center';
    ctx.fillStyle = i === 0 ? tape.color || '#f2c230' : '#f2e9d6';
    fitFont(ctx, tr(it.value), LW - 40, n === 1 ? 104 : 82, 900, SERIF); // 按最终的字算一次字号，数的时候不跳
    ctx.fillText(s, LW / 2, cy + (n === 1 ? 30 : 22));
    ctx.fillStyle = 'rgba(242,233,214,0.8)';
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(tr(it.label), LW / 2, cy + (n === 1 ? 70 : 54));
    ctx.textAlign = 'left';
  });
  ctx.globalAlpha = 1;
}

// ---------- 节目 ----------
export default {
  mount({ ctx, width, height, tape }) {
    const st = { show: null, err: null, clock: 0, ch: -1, media: new Map(), starts: [], total: 0, bad: new Set(), passes: 0 };
    load(tape.show).then((s) => {
      st.show = s;
      let acc = 0;
      st.starts = s.chapters.map((c) => { const a = acc; acc += c.dur; return a; });
      st.total = acc;
      // 一开始就把每章的图 / 视频建好（视频只读开头的元信息）：哪章的素材缺了，放到之前就知道，直接跳过不闪一下
      s.chapters.forEach((c, i) => keys(c).forEach((k) => media(i, k)));
    }).catch((e) => { st.err = e; console.warn('节目单加载失败', tape.show, e); });

    const media = (i, key) => { // 第 i 章的某个图 / 视频（第一次用到时才建）
      const id = i + ':' + key;
      if (!st.media.has(id)) {
        const c = st.show.chapters[i];
        const v = key === 'left' || key === 'right' ? c[key]?.src : key === 'cover' ? c.cover.logo || c.cover : key[0] === 'm' ? [c.media[Number(key.slice(1))]] : c[key];
        const m = makeMedia(v);
        if (key !== 'cover') m?.addEventListener('error', () => st.bad.add(i)); // 素材缺了：这一章跳过（封面图缺了不跳，用纯黑底）
        st.media.set(id, m);
      }
      return st.media.get(id);
    };
    const keys = (c) => [...['src', 'before', 'after', 'left', 'right'].filter((k) => c[k]), ...(c.media || []).map((_, k) => 'm' + k),
      ...(Array.isArray(c.cover) || c.cover?.logo ? ['cover'] : [])];
    const videos = (i) => keys(st.show.chapters[i]).map((k) => media(i, k)).filter((m) => m instanceof HTMLVideoElement);
    function enter(i) { // 进了第 i 章：它的视频从头放，别的停下；顺手把下一章的图和视频先加载
      st.media.forEach((m, id) => { if (m instanceof HTMLVideoElement && !id.startsWith(i + ':')) m.pause(); });
      const hold = st.show.chapters[i].hold || st.show.chapters[i].type === 'compare';
      for (const v of videos(i)) { v.loop = !hold; v.preload = 'auto'; v.currentTime = 0; v.play().catch(() => {}); }
      for (const k of keys(st.show.chapters[i])) media(i, k); // 图也在这时候建（加载失败就能早点知道）
      const nx = (i + 1) % st.show.chapters.length;
      for (const k of keys(st.show.chapters[nx])) { const m = media(nx, k); if (m instanceof HTMLVideoElement) m.preload = 'auto'; }
    }
    const at = () => { // 现在在第几章、这一章放了多久
      let i = st.starts.length - 1;
      while (i > 0 && st.starts[i] > st.clock) i--;
      return [i, st.clock - st.starts[i]];
    };

    const helpers = (t) => ({
      cover: (m, x, y, w, h) => cover(ctx, m, x, y, w, h), contain: (m, x, y, w, h) => contain(ctx, m, x, y, w, h),
      tracking: (x, y, w, h) => tracking(ctx, t, x, y, w, h),
    });
    const coverBg = (c, i, t) => { // 片头 / 片尾的底图：一张图（慢慢推近），或者某段动画的一帧
      if (!c.cover || c.cover.logo) return null;
      if (Array.isArray(c.cover)) return () => cover(ctx, media(i, 'cover'), 0, 0, LW, LH, 1.02 + 0.06 * clamp01(t / c.dur));
      const f = ANIMS[c.cover.anim];
      return f ? () => { ctx.save(); f(ctx, c.cover.t ?? 5, c.cover.dur ?? 10, { tape, c, tr, lang: lang(), media: [], ...helpers(t) }); ctx.restore(); return true; } : null;
    };

    const coverBadge = (c, i) => (c.cover?.logo ? () => contain(ctx, media(i, 'cover'), LW - 146, 34, 112, 112, true) : null); // 右上角的 logo

    function draw(c, i, t) {
      const n = st.show.chapters.length;
      switch (c.type) {
        case 'title': titleCard(ctx, c, t, tape, false, coverBg(c, i, t), coverBadge(c, i)); break;
        case 'end': titleCard(ctx, c, t, tape, true, coverBg(c, i, t), coverBadge(c, i)); break;
        case 'number': numberCard(ctx, c, t, tape); break;
        case 'anim': {
          const f = ANIMS[c.anim];
          const r = c.rate || 1; // rate：动画整体快放几倍（动画按自己设计的节奏写，dur 是实际放多久）
          const ms = (c.media || []).map((_, k) => media(i, 'm' + k));
          if (f) {
            f(ctx, t * r, c.dur * r, {
              tape, c, tr, lang: lang(), media: ms,
              cover: (m, x, y, w, h) => cover(ctx, m, x, y, w, h), contain: (m, x, y, w, h) => contain(ctx, m, x, y, w, h),
              tracking: (x, y, w, h) => tracking(ctx, t, x, y, w, h),
            });
          }
          else tracking(ctx, t);
          break;
        }
        case 'image': {
          if (!cover(ctx, media(i, 'src'), 0, 0, LW, LH, 1 + 0.08 * (t / c.dur))) tracking(ctx, t);
          label(ctx, tr(c.label), 14, 14);
          break;
        }
        case 'video': {
          const m = media(i, 'src');
          const top = c.fit === 'contain' ? contain(ctx, m, 0, 0, LW, LH) : cover(ctx, m, 0, 0, LW, LH) ? 14 : null;
          if (top == null) { tracking(ctx, t); break; }
          const y = c.fit === 'contain' ? Math.max(8, top - 30) : 14; // 宽银幕：标签放在上面的黑边里
          label(ctx, tr(c.label), 14, y);
          if (c.speed && c.speed !== 1) { ctx.font = `700 12px ${FONT}`; label(ctx, `${c.speed}×`, 14 + ctx.measureText(tr(c.label)).width + 22, y); }
          break;
        }
        case 'wipe': {
          const b = media(i, 'before'), a = media(i, 'after'), k = ease((t - 0.6) / Math.max(1, c.dur * 0.55)), x = LW * k;
          if (!cover(ctx, b, 0, 0, LW, LH)) { tracking(ctx, t); break; }
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, x, LH);
          ctx.clip();
          cover(ctx, a, 0, 0, LW, LH);
          ctx.restore();
          if (k > 0 && k < 1) { ctx.fillStyle = '#fff'; ctx.fillRect(x - 1.5, 0, 3, LH); }
          const [lb, la] = (c.labels || []).map(tr);
          label(ctx, la || 'AFTER', 14, 14);
          label(ctx, lb || 'BEFORE', LW - 14, 14, 'right');
          break;
        }
        case 'split': {
          const half = LW / 2;
          for (const [side, x] of [['left', 0], ['right', half]]) {
            if (!cover(ctx, media(i, side), x, 0, half, LH)) tracking(ctx, t, x, 0, half, LH);
            label(ctx, tr(c[side]?.label), x + 10, LH - 32);
          }
          ctx.fillStyle = '#000';
          ctx.fillRect(half - 1.5, 0, 3, LH);
          break;
        }
        case 'compare': {
          const col = tape.color || '#59b27a';
          ctx.fillStyle = '#0d1418';
          ctx.fillRect(0, 0, LW, LH);
          ctx.textBaseline = 'alphabetic';
          ctx.font = `700 12px ${FONT}`;
          ctx.fillStyle = col;
          ctx.fillText(tr(c.kicker), 16, 26);
          const p = tr(c.prompt), shown = p.slice(0, Math.round(p.length * clamp01((t - 0.15) / 1.1)));
          ctx.font = `600 18px ${SERIF}`;
          ctx.fillStyle = '#f2e9d6';
          wrap(ctx, shown, LW - 32).slice(0, 2).forEach((l, k) => ctx.fillText(l, 16, 52 + k * 22));
          const sw = 244, sh = 166, y0 = 96, rv = clamp01((t - (c.reveal ?? c.dur * 0.7)) / 0.4);
          for (const [side, x] of [['left', 8], ['right', 260]]) {
            const s2 = c[side] || {};
            ctx.fillStyle = '#000';
            ctx.fillRect(x, y0, sw, sh);
            if (!cover(ctx, media(i, side), x, y0, sw, sh)) tracking(ctx, t, x, y0, sw, sh);
            if (s2.ok) { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(x - 1, y0 - 1, sw + 2, sh + 2); ctx.lineWidth = 1; }
            ctx.font = `800 13px ${FONT}`;
            ctx.fillStyle = s2.ok ? col : '#9aa7b1';
            ctx.fillText(tr(s2.label), x + 2, y0 + sh + 20);
            if (rv > 0) {
              ctx.globalAlpha = rv;
              ctx.font = `700 13px ${FONT}`;
              ctx.fillStyle = s2.ok ? '#7be495' : '#ff7a59';
              wrap(ctx, (s2.ok ? '✓ ' : '✗ ') + tr(s2.verdict), sw - 4).slice(0, 2).forEach((l, k) => ctx.fillText(l, x + 2, y0 + sh + 42 + k * 18));
              ctx.globalAlpha = 1;
            }
          }
          break;
        }
        default: tracking(ctx, t);
      }
      if (c.tag) label(ctx, lang() === 'zh' ? '示意动画' : 'ILLUSTRATION', 14, LH - 34); // 左下角，和右下角的时间码对着
      // 右下角：VHS 时间码和第几章
      const sec = Math.floor(st.clock), tc = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      ctx.font = `700 14px ${MONO}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(`▶ ${tc}  ${i + 1}/${n}`, LW - 13, LH - 13);
      ctx.fillStyle = 'rgba(235,240,230,0.85)';
      ctx.fillText(`▶ ${tc}  ${i + 1}/${n}`, LW - 14, LH - 14);
      ctx.textAlign = 'left';
      // 换章：前 0.35 秒从黑里亮起来
      if (t < 0.35) { ctx.fillStyle = `rgba(0,0,0,${1 - t / 0.35})`; ctx.fillRect(0, 0, LW, LH); }
    }

    return {
      frame(t, dt) {
        ctx.setTransform(width / LW, 0, 0, height / LH, 0, 0);
        if (!st.show || !st.total) { tracking(ctx, t); return; }
        if (st.clock + dt >= st.total) st.passes++; // 放完了一遍（room.js 看到就换下一盘）
        st.clock = (st.clock + dt) % st.total;
        let [i, lt] = at();
        for (let k = 0; st.bad.has(i) && k < st.starts.length; k++) { // 素材缺了的章节：跳到下一章
          st.clock = st.starts[(i + 1) % st.starts.length];
          [i, lt] = at();
        }
        if (i !== st.ch) { st.ch = i; enter(i); }
        draw(st.show.chapters[i], i, lt);
        // 曝光：房间的"电影感"调色里，亮度过了 0.78 的地方都会发光（js/grade.js 的 bloom）。电视屏幕不受光照，
        // 画布上的纯白就是 1.0，大片的白（纸、浏览器窗口、实拍里的白屏）会糊成一团光。整体乘一层灰，最白的也压到门槛以下
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = EXPOSURE;
        ctx.fillRect(0, 0, LW, LH);
        ctx.globalCompositeOperation = 'source-over';
      },
      stop() { st.media.forEach((m) => { if (m instanceof HTMLVideoElement) m.pause(); }); },
      get passes() { return st.passes; }, // 整档节目放完了几遍
      // 跳章（room.js：↑↓、点电视、点字幕下面的点）
      jump(i) {
        if (!st.total) return;
        const n = st.starts.length;
        st.clock = st.starts[((i % n) + n) % n];
      },
      seek(d) { if (st.total) this.jump(at()[0] + d); },
      // 调试用（控制台里 __room.tv.run.media()）：这盘带子里每个视频的状态
      media() { return [...st.media].map(([id, m]) => ({ id, src: m?.currentSrc?.split('/').pop(), ready: m?.readyState, paused: m?.paused, time: m?.currentTime })); },
      // 字幕：这一章的字、第几章、一共几章
      caption() {
        if (!st.total) return null;
        const [i] = at();
        return { text: tr(st.show.chapters[i].sub), i, n: st.starts.length };
      },
    };
  },
};
