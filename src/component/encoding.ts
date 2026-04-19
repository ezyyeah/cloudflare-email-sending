const BASE64_BODY_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function normalizeBase64(input: string): string {
  const normalized = input.replace(/\s+/g, "");
  if (normalized.length === 0) {
    throw new Error("Attachment content must not be empty.");
  }
  if (normalized.length % 4 !== 0 || !BASE64_BODY_PATTERN.test(normalized)) {
    throw new Error("Attachment content must be valid base64.");
  }
  return normalized;
}

export function estimateBase64DecodedBytes(base64: string): number {
  const normalized = normalizeBase64(base64);
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  return (normalized.length / 4) * 3 - padding;
}

export function decodeBase64(base64: string): Uint8Array {
  const normalized = normalizeBase64(base64);
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(normalized, "base64"));
  }

  const binary = atob(normalized);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

export function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return encodeBase64(new Uint8Array(buffer));
}
