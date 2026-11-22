// 3D 房间要用到的全部 JS 模块 → index.html 里的 <script type="application/json" id="room-modules">。
// 头部的小脚本把清单里的文件一次性 modulepreload，浏览器不用等 main.js → room.js → three.js → GLTFLoader … 一层层发现。
// 改了 import 以后跑一次（three 的文件要从 CDN 读来找它们自己的 import，所以要联网；走代理的话前面加 NODE_USE_ENV_PROXY=1）：
//   node scripts/room-modules.mjs
// tests/room-modules.test.mjs 检查清单没过时（只查本地文件和它们直接 import 的 three 文件，不联网）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = new URL('../', import.meta.url);
export const PAGE = new URL('index.html', ROOT);
const ENTRY = new URL('js/main.js', ROOT);
const SKIP = new Set(['js/main.js', 'js/boot.js']); // index.html 直接用 <script> 加载的两个
const LIST = /(<script type="application\/json" id="room-modules">)([\s\S]*?)(<\/script>)/;

export function importMap(html) {
  return JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
}
export function listed(html) { return JSON.parse(html.match(LIST)[2]); }

// 一个模块里 import 的东西：import … from '…'、export … from '…'、import '…'、import('…')
export function specifiers(src) {
  const out = [];
  for (const re of [/^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm, /^\s*import\s*['"]([^'"]+)['"]/gm, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

export function resolve(spec, from, map) {
  if (/^(\.{1,2}\/|\/|https?:)/.test(spec)) return new URL(spec, from).href;
  if (map[spec]) return map[spec];
  const key = Object.keys(map).filter((k) => k.endsWith('/') && spec.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (!key) throw new Error(`import map 里没有 ${spec}（${from}）`);
  return map[key] + spec.slice(key.length);
}

// 本地文件写成相对 index.html 的路径（js/room.js），CDN 上的照旧是完整地址
export const display = (href) => (href.startsWith(ROOT.href) ? href.slice(ROOT.href.length) : href);

// 从 main.js 顺着 import 找下去；remote = false 时不读 CDN 上的文件（只记下本地文件直接 import 的那些）
export async function crawl({ remote = true } = {}) {
  const map = importMap(readFileSync(PAGE, 'utf8'));
  const seen = new Set([ENTRY.href]), order = [], queue = [ENTRY.href];
  while (queue.length) {
    const href = queue.shift();
    order.push(href);
    const local = href.startsWith('file:');
    if (!local && !remote) continue;
    const src = local ? readFileSync(fileURLToPath(href), 'utf8') : await (await fetch(href)).text();
    for (const spec of specifiers(src)) {
      const dep = resolve(spec, href, map);
      if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
  }
  return order.map(display).filter((p) => !SKIP.has(p));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const list = await crawl();
  const html = readFileSync(PAGE, 'utf8');
  if (!LIST.test(html)) throw new Error('index.html 里没有 <script type="application/json" id="room-modules">');
  const body = '\n' + JSON.stringify(list).slice(1, -1).split(',').map((s) => '  ' + s).join(',\n') + '\n';
  writeFileSync(PAGE, html.replace(LIST, (_, a, __, c) => `${a}[${body}]${c}`));
  console.log(`index.html: ${list.length} modules`);
}
