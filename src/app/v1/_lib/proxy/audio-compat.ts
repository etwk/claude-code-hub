import { Buffer } from "node:buffer";

interface AudioMultipartPart {
  readonly name: string;
  readonly partStart: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  /** Undefined for file parts: their bytes are never decoded or retained here. */
  readonly text: string | undefined;
}

/** Immutable offsets into the original source buffer; preserve this object across attempts. */
export interface AudioMultipartMetadata {
  readonly contentType: string;
  readonly boundary: string;
  readonly closingBoundaryStart: number;
  readonly parts: readonly AudioMultipartPart[];
}

// Weak keys do not keep request/file buffers alive. Only metadata paired with its source may splice it.
const parsedMetadata = new WeakMap<ArrayBuffer, WeakSet<AudioMultipartMetadata>>();
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function hasHeaderControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parameterizedHeader(
  header: string
): { value: string; parameters: Map<string, string> } | null {
  if (/[\r\n\0]/.test(header)) return null;
  const separator = header.indexOf(";");
  const value = (separator === -1 ? header : header.slice(0, separator)).trim().toLowerCase();
  const parameters = new Map<string, string>();
  let position = separator === -1 ? header.length : separator;
  while (position < header.length) {
    const prefix = /^;[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*/.exec(
      header.slice(position)
    );
    if (!prefix) return null;
    position += prefix[0].length;
    const name = prefix[1].toLowerCase();
    if (parameters.has(name)) return null;
    let parameter = "";
    if (header[position] === '"') {
      position++;
      let closed = false;
      while (position < header.length) {
        const character = header[position++];
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          if (position === header.length) return null;
          parameter += header[position++];
        } else {
          parameter += character;
        }
      }
      if (!closed || hasHeaderControlCharacter(parameter)) return null;
    } else {
      const end = header.indexOf(";", position);
      parameter = header.slice(position, end === -1 ? header.length : end).trim();
      if (!token.test(parameter)) return null;
      position = end === -1 ? header.length : end;
    }
    while (header[position] === " " || header[position] === "\t") position++;
    if (position < header.length && header[position] !== ";") return null;
    parameters.set(name, parameter);
  }
  return { value, parameters };
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

export function isAudioTranscriptionEndpointPath(path: string): boolean {
  return /^\/v1\/audio\/(?:transcriptions|translations)\/?$/i.test(path.split("?", 1)[0]);
}

/** Parse only textual fields; filename/file parts remain byte spans in the original buffer. */
export function parseAudioMultipartRequest(
  buffer: ArrayBuffer,
  contentType: string
): { requestMessage: Record<string, unknown>; metadata: AudioMultipartMetadata } | null {
  const type = parameterizedHeader(contentType);
  const boundary = type?.parameters.get("boundary");
  if (
    type?.value !== "multipart/form-data" ||
    !boundary ||
    boundary.length > 70 ||
    !/^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/.test(boundary)
  ) {
    return null;
  }
  const bytes = Buffer.from(buffer);
  const firstMarker = Buffer.from(`--${boundary}\r\n`);
  if (!bytes.subarray(0, firstMarker.length).equals(firstMarker)) return null;
  const marker = Buffer.from(`\r\n--${boundary}`);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: AudioMultipartPart[] = [];
  const fields = new Map<string, string[]>();
  const fileFields = new Set<string>();
  let partStart = 0;
  let headerStart = firstMarker.length;

  while (headerStart < bytes.length) {
    const partEnd = findBoundary(bytes, marker, headerStart);
    if (partEnd === -1) return null;
    const headerEnd = bytes.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1 || headerEnd + 4 > partEnd) return null;
    const headers = new Map<string, string>();
    for (const line of bytes.toString("latin1", headerStart, headerEnd).split("\r\n")) {
      const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
      if (!header || headers.has(header[1].toLowerCase())) return null;
      headers.set(header[1].toLowerCase(), header[2]);
    }
    const disposition = parameterizedHeader(headers.get("content-disposition") ?? "");
    const name = disposition?.parameters.get("name");
    if (disposition?.value !== "form-data" || !name || hasHeaderControlCharacter(name)) {
      return null;
    }
    const hasFilename =
      disposition.parameters.has("filename") || disposition.parameters.has("filename*");
    const partType = parameterizedHeader(headers.get("content-type") ?? "")?.value;
    const hasBinaryType =
      partType !== undefined &&
      /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(partType) &&
      !partType.startsWith("text/");
    const isFile = hasFilename || (name === "file" && hasBinaryType);
    // A bare field named file is not evidence of a file. Reject ambiguity without decoding it.
    if (name === "file" && !isFile) return null;
    if (name === "model" && (isFile || fields.has(name))) return null;
    if (isFile) {
      if (fields.has(name)) return null;
      fileFields.add(name);
    } else if (fileFields.has(name)) {
      return null;
    }
    let text: string | undefined;
    if (!isFile) {
      try {
        text = decoder.decode(bytes.subarray(headerEnd + 4, partEnd));
      } catch {
        return null;
      }
      const values = fields.get(name) ?? [];
      values.push(text);
      fields.set(name, values);
    }
    parts.push(
      Object.freeze({ name, partStart, bodyStart: headerEnd + 4, bodyEnd: partEnd, text })
    );
    const boundaryEnd = partEnd + marker.length;
    if (bytes[boundaryEnd] === 0x2d) {
      const model = fields.get("model");
      if (model?.length !== 1 || !model[0].trim()) return null;
      const requestMessage: Record<string, unknown> = Object.create(null);
      for (const [field, values] of fields) {
        requestMessage[field] = values.length === 1 ? values[0] : values;
      }
      const metadata: AudioMultipartMetadata = Object.freeze({
        contentType,
        boundary,
        closingBoundaryStart: partEnd + 2,
        parts: Object.freeze(parts),
      });
      let registrations = parsedMetadata.get(buffer);
      if (!registrations) {
        registrations = new WeakSet();
        parsedMetadata.set(buffer, registrations);
      }
      registrations.add(metadata);
      return { requestMessage, metadata };
    }
    partStart = partEnd + 2;
    headerStart = boundaryEnd + 2;
  }
  return null;
}

function fieldValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => {
    if (typeof entry === "string" || typeof entry === "boolean") return String(entry);
    if (typeof entry === "number" && Number.isFinite(entry)) return String(entry);
    throw new TypeError("Audio multipart fields must be strings, booleans, or finite numbers");
  });
}

/** Splice textual edits only; an unchanged logical message returns the original buffer itself. */
export function serializeAudioMultipartBody(
  buffer: ArrayBuffer,
  metadata: AudioMultipartMetadata,
  message: Record<string, unknown>
): ArrayBuffer {
  if (!parsedMetadata.get(buffer)?.has(metadata)) {
    throw new TypeError("Audio multipart metadata does not belong to the original buffer");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError("Audio multipart message must be an object");
  }
  if (
    !Object.prototype.propertyIsEnumerable.call(message, "model") ||
    typeof message.model !== "string" ||
    !message.model.trim()
  ) {
    throw new TypeError("Audio multipart requires one non-empty model string");
  }
  const desired = new Map<string, string[]>();
  for (const [name, value] of Object.entries(message)) {
    if (!name || hasHeaderControlCharacter(name) || /[\u0100-\uffff]/.test(name)) {
      throw new TypeError("Audio multipart field names must be non-empty Latin-1 without controls");
    }
    desired.set(name, fieldValues(value));
  }
  const edits: Array<{ start: number; end: number; replacement: Uint8Array }> = [];
  const marker = Buffer.from(`\r\n--${metadata.boundary}`);
  const encode = (text: string): Uint8Array => {
    // A new delimiter inside a field would change the multipart structure, not just its value.
    if (findBoundary(Buffer.from(`\r\n${text}\r\n`), marker, 0) !== -1) {
      throw new TypeError("Audio multipart text contains its boundary delimiter");
    }
    return new TextEncoder().encode(text);
  };
  const consumed = new Map<string, number>();
  for (const part of metadata.parts) {
    if (part.text === undefined) {
      if (desired.has(part.name)) {
        throw new TypeError("Audio multipart file fields cannot be replaced with text");
      }
      continue;
    }
    const index = consumed.get(part.name) ?? 0;
    consumed.set(part.name, index + 1);
    const next = desired.get(part.name)?.[index];
    if (next === undefined) {
      edits.push({ start: part.partStart, end: part.bodyEnd + 2, replacement: new Uint8Array() });
    } else if (next !== part.text) {
      edits.push({ start: part.bodyStart, end: part.bodyEnd, replacement: encode(next) });
    }
  }
  const additions: Uint8Array[] = [];
  let additionsLength = 0;
  for (const [name, values] of desired) {
    for (const value of values.slice(consumed.get(name) ?? 0)) {
      const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const header = Buffer.from(
        `--${metadata.boundary}\r\nContent-Disposition: form-data; name="${escapedName}"\r\n\r\n`,
        "latin1"
      );
      const text = encode(value);
      const ending = new Uint8Array([0x0d, 0x0a]);
      additions.push(header, text, ending);
      additionsLength += header.length + text.length + ending.length;
    }
  }
  if (additionsLength) {
    const replacement = new Uint8Array(additionsLength);
    let offset = 0;
    for (const addition of additions) {
      replacement.set(addition, offset);
      offset += addition.length;
    }
    edits.push({
      start: metadata.closingBoundaryStart,
      end: metadata.closingBoundaryStart,
      replacement,
    });
  }
  if (!edits.length) return buffer;
  const source = new Uint8Array(buffer);
  const length = edits.reduce(
    (size, edit) => size + edit.replacement.length - (edit.end - edit.start),
    source.length
  );
  const result = new Uint8Array(length);
  let sourceOffset = 0;
  let resultOffset = 0;
  for (const edit of edits) {
    const unchanged = source.subarray(sourceOffset, edit.start);
    result.set(unchanged, resultOffset);
    resultOffset += unchanged.length;
    result.set(edit.replacement, resultOffset);
    resultOffset += edit.replacement.length;
    sourceOffset = edit.end;
  }
  result.set(source.subarray(sourceOffset), resultOffset);
  return result.buffer;
}
