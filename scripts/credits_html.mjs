// 生成 index.html 里 #credits 的素材列表：书桌房间用到的第三方素材（assets/baked/manifest.json 的 vendor）、
// 窗外夜景用到的数据和素材（assets/baked/view.json 的 vendor：地图数据、3D 城市模型、照片、字体），
// 作者、原作链接、许可和改动说明都来自 assets/vendor/credits.json。CC BY 要求署名并注明改动，所以每一项都写上。
// 用法：node scripts/credits_html.mjs          改写 index.html 里 <!-- credits:begin --> 和 <!-- credits:end --> 之间的部分
//       node scripts/credits_html.mjs --check  只检查是不是最新的，不是就以退出码 1 结束（tests/credits.test.mjs 也会查）
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url);
const INDEX = new URL('index.html', ROOT);
export const BEGIN = '<!-- credits:begin -->';
export const END = '<!-- credits:end -->';
// 允许的许可：只收能再分发、能改的；NC（禁止商用）、ND（禁止改编）都不收
//   ODbL：OpenStreetMap 的数据（渲染出的图是 Produced Work，注明出处即可）；PLATEAU-TOU：日本政府标准利用规约 2.0（和 CC BY 4.0 兼容）；
//   OFL：字体（只用来画招牌，字体文件不分发）
export const LICENSES = {
  'CC-BY-4.0': 'CC BY 4.0', 'CC0-1.0': 'CC0 1.0', 'ODbL-1.0': 'ODbL 1.0', 'PLATEAU-TOU': 'Gov. of Japan Standard Terms of Use 2.0', 'OFL-1.1': 'SIL OFL 1.1',
};
// 每种许可的条款页应该在哪个网站（tests/credits.test.mjs 查）
export const LICENSE_HOSTS = {
  'CC-BY-4.0': 'creativecommons.org', 'CC0-1.0': 'creativecommons.org', 'ODbL-1.0': 'opendatacommons.org', 'PLATEAU-TOU': 'www.mlit.go.jp', 'OFL-1.1': 'openfontlicense.org',
};
// 需要署名、注明改动的许可排在前面
const ATTRIBUTION = new Set(['CC-BY-4.0', 'ODbL-1.0', 'PLATEAU-TOU']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));

export function roomInputs() {
  const room = readJson('assets/baked/manifest.json').vendor || [], view = readJson('assets/baked/view.json').vendor || [];
  return { credits: readJson('assets/vendor/credits.json'), vendor: [...room, ...view.filter((id) => !room.includes(id))] };
}

// changes 开头的"怀旧房间书桌上的电脑："是摆在哪儿，列表里已经有名字了，只留后面的改动
const changeText = (a) => (a.changes || []).map((c) => c.replace(/^怀旧房间[^：]*：/, '')).join('；');

export function render({ credits, vendor }) {
  const byId = new Map(credits.assets.map((a) => [a.id, a]));
  const used = vendor.map((id) => {
    const a = byId.get(id);
    if (!a) throw new Error(`assets/vendor/credits.json 里没有 ${id}`);
    if (!LICENSES[a.license]) throw new Error(`${id} 的许可 ${a.license} 不在允许的列表里`);
    return a;
  });
  // 需要署名的（CC BY）排前面，同一种许可里按房间清单的顺序
  used.sort((a, b) => Number(!ATTRIBUTION.has(a.license)) - Number(!ATTRIBUTION.has(b.license)));
  const items = used.map((a) => {
    const by = [(a.authors || []).join(', '), a.source].filter(Boolean).join(' · ');
    const lic = a.licenseUrl ? `<a class="lic" href="${esc(a.licenseUrl)}">${LICENSES[a.license]}</a>` : `<span class="lic">${LICENSES[a.license]}</span>`;
    // 界面是英文：列表里写原作的英文名；CC BY 要注明改了什么，具体的改动（中文）在 credits.json 的 changes 里
    const changes = changeText(a);
    return `      <li><a href="${esc(a.url)}">${esc(a.title || a.zh)}</a> <span class="by">${esc(by)}</span> ${lic}`
      + (a.note ? `\n        <p>${esc(a.note)}</p>` : changes ? '\n        <p>Modified for this room: rescaled, retextured and baked into the room lighting (details in credits.json).</p>' : '') + '</li>';
  });
  return `${BEGIN}\n    <ul class="credit-list">\n${items.join('\n')}\n    </ul>\n    ${END}`;
}

export function splice(html, block) {
  const i = html.indexOf(BEGIN), j = html.indexOf(END);
  if (i < 0 || j < i) throw new Error(`index.html 里找不到 ${BEGIN} … ${END}`);
  return html.slice(0, i) + block + html.slice(j + END.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = readFileSync(INDEX, 'utf8');
  const next = splice(html, render(roomInputs()));
  if (process.argv.includes('--check')) {
    if (next !== html) { console.error('index.html 的素材致谢不是最新的：运行 node scripts/credits_html.mjs'); process.exit(1); }
    console.log('素材致谢是最新的');
  } else if (next === html) {
    console.log('素材致谢没有变化');
  } else {
    writeFileSync(INDEX, next);
    console.log('已更新 index.html 的素材致谢');
  }
}
