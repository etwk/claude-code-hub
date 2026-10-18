import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import type { Context } from "hono";
import { createTranslator } from "next-intl";
import { getLocale } from "next-intl/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyModelGuard } from "@/app/v1/_lib/proxy/model-guard";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import {
  parseSystemOneMultipartRequest,
  serializeSystemOneMultipartBody,
} from "@/app/v1/_lib/proxy/systemone-compat";
import { withRequestMemoryLifetime } from "@/lib/memory/request-lifetime";
import enErrors from "../../../messages/en/errors.json";
import jaErrors from "../../../messages/ja/errors.json";
import ruErrors from "../../../messages/ru/errors.json";
import zhCnErrors from "../../../messages/zh-CN/errors.json";
import zhTwErrors from "../../../messages/zh-TW/errors.json";

const errorsByLocale = {
  en: enErrors,
  ja: jaErrors,
  ru: ruErrors,
  "zh-CN": zhCnErrors,
  "zh-TW": zhTwErrors,
};

vi.mock("@/repository/model-price", () => ({
  findLatestPriceByModel: vi.fn(),
}));

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => "en"),
  getTranslations: vi.fn(async ({ locale }: { locale: string }) =>
    createTranslator({
      locale,
      messages: { errors: errorsByLocale[locale as keyof typeof errorsByLocale] },
      namespace: "errors",
    })
  ),
}));

beforeEach(() => {
  vi.mocked(getLocale).mockResolvedValue("en");
});

const BOUNDARY = "systemone-test-boundary";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const LARGE_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const message = {
  model: "system-one",
  state: { text: "A snowy day: 雪", _source: "client" },
  questions: { weather: { type: "noul", criteria: { true: "snow", false: "sun" } } },
  assets: { photo: { type: "image", part: "photo" } },
};
const requestJson = JSON.stringify(message);
const binaryImage = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xc3, 0x28, 0x80]),
  Buffer.from(`\r\n--${BOUNDARY}-not-a-delimiter\r\n`),
  Buffer.from(`\r\n--${BOUNDARY}--not-a-closing-delimiter\r\n`),
  Buffer.from([0x00, 0xfe, 0xff]),
]);

interface MultipartPart {
  headers: string;
  body: string | Uint8Array;
}

function requestPart(body: string | Uint8Array = requestJson): MultipartPart {
  return {
    headers: 'Content-Disposition: form-data; name="request"\r\nContent-Type: application/json',
    body,
  };
}

function imagePart(): MultipartPart {
  return {
    headers:
      'Content-Disposition: form-data; name="photo"; filename="photo.png"\r\nContent-Type: image/png',
    body: binaryImage,
  };
}

function multipart(
  parts: MultipartPart[] = [requestPart(), imagePart()],
  closing = `--${BOUNDARY}--\r\n`
): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${part.headers}\r\n\r\n`));
    chunks.push(typeof part.body === "string" ? Buffer.from(part.body) : part.body);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(closing));
  return Uint8Array.from(Buffer.concat(chunks)).buffer;
}

function largeMultipart(requestBody = requestJson): ArrayBuffer {
  const image = Buffer.alloc(LARGE_REQUEST_BODY_BYTES, 0xff);
  binaryImage.copy(image);
  return multipart([requestPart(requestBody), { ...imagePart(), body: image }]);
}

function createContext(request: Request): Context {
  return {
    req: {
      method: request.method,
      url: request.url,
      raw: request,
      header(name?: string) {
        return name
          ? (request.headers.get(name) ?? undefined)
          : Object.fromEntries(request.headers.entries());
      },
    },
  } as unknown as Context;
}

function createRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://hub.test/V1/SystemOne/?trace=one", {
    method: "POST",
    headers: { "content-type": CONTENT_TYPE, ...headers },
    body,
  });
}

const invalidRequestParts: Array<[string, string | Uint8Array]> = [
  ["empty JSON", ""],
  ["malformed JSON", '{"model":'],
  ["null", "null"],
  ["an array", "[]"],
  ["a nested array", '[{"model":"system-one"}]'],
  ["a string", '"system-one"'],
  ["a number", "42"],
  ["a boolean", "true"],
  ["a UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(requestJson)])],
  [
    "invalid UTF-8 in JSON",
    Buffer.concat([Buffer.from('{"model":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
  ],
];

const ambiguousParts: Array<[string, MultipartPart[]]> = [
  ["missing", [imagePart()]],
  ["late", [imagePart(), requestPart()]],
  ["duplicated immediately", [requestPart(), requestPart()]],
  ["duplicated after a binary part", [requestPart(), imagePart(), requestPart()]],
];

const requestPartPrefix = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="request"\r\n\r\n`;
const malformedBodies: Array<[string, string]> = [
  ["empty body", ""],
  ["closing boundary without any parts", `--${BOUNDARY}--\r\n`],
  ["mismatched opening boundary", "--other-boundary\r\n"],
  [
    "LF-only framing",
    `--${BOUNDARY}\nContent-Disposition: form-data; name="request"\n\n{}\n--${BOUNDARY}--\n`,
  ],
  [
    "missing header separator",
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="request"\r\n{}\r\n` +
      `--${BOUNDARY}--\r\n`,
  ],
  [
    "header separator only in a later part",
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="request"\r\n{}\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="photo"\r\n\r\nimage\r\n` +
      `--${BOUNDARY}--\r\n`,
  ],
  ["missing closing boundary", `${requestPartPrefix}{}`],
  ["truncated closing boundary", `${requestPartPrefix}{}\r\n--${BOUNDARY}-`],
  ["invalid closing suffix", `${requestPartPrefix}{}\r\n--${BOUNDARY}--junk`],
  ["truncated closing CRLF", `${requestPartPrefix}{}\r\n--${BOUNDARY}--\r`],
  ["unterminated next part", `${requestPartPrefix}{}\r\n--${BOUNDARY}\r\n`],
];

