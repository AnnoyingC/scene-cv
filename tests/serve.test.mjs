import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer } from '../scripts/serve.mjs';

test('static preview serves the site without exposing local project data', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'scenecv-server-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'site');
  for (const dir of ['assets/baked', 'assets/tapes/sample', '.git', '.claude', 'scripts']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await mkdir(join(base, 'site-private'));
  await writeFile(join(root, 'index.html'), '<title>SceneCV</title>');
  await writeFile(join(root, 'assets/baked/manifest.json'), '{"scene":"room"}');
  await writeFile(join(root, 'assets/tapes/sample/show.json'), '{"chapters":[]}');
  await writeFile(join(root, '.git/config'), 'PRIVATE-GIT-CONFIG');
  await writeFile(join(root, '.env'), 'PRIVATE-ENV');
  await writeFile(join(root, 'scripts/serve.mjs'), 'PRIVATE-TOOL');
  await writeFile(join(base, 'site-private/secret.json'), 'PRIVATE-NEIGHBOR');
  await symlink(join(root, '.git/config'), join(root, 'assets/inside.json'));
  await symlink(join(base, 'site-private/secret.json'), join(root, 'assets/outside.json'));
  const server = createStaticServer({ root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const send = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
  for (const path of ['/', '/?room=1', '/assets/baked/manifest.json', '/assets/tapes/sample/show.json']) {
    await t.test(`serves ${path}`, async () => assert.equal((await send(path)).status, 200));
  }
  for (const path of ['/.git/config', '/%2egit/config', '/.env', '/scripts/serve.mjs', '/assets/inside.json',
    '/assets/outside.json', '/assets/%2e%2e%2f.git/config', '/assets/%2e%2e%2f%2e%2e%2fsite-private/secret.json']) {
    await t.test(`blocks ${path}`, async () => {
      const res = await send(path);
      assert.equal(res.status, 404); assert.ok(!res.body.includes('PRIVATE-'));
    });
  }
  await t.test('HEAD has matching headers and no body', async () => {
    const res = await send('/', 'HEAD'); assert.equal(res.status, 200); assert.equal(res.body, '');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  });
  await t.test('invalid encoding is a client error', async () => assert.equal((await send('/%zz')).status, 400));
  await t.test('does not accept writes', async () => {
    const res = await send('/', 'POST'); assert.equal(res.status, 405); assert.equal(res.headers.allow, 'GET, HEAD');
  });
});
