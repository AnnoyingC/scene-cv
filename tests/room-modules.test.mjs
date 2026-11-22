import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAGE, ROOT, crawl, listed, specifiers } from '../scripts/room-modules.mjs';

// index.html 的 modulepreload 清单要跟得上 import：漏了的模块又会一层层排队下载（跑 node scripts/room-modules.mjs 更新）
test('room module list in index.html covers the import graph', async () => {
  const list = listed(readFileSync(PAGE, 'utf8'));
  const need = await crawl({ remote: false }); // 本地模块 + 它们直接 import 的 three 文件
  const missing = need.filter((m) => !list.includes(m));
  assert.deepEqual(missing, [], `index.html 的 room-modules 少了这些，跑一次 node scripts/room-modules.mjs`);
  for (const m of list.filter((m) => !/^https?:/.test(m))) {
    assert.ok(existsSync(fileURLToPath(new URL(m, ROOT))), `清单里的 ${m} 不存在`);
    assert.ok(need.includes(m), `清单里的 ${m} 已经没有模块用了`);
  }
});

test('import scanner finds static, re-export and dynamic imports', () => {
  const src = `import * as THREE from 'three';\nimport {\n  a,\n  b,\n} from "./x.js";\nexport { c } from './y.js';\nimport './side.js';\nconst m = () => import('./lazy.js');\nconst s = Array.from('abc');`;
  assert.deepEqual(specifiers(src).sort(), ['./lazy.js', './side.js', './x.js', './y.js', 'three'].sort());
});