describe("System One multipart parsing", () => {
  it.each(["string", "file"] as const)("accepts the SDK's %s request JSON part", async (kind) => {
    const form = new FormData();
    if (kind === "file") {
      form.append("request", new Blob([requestJson], { type: "application/json" }), "request.json");
    } else {
      form.append("request", requestJson);
    }
    form.append(
      "photo",
      new Blob([Uint8Array.from(binaryImage)], { type: "image/png" }),
      "photo.png"
    );
    const request = new Request("https://hub.test/v1/systemone", { method: "POST", body: form });
    const contentType = request.headers.get("content-type")!;
    const buffer = await request.arrayBuffer();

    const parsed = parseSystemOneMultipartRequest(buffer, contentType);

    expect(parsed?.requestMessage).toEqual(message);
    expect(parsed?.metadata.contentType).toBe(contentType);
    expect(
      Buffer.from(buffer)
        .subarray(parsed!.metadata.requestPartBodyStart, parsed!.metadata.requestPartBodyEnd)
        .toString("utf8")
    ).toBe(requestJson);
    expect(Buffer.from(buffer).includes(binaryImage)).toBe(true);
  });

  it("accepts a quoted boundary and unquoted disposition name with case-insensitive headers", () => {
    const contentType = `multipart/form-data; charset=utf-8; BOUNDARY="${BOUNDARY}"; version=1`;
    const buffer = multipart([
      {
        headers:
          "cOnTeNt-DisPosition: FORM-DATA; name=request; filename=request.json\r\nContent-Type: application/json",
        body: requestJson,
      },
      imagePart(),
    ]);

    expect(parseSystemOneMultipartRequest(buffer, contentType)).toEqual({
      requestMessage: message,
      metadata: {
        contentType,
        requestPartBodyStart: Buffer.from(buffer).indexOf(requestJson),
        requestPartBodyEnd:
          Buffer.from(buffer).indexOf(requestJson) + Buffer.byteLength(requestJson),
      },
    });
  });

  it.each(["", "\r\n"])("accepts a closing delimiter with %j after it", (ending) => {
    const buffer = multipart([requestPart()], `--${BOUNDARY}--${ending}`);
    expect(parseSystemOneMultipartRequest(buffer, CONTENT_TYPE)?.requestMessage).toEqual(message);
  });

  it("ignores false boundary suffixes inside NUL and invalid-UTF-8 image bytes", () => {
    const buffer = multipart();
    const original = Buffer.from(buffer).toString("hex");
    const parsed = parseSystemOneMultipartRequest(buffer, CONTENT_TYPE);

    expect(parsed?.requestMessage).toEqual(message);
    const suffix = Buffer.from(buffer).subarray(parsed!.metadata.requestPartBodyEnd);
    expect(suffix.includes(binaryImage)).toBe(true);
    expect(suffix.subarray(-Buffer.byteLength(`--${BOUNDARY}--\r\n`)).toString()).toBe(
      `--${BOUNDARY}--\r\n`
    );
    expect(Buffer.from(buffer).toString("hex")).toBe(original);
  });

  it.each([
    "multipart/form-data",
    "multipart/form-data; boundary=",
    'multipart/form-data; boundary=""',
    `multipart/form-data; boundary=${"x".repeat(71)}`,
    `multipart/form-data; boundary="${BOUNDARY}\r\ninjected"`,
  ])("rejects an absent or invalid boundary in %j", (contentType) => {
    expect(parseSystemOneMultipartRequest(multipart(), contentType)).toBeNull();
  });

  it.each(invalidRequestParts)("rejects %s in the request part", (_name, body) => {
    expect(parseSystemOneMultipartRequest(multipart([requestPart(body)]), CONTENT_TYPE)).toBeNull();
  });

  it.each(ambiguousParts)("rejects a %s request part", (_name, parts) => {
    expect(parseSystemOneMultipartRequest(multipart(parts), CONTENT_TYPE)).toBeNull();
  });

  it.each([
    "Content-Type: application/json",
    "Content-Disposition: attachment; name=request",
    "Content-Disposition: form-data; filename=request.json",
    'Content-Disposition: form-data; name=""',
  ])("rejects a part without an unambiguous name: %s", (headers) => {
    expect(
      parseSystemOneMultipartRequest(multipart([{ headers, body: requestJson }]), CONTENT_TYPE)
    ).toBeNull();
  });

  it("rejects nameless parts even after a valid request part", () => {
    expect(
      parseSystemOneMultipartRequest(
        multipart([requestPart(), { headers: "Content-Type: image/png", body: binaryImage }]),
        CONTENT_TYPE
      )
    ).toBeNull();
  });

  it.each(malformedBodies)("rejects malformed framing: %s", (_name, body) => {
    expect(
      parseSystemOneMultipartRequest(new TextEncoder().encode(body).buffer, CONTENT_TYPE)
    ).toBeNull();
  });
});

