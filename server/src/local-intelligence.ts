/**
 * Local-mode stand-ins for CopilotKit Intelligence (OPENBOT_LOCAL_MODE=true).
 *
 * There is no Intelligence service in local mode. What the rest of the server
 * actually needs from it on the headless/chat paths is narrow:
 *
 * - thread history reads (`getThreadMessages`),
 * - thread existence (`getThread`, `getOrCreateThread`),
 * - the per-thread run lock (`ɵacquireThreadLock` / `ɵrenewThreadLock` /
 *   `ɵcleanupThreadLock`).
 *
 * History comes from an `InMemoryAgentRunner`. That runner's store is a
 * process-wide singleton in `@copilotkit/runtime` 1.77.0, so an instance
 * created here reads the same threads the chat runtime's own runner writes —
 * but nothing survives a process restart, and nothing is shared between
 * replicas. The lock is an in-process map, which is only correct under the
 * single-instance assumption local mode is built on.
 *
 * The shapes restated here mirror `IntelligenceLike` in routines/run-turn.ts
 * and the `ThreadHistoryMessage` rows it consumes; AG-UI messages returned by
 * the runner are converted back into that row shape (`toolCalls` in the
 * `{id, name, args}` dialect).
 */
import type { Message } from "@ag-ui/client";
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2";

type ThreadHistoryMessage = {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

function toHistoryMessage(message: Message): ThreadHistoryMessage {
  const record = message as Message & {
    activityType?: string;
    toolCalls?: {
      id: string;
      function?: { name: string; arguments: string };
      name?: string;
      args?: string;
    }[];
    toolCallId?: string;
  };
  return {
    id: record.id,
    role: record.role,
    content: record.content ?? "",
    ...(record.activityType ? { activityType: record.activityType } : {}),
    ...(record.toolCalls
      ? {
          toolCalls: record.toolCalls.map((call) => ({
            id: call.id,
            name: call.function?.name ?? call.name ?? "",
            args: call.function?.arguments ?? call.args ?? "{}",
          })),
        }
      : {}),
    ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
  };
}

/** A 404 in the exact shape the existing readers duck-type on (`error.name` / `error.status`). */
export function localThreadMissingError(): Error {
  const error = new Error("Thread not found (local mode).");
  error.name = "PlatformRequestError";
  (error as { status?: unknown }).status = 404;
  return error;
}

export type LocalIntelligence = {
  getOrCreateThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
    learningContainerId?: string;
  }): Promise<{ threadId: string }>;
  getThread(params: {
    threadId: string;
    userId: string;
  }): Promise<{ threadId: string }>;
  getThreadMessages(params: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: ThreadHistoryMessage[] }>;
  ɵacquireThreadLock(params: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    ttlSeconds?: number;
    learningContainerId?: string;
  }): Promise<{ runId: string }>;
  ɵrenewThreadLock(params: {
    threadId: string;
    runId: string;
    ttlSeconds: number;
  }): Promise<unknown>;
  ɵcleanupThreadLock(params: {
    threadId: string;
    runId: string;
  }): Promise<void>;
  ɵgetRunnerWsUrl(): string;
  ɵgetRunnerAuthToken(): string;
};

/**
 * Build the local stand-in. `runner` may be shared with the chat runtime;
 * when omitted a fresh `InMemoryAgentRunner` is created, which still reads
 * the same process-global store.
 */
export function createLocalIntelligence(
  runner: InMemoryAgentRunner = new InMemoryAgentRunner(),
): LocalIntelligence {
  /** threadId -> runId holding the lock. Single-instance only, by design. */
  const locks = new Map<string, string>();

  const hasThread = (threadId: string): boolean =>
    runner.listThreads().some((thread) => thread.id === threadId) ||
    runner.getThreadMessages(threadId).length > 0;

  return {
    async getOrCreateThread({ threadId }) {
      // Nothing to create: the runner materialises a thread on its first run.
      return { threadId };
    },
    async getThread({ threadId }) {
      if (!hasThread(threadId)) throw localThreadMissingError();
      return { threadId };
    },
    async getThreadMessages({ threadId }) {
      return {
        messages: runner.getThreadMessages(threadId).map(toHistoryMessage),
      };
    },
    async ɵacquireThreadLock({ threadId, runId }) {
      const heldBy = locks.get(threadId);
      if (heldBy !== undefined && heldBy !== runId) {
        const error = new Error(
          "Thread lock denied: another run holds this thread (local mode).",
        );
        (error as { status?: unknown }).status = 409;
        throw error;
      }
      locks.set(threadId, runId);
      return { runId };
    },
    async ɵrenewThreadLock() {
      // In-process lock: nothing expires while the process lives.
      return undefined;
    },
    async ɵcleanupThreadLock({ threadId, runId }) {
      if (locks.get(threadId) === runId) locks.delete(threadId);
    },
    ɵgetRunnerWsUrl() {
      throw new Error(
        "Local mode has no Intelligence runner WebSocket; headless turns use the in-process InMemoryAgentRunner.",
      );
    },
    ɵgetRunnerAuthToken() {
      throw new Error(
        "Local mode has no Intelligence runner auth token; headless turns use the in-process InMemoryAgentRunner.",
      );
    },
  };
}
