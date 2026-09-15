import { EventEmitter } from "node:events";

import { JsonRpcStdioClient } from "./json-rpc-stdio.js";
import {
  CodexAppServerError,
  type CodexAppServerClientOptions,
  type CodexNotification,
  type CodexServerRequest,
  type ConversationTextRole,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type DynamicToolHandler,
  type JsonRpcErrorShape,
  type JsonRpcId,
  type StartRealtimeOptions,
  type StartRealtimeResult,
  type StartThreadOptions,
  type ThreadStartOptionsProvider,
  type TurnInput,
} from "./types.js";

interface ThreadStartResponse {
  thread: {
    id: string;
  };
}

interface RealtimeStartedParams {
  threadId: string;
  realtimeSessionId?: string | null;
  version: string;
}

interface RealtimeSdpParams {
  threadId: string;
  sdp: string;
}

interface RealtimeErrorParams {
  threadId: string;
  message: string;
}

interface RealtimeClosedParams {
  threadId: string;
  reason?: string | null;
}

interface SdpWaiter {
  promise: Promise<RealtimeSdpParams>;
  cancel: () => void;
}

interface TurnStartResponse {
  turn: {
    id: string;
  };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REALTIME_START_TIMEOUT_MS = 45_000;
const DEFAULT_DYNAMIC_TOOL_REQUEST_TIMEOUT_MS = 15_000;
const MAIN_PROCESS_ONLY_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_PROJECT_ID",
  "OPENAI_ORG_ID",
  "APP_TOKEN_SECRET",
  "TWILIO_ACCESS_TOKEN",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_AUTH_TOKEN",
] as const;

export function codexProcessEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment = { ...base, ...overrides };
  for (const name of MAIN_PROCESS_ONLY_ENV) delete environment[name];
  return environment;
}

