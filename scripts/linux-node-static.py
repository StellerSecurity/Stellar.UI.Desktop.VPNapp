"""Read the exact official Node Linux artifact as data. Never materialize or execute it."""
import hashlib
import io
import json
import lzma
import struct
import tarfile
import urllib.request

URL = 'https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz'
SHA = '5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(URL, timeout=30) as response:
        raw = response.read(64 * 1024**2 + 1)
    if len(raw) > 64 * 1024**2 or hashlib.sha256(raw).hexdigest() != SHA:
        raise ValueError('official Linux Node archive identity or byte limit')
    decoder = lzma.LZMADecompressor(memlimit=128 * 1024**2)
    expanded = decoder.decompress(raw, max_length=512 * 1024**2 + 1)
    if len(expanded) > 512 * 1024**2 or not decoder.eof or decoder.unused_data:
        raise ValueError('Linux Node XZ framing or expansion limit')
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        member = archive.getmember('node-v26.13.1-linux-x64/bin/node')
        if not member.isfile() or not 1024**2 <= member.size <= 256 * 1024**2:
            raise ValueError('bounded regular Linux Node executable required')
        native = archive.extractfile(member).read(256 * 1024**2 + 1)
    if len(native) != member.size or native[:6] != b'\x7fELF\x02\x01':
        raise ValueError('exact ELF64 little-endian Node required')
    kind, machine = struct.unpack_from('<HH', native, 16)
    entry, table = struct.unpack_from('<QQ', native, 24)
    width, count = struct.unpack_from('<HH', native, 54)
    if kind not in (2, 3) or machine != 62 or width != 56 or not 1 <= count <= 128 or table + count * width > len(native):
        raise ValueError('unexpected native ELF program-header layout')
    segments = []
    for index in range(count):
        ptype, flags, offset, address, _, size, memory, align = struct.unpack_from('<IIQQQQQQ', native, table + index * width)
        if offset + size > len(native) or size > memory:
            raise ValueError('uncontained native program segment')
        segments.append(dict(type=ptype, flags=flags, offset=offset, address=address, bytes=size,
                             memory_bytes=memory, alignment=align,
                             sha256=hashlib.sha256(native[offset:offset + size]).hexdigest()))
    if not any(row['type'] == 1 and row['flags'] & 1 and row['address'] <= entry < row['address'] + row['memory_bytes'] for row in segments):
        raise ValueError('ELF entry outside executable load segment')
    print(json.dumps(dict(version='26.13.1', archive_url=URL, archive_sha256=SHA,
                          native_sha256=hashlib.sha256(native).hexdigest(), native_bytes=len(native),
                          elf_machine=machine, segments=segments,
                          writable_executable_load_segments=sum(row['type'] == 1 and row['flags'] & 3 == 3 for row in segments),
                          independently_verified_release_signature=False, native_semantic_review_complete=False,
                          purpose='Exact isolated fixed-input tool regressions; no general runtime/release clearance.',
                          materialized=False, target_executed=False, execution_approved=False)))


if __name__ == '__main__':
    main()
