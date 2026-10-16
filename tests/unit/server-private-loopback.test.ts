import { once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

const requireFromHere = createRequire(import.meta.url);
const { createNextAppWithPrivateServer, handleWebSocketConnection, listenOnPrivateLoopback } =
  requireFromHere("../../server.js") as {
    listenOnPrivateLoopback: (server: http.Server) => Promise<{ hostname: string; port: number }>;
    createNextAppWithPrivateServer: (
      factory: (options: Record<string, unknown>) => NextFixture,
      options: Record<string, unknown>
    ) => { app: NextFixture; internalServer: http.Server };
    handleWebSocketConnection: (
      ws: WebSocket,
      request: http.IncomingMessage,
      target: { hostname: string; port: number }
    ) => Promise<void>;
  };

type NextFixture = {
  init: {
    requestHandler: (request: http.IncomingMessage, response: http.ServerResponse) => void;
    upgradeHandler: (_request: http.IncomingMessage, socket: Socket) => void;
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

  it("keeps Responses WS reusable after public HTTP warms Next's automatic upgrade handler", async () => {
    // Use Next's real NextCustomServer/getRequestHandler implementation. Only
    // its route resolution is replaced with a local response fixture, avoiding
    // a build/database dependency while preserving lazy upgrade registration.
    const nextFactory = requireFromHere("next") as (
      options: Record<string, unknown>
    ) => NextFixture;
    let nextUpgradeCalls = 0;
    let turn = 0;
    const { app, internalServer } = createNextAppWithPrivateServer(nextFactory, { dev: false });
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
              response: { id: `resp_next_${++turn}`, usage: { input_tokens: 8, output_tokens: 1 } },
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
    publicServer.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        void handleWebSocketConnection(ws, request, target);
      });
    });
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
  });
});
