"""Dry-run reviewed backports in memory. Never extract, install or execute input."""
import hashlib
import json
import pathlib
import sys
import tarfile


BACKPORTS = [
    {
        'package': 'lzo', 'file': 'src/lzo1f_d.ch',
        'source': 'https://www.oberhumer.com/opensource/lzo/',
        'replacements': [(
            '        if (t > 31)\n            goto match;',
            '        if (t > 31) {\n            NEED_IP(1);\n            goto match;\n        }',
        )],
    },
    {
        'package': 'lz4', 'file': 'lib/lz4frame.c',
        'source': 'https://github.com/lz4/lz4/commit/f64efec011c058bd70348576438abac222fe6c82',
        'replacements': [(
            '    LZ4F_CDict* const cdict = (LZ4F_CDict*)LZ4F_malloc(sizeof(*cdict), cmem);\n'
            '    DEBUGLOG(4, "LZ4F_createCDict_advanced");\n    if (!cdict) return NULL;',
            '    LZ4F_CDict* cdict = NULL;\n'
            '    DEBUGLOG(4, "LZ4F_createCDict_advanced");\n'
            '    if (!dictStart) return NULL;\n'
            '    cdict = (LZ4F_CDict*)LZ4F_malloc(sizeof(*cdict), cmem);\n'
            '    if (!cdict) return NULL;',
        ), (
            '                             const void* srcBuffer, size_t* srcSizePtr)\n{\n'
            '    LZ4F_STATIC_ASSERT(dstage_getFrameHeader < dstage_storeFrameHeader);',
            '                             const void* srcBuffer, size_t* srcSizePtr)\n{\n'
            '    assert(dctx != NULL);\n'
            '    RETURN_ERROR_IF(frameInfoPtr == NULL, parameter_null);\n'
            '    RETURN_ERROR_IF(srcSizePtr == NULL, parameter_null);\n'
            '    LZ4F_STATIC_ASSERT(dstage_getFrameHeader < dstage_storeFrameHeader);',
        )],
    },
    {
        'package': 'pkcs11-helper', 'file': 'lib/_pkcs11h-crypto-openssl.c',
        'source': 'https://github.com/OpenSC/pkcs11-helper/commit/9c64c288384a7676c8e89258738d56f39116bd28',
        'replacements': [(
            '\t\tX509_cmp_current_time (notAfter) >= 0 &&\n\t\tnotAfter->length >= 12',
            '\t\tX509_cmp_current_time (notAfter) >= 0',
        ), (
            '\t\ttm1.tm_year = (notAfter->data[ 0] - \'0\') * 10 + (notAfter->data[ 1] - \'0\') + 100;\n'
            '\t\ttm1.tm_mon  = (notAfter->data[ 2] - \'0\') * 10 + (notAfter->data[ 3] - \'0\') - 1;\n'
            '\t\ttm1.tm_mday = (notAfter->data[ 4] - \'0\') * 10 + (notAfter->data[ 5] - \'0\');\n'
            '\t\ttm1.tm_hour = (notAfter->data[ 6] - \'0\') * 10 + (notAfter->data[ 7] - \'0\');\n'
            '\t\ttm1.tm_min  = (notAfter->data[ 8] - \'0\') * 10 + (notAfter->data[ 9] - \'0\');\n'
            '\t\ttm1.tm_sec  = (notAfter->data[10] - \'0\') * 10 + (notAfter->data[11] - \'0\');\n\n'
            '\t\t*expiration = mktime (&tm1);\n'
            '\t\t*expiration += (int)(mktime (localtime (expiration)) - mktime (gmtime (expiration)));',
            '\t\tif (ASN1_TIME_to_tm (notAfter, &tm1)) {\n'
            '\t\t\t*expiration = mktime (&tm1);\n'
            '\t\t\t*expiration += (int)(mktime (localtime (expiration)) - mktime (gmtime (expiration)));\n'
            '\t\t}',
        )],
    },
]


def patched_text(text, replacements):
    for old, new in replacements:
        if text.count(old) != 1:
            raise ValueError('Backport context must occur exactly once; source differs or is already patched')
        text = text.replace(old, new, 1)
    return text


def review(directory):
    lock = json.loads((pathlib.Path(__file__).resolve().parent / 'intel-source-lock.json').read_text())
    inputs = {item['name']: item for item in lock['artifacts']}
    result = []
    for backport in BACKPORTS:
        item = inputs[backport['package']]
        archive = directory / item['file']
        if archive.is_symlink() or not archive.is_file():
            raise ValueError('Expected a regular, non-symlink archive')
        if hashlib.sha256(archive.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Input archive checksum mismatch')
        with tarfile.open(archive, 'r:*') as source:
            member = source.getmember(f"{item['name']}-{item['version']}/{backport['file']}")
            if not member.isfile() or member.size > 1_000_000:
                raise ValueError('Expected bounded regular source file')
            original = source.extractfile(member).read()
        updated = patched_text(original.decode('utf8'), backport['replacements']).encode('utf8')
        result.append({
            'package': item['name'], 'version': item['version'], 'file': backport['file'],
            'source': backport['source'], 'inputSha256': hashlib.sha256(original).hexdigest(),
            'plannedOutputSha256': hashlib.sha256(updated).hexdigest(),
            'replacementCount': len(backport['replacements']),
        })
    return {'mode': 'in-memory dry-run only', 'extracted': False, 'executed': False,
            'installed': False, 'backports': result}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 scripts/review-intel-backports.py REVIEW_DIRECTORY')
    print(json.dumps(review(pathlib.Path(sys.argv[1]).resolve(strict=True)), indent=2))
