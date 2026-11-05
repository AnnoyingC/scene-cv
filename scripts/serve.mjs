// Local static preview only. No database, account system or write API.
// Usage: node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIRS = new Set(['assets', 'css', 'js', 'lab', 'learning']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function publicFile(path) {
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => !part || part.startsWith('.'))) return false;
  return path === 'index.html' || (PUBLIC_DIRS.has(parts[0]) && Object.hasOwn(TYPES, extname(path).toLowerCase()));
}

export function createStaticServer({ root = ROOT } = {}) {
  const rootPath = realpath(root);
  return createServer(async (req, res) => {
    const finish = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : message);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return finish(405, 'Method not allowed');
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return finish(400, 'Invalid URL'); }
    if (pathname.includes('\0') || pathname.includes('\\')) return finish(400, 'Invalid URL');
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!publicFile(requested)) return finish(404, 'Not found');
    try {
      const base = await rootPath;
      const file = await realpath(join(base, requested));
      const rel = relative(base, file);
      // Check resolved targets too: symlinks cannot expose private files or escape root.
      if (rel === '..' || rel.startsWith('..' + sep) || !publicFile(rel)) return finish(404, 'Not found');
      if (!(await stat(file)).isFile()) return finish(404, 'Not found');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()], 'Content-Length': body.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      finish(404, 'Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 5173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const server = createStaticServer();
  server.listen(port, '127.0.0.1', () => console.log(`SceneCV: http://localhost:${server.address().port}`));
}
