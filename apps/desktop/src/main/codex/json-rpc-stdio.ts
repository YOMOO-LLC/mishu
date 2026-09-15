import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import {
  CodexAppServerError,
  type CodexNotification,
  type CodexServerRequest,
  type JsonRpcErrorShape,
  type JsonRpcId,
} from "./types.js";

interface JsonRpcStdioOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

interface JsonRpcMethodMessage {
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export declare interface JsonRpcStdioClient {
  on(event: "notification", listener: (notification: CodexNotification) => void): this;
  on(event: "serverRequest", listener: (request: CodexServerRequest) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export class JsonRpcStdioClient extends EventEmitter {
  private readonly options: JsonRpcStdioOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  private recentStderr = "";

  constructor(options: JsonRpcStdioOptions) {
    super();
    this.options = options;
    // EventEmitter throws when an error event has no listener. Requests still reject with the
    // same error, while this listener keeps early process failures observable without crashing.
    this.on("error", () => undefined);
  }

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new CodexAppServerError("Codex app-server client is disposed"));
    }
    this.startPromise ??= this.spawnProcess();
    return this.startPromise;
  }

  async request<TResult>(method: string, params: unknown = {}): Promise<TResult> {
    await this.start();
    const child = this.process;
    if (!child || child.stdin.destroyed) {
      throw new CodexAppServerError("Codex app-server stdin is unavailable", { method });
    }

    const id = this.nextRequestId++;
    const key = String(id);
    const response = new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(
          new CodexAppServerError(
            `Codex app-server request timed out after ${this.options.requestTimeoutMs}ms`,
            { method },
          ),
        );
      }, this.options.requestTimeoutMs);

      this.pending.set(key, {
        method,
        resolve: (result) => resolve(result as TResult),
        reject,
        timeout,
      });
    });

    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(`${message}\n`, (error) => {
      if (!error) return;
      const pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(key);
      pending.reject(new CodexAppServerError(`Failed to write ${method} request`, { method, cause: error }));
    });

    return response;
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  reject(id: JsonRpcId, error: JsonRpcErrorShape): void {
    this.writeMessage({ jsonrpc: "2.0", id, error });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.startPromise = null;
    this.rejectAll(new CodexAppServerError("Codex app-server client was disposed"));
    this.stdoutLines?.close();
    this.stdoutLines = null;

    const child = this.process;
    this.process = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_500);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async spawnProcess(): Promise<void> {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this.recentStderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.recentStderr = `${this.recentStderr}${chunk}`.slice(-8_192);
    });

    this.stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutLines.on("line", (line) => this.handleLine(line));

    child.once("exit", (code, signal) => this.handleExit(child, code, signal));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (cause) => {
        const error = new CodexAppServerError(
          `Could not start Codex app-server with ${this.options.command}`,
          { cause },
        );
        this.handleStartupError(child, error);
        reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (cause) {
      this.emit(
        "error",
        new CodexAppServerError("Codex app-server emitted invalid JSON", { data: line, cause }),
      );
      return;
    }

    if (!message || typeof message !== "object") {
      this.emit("error", new CodexAppServerError("Codex app-server emitted an invalid message", { data: message }));
      return;
    }

    const object = message as Record<string, unknown>;
    if ("id" in object && ("result" in object || "error" in object) && !("method" in object)) {
      this.handleResponse(object as unknown as JsonRpcResponse);
      return;
    }

    if (typeof object.method === "string") {
      const methodMessage = object as unknown as JsonRpcMethodMessage;
      const params = methodMessage.params ?? {};
      if (methodMessage.id !== undefined) {
        const request = { id: methodMessage.id, method: methodMessage.method, params };
        if (this.listenerCount("serverRequest") === 0) {
          this.reject(methodMessage.id, {
            code: -32601,
            message: `Unhandled app-server request: ${methodMessage.method}`,
          });
        } else {
          this.emit("serverRequest", request satisfies CodexServerRequest);
        }
      } else {
        this.emit("notification", {
          method: methodMessage.method,
          params,
        } satisfies CodexNotification);
      }
      return;
    }

    this.emit("error", new CodexAppServerError("Codex app-server emitted an unknown message", { data: message }));
  }

  private handleResponse(message: JsonRpcResponse): void {
    const key = String(message.id);
    const pending = this.pending.get(key);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(key);
    if (message.error) {
      pending.reject(
        new CodexAppServerError(message.error.message, {
          code: message.error.code,
          data: message.error.data,
          method: pending.method,
        }),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private handleStartupError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process === child) this.process = null;
    this.startPromise = null;
    this.emit("error", error);
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.process !== child) return;
    this.process = null;
    this.startPromise = null;
    this.stdoutLines?.close();
    this.stdoutLines = null;

    const detail = this.recentStderr.trim();
    const error = new CodexAppServerError(
      `Codex app-server exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
    );
    this.rejectAll(error);
    if (!this.disposed) this.emit("error", error);
    this.emit("exit", code, signal);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private writeMessage(message: unknown): void {
    const child = this.process;
    if (!child || child.stdin.destroyed) {
      throw new CodexAppServerError("Codex app-server stdin is unavailable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
