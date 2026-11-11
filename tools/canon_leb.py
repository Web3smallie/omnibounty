"""Canonicalize padded LEB128 immediates in wasm modules for nearcore.

Background: LLVM 19+ pads code-section LEB128 immediates to 5 bytes
(80 80 80 80 00). nearcore's strict parser reads most immediates as
LEB (fine) but reads the `call_indirect` table index and the
`memory.size`/`memory.grow` reserved byte as ONE byte, so it sees
0x80 = 128 instead of 0 and rejects the module with
`PrepareError(Deserialization)` (verified against parity-wasm 0.42,
which is what nearcore 1.35 uses; sandbox 2.x behaves the same).

This script rewrites exactly those immediates to the canonical single
0x00 byte and fixes up the enclosing body/section size fields. Nothing
else changes: every other section is copied verbatim, and any
unexpected byte pattern aborts loudly instead of guessing.

Verification basis: the rewritten modules' patch sites are
byte-identical (function, offset, values) to the reference `wasmparser`
decoder's listing; the mock contract executes correctly under V8; and
the full xsuite passes on sandbox 2.9.0 with rewritten artifacts.

Usage:
    python canon_leb.py INPUT OUTPUT      # rewrite (OUTPUT may equal INPUT)
    python canon_leb.py --check FILE      # exit 0 iff no padded sites remain

Only stdlib is used. Exit 1 with a message on any error.
"""

import sys


def read_uleb(buf, pos):
    out = 0
    shift = 0
    start = pos
    while True:
        b = buf[pos]
        pos += 1
        out |= (b & 0x7F) << shift
        if not b & 0x80:
            return out, pos, pos - start
        shift += 7


def read_sleb(buf, pos, nbytes=10):
    out = 0
    shift = 0
    for _ in range(nbytes):
        b = buf[pos]
        pos += 1
        out |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            if b & 0x40:
                out -= 1 << shift
            return out, pos
    raise ValueError("sleb too long")


