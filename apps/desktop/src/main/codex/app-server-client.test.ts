import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./json-rpc-stdio.js", async () => {
  const { EventEmitter: MockEventEmitter } = await vi.importActual<typeof import("node:events")>(
    "node:events",
  );
  class FakeRpc extends MockEventEmitter {
    static readonly instances: FakeRpc[] = [];
    requests: Array<{ method: string; params: unknown }> = [];
    responses: Array<{ id: number | string; result: unknown }> = [];
    rejections: Array<{ id: number | string; error: unknown }> = [];
    nextThread = 1;
    nextTurn = 1;

    constructor() {
      super();
      FakeRpc.instances.push(this);
    }

    async start(): Promise<void> {}

    async request<T>(method: string, params: unknown): Promise<T> {
      this.requests.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: `thread-${this.nextThread++}` } } as T;
      }
      if (method === "turn/start") {
        return { turn: { id: `turn-${this.nextTurn++}` } } as T;
      }
      return {} as T;
    }

    respond(id: number | string, result: unknown): void {
      this.responses.push({ id, result });
    }

    reject(id: number | string, error: unknown): void {
      this.rejections.push({ id, error });
    }

    async dispose(): Promise<void> {}
  }

  return { JsonRpcStdioClient: FakeRpc };
});

import { CodexAppServerClient, codexProcessEnvironment } from "./app-server-client.js";
import { JsonRpcStdioClient } from "./json-rpc-stdio.js";

interface FakeRpc extends EventEmitter {
  requests: Array<{ method: string; params: unknown }>;
  responses: Array<{ id: number | string; result: unknown }>;
  rejections: Array<{ id: number | string; error: unknown }>;
}

function rpc(): FakeRpc {
  return (JsonRpcStdioClient as unknown as { instances: FakeRpc[] }).instances.at(-1) as FakeRpc;
}

describe("CodexAppServerClient generic thread operations", () => {
  beforeEach(() => {
    (JsonRpcStdioClient as unknown as { instances: FakeRpc[] }).instances.length = 0;
    vi.useRealTimers();
  });

  it("keeps Twilio signing secrets out of the Codex child environment", () => {
    expect(codexProcessEnvironment({
      PATH: "/usr/bin",
      APP_TOKEN_SECRET: "helper",
      TWILIO_ACCESS_TOKEN: "short-lived",
      TWILIO_API_KEY_SECRET: "api-secret",
      TWILIO_AUTH_TOKEN: "auth-secret",
    }, { CODEX_HOME: "/tmp/codex" })).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex",
    });
  });

  it("sends dynamic tools and ephemeral thread options without weakening the sandbox", async () => {
    const client = new CodexAppServerClient({ cwd: "/default/project" });
    const threadId = await client.startThread({
      cwd: "/campaign/project",
      ephemeral: true,
      developerInstructions: "Use only registered tools.",
      dynamicTools: [
        {
          type: "function",
          name: "lookup_customer",
          description: "Look up a customer",
          inputSchema: { type: "object" },
          deferLoading: false,
        },
      ],
    });

    expect(threadId).toBe("thread-1");
    expect(rpc().requests).toContainEqual({
      method: "thread/start",
      params: {
        cwd: "/campaign/project",
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: "Use only registered tools.",
        dynamicTools: [
          {
            type: "function",
            name: "lookup_customer",
            description: "Look up a customer",
            inputSchema: { type: "object" },
            deferLoading: false,
          },
        ],
      },
    });
  });

  it("starts and interrupts a text turn", async () => {
    const client = new CodexAppServerClient();
    const turnId = await client.startTurn("thread-1", "caller transcript");
    await client.interruptTurn("thread-1", turnId);

    expect(turnId).toBe("turn-1");
    expect(rpc().requests).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "caller transcript" }],
      },
    });
    expect(rpc().requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("responds to item/tool/call and keeps other server requests rejectable", async () => {
    const client = new CodexAppServerClient();
    const externalRequests: string[] = [];
    client.on("serverRequest", ({ method }) => externalRequests.push(method));
    client.setDynamicToolHandler(async ({ tool }) => ({
      contentItems: [{ type: "inputText", text: `handled:${tool}` }],
      success: true,
    }));

    rpc().emit("serverRequest", {
      id: 7,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "lookup_customer",
        arguments: {},
      },
    });
    rpc().emit("serverRequest", { id: 8, method: "item/fileChange/requestApproval", params: {} });
    await vi.waitFor(() => expect(rpc().responses).toHaveLength(1));

    expect(rpc().responses[0]).toEqual({
      id: 7,
      result: {
        contentItems: [{ type: "inputText", text: "handled:lookup_customer" }],
        success: true,
      },
    });
    expect(externalRequests).toEqual(["item/fileChange/requestApproval"]);
  });

  it("returns a protocol-shaped failure when a dynamic tool exceeds its deadline", async () => {
    vi.useFakeTimers();
    const client = new CodexAppServerClient({ dynamicToolRequestTimeoutMs: 25 });
    client.setDynamicToolHandler(() => new Promise(() => undefined));

    rpc().emit("serverRequest", {
      id: "slow",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "lookup_customer",
        arguments: {},
      },
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(rpc().responses).toEqual([
      {
        id: "slow",
        result: {
          contentItems: [
            { type: "inputText", text: "Tool execution timed out after 25ms." },
          ],
          success: false,
        },
      },
    ]);
  });

  it("routes lifecycle notifications only to listeners for their thread", () => {
    const client = new CodexAppServerClient();
    const first: string[] = [];
    const second: string[] = [];
    client.onThreadNotification("thread-1", ({ method }) => first.push(method));
    client.onThreadNotification("thread-2", ({ method }) => second.push(method));

    for (const method of ["turn/started", "item/started", "item/completed", "turn/completed", "error"]) {
      rpc().emit("notification", { method, params: { threadId: "thread-1" } });
    }

    expect(first).toEqual([
      "turn/started",
      "item/started",
      "item/completed",
      "turn/completed",
      "error",
    ]);
    expect(second).toEqual([]);
  });
});
