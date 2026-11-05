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
PRIVATE_ROOTS = {'.claude', 'vendor-src', 'dist', 'learning', 'learning-records', 'node_modules'}
PRIVATE_FILES = {'MISSION.md', 'GLOSSARY.md', 'RESOURCES.md', '.env', '.envrc'}
PATTERNS = {
    'personal_home_path': rb'/(?:Users|home)/[^/\s\x00]+/',
    'private_key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'access_token': rb'\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{15,})\b',
    'url_credentials': rb'https?://[^\s/@]+:[^\s/@]+@',
}

def inspect(name, data):
    problems = []
    path = Path(name)
    if path.parts[0] in PRIVATE_ROOTS or name in PRIVATE_FILES or (path.name.startswith('.env.') and path.name != '.env.example'):
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
    print(json.dumps({'files_checked': count, 'findings': findings}, ensure_ascii=False, indent=2))
    return 1 if findings else 0

if __name__ == '__main__':
    sys.exit(main())
