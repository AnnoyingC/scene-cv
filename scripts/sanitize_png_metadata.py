"""Remove PNG text/EXIF/time metadata without recompressing image pixels."""
from pathlib import Path
import struct
import sys

METADATA = {b'tEXt', b'zTXt', b'iTXt', b'eXIf', b'tIME'}


def strip_metadata(filename):
    path = Path(filename)
    data = path.read_bytes()
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError(f'Not a PNG: {path.name}')
    chunks = [data[:8]]
    pos, removed, kind = 8, 0, b''
    while pos + 12 <= len(data):
        size = struct.unpack_from('>I', data, pos)[0]
        end = pos + size + 12
        if end > len(data):
            raise ValueError(f'Truncated PNG: {path.name}')
        kind = data[pos + 4:pos + 8]
        if kind in METADATA:
            removed += 1
        else:
            chunks.append(data[pos:end])
        pos = end
        if kind == b'IEND':
            break
    if pos != len(data) or kind != b'IEND':
        raise ValueError(f'Invalid PNG ending: {path.name}')
    if removed:
        path.write_bytes(b''.join(chunks))
    return removed


if __name__ == '__main__':
    for filename in sys.argv[1:]:
        print(f'{Path(filename).name}: removed {strip_metadata(filename)} metadata chunks')
