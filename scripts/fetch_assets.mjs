// 下载第三方 3D 素材的原始文件，放进 vendor-src/（不进仓库）。零依赖：
//   node scripts/fetch_assets.mjs            下载 credits.json 里所有能自动下载的
//   node scripts/fetch_assets.mjs --dry      只列出要下载的文件和大小
//   node scripts/fetch_assets.mjs chess_set  只下载名字里带 chess_set 的
// Poly Haven 不用登录，自动下载并校验 md5；Sketchfab 必须登录才能下载，这里只打印链接，
// 下载的 zip 解压到 vendor-src/sketchfab/<名字>/ 即可。
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'vendor-src');
const UA = { 'User-Agent': 'self-engineering-asset-fetch/1.0' };
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = args.filter((a) => !a.startsWith('--'));

const { assets } = JSON.parse(await readFile(join(ROOT, 'assets/vendor/credits.json'), 'utf8'));
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const md5 = (buf) => createHash('md5').update(buf).digest('hex');

// 素材自带的相对路径（比如 textures/xxx.jpg）只能落在它自己的文件夹里
function inside(dir, rel) {
  const p = resolve(dir, rel);
  if (!p.startsWith(dir + sep)) throw new Error(`路径越界：${rel}`);
  return p;
}

async function polyhavenFiles({ polyhaven: id, res, format, maps }) {
  const r = await fetch(`https://api.polyhaven.com/files/${encodeURIComponent(id)}`, { headers: UA });
  if (!r.ok) throw new Error(`Poly Haven API ${r.status}：${id}`);
  const files = await r.json();
  if (format === 'gltf') {
    const g = files.gltf?.[res]?.gltf;
    if (!g) throw new Error(`${id} 没有 ${res} 的 glTF`);
    return [{ rel: g.url.split('/').pop(), ...g }, ...Object.entries(g.include || {}).map(([rel, f]) => ({ rel, ...f }))];
  }
  return maps.map((m) => {
    const f = files[m]?.[res]?.[format];
    if (!f) throw new Error(`${id} 没有 ${m} ${res} ${format}`);
    return { rel: f.url.split('/').pop(), ...f };
  });
}

let total = 0, fetched = 0;
const manual = [];
for (const a of assets) {
  if (only.length && !only.some((o) => a.id.includes(o))) continue;
  const dir = join(OUT, a.id);
  if (a.fetch?.manual) {
    const have = await stat(dir).then(() => true, () => false);
    manual.push(`${have ? '✓' : '·'} ${a.title}（${a.authors.join(', ')}）\n    ${a.url}\n    解压到 vendor-src/${a.id}/`);
    continue;
  }
  const list = await polyhavenFiles(a.fetch);
  const size = list.reduce((s, f) => s + f.size, 0);
  total += size;
  console.log(`${a.id}  ${list.length} 个文件  ${mb(size)}`);
  if (dry) continue;
  for (const f of list) {
    const dest = inside(dir, f.rel);
    const old = await readFile(dest).catch(() => null);
    if (old && old.length === f.size && (!f.md5 || md5(old) === f.md5)) continue;
    const r = await fetch(f.url, { headers: UA });
    if (!r.ok) throw new Error(`下载失败 ${r.status}：${f.url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== f.size || (f.md5 && md5(buf) !== f.md5)) throw new Error(`校验失败：${f.url}`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    fetched += buf.length;
  }
}
console.log(`\n合计 ${mb(total)}${dry ? '（没有下载）' : `，这次下载 ${mb(fetched)}，放在 vendor-src/`}`);
if (manual.length) console.log(`\nSketchfab 需要登录后手动下载（选 glTF 格式）：\n${manual.join('\n')}`);
