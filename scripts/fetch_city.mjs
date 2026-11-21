// 下载窗外夜景（东京塔一带）用的城市数据，放进 vendor-src/（不进仓库），再把中间文件做好。零依赖（Node 18+；解压用系统的 unzip）：
//   node scripts/fetch_city.mjs          下载缺的、做缺的
//   node scripts/fetch_city.mjs --dry    只列出要做什么
// 之后渲染窗景：/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/render_view.py -- --width 3840 --samples 64
//
// 1. OpenStreetMap（Overpass API，© OpenStreetMap contributors，ODbL）→ vendor-src/osm/
//      near.json   视点 1.6 公里以内所有的楼          far.json    5 公里以内标了高度或层数的楼（远处的天际线）
//      roads.json  2.5 公里以内的主要道路             detail.json 520 米以内的小街小巷、店、树、公园
// 2. 国土交通省 PLATEAU 港区（2023 年度）CityGML（约 1.5 GB）→ vendor-src/plateau/，只解压建筑（bldg）和地形（dem）
//    → blender/plateau_prep.py 转成 vendor-src/plateau/city.npz（几分钟）
// 3. Wikimedia Commons 的三张 CC0 夜景照片 → vendor-src/commons/windows/ → blender/window_atlas.py 裁成楼面图集
// 4. blender/sign_atlas.py 用 Blender 自带的 Noto Sans CJK 画招牌图集 → vendor-src/signs/
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const V = join(ROOT, 'vendor-src');
const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
const BPY = process.env.BLENDER_PYTHON || '/Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13';
const UA = { 'User-Agent': 'scene-cv-asset-fetch/1.0' };
const dry = process.argv.includes('--dry');
const VP = [35.65671, 139.73688]; // 视点（麻布十番上空），和 blender/render_view.py 的默认值一样
const exists = (p) => stat(p).then(() => true, () => false);
const around = (r) => `around:${r},${VP[0]},${VP[1]}`;

const OSM = {
  'near.json': `[out:json][timeout:180];(way["building"](${around(1600)});relation["building"](${around(1600)}););out geom tags;`,
  'far.json': `[out:json][timeout:180];(way["building"]["height"](${around(5000)});way["building"]["building:levels"](${around(5000)});`
    + `relation["building"]["height"](${around(5000)});relation["building"]["building:levels"](${around(5000)}););out geom tags;`,
  'roads.json': `[out:json][timeout:180];way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|secondary|tertiary)$"](${around(2500)});out geom tags;`,
  'detail.json': `[out:json][timeout:120];(way["highway"~"^(residential|unclassified|living_street|service|pedestrian)$"](${around(520)});`
    + `node["amenity"~"^(cafe|restaurant|bar|pub|izakaya|fast_food)$"](${around(520)});node["natural"="tree"](${around(520)});`
    + `way["leisure"~"^(park|garden)$"](${around(520)});way["landuse"="grass"](${around(520)});node["shop"="convenience"](${around(520)}););out geom tags;`,
};
const PLATEAU = 'https://assets.cms.plateau.reearth.io/assets/36/598fa9-8acd-44cf-85da-2511783b51dc/13103_minato-ku_pref_2023_citygml_2_op.zip';
const PHOTOS = {
  'roppongi-from-shibuya-stream': 'Roppongi_at_night_seen_from_Shibuya_Stream.jpg',
  'roppongi-from-shibuya-stream-2024': 'September_2024_Roppongi_at_night_from_Shibuya_Stream.jpg',
  'azabudai-from-roppongi-4': 'January_2024,_Azabudai_Hills_seen_from_Roppongi_Hills_4.jpg',
};

async function download(url, file, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(file));
}

async function step(label, out, run) {
  if (await exists(out)) return console.log(`✓ ${label}`);
  console.log(`· ${label} → ${out.slice(ROOT.length + 1)}`);
  if (!dry) await run();
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });

await mkdir(join(V, 'osm'), { recursive: true });
for (const [name, q] of Object.entries(OSM)) {
  await step(`OpenStreetMap ${name}`, join(V, 'osm', name), async () => {
    for (let i = 0; ; i++) {           // Overpass 忙的时候会回 429 / 504：等一会儿再试（一个一个来，别并发）
      try {
        await download('https://overpass-api.de/api/interpreter', join(V, 'osm', name), {
          method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        return;
      } catch (e) {
        if (i >= 4) throw e;
        console.log(`  ${e.message}，${15 * (i + 1)} 秒后重试`);
        await new Promise((ok) => setTimeout(ok, 15000 * (i + 1)));
      }
    }
  });
}

const pz = join(V, 'plateau', '13103_minato-ku_pref_2023_citygml_2_op.zip');
await mkdir(join(V, 'plateau'), { recursive: true });
await step('PLATEAU 港区 CityGML（约 1.5 GB）', pz, () => download(PLATEAU, pz));
await step('解压建筑、地形', join(V, 'plateau', 'udx', 'dem'), () => run('unzip', ['-q', '-o', pz, 'udx/bldg/*.gml', 'udx/dem/*.gml', '-d', join(V, 'plateau')]));
await step('PLATEAU → city.npz', join(V, 'plateau', 'city.npz'), () => run(BPY, ['-I', 'blender/plateau_prep.py', '--gml', join(V, 'plateau', 'udx'),
  '--out', join(V, 'plateau', 'city.npz'), '--vp-lat', String(VP[0]), '--vp-lon', String(VP[1]), '--bearing', '66', '--height', '70']));

for (const [slug, file] of Object.entries(PHOTOS)) {
  const dir = join(V, 'commons', 'windows', slug);
  await mkdir(dir, { recursive: true });
  await step(`照片 ${slug}`, join(dir, slug + '.jpg'),
    () => download(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`, join(dir, slug + '.jpg')));
}
await step('楼面图集', join(V, 'commons', 'windows', 'atlas', 'atlas.json'),
  () => run(BLENDER, ['-b', '--factory-startup', '--python', 'blender/window_atlas.py', '--', '--src', 'vendor-src/commons/windows', '--out', 'vendor-src/commons/windows/atlas']));
await step('招牌图集', join(V, 'signs', 'signs.json'),
  () => run(BLENDER, ['-b', '--factory-startup', '--python', 'blender/sign_atlas.py', '--', '--out', 'vendor-src/signs']));
if (!dry) await writeFile(join(V, 'osm', 'README.txt'), 'Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).\n');
console.log(dry ? '（--dry：什么都没做）' : '城市数据齐了。');
