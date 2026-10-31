const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Rewrite routing fields in JSON already validated by the request parser.
 * Do not parse/stringify the body: tool schemas can contain numbers that cannot
 * round-trip through JavaScript, and raw endpoints must preserve unrelated bytes.
 */
export function rewriteRawJsonModel(buffer: ArrayBuffer, model: string): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  const replacement = encoder.encode(JSON.stringify(model));
  let length = bytes.length;
  let matches = 0;
  visitModelValues(bytes, (start, end) => {
    length += replacement.length - (end - start);
    matches++;
  });
  if (matches === 0) {
    throw new Error("Expected a top-level model in validated raw JSON");
  }

  const result = new Uint8Array(length);
  let sourceOffset = 0;
  let targetOffset = 0;
  // Two passes keep memory bounded even for many duplicate model keys. Rewrite
  // all occurrences so first-key and last-key parsers agree on the routing model.
  visitModelValues(bytes, (start, end) => {
    result.set(bytes.subarray(sourceOffset, start), targetOffset);
    targetOffset += start - sourceOffset;
    result.set(replacement, targetOffset);
    targetOffset += replacement.length;
    sourceOffset = end;
  });
  result.set(bytes.subarray(sourceOffset), targetOffset);
  return result.buffer;
}

function visitModelValues(bytes: Uint8Array, visit: (start: number, end: number) => void): void {
  // TextDecoder accepts a UTF-8 BOM at the parsing boundary; preserve it here.
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let offset = skipWhitespace(bytes, bom) + 1; // Root opening brace.
  while (true) {
    offset = skipWhitespace(bytes, offset);
    if (bytes[offset] === 0x7d) return;
    const keyStart = offset;
    const keyEnd = skipString(bytes, keyStart);
    const start = skipWhitespace(bytes, skipWhitespace(bytes, keyEnd) + 1); // Colon.
    const end = skipValue(bytes, start);
    if (isModelKey(bytes, keyStart, keyEnd)) visit(start, end);
    offset = skipWhitespace(bytes, end);
    if (bytes[offset] === 0x7d) return;
    offset++; // Comma.
  }
}

function isModelKey(bytes: Uint8Array, start: number, end: number): boolean {
  // Five letters, each optionally represented as a six-byte Unicode escape.
  if (end - start < 7 || end - start > 32) return false;
  for (let offset = start + 1; offset < end - 1; offset++) {
    if (bytes[offset] === 0x5c) {
      return JSON.parse(decoder.decode(bytes.subarray(start, end))) === "model";
    }
  }
  return (
    end - start === 7 &&
    bytes[start + 1] === 0x6d &&
    bytes[start + 2] === 0x6f &&
    bytes[start + 3] === 0x64 &&
    bytes[start + 4] === 0x65 &&
    bytes[start + 5] === 0x6c
  );
}

function skipWhitespace(bytes: Uint8Array, offset: number): number {
  while (
    bytes[offset] === 0x20 ||
    bytes[offset] === 0x09 ||
    bytes[offset] === 0x0a ||
    bytes[offset] === 0x0d
  ) {
    offset++;
  }
  return offset;
}

function skipString(bytes: Uint8Array, start: number): number {
  for (let offset = start + 1; offset < bytes.length; offset++) {
    if (bytes[offset] === 0x5c) offset++;
    else if (bytes[offset] === 0x22) return offset + 1;
  }
  throw new Error("Expected a terminated string in validated raw JSON");
}

function skipValue(bytes: Uint8Array, start: number): number {
  let depth = 0;
  for (let offset = start; offset < bytes.length; offset++) {
    const byte = bytes[offset];
    if (byte === 0x22) {
      offset = skipString(bytes, offset) - 1;
    } else if (byte === 0x7b || byte === 0x5b) {
      depth++;
    } else if (byte === 0x7d || byte === 0x5d) {
      if (depth === 0) return offset;
      if (--depth === 0) return offset + 1;
    } else if (
      depth === 0 &&
      (byte === 0x2c || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d)
    ) {
      return offset;
    }
  }
  return bytes.length;
}
