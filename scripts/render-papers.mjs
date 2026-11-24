// 桌上那摞纸的纸面贴图：从 index.html #papers 截每份文件的第一页（报纸、会议论文、期刊论文），给 blender/bake_room.py 用，
// 桌上看到的和拿起来的是同一张纸。改了这几页的内容以后重截一次、再烘焙：
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/render-papers.mjs
// 输出 output/papers-tex/<data-slug>.jpg（794 × 1123；output/ 不进 Git）。
// 要一个装了 playwright-core 的地方（npm i -g playwright-core 也行）；CHROME=…/Google Chrome 可以指定浏览器。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createStaticServer } from './serve.mjs';

const SCALE = 1; // 794 × 1123 像素：桌上的纸在屏幕上最多几百像素宽，够了
const OUT = new URL('../output/papers-tex/', import.meta.url);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

mkdirSync(OUT, { recursive: true });
const server = createStaticServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 1130 }, deviceScaleFactor: SCALE });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?plain=1`); // 静态版：不起 3D，#papers 的纸就在页面里
  const slugs = await page.evaluate(() => [...document.querySelectorAll('#papers .pp-doc')].map((d) => d.dataset.slug));
  for (const slug of slugs) {
    await page.evaluate((s) => { // 第一页复制一份，按原尺寸（794 × 1123，不缩放）钉在左上角
      document.getElementById('paper-tex')?.remove();
      const src = document.querySelector(`#papers .pp-doc[data-slug="${s}"] .pp-page`);
      const box = document.createElement('div');
      box.id = 'paper-tex';
      box.style.cssText = 'position: fixed; left: 0; top: 0; width: 794px; height: 1123px; z-index: 2147483647;';
      box.append(src.cloneNode(true));
      document.body.append(box);
    }, slug);
    await page.evaluate(() => document.fonts.ready);
    const jpg = await page.locator('#paper-tex').screenshot({ type: 'jpeg', quality: 84 });
    writeFileSync(new URL(`${slug}.jpg`, OUT), jpg);
    console.log(`output/papers-tex/${slug}.jpg  ${(jpg.length / 1024).toFixed(0)} KB`);
  }
} finally {
  await browser.close();
  server.close();
}
