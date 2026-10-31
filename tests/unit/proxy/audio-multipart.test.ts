import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  type AudioMultipartMetadata,
  isAudioTranscriptionEndpointPath,
  parseAudioMultipartRequest,
  serializeAudioMultipartBody,
} from "@/app/v1/_lib/proxy/audio-compat";

const boundary = "audio-boundary-123";
const contentType = `multipart/form-data; boundary="${boundary}"`;
const binaryAudio = Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x00, 0xff]);

interface Part {
  headers: string;
  body: string | Uint8Array;
}

function field(name: string, body: string): Part {
  return { headers: `Content-Disposition: form-data; name="${name}"`, body };
}

function audioPart(name = "file", filename = "clip.wav"): Part {
  return {
    headers:
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      "Content-Type: audio/wav\r\nX-Part-Tag: original",
    body: binaryAudio,
  };
}

function multipart(
  parts: Part[] = [
    audioPart(),
    field("model", "whisper-1"),
    field("prompt", "A snowy day: 雪"),
    field("timestamp_granularities[]", "word"),
    field("timestamp_granularities[]", "segment"),
    field("stream", "true"),
    audioPart("reference", "reference.wav"),
  ],
  closing = `--${boundary}--\r\n`
): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers}\r\n\r\n`, "latin1"));
    chunks.push(typeof part.body === "string" ? Buffer.from(part.body) : part.body);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(closing));
  return Uint8Array.from(Buffer.concat(chunks)).buffer;
}

async function readForm(buffer: ArrayBuffer): Promise<FormData> {
  return new Response(buffer, { headers: { "content-type": contentType } }).formData();
}

async function expectOriginalFiles(form: FormData): Promise<void> {
  for (const [name, filename] of [
    ["file", "clip.wav"],
    ["reference", "reference.wav"],
  ]) {
    const file = form.get(name) as File;
    expect(file.name).toBe(filename);
    expect(file.type).toBe("audio/wav");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(binaryAudio);
  }
}

describe("audio multipart preservation", () => {
  it("round-trips invalid-UTF8 audio, repeated fields, original headers and boundary byte-for-byte", async () => {
    const buffer = multipart();
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;

    expect(parsed.requestMessage).toEqual({
      model: "whisper-1",
      prompt: "A snowy day: 雪",
      "timestamp_granularities[]": ["word", "segment"],
      stream: "true",
    });
    const result = serializeAudioMultipartBody(buffer, parsed.metadata, parsed.requestMessage);

    expect(result).toBe(buffer);
    const form = await readForm(result);
    expect(form.getAll("timestamp_granularities[]")).toEqual(["word", "segment"]);
    await expectOriginalFiles(form);
  });

  it("accepts SDK FormData and keeps the generated body and boundary untouched", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(binaryAudio)], { type: "audio/wav" }),
      "clip.wav"
    );
    form.append("model", "whisper-1");
    form.append("language", "en");
    const request = new Request("https://hub.test/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const buffer = await request.arrayBuffer();
    const type = request.headers.get("content-type")!;
    const parsed = parseAudioMultipartRequest(buffer, type)!;

    expect(parsed.requestMessage).toEqual({ model: "whisper-1", language: "en" });
    expect(parsed.metadata.contentType).toBe(type);
    expect(serializeAudioMultipartBody(buffer, parsed.metadata, parsed.requestMessage)).toBe(
      buffer
    );
  });

  it("rewrites model and Unicode text without changing file bytes, names, types or part headers", async () => {
    const buffer = multipart();
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;
    const result = serializeAudioMultipartBody(buffer, parsed.metadata, {
      ...parsed.requestMessage,
      model: "gpt-4o-transcribe",
      prompt: "音声を文字起こししてください",
    });
    const form = await readForm(result);

    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("prompt")).toBe("音声を文字起こししてください");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["word", "segment"]);
    await expectOriginalFiles(form);
    const reparsed = parseAudioMultipartRequest(result, contentType)!;
    for (let index = 0; index < parsed.metadata.parts.length; index++) {
      const original = parsed.metadata.parts[index];
      const rewritten = reparsed.metadata.parts[index];
      expect(Buffer.from(result).subarray(rewritten.partStart, rewritten.bodyStart)).toEqual(
        Buffer.from(buffer).subarray(original.partStart, original.bodyStart)
      );
    }
    expect(parsed.requestMessage.model).toBe("whisper-1");
    expect(Buffer.from(buffer).includes(Buffer.from("gpt-4o-transcribe"))).toBe(false);
  });

  it("adds, removes and changes repeated text fields while retaining every original file", async () => {
    const buffer = multipart();
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;
    const message = { ...parsed.requestMessage };
    delete message.prompt;
    message["timestamp_granularities[]"] = ["segment", "word", "sentence"];
    message.language = "ja";
    message.temperature = 0;
    message.stream = false;
    const result = serializeAudioMultipartBody(buffer, parsed.metadata, message);
    const form = await readForm(result);

    expect(form.has("prompt")).toBe(false);
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment", "word", "sentence"]);
    expect(form.get("language")).toBe("ja");
    expect(form.get("temperature")).toBe("0");
    expect(form.get("stream")).toBe("false");
    await expectOriginalFiles(form);
  });

  it("removes first and last text parts and shrinks repeated fields without broken framing", async () => {
    const buffer = multipart([
      field("prompt", "remove first"),
      field("model", "whisper-1"),
      audioPart(),
      field("language", "en"),
      field("language", "fr"),
      field("tail", "remove last"),
    ]);
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;
    const result = serializeAudioMultipartBody(buffer, parsed.metadata, {
      model: "whisper-1",
      language: ["ja"],
    });
    const form = await readForm(result);

    expect(form.has("prompt")).toBe(false);
    expect(form.has("tail")).toBe(false);
    expect(form.getAll("language")).toEqual(["ja"]);
    expect(Buffer.from(await (form.get("file") as File).arrayBuffer())).toEqual(binaryAudio);
    expect(parseAudioMultipartRequest(result, contentType)?.requestMessage).toEqual({
      model: "whisper-1",
      language: "ja",
    });
  });

  it("preserves original bytes for scalar rewrites with identical textual values", () => {
    const buffer = multipart([
      field("model", "whisper-1"),
      field("stream", "true"),
      field("n", "0"),
    ]);
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;

    expect(
      serializeAudioMultipartBody(buffer, parsed.metadata, {
        ...parsed.requestMessage,
        stream: true,
        n: 0,
      })
    ).toBe(buffer);
  });

  it("decodes only original text views and retains no binary buffers in immutable metadata", () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const buffer = multipart();
      const parsed = parseAudioMultipartRequest(buffer, contentType)!;
      expect(decode).toHaveBeenCalledTimes(5);
      for (const [input] of decode.mock.calls) {
        expect((input as Uint8Array).buffer).toBe(buffer);
      }
      expect(Object.isFrozen(parsed.metadata)).toBe(true);
      expect(Object.isFrozen(parsed.metadata.parts)).toBe(true);
      for (const part of parsed.metadata.parts) {
        expect(Object.isFrozen(part)).toBe(true);
        for (const value of Object.values(part)) {
          expect(value instanceof ArrayBuffer || ArrayBuffer.isView(value)).toBe(false);
        }
      }
      expect(parsed.metadata.parts.filter((part) => part.text === undefined)).toHaveLength(2);
    } finally {
      decode.mockRestore();
    }
  });

  it("preserves repeated file fields and never decodes a declared filename-less file field", () => {
    const buffer = multipart([
      {
        headers: 'Content-Disposition: form-data; name="file"\r\nContent-Type: audio/wav',
        body: binaryAudio,
      },
      audioPart(),
      field("model", "whisper-1"),
    ]);
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;
    expect(parsed.requestMessage).toEqual({ model: "whisper-1" });
    expect(serializeAudioMultipartBody(buffer, parsed.metadata, parsed.requestMessage)).toBe(
      buffer
    );
  });

  it("ignores boundary prefixes with invalid suffixes inside binary parts during rewrites", () => {
    const audio = Buffer.concat([
      binaryAudio,
      Buffer.from(`\r\n--${boundary}-not-a-delimiter\r\n`),
      Buffer.from(`\r\n--${boundary}--not-a-closing-delimiter\r\n`),
      binaryAudio,
    ]);
    const buffer = multipart([{ ...audioPart(), body: audio }, field("model", "whisper-1")]);
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;
    expect(serializeAudioMultipartBody(buffer, parsed.metadata, parsed.requestMessage)).toBe(
      buffer
    );
    const result = serializeAudioMultipartBody(buffer, parsed.metadata, {
      ...parsed.requestMessage,
      model: "gpt-4o-transcribe",
    });
    const rewritten = parseAudioMultipartRequest(result, contentType)!;
    const file = rewritten.metadata.parts[0];
    expect(rewritten.requestMessage.model).toBe("gpt-4o-transcribe");
    expect(Buffer.from(result).subarray(file.bodyStart, file.bodyEnd)).toEqual(audio);
  });

  it.each(["", "\r\n", "\r\nretained MIME epilogue"])(
    "preserves a valid closing delimiter followed by %j",
    (ending) => {
      const buffer = multipart([field("model", "whisper-1")], `--${boundary}--${ending}`);
      const parsed = parseAudioMultipartRequest(buffer, contentType)!;
      expect(serializeAudioMultipartBody(buffer, parsed.metadata, parsed.requestMessage)).toBe(
        buffer
      );
    }
  );
});

describe("audio multipart rejection", () => {
  it.each([
    "multipart/form-data",
    'multipart/form-data; boundary=""',
    `multipart/form-data; boundary=${"x".repeat(71)}`,
    `multipart/form-data; boundary="${boundary} "`,
    `multipart/form-data; boundary="${boundary}\r\ninjected"`,
    `multipart/form-data; boundary=${boundary}; boundary=other`,
    `multipart/form-data; boundary=${boundary} unexpected`,
    `multipart/mixed; boundary=${boundary}`,
  ])("rejects missing, malformed or ambiguous boundary parameters: %j", (type) => {
    expect(parseAudioMultipartRequest(multipart(), type)).toBeNull();
  });

  it.each([
    ["empty body", ""],
    ["wrong opening boundary", "--other\r\n"],
    [
      "LF framing",
      `--${boundary}\nContent-Disposition: form-data; name=model\n\nwhisper-1\n--${boundary}--\n`,
    ],
    [
      "truncated closing boundary",
      `--${boundary}\r\nContent-Disposition: form-data; name=model\r\n\r\nwhisper-1\r\n--${boundary}-`,
    ],
    [
      "invalid closing suffix",
      `--${boundary}\r\nContent-Disposition: form-data; name=model\r\n\r\nwhisper-1\r\n--${boundary}--junk`,
    ],
    [
      "truncated closing CRLF",
      `--${boundary}\r\nContent-Disposition: form-data; name=model\r\n\r\nwhisper-1\r\n--${boundary}--\r`,
    ],
    [
      "separator only in later part",
      `--${boundary}\r\nContent-Disposition: form-data; name=model\r\nwhisper-1\r\n--${boundary}\r\nContent-Disposition: form-data; name=prompt\r\n\r\ntext\r\n--${boundary}--\r\n`,
    ],
  ])("rejects malformed framing: %s", (_name, body) => {
    const buffer = Uint8Array.from(Buffer.from(body)).buffer;
    expect(parseAudioMultipartRequest(buffer, contentType)).toBeNull();
  });

  it.each([
    ["missing", [audioPart()]],
    ["empty", [field("model", ""), audioPart()]],
    ["whitespace-only", [field("model", "  "), audioPart()]],
    ["duplicate", [field("model", "whisper-1"), audioPart(), field("model", "other")]],
    ["file", [audioPart("model")]],
    ["undeclared file", [field("model", "whisper-1"), field("file", "fake file")]],
    [
      "text mixed with file",
      [field("model", "whisper-1"), field("file", "fake file"), audioPart()],
    ],
    [
      "file mixed with text",
      [audioPart(), field("file", "fake file"), field("model", "whisper-1")],
    ],
  ] satisfies Array<[string, Part[]]>)(
    "rejects a %s model or ambiguous file/text identity",
    (_name, parts) => {
      expect(parseAudioMultipartRequest(multipart(parts), contentType)).toBeNull();
    }
  );

  it.each([
    'Content-Disposition: form-data; name="model"; name="other"',
    'Content-Disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="other"',
    'Content-Disposition: form-data; name="model',
    'Content-Disposition: attachment; name="model"',
    'Content-Disposition: form-data; filename="model.txt"',
    'Content-Disposition: form-data; name=""',
  ])("rejects ambiguous or malformed disposition headers: %s", (headers) => {
    expect(
      parseAudioMultipartRequest(multipart([{ headers, body: "whisper-1" }]), contentType)
    ).toBeNull();
  });

  it("rejects invalid UTF8 in text rather than replacing it or decoding binary as JSON", () => {
    const buffer = multipart([
      field("model", "whisper-1"),
      { ...field("prompt", ""), body: Buffer.from([0xc3, 0x28]) },
      audioPart(),
    ]);
    expect(parseAudioMultipartRequest(buffer, contentType)).toBeNull();
  });

  it("rejects forged metadata, copied buffers and metadata from another parse", () => {
    const buffer = multipart();
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;
    const forged = {
      ...parsed.metadata,
      parts: [{ ...parsed.metadata.parts[0], bodyStart: -1 }],
    } as AudioMultipartMetadata;
    expect(() => serializeAudioMultipartBody(buffer, forged, parsed.requestMessage)).toThrow(
      TypeError
    );
    expect(() =>
      serializeAudioMultipartBody(buffer.slice(0), parsed.metadata, parsed.requestMessage)
    ).toThrow(TypeError);
    const other = parseAudioMultipartRequest(multipart(), contentType)!;
    expect(() =>
      serializeAudioMultipartBody(buffer, other.metadata, parsed.requestMessage)
    ).toThrow(TypeError);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["object", { content: "not a text field" }],
    ["nested array", [["not scalar"]]],
    ["nonfinite number", Number.NaN],
  ])("rejects unsupported %s text rewrites", (_name, value) => {
    const buffer = multipart();
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;
    expect(() =>
      serializeAudioMultipartBody(buffer, parsed.metadata, {
        ...parsed.requestMessage,
        prompt: value,
      })
    ).toThrow(TypeError);
  });

  it("rejects file overwrites, model removal and delimiter injection instead of emitting invalid multipart", () => {
    const buffer = multipart();
    const parsed = parseAudioMultipartRequest(buffer, contentType)!;
    for (const message of [
      { ...parsed.requestMessage, file: "replacement" },
      { ...parsed.requestMessage, model: undefined },
      { ...parsed.requestMessage, model: ["one", "two"] },
      Object.create({ model: "whisper-1" }) as Record<string, unknown>,
      Object.defineProperty({}, "model", { value: "whisper-1", enumerable: false }),
      { ...parsed.requestMessage, prompt: `text\r\n--${boundary}\r\ninjected` },
      { ...parsed.requestMessage, prompt: `--${boundary}--` },
      { ...parsed.requestMessage, "injected\r\nname": "text" },
    ]) {
      expect(() => serializeAudioMultipartBody(buffer, parsed.metadata, message)).toThrow(
        TypeError
      );
    }
  });
});

describe("audio multipart endpoint selection", () => {
  it.each([
    "/v1/audio/transcriptions",
    "/V1/Audio/Translations/",
    "/v1/audio/translations?trace=one",
  ])("recognizes %s", (path) => expect(isAudioTranscriptionEndpointPath(path)).toBe(true));

  it.each([
    "/v1/audio/speech",
    "/v1/audio/transcriptions/extra",
    "/v1/responses",
    "/audio/transcriptions",
  ])("does not select %s", (path) => expect(isAudioTranscriptionEndpointPath(path)).toBe(false));
});
