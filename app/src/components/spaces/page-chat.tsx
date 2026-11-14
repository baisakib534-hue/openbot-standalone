import type { Message } from "@ag-ui/core";
import {
  CopilotChat,
  UseAgentUpdate,
  useAgent,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import { IconFilePlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  createPage,
  pageConversation,
  saveReviewedPage,
  spaceGrantsQueryOptions,
  spaceKeys,
  type Page,
  type Space,
} from "@/lib/spaces/api";

/**
 * The conversation a page and a Bot share, docked beside the editor.
 *
 * The thread is an ordinary Bot thread — the server mints one per (page, Bot) pair and binds
 * it, and the runtime puts the page itself into the run's context — so this pane is a plain
 * CopilotChat over that thread id, in local mode exactly as upstream. Two page-specific acts
 * live here: saving the conversation as a new page (the messages on screen, formatted as
 * markdown, written through the pages API with this thread recorded as their source), and the
 * `review_space_page` human-in-the-loop tool, through which a Bot proposes a page draft that
 * lands only when the person approves it.
 */

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function conversationMarkdown(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      text: messageText(message).trim(),
    }))
    .filter((message) => message.text.length > 0)
    .map((message) => `## ${message.role === "user" ? "You" : "Bot"}\n\n${message.text}`)
    .join("\n\n");
}

const reviewSchema = z.object({
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(20_000),
  spaceId: z.string().min(1),
});

function ReviewTool({ threadId }: { threadId: string }) {
  const queryClient = useQueryClient();
  const Card = useMemo(
    () =>
      function ReviewCard(props: {
        args: Partial<z.infer<typeof reviewSchema>>;
        respond?: (result: unknown) => Promise<void>;
        result?: string;
      }) {
        const [state, setState] = useState<"idle" | "saving" | "saved" | "declined" | "error">(
          props.result ? "saved" : "idle",
        );
        const [error, setError] = useState<string | null>(null);
        const { title, content, spaceId } = props.args;
        if (!title || !content || !spaceId) return null;
        if (props.result) {
          return (
            <div className="rounded-md border border-border bg-card p-3 text-sm text-card-foreground">
              Saved “{title}” to the Space.
            </div>
          );
        }
        return (
          <div className="rounded-md border border-border bg-card p-3 text-card-foreground">
            <p className="text-sm font-medium">Review this page draft</p>
            <p className="mt-1 text-sm font-semibold">{title}</p>
            <div className="prose-sm mt-2 max-h-64 overflow-y-auto text-sm">
              <Streamdown>{content}</Streamdown>
            </div>
            {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={state === "saving" || state === "saved" || state === "declined"}
                onClick={async () => {
                  setState("saving");
                  try {
                    const saved = await saveReviewedPage(spaceId, {
                      threadId,
                      toolCallId:
                        (props as { toolCallId?: string }).toolCallId ?? `${threadId}:${title}`,
                      title,
                      content,
                    });
                    if (saved.page) {
                      await queryClient.invalidateQueries({
                        queryKey: spaceKeys.pages(spaceId),
                      });
                      setState("saved");
                      await props.respond?.({
                        approved: true,
                        pageId: saved.page.id,
                        spaceId,
                        url: `/spaces/${spaceId}/pages/${saved.page.id}`,
                      });
                    } else {
                      setError("That page was saved and later deleted.");
                      await props.respond?.({
                        approved: true,
                        deleted: true,
                        message: "The page was saved and later deleted; do not link it.",
                      });
                    }
                  } catch (caught) {
                    setState("error");
                    setError(caught instanceof Error ? caught.message : "That did not work.");
                  }
                }}
              >
                {state === "saving" ? "Saving…" : "Approve & save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={state === "saving" || state === "saved" || state === "declined"}
                onClick={async () => {
                  setState("declined");
                  await props.respond?.({
                    approved: false,
                    message: "The owner declined this draft. Do not save it.",
                  });
                }}
              >
                Decline
              </Button>
            </div>
          </div>
        );
      },
    [queryClient, threadId],
  );

  useHumanInTheLoop({
    name: "review_space_page",
    description:
      "Present a Markdown draft for human review before saving it into an authorized Space. The person can approve and save, or decline. Do not create the page yourself after this tool: its approved result includes the saved page URL. Call once, then wait for the review result.",
    parameters: reviewSchema,
    render: Card,
  });

  return null;
}

export function PageChat({ space, page }: { space: Space; page: Page }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: grants } = useQuery(spaceGrantsQueryOptions(space.id));
  const { data: bots } = useQuery(agentListQueryOptions());
  const grantedBots = (bots ?? []).filter((bot) => grants?.includes(bot.id));
  const [agentId, setAgentId] = useState<string | null>(null);
  const activeAgentId = agentId ?? grantedBots[0]?.id ?? null;
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThreadId(null);
    if (!activeAgentId) return;
    void pageConversation(space.id, page.id, activeAgentId)
      .then(({ threadId: opened }) => {
        if (!cancelled) setThreadId(opened);
      })
      .catch(() => {
        if (!cancelled) setThreadId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [space.id, page.id, activeAgentId]);

  const { agent } = useAgent({
    agentId: activeAgentId ?? "",
    runtimeAgentId: activeAgentId ?? "",
    threadId: threadId ?? "",
    updates: [UseAgentUpdate.OnMessagesChanged],
  });

  const saveConversation = useMutation({
    mutationFn: async () => {
      if (!threadId) throw new Error("The conversation is not open yet.");
      const markdown = conversationMarkdown(agent?.messages ?? []);
      if (!markdown) throw new Error("This conversation has no text to save yet.");
      const title = window.prompt("Page title", `${page.title} — conversation`);
      if (!title) return null;
      return createPage(space.id, {
        title,
        content: markdown,
        sourceThreadId: threadId,
      });
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: spaceKeys.pages(space.id) });
      if (created) {
        await navigate({
          to: "/spaces/$spaceId/pages/$pageId",
          params: { spaceId: space.id, pageId: created.id },
        });
      }
    },
  });

  if (!grants || !bots) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (grantedBots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Bot has access to this Space yet. Grant one under “Bot access” in the library, then
        come back to discuss this page.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select
          value={activeAgentId ?? undefined}
          onValueChange={(value) => setAgentId(value as string)}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Choose a Bot" />
          </SelectTrigger>
          <SelectContent>
            {grantedBots.map((bot) => (
              <SelectItem key={bot.id} value={bot.id}>
                {bot.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!threadId || saveConversation.isPending}
          onClick={() => saveConversation.mutate()}
          title="Save conversation as page"
        >
          <IconFilePlus size={16} />
          Save as page
        </Button>
      </div>
      {saveConversation.isError ? (
        <p className="text-sm text-destructive">
          {saveConversation.error instanceof Error
            ? saveConversation.error.message
            : "That did not work."}
        </p>
      ) : null}
      {threadId && activeAgentId ? (
        <>
          <ReviewTool threadId={threadId} />
          <div className="min-h-0 flex-1">
            <CopilotChat
              agentId={activeAgentId}
              key={`${activeAgentId}:${threadId}`}
              threadId={threadId}
            />
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Opening the conversation…</p>
      )}
    </div>
  );
}
