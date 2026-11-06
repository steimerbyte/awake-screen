#!/usr/bin/env python3
"""Verify a CRX3 package without loading it into a browser.

Checks, in order: magic and version, that the embedded public key matches the one
pinned in manifest.json, that the CRX ID derives from that key, the RSA signature
over the SignedData blob plus payload, the zip payload's CRCs, and that the payload
is byte-identical to the staging directory it was built from.

    python3 tools/verify-crx.py dist/awake-screen-1.0.0.crx --source /tmp/awake-dist

Exits 0 only when every check passes.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile


def varint(buf, i):
    value = shift = 0
    while True:
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7


def fields(buf):
    i, out = 0, []
    while i < len(buf):
        key, i = varint(buf, i)
        number, wire = key >> 3, key & 7
        if wire == 2:
            length, i = varint(buf, i)
            out.append((number, buf[i:i + length]))
            i += length
        elif wire == 0:
            value, i = varint(buf, i)
            out.append((number, value))
        else:
            raise ValueError(f"unsupported wire type {wire}")
    return out


def extension_id(pubkey_der):
    nibbles = hashlib.sha256(pubkey_der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in nibbles)


def fail(message):
    print(f"FAIL  {message}")
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("crx")
    ap.add_argument("--source", required=True, help="staging directory the CRX was packed from")
    ap.add_argument("--manifest", default="manifest.json")
    args = ap.parse_args()

    raw = open(args.crx, "rb").read()
    if raw[:4] != b"Cr24":
        fail("missing Cr24 magic")
    version, header_len = struct.unpack("<II", raw[4:12])
    if version != 3:
        fail(f"CRX version {version}, expected 3")
    header = raw[12:12 + header_len]
    payload = raw[12 + header_len:]

    proofs = [v for n, v in fields(header) if n == 2]
    signed = [v for n, v in fields(header) if n == 10000]
    if not proofs or not signed:
        fail("header lacks a sha256_with_rsa proof or signed_header_data")
    proof = dict(fields(proofs[0]))
    pubkey, signature = proof[1], proof[2]
    crx_id = dict(fields(signed[0]))[1]
    if len(crx_id) != 16:
        fail(f"crx_id is {len(crx_id)} bytes, expected 16")
    print(f"ok    header: version 3, {header_len} header bytes, {len(proofs)} proof(s), "
          f"{len(payload)} payload bytes")

    pinned = json.load(open(args.manifest))["key"]
    if base64.b64decode(pinned) != pubkey:
        fail("payload public key differs from manifest 'key'")
    derived = extension_id(pubkey)
    if crx_id.hex() != hashlib.sha256(pubkey).hexdigest()[:32]:
        fail("crx_id is not sha256(public_key)[:16]")
    print(f"ok    extension id {derived} (derived, matches manifest key)")

    blob = b"CRX3 SignedData\x00" + struct.pack("<I", len(signed[0])) + signed[0] + payload
    work = tempfile.mkdtemp()
    try:
        for name, data in (("data.bin", blob), ("sig.bin", signature), ("der.bin", pubkey)):
            open(os.path.join(work, name), "wb").write(data)
        proc = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", os.path.join(work, "der.bin"),
             "-keyform", "DER", "-signature", os.path.join(work, "sig.bin"),
             os.path.join(work, "data.bin")],
            capture_output=True, text=True)
        output = (proc.stdout + proc.stderr).strip()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if proc.returncode != 0 or "Verified OK" not in output:
        fail(f"signature: {output}")
    print(f"ok    signature: {output}")

    zf = zipfile.ZipFile(io.BytesIO(payload))
    bad = zf.testzip()
    if bad is not None:
        fail(f"payload CRC error in {bad}")
    names = [n for n in zf.namelist() if not n.endswith("/")]
    if any(n.endswith(".pem") for n in names):
        fail("payload contains a .pem file (signing key must never ship)")
    print(f"ok    payload: {len(names)} files, CRCs clean, no key material")

    source_files = {}
    for root, _, files in os.walk(args.source):
        for name in files:
            path = os.path.join(root, name)
            source_files[os.path.relpath(path, args.source)] = open(path, "rb").read()
    if set(source_files) != set(names):
        fail(f"payload/source file set differs: "
             f"only in payload {sorted(set(names) - set(source_files))}, "
             f"only in source {sorted(set(source_files) - set(names))}")
    differing = [n for n in names if zf.read(n) != source_files[n]]
    if differing:
        fail(f"payload differs from source: {differing}")
    print(f"ok    payload is byte-identical to {args.source}")
    print(f"\nALL CHECKS PASSED  {args.crx}")


if __name__ == "__main__":
    main()