describe("System One multipart serialization", () => {
  it.each([
    ["growing", { ...message, state: { text: "longer replacement 雪".repeat(20) } }],
    ["shrinking", { model: "short" }],
  ])("preserves framing and binary data for a %s JSON replacement", (_name, updated) => {
    const buffer = multipart();
    const original = Uint8Array.from(new Uint8Array(buffer));
    const parsed = parseSystemOneMultipartRequest(buffer, CONTENT_TYPE)!;
    const metadata = Object.freeze({ ...parsed.metadata });
    const json = JSON.stringify(updated);

    const serialized = serializeSystemOneMultipartBody(buffer, metadata, json);

    expect(serialized).not.toBe(buffer);
    expect(serialized.byteLength).toBe(
      buffer.byteLength -
        (metadata.requestPartBodyEnd - metadata.requestPartBodyStart) +
        Buffer.byteLength(json)
    );
    expect(Buffer.from(serialized).subarray(0, metadata.requestPartBodyStart)).toEqual(
      Buffer.from(buffer).subarray(0, metadata.requestPartBodyStart)
    );
    expect(
      Buffer.from(serialized).subarray(metadata.requestPartBodyStart + Buffer.byteLength(json))
    ).toEqual(Buffer.from(buffer).subarray(metadata.requestPartBodyEnd));
    expect(parseSystemOneMultipartRequest(serialized, CONTENT_TYPE)?.requestMessage).toEqual(
      updated
    );
    expect(Buffer.from(serialized).includes(binaryImage)).toBe(true);
    expect(new Uint8Array(buffer)).toEqual(original);
    expect(metadata).toEqual(parsed.metadata);
    expect(parsed.requestMessage).toEqual(message);
  });
});

