/* Local library smoke test. No sockets, VPN, providers, keys or account data. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <lz4.h>
#include <lzo/lzo1x.h>
#include <openssl/evp.h>
#include <openssl/ssl.h>
#include <pkcs11-helper-1.0/pkcs11h-core.h>

int main(void) {
    static const unsigned char expected[32] = {
        0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
        0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad
    };
    unsigned char digest[EVP_MAX_MD_SIZE]; unsigned int digest_size = 0;
    assert(EVP_Digest("abc", 3, digest, &digest_size, EVP_sha256(), NULL) == 1);
    assert(digest_size == 32 && memcmp(digest, expected, 32) == 0);
    SSL_CTX *tls = SSL_CTX_new(TLS_client_method()); assert(tls != NULL); SSL_CTX_free(tls);
    char input[4096], compressed[8192], restored[4096];
    for (size_t i = 0; i < sizeof(input); i++) input[i] = (char)(i % 113);
    int length = LZ4_compress_default(input, compressed, sizeof(input), sizeof(compressed));
    assert(length > 0);
    assert(LZ4_decompress_safe(compressed, restored, length, sizeof(restored)) == sizeof(input));
    assert(memcmp(input, restored, sizeof(input)) == 0);
    assert(lzo_init() == LZO_E_OK);
    void *work = malloc(LZO1X_1_MEM_COMPRESS); assert(work != NULL);
    lzo_uint packed = sizeof(compressed), unpacked = sizeof(restored);
    assert(lzo1x_1_compress((const lzo_bytep)input, sizeof(input), (lzo_bytep)compressed, &packed, work) == LZO_E_OK);
    assert(lzo1x_decompress_safe((const lzo_bytep)compressed, packed, (lzo_bytep)restored, &unpacked, NULL) == LZO_E_OK);
    assert(unpacked == sizeof(input) && memcmp(input, restored, sizeof(input)) == 0);
    free(work);
    assert(pkcs11h_getVersion() != 0); /* Metadata only; never initialize a token/provider. */
    puts("PASS: SHA-256 known vector, TLS context, LZ4/LZO round trips, PKCS11 version");
    return 0;
}