def enc_uleb(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def memargs(buf, pos):
    _, pos, _ = read_uleb(buf, pos)
    _, pos, _ = read_uleb(buf, pos)
    return pos


ULEB1 = set(range(0x0C, 0x0E)) | {0x10, 0x12, 0x13, 0x20, 0x21, 0x22,
                                  0x23, 0x24, 0x25, 0x26, 0xD2}
MEM = set(range(0x28, 0x3F))
FIXED = {0x43: 4, 0x44: 8}


def walk_body(code, patched):
    """Walk one function body. When patched is None, only validate the
    walk; otherwise append the rewritten body bytes. Returns the list of
    (kind, length) sites found."""
    pos = 0
    end = len(code)
    out = bytearray() if patched is not None else None
    sites = []
    while pos < end:
        start = pos
        op = code[pos]
        pos += 1
        if op in (0x00, 0x01, 0x05, 0x0B, 0x0F):
            emit = code[start:pos]
        elif op in (0x02, 0x03, 0x04):
            _, pos = read_sleb(code, pos)
            emit = code[start:pos]
        elif op == 0x1C:
            cnt, pos, _ = read_uleb(code, pos)
            pos += cnt
            emit = code[start:pos]
        elif op in ULEB1 or op in FIXED or op in (0x41, 0x42):
            if op in FIXED:
                pos += FIXED[op]
            elif op in (0x41, 0x42):
                _, pos = read_sleb(code, pos)
            else:
                _, pos, _ = read_uleb(code, pos)
            emit = code[start:pos]
        elif op in MEM:
            pos = memargs(code, pos)
            emit = code[start:pos]
        elif op == 0x0E:
            cnt, pos, _ = read_uleb(code, pos)
            for _ in range(cnt + 1):
                _, pos, _ = read_uleb(code, pos)
            emit = code[start:pos]
        elif op == 0x11:  # call_indirect: typeidx LEB + table byte
            _, pos, _ = read_uleb(code, pos)
            head = code[start:pos]
            v, pos, ln = read_uleb(code, pos)
            if v != 0:
                raise ValueError(f"call_indirect nonzero table {v}")
            sites.append(("call_indirect", ln))
            emit = head + b"\x00"
        elif op in (0x3F, 0x40):  # memory.size/grow reserved byte
            v, pos, ln = read_uleb(code, pos)
            if v != 0:
                raise ValueError(f"memory reserved nonzero {v}")
            sites.append(("mem_reserved", ln))
            emit = bytes([op]) + b"\x00"
        elif op in (0xD0, 0xD1):
            pos += 1
            emit = code[start:pos]
        elif op == 0xFC:
            sub, pos, _ = read_uleb(code, pos)
            if sub in (0x08,) or sub in range(0x0B, 0x11):
                pos = memargs(code, pos)
            elif sub == 0x0A:
                pos = memargs(code, pos)
                _, pos, _ = read_uleb(code, pos)
            elif sub > 0x11:
                raise ValueError(f"unknown FC subop {sub}")
            emit = code[start:pos]
        elif op in (0xFB, 0xFD, 0xFE) or op in range(0x06, 0x0A):
            raise ValueError(f"unsupported prefix op {op:#x}")
        else:
            emit = code[start:pos]
        if out is not None:
            out += emit
    return sites, bytes(out) if out is not None else None


def iter_bodies(buf):
    """Yield (section_id, raw_bytes) for every section; code-section
    caller handles function bodies itself."""
    if buf[:4] != b"\x00asm" or buf[4:8] != b"\x01\x00\x00\x00":
        raise ValueError("bad wasm header")
    pos = 8
    while pos < len(buf):
        sid = buf[pos]
        pos += 1
        size, pos, _ = read_uleb(buf, pos)
        yield sid, buf[pos:pos + size]
        pos += size


def rewrite(path, dest):
    buf = open(path, "rb").read()
    out = bytearray(buf[:8])
    kinds = {}
    for sid, body in iter_bodies(buf):
        if sid != 10:
            out.append(sid)
            out += enc_uleb(len(body))
            out += body
            continue
        cpos = 0
        cnt, cpos, _ = read_uleb(body, cpos)
        new_code = bytearray(enc_uleb(cnt))
        for _ in range(cnt):
            bsize, cpos, _ = read_uleb(body, cpos)
            bend = cpos + bsize
            nloc, cps, _ = read_uleb(body, cpos)
            loc_end = cps
            for _ in range(nloc):
                _, loc_end, _ = read_uleb(body, loc_end)
                loc_end += 1
            sites, new = walk_body(body[loc_end:bend], True)
            for kind, _ in sites:
                kinds[kind] = kinds.get(kind, 0) + 1
            new_body = bytes(body[cpos:loc_end]) + new
            new_code += enc_uleb(len(new_body))
            new_code += new_body
            cpos = bend
        if cpos != len(body):
            raise ValueError("code section walk desync")
        out.append(10)
        out += enc_uleb(len(new_code))
        out += new_code
    open(dest, "wb").write(bytes(out))
    total = sum(kinds.values())
    print(f"{path}: {total} sites canonicalized {kinds}, "
          f"{len(buf)} -> {len(out)} bytes")


def check(path):
    buf = open(path, "rb").read()
    padded = 0
    for sid, body in iter_bodies(buf):
        if sid != 10:
            continue
        cpos = 0
        cnt, cpos, _ = read_uleb(body, cpos)
        for _ in range(cnt):
            bsize, cpos, _ = read_uleb(body, cpos)
            bend = cpos + bsize
            nloc, cps, _ = read_uleb(body, cpos)
            loc_end = cps
            for _ in range(nloc):
                _, loc_end, _ = read_uleb(body, loc_end)
                loc_end += 1
            sites, _ = walk_body(body[loc_end:bend], None)
            padded += sum(1 for _, ln in sites if ln > 1)
            cpos = bend
    if padded:
        print(f"{path}: {padded} padded sites remain")
        return 1
    print(f"{path}: canonical")
    return 0


def main(argv):
    if len(argv) == 3 and argv[1] == "--check":
        try:
            return check(argv[2])
        except (OSError, ValueError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
    if len(argv) != 3:
        print("usage: canon_leb.py INPUT OUTPUT | canon_leb.py --check FILE",
              file=sys.stderr)
        return 2
    try:
        rewrite(argv[1], argv[2])
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
