import { Buffer } from "node:buffer";

/** Byte offsets into the original, decompressed request buffer; immutable across attempts. */
export interface SystemOneMultipartMetadata {
  readonly contentType: string;
  readonly requestPartBodyStart: number;
  readonly requestPartBodyEnd: number;
}

export interface ParsedSystemOneMultipartRequest {
  requestMessage: Record<string, unknown>;
  metadata: SystemOneMultipartMetadata;
}

function findBoundary(bytes: Buffer, marker: Buffer, start: number): number {
  let position = bytes.indexOf(marker, start);
  while (position !== -1) {
    const end = position + marker.length;
    if (bytes[end] === 0x0d && bytes[end + 1] === 0x0a) return position;
    if (
      bytes[end] === 0x2d &&
      bytes[end + 1] === 0x2d &&
      (end + 2 === bytes.length || (bytes[end + 2] === 0x0d && bytes[end + 3] === 0x0a))
    ) {
      return position;
    }
    position = bytes.indexOf(marker, position + marker.length);
  }
  return -1;
}

/** Require one unambiguous first JSON part; never decode binary image bodies as text. */
export function parseSystemOneMultipartRequest(
  buffer: ArrayBuffer,
  contentType: string
): ParsedSystemOneMultipartRequest | null {
  const match = contentType.match(/;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70) return null;
  const bytes = Buffer.from(buffer);
  const firstMarker = Buffer.from(`--${boundary}\r\n`);
  if (!bytes.subarray(0, firstMarker.length).equals(firstMarker)) return null;
  const marker = Buffer.from(`\r\n--${boundary}`);
  let partStart = firstMarker.length;
  let metadata: SystemOneMultipartMetadata | null = null;
  let requestMessage: Record<string, unknown> | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  while (partStart < bytes.length) {
    const partEnd = findBoundary(bytes, marker, partStart);
    if (partEnd === -1) return null;
    const headerEnd = bytes.indexOf("\r\n\r\n", partStart);
    if (headerEnd === -1 || headerEnd >= partEnd) return null;
    const headers = bytes.toString("latin1", partStart, headerEnd);
    const disposition = headers.match(/^content-disposition:\s*form-data\s*;([^\r\n]*)/im);
    const nameMatch = disposition?.[1].match(/(?:^|;)\s*name\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
    const name = nameMatch?.[1] ?? nameMatch?.[2];
    if (!name || (!metadata && name !== "request")) return null;
    if (name === "request") {
      if (metadata) return null;
      const bodyStart = headerEnd + 4;
      const body = bytes.subarray(bodyStart, partEnd);
      if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return null;
      try {
        const parsed: unknown = JSON.parse(decoder.decode(body));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        requestMessage = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
      metadata = { contentType, requestPartBodyStart: bodyStart, requestPartBodyEnd: partEnd };
    }
    const boundaryEnd = partEnd + marker.length;
    if (bytes[boundaryEnd] === 0x2d) {
      return requestMessage && metadata ? { requestMessage, metadata } : null;
    }
    partStart = boundaryEnd + 2;
  }
  return null;
}

export function serializeSystemOneMultipartBody(
  buffer: ArrayBuffer,
  metadata: SystemOneMultipartMetadata,
  updatedRequestJson: string
): ArrayBuffer {
  const source = new Uint8Array(buffer);
  const replacement = new TextEncoder().encode(updatedRequestJson);
  const suffix = source.subarray(metadata.requestPartBodyEnd);
  const result = new Uint8Array(metadata.requestPartBodyStart + replacement.length + suffix.length);
  result.set(source.subarray(0, metadata.requestPartBodyStart));
  result.set(replacement, metadata.requestPartBodyStart);
  result.set(suffix, metadata.requestPartBodyStart + replacement.length);
  return result.buffer;
}
