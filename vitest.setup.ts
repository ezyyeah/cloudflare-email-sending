import { Blob, File } from "node:buffer";
import { webcrypto } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

process.env.TZ = "UTC";

if (!globalThis.Blob) {
  Object.defineProperty(globalThis, "Blob", {
    value: Blob,
    configurable: true,
  });
}

if (!globalThis.File) {
  Object.defineProperty(globalThis, "File", {
    value: File,
    configurable: true,
  });
}

if (!globalThis.TextEncoder) {
  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoder,
    configurable: true,
  });
}

if (!globalThis.TextDecoder) {
  Object.defineProperty(globalThis, "TextDecoder", {
    value: TextDecoder,
    configurable: true,
  });
}

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}
