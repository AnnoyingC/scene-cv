// 画 canvas 用的小工具。
export const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
export const MONO = '"SF Mono",Menlo,Consolas,"PingFang SC","Microsoft YaHei",monospace';

export const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

// 自动换行：英文按单词断，中文按字断。逗号、句号这类标点不放在行首（宁可让上一行稍微超出一点）。
const NO_START = /^[，。、；：！？）》」』”’,.!?;:)\]]/;
export function wrap(ctx, str, maxW) {
  const tokens = String(str ?? "").match(/[⺀-鿿＀-￯]|[^\s⺀-鿿＀-￯]+|\s+/g) || [];
  const lines = [];
  let line = '';
  for (const tok of tokens) {
    const test = line + tok;
    if (ctx.measureText(test).width > maxW && line.trim() && !NO_START.test(tok)) {
      lines.push(line.trimEnd());
      line = tok.trimStart();
    } else {
      line = test;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

// 可复现的随机数（同一个 seed 每次结果一样）。
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// CRT 扫描线 + 暗角，盖在屏幕画面上。
export function scanlines(W, H, alpha = 0.18) {
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = `rgba(0,0,0,${alpha})`;
  for (let y = 0; y < H; y += 3) x.fillRect(0, y, W, 1);
  const g = x.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  return c;
}
