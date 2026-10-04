"""
seal.py — password-encrypt the app data (stdlib only, no pip install needed).

Format (all base64 inside JSON):
    {"enc": 1, "kdf": "PBKDF2-SHA256", "iter": N, "salt": ..., "iv": ..., "ct": ..., "mac": ...}

    keys = PBKDF2-HMAC-SHA256(password, salt, iter, 64 bytes)
    ct   = AES-256-CTR(keys[:32], iv)  — counter = low 64 bits of iv, big-endian, wraps mod 2^64
    mac  = HMAC-SHA256(keys[32:], iv + ct)          (encrypt-then-MAC)

The browser side (app.js) does the same with WebCrypto:
    PBKDF2 deriveBits 512 → AES-CTR {counter: iv, length: 64} + HMAC verify.
"""
import base64, hashlib, hmac, json, os

# ---------- AES-256 (encryption direction only; table-based) ----------
_SBOX = [0] * 256
_p = _q = 1
while True:  # generate the S-box
    _p = _p ^ ((_p << 1) & 0xFF) ^ (0x1B if _p & 0x80 else 0)
    _q ^= _q << 1; _q ^= _q << 2; _q ^= _q << 4; _q &= 0xFF
    if _q & 0x80: _q ^= 0x09
    _x = _q ^ ((_q << 1) | (_q >> 7)) ^ ((_q << 2) | (_q >> 6)) ^ ((_q << 3) | (_q >> 5)) ^ ((_q << 4) | (_q >> 4))
    _SBOX[_p] = (_x ^ 0x63) & 0xFF
    if _p == 1: break
_SBOX[0] = 0x63


def _xt(a): return ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else a << 1


_T0 = [((_xt(s) << 24) | (s << 16) | (s << 8) | (_xt(s) ^ s)) for s in _SBOX]
_T1 = [((t >> 8) | ((t & 0xFF) << 24)) for t in _T0]
_T2 = [((t >> 8) | ((t & 0xFF) << 24)) for t in _T1]
_T3 = [((t >> 8) | ((t & 0xFF) << 24)) for t in _T2]
_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40]


def _expand(key: bytes):
    assert len(key) == 32
    w = [int.from_bytes(key[i:i + 4], "big") for i in range(0, 32, 4)]
    S = _SBOX
    for i in range(8, 60):
        t = w[i - 1]
        if i % 8 == 0:
            t = ((S[(t >> 16) & 0xFF] << 24) | (S[(t >> 8) & 0xFF] << 16) | (S[t & 0xFF] << 8) | S[t >> 24]) ^ (_RCON[i // 8 - 1] << 24)
        elif i % 8 == 4:
            t = (S[t >> 24] << 24) | (S[(t >> 16) & 0xFF] << 16) | (S[(t >> 8) & 0xFF] << 8) | S[t & 0xFF]
        w.append(w[i - 8] ^ t)
    return w


def _encrypt_block(w, block: bytes) -> bytes:
    T0, T1, T2, T3, S = _T0, _T1, _T2, _T3, _SBOX
    s0 = int.from_bytes(block[0:4], "big") ^ w[0]
    s1 = int.from_bytes(block[4:8], "big") ^ w[1]
    s2 = int.from_bytes(block[8:12], "big") ^ w[2]
    s3 = int.from_bytes(block[12:16], "big") ^ w[3]
    k = 4
    for _ in range(13):
        t0 = T0[s0 >> 24] ^ T1[(s1 >> 16) & 0xFF] ^ T2[(s2 >> 8) & 0xFF] ^ T3[s3 & 0xFF] ^ w[k]
        t1 = T0[s1 >> 24] ^ T1[(s2 >> 16) & 0xFF] ^ T2[(s3 >> 8) & 0xFF] ^ T3[s0 & 0xFF] ^ w[k + 1]
        t2 = T0[s2 >> 24] ^ T1[(s3 >> 16) & 0xFF] ^ T2[(s0 >> 8) & 0xFF] ^ T3[s1 & 0xFF] ^ w[k + 2]
        t3 = T0[s3 >> 24] ^ T1[(s0 >> 16) & 0xFF] ^ T2[(s1 >> 8) & 0xFF] ^ T3[s2 & 0xFF] ^ w[k + 3]
        s0, s1, s2, s3 = t0, t1, t2, t3
        k += 4
    out = []
    for a, b, c, d, wk in ((s0, s1, s2, s3, w[k]), (s1, s2, s3, s0, w[k + 1]), (s2, s3, s0, s1, w[k + 2]), (s3, s0, s1, s2, w[k + 3])):
        out.append(((S[a >> 24] << 24) | (S[(b >> 16) & 0xFF] << 16) | (S[(c >> 8) & 0xFF] << 8) | S[d & 0xFF]) ^ wk)
    return b"".join(x.to_bytes(4, "big") for x in out)


def aes256_ctr(key: bytes, iv: bytes, data: bytes) -> bytes:
    w = _expand(key)
    hi, lo = iv[:8], int.from_bytes(iv[8:], "big")
    stream = bytearray()
    for i in range((len(data) + 15) // 16):
        stream += _encrypt_block(w, hi + ((lo + i) & 0xFFFFFFFFFFFFFFFF).to_bytes(8, "big"))
    n = len(data)
    return (int.from_bytes(data, "big") ^ int.from_bytes(bytes(stream[:n]), "big")).to_bytes(n, "big") if n else b""


# ---------- envelope ----------
ITER = 310_000
b64 = lambda b: base64.b64encode(b).decode()


def derive(password: str, salt: bytes, iterations: int = ITER) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=64)


def seal(plaintext: bytes, password: str, salt: bytes, iterations: int = ITER) -> dict:
    keys = derive(password, salt, iterations)
    iv = os.urandom(16)
    ct = aes256_ctr(keys[:32], iv, plaintext)
    mac = hmac.new(keys[32:], iv + ct, hashlib.sha256).digest()
    return {"enc": 1, "kdf": "PBKDF2-SHA256", "iter": iterations, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct), "mac": b64(mac)}


def unseal(env: dict, password: str) -> bytes:
    d = lambda k: base64.b64decode(env[k])
    keys = derive(password, d("salt"), env["iter"])
    if not hmac.compare_digest(hmac.new(keys[32:], d("iv") + d("ct"), hashlib.sha256).digest(), d("mac")):
        raise ValueError("wrong password")
    return aes256_ctr(keys[:32], d("iv"), d("ct"))
