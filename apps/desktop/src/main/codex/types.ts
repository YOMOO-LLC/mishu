export type JsonRpcId = number | string;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexNotification<T = unknown> {
  method: string;
  params: T;
}

export interface CodexServerRequest<T = unknown> extends CodexNotification<T> {
  id: JsonRpcId;
}

export interface CodexAppServerClientOptions {
  /** Path or executable name for the Codex CLI. */
  command?: string;
  /** Working directory used by app-server and newly created threads. */
  cwd?: string;
  /** Extra environment variables passed to the app-server process. */
  env?: NodeJS.ProcessEnv;
  /** Timeout for ordinary JSON-RPC requests. */
  requestTimeoutMs?: number;
  /** Timeout while waiting for WebRTC SDP during realtime startup. */
  realtimeStartTimeoutMs?: number;
  /** Deadline for client-owned dynamic tool requests from app-server. */
  dynamicToolRequestTimeoutMs?: number;
}

export interface DynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
}

export interface StartThreadOptions {
  dynamicTools?: readonly DynamicToolSpec[];
  ephemeral?: boolean;
  developerInstructions?: string;
  cwd?: string;
}

export type TurnInput =
  | string
  | ReadonlyArray<{
      type: "text";
      text: string;
    }>;

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolCallResponse {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
}

export type DynamicToolHandler = (
  params: DynamicToolCallParams,
) => Promise<DynamicToolCallResponse>;

export type ThreadStartOptionsProvider = () =>
  | StartThreadOptions
  | undefined
  | Promise<StartThreadOptions | undefined>;

export type { RealtimeVoice } from "../../shared/contracts.js";

export interface StartRealtimeOptions {
  /** SDP offer created by the renderer's RTCPeerConnection. */
  sdp: string;
  /** Reuse a thread already loaded in this app-server process. */
  threadId?: string;
  voice?: RealtimeVoice;
  /** Instructions applied to the live voice model and its backing Codex session. */
  instructions?: string;
}

export interface StartRealtimeResult {
  /** SDP answer delivered by the thread/realtime/sdp notification. */
  sdp: string;
  threadId: string;
  /** Realtime session id, when the started notification arrives before the SDP answer. */
  sessionId?: string;
}

export type ConversationTextRole = "user" | "assistant";

export class CodexAppServerError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  readonly method?: string;

  constructor(
    message: string,
    options: { code?: number; data?: unknown; method?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CodexAppServerError";
    this.code = options.code;
    this.data = options.data;
    this.method = options.method;
  }
}
import type { RealtimeVoice } from "../../shared/contracts.js";