describe("ProxySession System One body parsing", () => {
  it("decompresses gzip multipart without decoding binary image bytes into request.log", async () => {
    const buffer = multipart();
    const contentType = `multipart/form-data; boundary="${BOUNDARY}"`;
    const compressed = Uint8Array.from(gzipSync(new Uint8Array(buffer)));
    const request = createRequest(compressed, {
      "content-type": contentType,
      "content-encoding": "gzip",
      "content-length": String(compressed.byteLength),
    });

    const session = await ProxySession.fromContext(createContext(request));

    expect(session.request.model).toBe(message.model);
    expect(session.request.message).toEqual(message);
    expect(new Uint8Array(session.request.buffer!)).toEqual(new Uint8Array(buffer));
    expect(session.headers.get("content-encoding")).toBeNull();
    expect(session.headers.get("content-type")).toBe(contentType);
    expect(session.request.systemOneMultipart).toEqual(
      parseSystemOneMultipartRequest(buffer, contentType)?.metadata
    );
    expect(JSON.parse(session.request.log)).toEqual(message);
    expect(session.request.log).not.toContain("photo.png");
    expect(session.request.log).not.toContain("not-a-delimiter");
    expect(session.request.log).not.toContain("\ufffd");
  });

  it.each(["en", "ja", "ru", "zh-CN", "zh-TW"] as const)(
    "returns a localized invalid_request_error for a large missing-model upload in %s",
    async (locale) => {
      vi.mocked(getLocale).mockResolvedValue(locale);
      const expectedMessage = errorsByLocale[locale].REQUIRED_FIELD.replace("{field}", "model");
      const withoutModel = {
        state: message.state,
        questions: message.questions,
        assets: message.assets,
      };
      const buffer = largeMultipart(JSON.stringify(withoutModel));
      expect(buffer.byteLength).toBeGreaterThanOrEqual(LARGE_REQUEST_BODY_BYTES);
      const request = createRequest(buffer);
      // An absent Content-Length must not bypass the actual-body-size regression.
      expect(request.headers.has("content-length")).toBe(false);

      const response = await withRequestMemoryLifetime(async () => {
        const session = await ProxySession.fromContext(createContext(request));
        session.authState = { user: { allowedModels: [] } } as ProxySession["authState"];
        expect(session.request.model).toBeNull();
        expect(session.request.message).toEqual(withoutModel);
        const errorResponse = await ProxyModelGuard.ensure(session);
        expect(errorResponse).not.toBeNull();
        return errorResponse!;
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_request_error", message: expectedMessage },
      });
    }
  );

  it("accepts a valid large upload while keeping binary bytes out of request.log", async () => {
    const buffer = largeMultipart();
    expect(buffer.byteLength).toBeGreaterThanOrEqual(LARGE_REQUEST_BODY_BYTES);
    const request = createRequest(buffer, { "content-length": String(buffer.byteLength) });

    await withRequestMemoryLifetime(async () => {
      const session = await ProxySession.fromContext(createContext(request));
      session.authState = { user: { allowedModels: [] } } as ProxySession["authState"];

      expect(await ProxyModelGuard.ensure(session)).toBeNull();
      expect(session.request.model).toBe(message.model);
      expect(session.request.message).toEqual(message);
      expect(Buffer.from(session.request.buffer!).equals(Buffer.from(buffer))).toBe(true);
      expect(session.headers.get("content-type")).toBe(CONTENT_TYPE);
      expect(session.request.systemOneMultipart).toEqual(
        parseSystemOneMultipartRequest(buffer, CONTENT_TYPE)?.metadata
      );
      expect(JSON.parse(session.request.log)).toEqual(message);
      expect(Buffer.byteLength(session.request.log)).toBeLessThan(1024);
      expect(session.request.log).not.toContain("photo.png");
      expect(session.request.log).not.toContain("not-a-delimiter");
      expect(session.request.log).not.toContain("\ufffd");
      return new Response(null, { status: 204 });
    });
  });

  it.each(["/v1/responses", "/v1/rerank"])(
    "rejects large missing-model bodies before the guard on %s",
    async (pathname) => {
      vi.mocked(getLocale).mockResolvedValue("ja");
      const body = JSON.stringify({ input: "x".repeat(LARGE_REQUEST_BODY_BYTES) });
      expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(LARGE_REQUEST_BODY_BYTES);
      const request = new Request(`https://hub.test${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      await expect(
        withRequestMemoryLifetime(async () => {
          await ProxySession.fromContext(createContext(request));
          return new Response(null, { status: 204 });
        })
      ).rejects.toMatchObject({
        statusCode: 400,
      });
    }
  );

  it.each(["null", "[]", '[{"model":"system-one"}]', '"string"', "42", "true"])(
    "keeps non-object JSON %s in the raw-body fallback rather than assigning it as the message",
    async (body) => {
      const session = await ProxySession.fromContext(
        createContext(createRequest(body, { "content-type": "application/json" }))
      );

      expect(session.request.message).toEqual({ raw: body });
      expect(session.request.model).toBeNull();
      expect(session.request.log).toBe(body);
      expect(new TextDecoder().decode(session.request.buffer)).toBe(body);
      expect(session.request.systemOneMultipart).toBeUndefined();
    }
  );

  it.each(ambiguousParts)(
    "returns HTTP 400 for a %s multipart request part",
    async (_name, parts) => {
      await expect(
        ProxySession.fromContext(createContext(createRequest(multipart(parts))))
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("request") });
    }
  );

  it.each(invalidRequestParts)(
    "returns HTTP 400 for multipart request JSON containing %s",
    async (_name, body) => {
      await expect(
        ProxySession.fromContext(createContext(createRequest(multipart([requestPart(body)]))))
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  );

  it("returns HTTP 400 for unterminated multipart framing", async () => {
    await expect(
      ProxySession.fromContext(createContext(createRequest(multipart([requestPart()], ""))))
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
