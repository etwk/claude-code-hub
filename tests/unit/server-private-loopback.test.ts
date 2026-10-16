import { once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

const requireFromHere = createRequire(import.meta.url);
const { createNextAppWithPrivateServer, createPublicUpgradeHandler, listenOnPrivateLoopback } =
  requireFromHere("../../server.js") as {
    listenOnPrivateLoopback: (server: http.Server) => Promise<{ hostname: string; port: number }>;
    createNextAppWithPrivateServer: (
      factory: (options: Record<string, unknown>) => NextFixture,
      options: Record<string, unknown>
    ) => { app: NextFixture; internalServer: http.Server };
    createPublicUpgradeHandler: (options: {
      dev: boolean;
      internalServer: http.Server;
      wss: WebSocketServer | null;
      internalHttpTarget: { hostname: string; port: number };
    }) => (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  };

type NextFixture = {
  init: {
    requestHandler: (request: http.IncomingMessage, response: http.ServerResponse) => void;
    upgradeHandler: (request: http.IncomingMessage, socket: Socket, head: Buffer) => void;
  };
  getRequestHandler: () => http.RequestListener;
};

const openServers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(
    Array.from(
      openServers,
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  openServers.clear();
});

describe("private WebSocket loopback listener", () => {
  it("binds an ephemeral IPv4 loopback port and serves the local Next handler", async () => {
    const server = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/responses");
      response.end("same-worker");
    });
    openServers.add(server);

    const target = await listenOnPrivateLoopback(server);
    expect(target.hostname).toBe("127.0.0.1");
    expect(target.port).toBeGreaterThan(0);
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port: target.port });

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(
          { hostname: target.hostname, port: target.port, path: "/v1/responses" },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          }
        )
        .on("error", reject);
    });
    expect(body).toBe("same-worker");
  });

  it.each([false, true])(
    "keeps Responses WS reusable after public HTTP warmup (dev=%s)",
    async (dev) => {
      // Use Next's real NextCustomServer/getRequestHandler implementation. Only
      // its route resolution is replaced with a local response fixture, avoiding
      // a build/database dependency while preserving lazy upgrade registration.
      const nextFactory = requireFromHere("next") as (
        options: Record<string, unknown>
      ) => NextFixture;
      let nextUpgradeCalls = 0;
      let turn = 0;
      const { app, internalServer } = createNextAppWithPrivateServer(nextFactory, { dev });
      app.init = {
        requestHandler: (request, response) => {
          if (request.method !== "POST") {
            response.end("warmed");
            return;
          }
          request.resume();
          request.once("end", () => {
            response.setHeader("content-type", "text/event-stream");
            response.end(
              `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  id: `resp_next_${++turn}`,
                  usage: { input_tokens: 8, output_tokens: 1 },
                },
              })}\n\n`
            );
          });
        },
        upgradeHandler: (_request, socket) => {
          nextUpgradeCalls += 1;
          socket.end();
        },
      };
      const handler = app.getRequestHandler();
      internalServer.on("request", handler);
      openServers.add(internalServer);
      const target = await listenOnPrivateLoopback(internalServer);
      const publicServer = http.createServer(handler);
      openServers.add(publicServer);
      const wss = new WebSocketServer({ noServer: true });
      publicServer.on(
        "upgrade",
        createPublicUpgradeHandler({ dev, internalServer, wss, internalHttpTarget: target })
      );
      const publicTarget = await listenOnPrivateLoopback(publicServer);
      await new Promise<void>((resolve, reject) => {
        http
          .get({ ...publicTarget, agent: false }, (response) => {
            response.resume();
            response.once("end", resolve);
          })
          .on("error", reject);
      });

      const client = new WebSocket(`ws://127.0.0.1:${publicTarget.port}/v1/responses`);
      try {
        await once(client, "open");
        for (let index = 1; index <= 2; index += 1) {
          const received = once(client, "message");
          client.send(
            JSON.stringify({ type: "response.create", model: "gpt-6.1-sol", input: "small" })
          );
          const [raw] = await received;
          expect(JSON.parse(raw.toString("utf8"))).toMatchObject({
            type: "response.completed",
            response: { id: `resp_next_${index}`, usage: { input_tokens: 8, output_tokens: 1 } },
          });
        }
        expect(nextUpgradeCalls).toBe(0);
        const closed = once(client, "close");
        client.close(1000, "test_done");
        const [code] = await closed;
        expect(code).toBe(1000);
      } finally {
        client.terminate();
        for (const socket of wss.clients) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    }
  );

  it.each([true, false])(
    "preserves development-only Next upgrade traffic and head bytes (dev=%s)",
    async (dev) => {
      const nextFactory = requireFromHere("next") as (
        options: Record<string, unknown>
      ) => NextFixture;
      const { app, internalServer } = createNextAppWithPrivateServer(nextFactory, { dev });
      const nextWss = new WebSocketServer({ noServer: true });
      let nextUpgradeCalls = 0;
      app.init = {
        requestHandler: (_request, response) => response.end("warmed"),
        upgradeHandler: (request, socket, head) => {
          nextUpgradeCalls += 1;
          nextWss.handleUpgrade(request, socket, head, (ws) => {
            ws.on("message", (data) => ws.send(`next:${data.toString()}`));
          });
        },
      };
      const handler = app.getRequestHandler();
      internalServer.on("request", handler);
      openServers.add(internalServer);
      const target = await listenOnPrivateLoopback(internalServer);
      const publicServer = http.createServer(handler);
      openServers.add(publicServer);
      publicServer.on(
        "upgrade",
        createPublicUpgradeHandler({ dev, internalServer, wss: null, internalHttpTarget: target })
      );
      const publicTarget = await listenOnPrivateLoopback(publicServer);
      await new Promise<void>((resolve, reject) => {
        http
          .get({ ...publicTarget, agent: false }, (response) => {
            response.resume();
            response.once("end", resolve);
          })
          .on("error", reject);
      });

      const client = connect(publicTarget.port, publicTarget.hostname);
      try {
        await once(client, "connect");
        const received = new Promise<Buffer>((resolve, reject) => {
          let bytes = Buffer.alloc(0);
          client.on("data", (chunk: Buffer) => {
            bytes = Buffer.concat([bytes, chunk]);
            if (bytes.includes("next:ping")) resolve(bytes);
          });
          client.once("close", () => resolve(bytes));
          client.once("error", reject);
        });
        const headers = Buffer.from(
          "GET /_next/hmr HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${publicTarget.port}\r\n` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n"
        );
        // Coalesce a real masked text frame with the handshake. Node must pass
        // these frame bytes as `head` to Next's private listener exactly once.
        const pingFrame = Buffer.from([0x81, 0x84, 1, 2, 3, 4, 0x71, 0x6b, 0x6d, 0x63]);
        client.write(Buffer.concat([headers, pingFrame]));
        const bytes = await received;
        if (dev) {
          expect(bytes.toString()).toContain("101 Switching Protocols");
          expect(bytes.toString()).toContain("next:ping");
          expect(nextUpgradeCalls).toBe(1);
        } else {
          expect(bytes.length).toBe(0);
          expect(nextUpgradeCalls).toBe(0);
        }
      } finally {
        client.destroy();
        for (const socket of nextWss.clients) socket.terminate();
        await new Promise<void>((resolve) => nextWss.close(() => resolve()));
      }
    }
  );
});
