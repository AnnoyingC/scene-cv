// 上了锁的文章（js/room.js、js/books.js 用）：密文是 scripts/seal.mjs 生成的 JSON。
// 口令 → PBKDF2-SHA256 派生 256 位密钥 → AES-GCM 解密，全在浏览器里做，口令和正文都不会发到别处。
// "记住这台设备"：把派生出来的密钥存在这个浏览器的 localStorage 里（不存口令），下次打开本子直接解开；
// 密文换了（重新 seal 过）旧密钥就解不开，会自动忘掉
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const slot = (url) => 'scenecv.unlock:' + new URL(url, location.href).pathname;

export async function loadSealed(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    const box = await r.json();
    return box?.v === 1 && box.data ? box : null;
  } catch { return null; }
}

async function decrypt(key, box) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(box.iv) }, key, b64(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// 用口令解开；口令不对会抛错。remember = 记住这台设备
export async function unseal(url, box, pass, remember = false) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(box.salt), iterations: box.iter },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  const doc = await decrypt(key, box);
  if (remember) {
    try { localStorage.setItem(slot(url), b64enc(await crypto.subtle.exportKey('raw', key))); } catch { /* 隐私模式：不记 */ }
  }
  return doc;
}

// 这台设备记住过：直接解开；没记过或者解不开 = null
export async function unsealRemembered(url, box) {
  let raw = null;
  try { raw = localStorage.getItem(slot(url)); } catch { /* 读不了就当没记过 */ }
  if (!raw) return null;
  try {
    const key = await crypto.subtle.importKey('raw', b64(raw), 'AES-GCM', false, ['decrypt']);
    return await decrypt(key, box);
  } catch {
    forget(url);
    return null;
  }
}

export function remembered(url) {
  try { return !!localStorage.getItem(slot(url)); } catch { return false; }
}

export function forget(url) {
  try { localStorage.removeItem(slot(url)); } catch { /* 无所谓 */ }
}
