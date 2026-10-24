"""EDEN Marble core: canonical JSON, RFC 6962 Merkle trees, Ed25519.

STATUS: REBUILT v2 (22 Oct 2026). Standard library only. Uses the
`cryptography` package for Ed25519 when present, else a pure-Python
RFC 8032 implementation (slow, but signing happens once per pass/alert).

Merkle hashing follows RFC 6962 / RFC 9162:
  leaf = SHA256(0x00 || data), node = SHA256(0x01 || left || right)
"""
import hashlib
import json

# ------------------------------------------------------------ canonical JSON
def canon(obj):
    """Deterministic JSON bytes: sorted keys, no whitespace, UTF-8."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def sha256(b):
    return hashlib.sha256(b).digest()


# ------------------------------------------------------------ Merkle (RFC 6962)
def _leaf(data):
    return sha256(b"\x00" + data)


def _node(left, right):
    return sha256(b"\x01" + left + right)


def _split(n):
    """Largest power of two strictly less than n (n >= 2)."""
    k = 1
    while k << 1 < n:
        k <<= 1
    return k


def _subroot(h, lo, hi):
    n = hi - lo
    if n == 1:
        return h[lo]
    k = _split(n)
    return _node(_subroot(h, lo, lo + k), _subroot(h, lo + k, hi))


EMPTY_ROOT = sha256(b"")


def merkle_root(leaves):
    if not leaves:
        return EMPTY_ROOT
    return _subroot([_leaf(x) for x in leaves], 0, len(leaves))


def root_from_leaf_hashes(h):
    return _subroot(h, 0, len(h)) if h else EMPTY_ROOT


def inclusion_proof(leaves, m):
    """Audit path for leaf m (RFC 9162 2.1.3.1)."""
    h = [_leaf(x) for x in leaves]
    return inclusion_proof_from_hashes(h, m)


def inclusion_proof_from_hashes(h, m):
    if not 0 <= m < len(h):
        raise ValueError("index out of range")

    def path(m, lo, hi):
        n = hi - lo
        if n == 1:
            return []
        k = _split(n)
        if m < k:
            return path(m, lo, lo + k) + [_subroot(h, lo + k, hi)]
        return path(m - k, lo + k, hi) + [_subroot(h, lo, lo + k)]

    return path(m, 0, len(h))


def verify_inclusion(leaf_data, index, size, path, root):
    """RFC 9162 2.1.3.2."""
    if not 0 <= index < size:
        return False
    fn, sn = index, size - 1
    r = _leaf(leaf_data)
    for p in path:
        if sn == 0:
            return False
        if fn & 1 or fn == sn:
            r = _node(p, r)
            if not fn & 1:
                while fn and not fn & 1:
                    fn >>= 1
                    sn >>= 1
        else:
            r = _node(r, p)
        fn >>= 1
        sn >>= 1
    return sn == 0 and r == root


def consistency_proof(leaves, m):
    return consistency_proof_from_hashes([_leaf(x) for x in leaves], m)


def consistency_proof_from_hashes(h, m):
    """Proof that the size-m tree is a prefix of the size-n tree (RFC 9162 2.1.4.1)."""
    n = len(h)
    if not 0 < m <= n:
        raise ValueError("need 0 < m <= n")

    def sub(m, lo, hi, b):
        size = hi - lo
        if m == size:
            return [] if b else [_subroot(h, lo, hi)]
        k = _split(size)
        if m <= k:
            return sub(m, lo, lo + k, b) + [_subroot(h, lo + k, hi)]
        return sub(m - k, lo + k, hi, False) + [_subroot(h, lo, lo + k)]

    return sub(m, 0, n, True)


def verify_consistency(first, second, first_hash, second_hash, path):
    """RFC 9162 2.1.4.2."""
    if not 0 < first <= second:
        return False
    if first == second:
        return not path and first_hash == second_hash
    path = list(path)
    if first & (first - 1) == 0:          # first is a power of two
        path = [first_hash] + path
    if not path:
        return False
    fn, sn = first - 1, second - 1
    while fn & 1:
        fn >>= 1
        sn >>= 1
    fr = sr = path[0]
    for c in path[1:]:
        if sn == 0:
            return False
        if fn & 1 or fn == sn:
            fr = _node(c, fr)
            sr = _node(c, sr)
            if not fn & 1:
                while fn and not fn & 1:
                    fn >>= 1
                    sn >>= 1
        else:
            sr = _node(sr, c)
        fn >>= 1
        sn >>= 1
    return sn == 0 and fr == first_hash and sr == second_hash


class StreamingTree:
    """Compact-range Merkle state: O(log n) memory.

    append() returns the audit path of the leaf just added, read straight
    off the state, so an alert needs no journal re-read.
    """

    def __init__(self):
        self.size = 0
        self.peaks = []  # list of (height, hash), left to right

    def append_leaf_hash(self, lh):
        merged = []
        node, height = lh, 0
        while self.peaks and self.peaks[-1][0] == height:
            _, left = self.peaks.pop()
            merged.append(left)
            node = _node(left, node)
            height += 1
        self.peaks.append((height, node))
        self.size += 1
        # path = siblings inside the last peak, then the other peaks right-to-left
        return merged + [h for _, h in reversed(self.peaks[:-1])]

    def append(self, data):
        return self.append_leaf_hash(_leaf(data))

    def root(self):
        if not self.peaks:
            return EMPTY_ROOT
        r = self.peaks[-1][1]
        for _, h in reversed(self.peaks[:-1]):
            r = _node(h, r)
        return r


# ------------------------------------------------------------ Ed25519
import os as _os

try:  # pragma: no cover - depends on platform
    if _os.environ.get("EDEN_FORCE_PURE_PYTHON") == "1":
        raise ImportError("forced pure-Python Ed25519")
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey, Ed25519PublicKey)
    from cryptography.exceptions import InvalidSignature
    HAVE_CRYPTOGRAPHY = True
except Exception:  # pragma: no cover
    HAVE_CRYPTOGRAPHY = False

# Pure-Python RFC 8032 (reference style; not constant-time - ground/test use
# and fallback only; a flight build would use a vetted library).
_p = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _p - 2, _p) % _p
_I = pow(2, (_p - 1) // 4, _p)


def _xrecover(y):
    xx = (y * y - 1) * pow(_d * y * y + 1, _p - 2, _p)
    x = pow(xx, (_p + 3) // 8, _p)
    if (x * x - xx) % _p:
        x = x * _I % _p
    if x % 2:
        x = _p - x
    return x


_By = 4 * pow(5, _p - 2, _p) % _p
_B = (_xrecover(_By), _By, 1, _xrecover(_By) * _By % _p)


def _add(P, Q):
    x1, y1, z1, t1 = P
    x2, y2, z2, t2 = Q
    A = (y1 - x1) * (y2 - x2) % _p
    B = (y1 + x1) * (y2 + x2) % _p
    C = t1 * 2 * _d * t2 % _p
    D = z1 * 2 * z2 % _p
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _p, G * H % _p, F * G % _p, E * H % _p)


def _mul(s, P):
    Q = (0, 1, 1, 0)
    while s:
        if s & 1:
            Q = _add(Q, P)
        P = _add(P, P)
        s >>= 1
    return Q


def _enc(P):
    x, y, z, _ = P
    zi = pow(z, _p - 2, _p)
    x, y = x * zi % _p, y * zi % _p
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _dec(s):
    if len(s) != 32:
        raise ValueError("bad point")
    y = int.from_bytes(s, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    if y >= _p:
        raise ValueError("bad point")
    x = _xrecover(y)
    if (x * x * -1 + y * y - 1 - _d * x * x * y * y) % _p:
        raise ValueError("not on curve")
    if x & 1 != sign:
        if x == 0:
            raise ValueError("bad point")
        x = _p - x
    return (x, y, 1, x * y % _p)


def _h(m):
    return int.from_bytes(hashlib.sha512(m).digest(), "little")


def _expand(seed):
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def py_public(seed):
    a, _ = _expand(seed)
    return _enc(_mul(a, _B))


def py_sign(seed, msg):
    a, prefix = _expand(seed)
    A = _enc(_mul(a, _B))
    r = _h(prefix + msg) % _L
    R = _enc(_mul(r, _B))
    S = (r + _h(R + A + msg) * a) % _L
    return R + S.to_bytes(32, "little")


def py_verify(pub, msg, sig):
    try:
        if len(sig) != 64:
            return False
        A = _dec(pub)
        R = _dec(sig[:32])
        S = int.from_bytes(sig[32:], "little")
        if S >= _L:
            return False
        k = _h(sig[:32] + pub + msg) % _L
        return _enc(_mul(S, _B)) == _enc(_add(R, _mul(k, A)))
    except ValueError:
        return False


def backend():
    return "cryptography" if HAVE_CRYPTOGRAPHY else "pure-python RFC 8032"


def public_from_seed(seed):
    if HAVE_CRYPTOGRAPHY:
        from cryptography.hazmat.primitives import serialization as s
        return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
            s.Encoding.Raw, s.PublicFormat.Raw)
    return py_public(seed)


def sign(seed, msg):
    if HAVE_CRYPTOGRAPHY:
        return Ed25519PrivateKey.from_private_bytes(seed).sign(msg)
    return py_sign(seed, msg)


def verify(pub, msg, sig):
    if HAVE_CRYPTOGRAPHY:
        try:
            Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg)
            return True
        except (InvalidSignature, ValueError):
            return False
    return py_verify(pub, msg, sig)


def key_id(pub):
    return hashlib.sha256(pub).hexdigest()[:16]
