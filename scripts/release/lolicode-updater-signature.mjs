// Minisign framing follows minisign-verify 0.2.5, used by Tauri updater v2.
// Crypto operations use Node's OpenSSL Ed25519 and BLAKE2b implementations.
// This module handles public keys/signatures only; it never reads a private key.
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";

export const UPSTREAM_KEY_FINGERPRINT =
  "c5ceddd722e747d9cfb754779356cc6e20abe1580ac65723a4253c79ba3c157e";

function base64(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error(`Invalid ${label} base64.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error(`Non-canonical ${label} base64.`);
  return bytes;
}

function tauriText(value, label) {
  if (typeof value !== "string" || value.length > 16384)
    throw new Error(`Invalid ${label}.`);
  const bytes = base64(value.trim(), label);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    throw new Error(`Invalid ${label} UTF-8.`);
  return text.trimEnd().split(/\r?\n/);
}

export function parsePublicKey(encoded) {
  const lines = tauriText(encoded, "public key");
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: "))
    throw new Error("Expected a Tauri public key, not a private key or path.");
  const raw = base64(lines[1], "public key");
  if (
    raw.length !== 42 ||
    !["Ed", "ED"].includes(raw.subarray(0, 2).toString("ascii"))
  )
    throw new Error("Unsupported Minisign public key.");
  return {
    encoded: encoded.trim(),
    raw,
    keyId: raw.subarray(2, 10),
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    key: createPublicKey({
      // RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key.
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        raw.subarray(10),
      ]),
      format: "der",
      type: "spki",
    }),
  };
}

export function parseSignature(encoded) {
  const lines = tauriText(encoded, "signature");
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  )
    throw new Error("Invalid Minisign signature framing.");
  const raw = base64(lines[1], "signature"),
    global = base64(lines[3], "global signature");
  const algorithm = raw.subarray(0, 2).toString("ascii");
  if (
    raw.length !== 74 ||
    global.length !== 64 ||
    !["ED", "Ed"].includes(algorithm)
  )
    throw new Error("Unsupported Minisign signature.");
  return {
    encoded: encoded.trim(),
    algorithm,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    global,
    trustedComment: Buffer.from(
      lines[2].slice("trusted comment: ".length),
      "utf8",
    ),
  };
}

function checkSignatures(key, signature, message) {
  if (!key.keyId.equals(signature.keyId))
    throw new Error("Signature public key ID does not match.");
  if (!verify(null, message, key.key, signature.signature))
    throw new Error("Installer signature verification failed.");
  if (
    !verify(
      null,
      Buffer.concat([signature.signature, signature.trustedComment]),
      key.key,
      signature.global,
    )
  )
    throw new Error("Signature trusted-comment verification failed.");
}

export function verifySignatureBytes(bytes, encodedSignature, encodedKey) {
  const key = parsePublicKey(encodedKey),
    signature = parseSignature(encodedSignature);
  const message =
    signature.algorithm === "ED"
      ? createHash("blake2b512").update(bytes).digest()
      : bytes;
  checkSignatures(key, signature, message);
  return key.fingerprint;
}

export async function verifySignatureFile(
  filename,
  encodedSignature,
  encodedKey,
) {
  const key = parsePublicKey(encodedKey),
    signature = parseSignature(encodedSignature);
  // Modern signatures hash the complete artifact without buffering the installer.
  if (signature.algorithm === "ED") {
    const hash = createHash("blake2b512");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    checkSignatures(key, signature, hash.digest());
  } else {
    // Tauri updater also accepts the old, non-prehashed Ed format.
    checkSignatures(key, signature, readFileSync(filename));
  }
  return key.fingerprint;
}
