// 开场静帧：js/boot.js 在 3D 房间下载完以前铺在进度后面的那张图（assets/baked/first.webp，压暗、虚化着用）。
// 从真的 3D 房间里截（开场镜头、同样的调色），房间淡入时才对得上。重新烘焙、改了开场镜头或调色以后重截一次：
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/capture-first.mjs
// 要一个装了 playwright-core 的地方（npm i -g playwright-core 也行）和一个能用 GPU 的 Chrome（CHROME=…/Google Chrome 指定，
// 不指定就用 Playwright 自己下的 Chromium）。画面宽高比 2:1：常见的横屏（4:3 到 2:1）居中裁一下就和 3D 的开场镜头一样。
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createStaticServer } from './serve.mjs';

const W = 1280, H = 640, QUALITY = 0.72;
const OUT = new URL('../assets/baked/first.webp', import.meta.url);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const server = createStaticServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  headless: true,
  args: ['--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?room=1`);
  await page.waitForFunction(() => !document.getElementById('boot') || document.documentElement.classList.contains('is-plain'), null, { timeout: 120000 });
  if (await page.evaluate(() => document.documentElement.classList.contains('is-plain'))) throw new Error('房间没跑起来（显示的是静态版）');
  await page.addStyleTag({ content: 'body > *:not(#room), #room > *:not(#gl) { visibility: hidden !important; }' });
  await page.waitForTimeout(2500); // 等灯、窗外、辉光都稳定下来
  const png = (await page.screenshot({ type: 'png' })).toString('base64');
  // Playwright 只能截 png / jpeg：在页面里用 canvas 转成 webp
  const webp = await page.evaluate(async ([src, q]) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', q).split(',')[1];
  }, [png, QUALITY]);
  writeFileSync(OUT, Buffer.from(webp, 'base64'));
  console.log(`${OUT.pathname}: ${W}×${H}, ${(Buffer.from(webp, 'base64').length / 1024).toFixed(0)} KB`);
} finally {
  await browser.close();
  server.close();
}
