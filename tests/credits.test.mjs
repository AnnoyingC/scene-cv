// 素材致谢：index.html 里的列表要和 credits.json、房间的 manifest 一致；房间用到的每件素材都要能合法署名。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LICENSES, render, roomInputs, splice } from '../scripts/credits_html.mjs';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html 的素材致谢是最新生成的', () => {
  assert.equal(splice(index, render(roomInputs())), index, '运行 node scripts/credits_html.mjs 重新生成');
});

test('房间用到的素材都有作者、原作链接、许可链接和改动说明', () => {
  const { credits, vendor } = roomInputs();
  const byId = new Map(credits.assets.map((a) => [a.id, a]));
  assert.ok(vendor.length > 0, 'manifest.vendor 是空的');
  for (const id of vendor) {
    const a = byId.get(id);
    assert.ok(a, `credits.json 里没有 ${id}`);
    assert.ok(LICENSES[a.license], `${id}: 许可 ${a.license} 不在允许的列表里`);
    assert.ok(a.authors?.length && a.authors.every(Boolean), `${id}: 缺作者`);
    assert.match(a.url, /^https:\/\//, `${id}: 缺原作链接`);
    assert.match(a.licenseUrl || '', /^https:\/\/creativecommons\.org\//, `${id}: 缺许可链接`);
    if (a.license === 'CC-BY-4.0') assert.ok(a.changes?.length, `${id}: CC BY 要注明改动`);
  }
});

test('生成的列表会转义 HTML', () => {
  const html = render({
    credits: { assets: [{ id: 'x', title: '<b>"T"</b>', authors: ['A & B'], url: 'https://e.x/?a=1&b=2', license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' }] },
    vendor: ['x'],
  });
  assert.ok(!html.includes('<b>"T"</b>'));
  assert.ok(html.includes('&lt;b&gt;&quot;T&quot;&lt;/b&gt;') && html.includes('A &amp; B') && html.includes('a=1&amp;b=2'));
});

test('不收 NC、ND 或不认识的许可', () => {
  const credits = { assets: [{ id: 'x', title: 'T', authors: ['A'], url: 'https://e.x', license: 'CC-BY-NC-4.0' }] };
  assert.throws(() => render({ credits, vendor: ['x'] }), /不在允许的列表里/);
  assert.throws(() => render({ credits, vendor: ['missing'] }), /没有 missing/);
});