export declare interface CodexAppServerClient {
  on(event: "notification", listener: (notification: CodexNotification) => void): this;
  on(event: "serverRequest", listener: (request: CodexServerRequest) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

/** Runs Codex app-server and exposes the thread-scoped GPT Live v3 operations used by Electron. */
export class CodexAppServerClient extends EventEmitter {
  private readonly rpc: JsonRpcStdioClient;
  private readonly cwd?: string;
  private readonly realtimeStartTimeoutMs: number;
  private readonly dynamicToolRequestTimeoutMs: number;
  private readonly threadListeners = new Map<
    string,
    Set<(notification: CodexNotification) => void>
  >();
  private dynamicToolHandler?: DynamicToolHandler;
  private threadStartOptionsProvider?: ThreadStartOptionsProvider;
  private activeThreadId: string | null = null;
  private activeRealtimeSessionId: string | null = null;
  private initialized = false;
  private startPromise: Promise<void> | null = null;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.on("error", () => undefined);
    this.cwd = options.cwd;
    this.realtimeStartTimeoutMs = options.realtimeStartTimeoutMs ?? DEFAULT_REALTIME_START_TIMEOUT_MS;
    this.dynamicToolRequestTimeoutMs =
      options.dynamicToolRequestTimeoutMs ?? DEFAULT_DYNAMIC_TOOL_REQUEST_TIMEOUT_MS;
    this.rpc = new JsonRpcStdioClient({
      command: options.command ?? process.env.CODEX_BIN ?? "codex",
      args: ["app-server", "--enable", "realtime_conversation"],
      cwd: options.cwd,
      env: codexProcessEnvironment(process.env, options.env),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    this.rpc.on("notification", (notification) => this.handleNotification(notification));
    this.rpc.on("serverRequest", (request) => {
      if (request.method === "item/tool/call" && this.dynamicToolHandler) {
        void this.handleDynamicToolRequest(request);
        return;
      }
      if (this.listenerCount("serverRequest") === 0) {
        this.rpc.reject(request.id, {
          code: -32601,
          message: `Unhandled app-server request: ${request.method}`,
        });
      } else {
        this.emit("serverRequest", request);
      }
    });
    this.rpc.on("error", (error) => this.emit("error", error));
    this.rpc.on("exit", () => {
      this.initialized = false;
      this.startPromise = null;
      this.activeThreadId = null;
      this.activeRealtimeSessionId = null;
    });
  }

  start(): Promise<void> {
    this.startPromise ??= this.initialize();
    return this.startPromise;
  }

  async startRealtime(options: StartRealtimeOptions): Promise<StartRealtimeResult> {
    await this.start();
    if (this.activeThreadId) {
      throw new CodexAppServerError(
        `Realtime is already active for thread ${this.activeThreadId}`,
        { method: "thread/realtime/start" },
      );
    }

    const threadOptions = options.threadId
      ? undefined
      : await this.threadStartOptionsProvider?.();
    const threadId = options.threadId ?? (await this.startThread(threadOptions));
    this.activeThreadId = threadId;
    this.activeRealtimeSessionId = null;
    const sdpWaiter = this.waitForSdp(threadId);

    try {
      const [, answer] = await Promise.all([
        this.rpc.request<Record<string, never>>("thread/realtime/start", {
          threadId,
          clientManagedHandoffs: true,
          model: "gpt-live-1-codex",
          outputModality: "audio",
          includeStartupContext: false,
          ...(options.instructions
            ? {
                prompt: options.instructions,
                realtimeStartInstructions: options.instructions,
              }
            : {}),
          transport: { type: "webrtc", sdp: options.sdp },
          version: "v3",
          ...(options.voice ? { voice: options.voice } : {}),
        }),
        sdpWaiter.promise,
      ]);
      return {
        sdp: answer.sdp,
        threadId,
        ...(this.activeRealtimeSessionId
          ? { sessionId: this.activeRealtimeSessionId }
          : {}),
      };
    } catch (error) {
      sdpWaiter.cancel();
      if (this.activeThreadId === threadId) {
        this.activeThreadId = null;
        this.activeRealtimeSessionId = null;
      }
      throw error;
    }
  }

  async appendSpeech(text: string, explicitThreadId?: string): Promise<void> {
    const threadId = explicitThreadId ?? this.requireActiveThread("thread/realtime/appendSpeech");
    await this.rpc.request<Record<string, never>>("thread/realtime/appendSpeech", { threadId, text });
  }

  async appendText(
    text: string,
    role: ConversationTextRole = "user",
    explicitThreadId?: string,
  ): Promise<void> {
    const threadId = explicitThreadId ?? this.requireActiveThread("thread/realtime/appendText");
    await this.rpc.request<Record<string, never>>("thread/realtime/appendText", {
      threadId,
      text,
      role,
    });
  }

  async stopRealtime(): Promise<void> {
    const threadId = this.activeThreadId;
    if (!threadId) return;
    await this.rpc.request<Record<string, never>>("thread/realtime/stop", { threadId });
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
      this.activeRealtimeSessionId = null;
    }
  }

  respondToServerRequest(id: JsonRpcId, result: unknown): void {
    this.rpc.respond(id, result);
  }

  rejectServerRequest(id: JsonRpcId, error: JsonRpcErrorShape): void {
    this.rpc.reject(id, error);
  }

  setDynamicToolHandler(handler?: DynamicToolHandler): void {
    this.dynamicToolHandler = handler;
  }

  setThreadStartOptionsProvider(provider?: ThreadStartOptionsProvider): void {
    this.threadStartOptionsProvider = provider;
  }

  onThreadNotification(
    threadId: string,
    listener: (notification: CodexNotification) => void,
  ): () => void {
    const listeners = this.threadListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.threadListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.threadListeners.delete(threadId);
    };
  }

  async startThread(options: StartThreadOptions = {}): Promise<string> {
    await this.start();
    const cwd = options.cwd ?? this.cwd;
    const response = await this.rpc.request<ThreadStartResponse>("thread/start", {
      ...(cwd ? { cwd } : {}),
      approvalPolicy: "never",
      sandbox: "read-only",
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
      ...(options.dynamicTools?.length
        ? { dynamicTools: options.dynamicTools.map((tool) => ({ ...tool })) }
        : {}),
    });
    const threadId = response.thread?.id;
    if (!threadId) {
      throw new CodexAppServerError("thread/start response did not include a thread id", {
        method: "thread/start",
        data: response,
      });
    }
    return threadId;
  }

  async startTurn(threadId: string, input: TurnInput): Promise<string> {
    await this.start();
    const normalizedInput =
      typeof input === "string" ? [{ type: "text" as const, text: input }] : [...input];
    const response = await this.rpc.request<TurnStartResponse>("turn/start", {
      threadId,
      input: normalizedInput,
    });
    const turnId = response.turn?.id;
    if (!turnId) {
      throw new CodexAppServerError("turn/start response did not include a turn id", {
        method: "turn/start",
        data: response,
      });
    }
    return turnId;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.rpc.request<Record<string, never>>("turn/interrupt", { threadId, turnId });
  }

  async dispose(): Promise<void> {
    try {
      await this.stopRealtime();
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
    this.activeThreadId = null;
    this.activeRealtimeSessionId = null;
    this.threadListeners.clear();
    this.dynamicToolHandler = undefined;
    this.threadStartOptionsProvider = undefined;
    this.initialized = false;
    this.startPromise = null;
    await this.rpc.dispose();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc.start();
    await this.rpc.request("initialize", {
      clientInfo: {
        name: "mishu",
        title: "Mishu",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.initialized = true;
  }

  private handleNotification(notification: CodexNotification): void {
    if (notification.method === "thread/realtime/started") {
      const params = notification.params as RealtimeStartedParams;
      if (params.threadId === this.activeThreadId) {
        this.activeRealtimeSessionId = params.realtimeSessionId ?? null;
      }
    } else if (notification.method === "thread/realtime/closed") {
      const params = notification.params as RealtimeClosedParams;
      if (params.threadId === this.activeThreadId) {
        this.activeThreadId = null;
        this.activeRealtimeSessionId = null;
      }
    }
    const threadId = this.notificationThreadId(notification);
    if (threadId) {
      for (const listener of this.threadListeners.get(threadId) ?? []) {
        listener(notification);
      }
    }
    this.emit("notification", notification);
  }

  private async handleDynamicToolRequest(request: CodexServerRequest): Promise<void> {
    const handler = this.dynamicToolHandler;
    if (!handler) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const timeoutResult = new Promise<DynamicToolCallResponse>((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              contentItems: [
                {
                  type: "inputText",
                  text: `Tool execution timed out after ${this.dynamicToolRequestTimeoutMs}ms.`,
                },
              ],
              success: false,
            }),
          this.dynamicToolRequestTimeoutMs,
        );
      });
      const result = await Promise.race([
        handler(request.params as DynamicToolCallParams),
        timeoutResult,
      ]);
      this.rpc.respond(request.id, result);
    } catch {
      this.rpc.respond(request.id, {
        contentItems: [
          {
            type: "inputText",
            text: "Tool execution failed.",
          },
        ],
        success: false,
      } satisfies DynamicToolCallResponse);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private notificationThreadId(notification: CodexNotification): string | undefined {
    const params = notification.params;
    if (!params || typeof params !== "object") return undefined;
    const threadId = (params as Record<string, unknown>).threadId;
    return typeof threadId === "string" ? threadId : undefined;
  }

  private waitForSdp(threadId: string): SdpWaiter {
    let settled = false;
    let rejectPromise: (error: Error) => void = () => undefined;

    const cleanup = (): void => {
      this.off("notification", onNotification);
      this.off("error", onError);
      clearTimeout(timeout);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const onError = (error: Error): void => fail(error);
    const onNotification = (notification: CodexNotification): void => {
      if (notification.method === "thread/realtime/sdp") {
        const params = notification.params as RealtimeSdpParams;
        if (params.threadId !== threadId) return;
        settled = true;
        cleanup();
        resolvePromise(params);
        return;
      }

      if (notification.method === "thread/realtime/error") {
        const params = notification.params as RealtimeErrorParams;
        if (params.threadId === threadId) {
          fail(new CodexAppServerError(params.message, { method: "thread/realtime/start" }));
        }
      } else if (notification.method === "thread/realtime/closed") {
        const params = notification.params as RealtimeClosedParams;
        if (params.threadId === threadId) {
          fail(
            new CodexAppServerError(
              `Realtime transport closed before SDP${params.reason ? `: ${params.reason}` : ""}`,
              { method: "thread/realtime/start" },
            ),
          );
        }
      }
    };

    let resolvePromise: (params: RealtimeSdpParams) => void = () => undefined;
    const promise = new Promise<RealtimeSdpParams>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timeout = setTimeout(
      () =>
        fail(
          new CodexAppServerError(
            `Timed out waiting for realtime SDP after ${this.realtimeStartTimeoutMs}ms`,
            { method: "thread/realtime/start" },
          ),
        ),
      this.realtimeStartTimeoutMs,
    );
    this.on("notification", onNotification);
    this.on("error", onError);

    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        cleanup();
      },
    };
  }

  private requireActiveThread(method: string): string {
    if (!this.activeThreadId) {
      throw new CodexAppServerError("No realtime session is active", { method });
    }
    return this.activeThreadId;
  }
}
