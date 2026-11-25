"""Check tracked publication files without printing any matched private values.

Run from the project root: python3 scripts/audit_public.py
Use a dedicated secret scanner as well; this script is not a comprehensive security audit.
Compressed .blend files are rejected because their contents cannot be checked directly.
"""
from pathlib import Path
import json
import re
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ROOTS = {'.claude', 'vendor-src', 'dist', 'output', 'node_modules'}
PRIVATE_FILES = {'.env', '.envrc', '.private-terms', 'assets/books/books.html'}
# 只在本地用的个人内容：真实简历（电话、邮箱、照片、PDF）、真实的论文和报道、书的真实封面、个人照片、墙上的海报（有版权的封面）
PRIVATE_PREFIXES = ('assets/resume/', 'assets/papers/', 'assets/books/covers/', 'assets/photos/',
                    'assets/posters/', 'assets/messages/', 'assets/audio/', 'photos-src/')
PATTERNS = {
    'personal_home_path': rb'/(?:Users|home)/[^/\s\x00]+/',
    'private_key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'access_token': rb'\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{15,})\b',
    'url_credentials': rb'https?://[^\s/@]+:[^\s/@]+@',
    # 真实联系方式只放在 assets/resume/contact.html（不进 Git）：公开文件里不该有邮箱、电话链接或手机号
    'contact_details': rb'mailto:[^"\s<]*@|tel:\+?[0-9]|@(?:qq|163|126|gmail|outlook|hotmail|foxmail)\.com|(?<![0-9A-Za-z])1[3-9][0-9]{9}(?![0-9A-Za-z])',
}

# 本地词表（不进 Git）：一行一个不该出现在公开文件里的词（真名、学校、公司、项目名……），# 开头是注释；不区分大小写。
# ! 开头的一行是放行的词组：它里面碰巧含着某个词（比如一个地名），整个词组出现时不算。
# 公开的检查脚本里写不了这些词，所以放在仓库外面；查到了只报文件名，不打印是哪个词。
TERMS_FILE = ROOT / '.private-terms'
_LINES = [t.strip() for t in (TERMS_FILE.read_text(encoding='utf-8').splitlines() if TERMS_FILE.is_file() else [])
          if t.strip() and not t.strip().startswith('#')]
TERMS = [t.lower().encode() for t in _LINES if not t.startswith('!')]
ALLOW = [t[1:].strip().lower().encode() for t in _LINES if t.startswith('!') and t[1:].strip()]


def inspect(name, data):
    problems = []
    lower = data.lower()
    for a in ALLOW:
        lower = lower.replace(a, b' ')
    if any(t in lower for t in TERMS):
        problems.append('private_term')
    path = Path(name)
    if path.parts[0] in PRIVATE_ROOTS or name in PRIVATE_FILES or name.startswith(PRIVATE_PREFIXES) or (path.name.startswith('.env.') and path.name != '.env.example'):
        problems.append('private_file_in_publication')
    if path.suffix.lower() in {'.pem', '.key', '.p12', '.pfx', '.db', '.sqlite', '.sqlite3'}:
        problems.append('credential_or_database_file')
    if len(data) >= 100_000_000:
        problems.append('oversized_git_file')
    if path.suffix == '.blend' and not data.startswith(b'BLENDER'):
        problems.append('compressed_blend_requires_explicit_review')
    for label, pattern in PATTERNS.items():
        if re.search(pattern, data):
            problems.append(label)
    if path.suffix == '.png' and data.startswith(b'\x89PNG\r\n\x1a\n'):
        pos = 8
        while pos + 12 <= len(data):
            size = struct.unpack_from('>I', data, pos)[0]
            kind = data[pos + 4:pos + 8]
            if kind in {b'tEXt', b'zTXt', b'iTXt', b'eXIf'}:
                problems.append('image_metadata_requires_review')
                break
            pos += size + 12
    return problems

def main():
    names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    findings = []
    count = 0
    for name in filter(None, names):
        path = ROOT / name
        if path.is_symlink():
            findings.append({'file': name, 'issues': ['symlink_requires_review']})
            continue
        if not path.is_file():
            findings.append({'file': name, 'issues': ['tracked_file_missing']})
            continue
        count += 1
        problems = inspect(name, path.read_bytes())
        if problems:
            findings.append({'file': name, 'issues': problems})
    print(json.dumps({'files_checked': count, 'private_terms': len(TERMS), 'findings': findings}, ensure_ascii=False, indent=2))
    return 1 if findings else 0

if __name__ == '__main__':
    sys.exit(main())
