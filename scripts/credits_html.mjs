// 生成 index.html 里 #credits 的素材列表：书桌房间用到的第三方素材（assets/baked/manifest.json 的 vendor），
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
export const LICENSES = { 'CC-BY-4.0': 'CC BY 4.0', 'CC0-1.0': 'CC0 1.0' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));

export function roomInputs() {
  return { credits: readJson('assets/vendor/credits.json'), vendor: readJson('assets/baked/manifest.json').vendor || [] };
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
  used.sort((a, b) => Number(a.license !== 'CC-BY-4.0') - Number(b.license !== 'CC-BY-4.0'));
  const items = used.map((a) => {
    const by = [a.title, (a.authors || []).join('、'), a.source].filter(Boolean).join(' · ');
    const lic = a.licenseUrl ? `<a class="lic" href="${esc(a.licenseUrl)}">${LICENSES[a.license]}</a>` : `<span class="lic">${LICENSES[a.license]}</span>`;
    const changes = changeText(a);
    return `      <li><a href="${esc(a.url)}">${esc(a.zh || a.title)}</a> <span class="by">${esc(by)}</span> ${lic}`
      + (changes ? `\n        <p>改动：${esc(changes)}</p>` : '') + '</li>';
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
