import { useState, useRef, useEffect, useCallback } from "react";
import { Bot, Plus, Trash2, Send, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useListAnthropicConversations,
  useCreateAnthropicConversation,
  useDeleteAnthropicConversation,
  useGetAnthropicConversation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListAnthropicConversationsQueryKey, getGetAnthropicConversationQueryKey } from "@workspace/api-client-react";

interface StreamingMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

const SUGGESTED_PROMPTS = [
  "What's my current monthly cash flow?",
  "Which bills are due in the next 7 days?",
  "How much am I spending on subscriptions?",
  "What's my net worth breakdown by account type?",
  "Am I saving enough relative to my income?",
];

function MessageBubble({ role, content, streaming }: StreamingMessage) {
  const isAssistant = role === "assistant";
  return (
    <div className={`flex items-start gap-3 ${isAssistant ? "" : "flex-row-reverse"}`}>
      <div
        className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold ${
          isAssistant
            ? "bg-primary/15 text-primary border border-primary/20"
            : "bg-secondary text-secondary-foreground border border-border"
        }`}
      >
        {isAssistant ? <Bot className="h-3.5 w-3.5" /> : "JS"}
      </div>
      <div
        className={`rounded-2xl px-4 py-2.5 text-sm max-w-[78%] leading-relaxed whitespace-pre-wrap ${
          isAssistant
            ? "bg-secondary text-secondary-foreground rounded-tl-sm"
            : "bg-primary text-primary-foreground rounded-tr-sm"
        }`}
      >
        {content}
        {streaming && (
          <span className="inline-block w-1.5 h-4 bg-current opacity-70 ml-0.5 animate-pulse align-text-bottom" />
        )}
      </div>
    </div>
  );
}

export default function AI() {
  const queryClient = useQueryClient();
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [streamingMessages, setStreamingMessages] = useState<StreamingMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: conversations, isLoading: loadingConvs } = useListAnthropicConversations();
  const { data: activeConv, isLoading: loadingConv } = useGetAnthropicConversation(
    activeConvId ?? 0,
    { query: { enabled: activeConvId !== null } }
  );
  const createConv = useCreateAnthropicConversation();
  const deleteConv = useDeleteAnthropicConversation();

  const displayMessages: StreamingMessage[] =
    isStreaming || streamingMessages.length > 0
      ? streamingMessages
      : (activeConv?.messages ?? []).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayMessages]);

  useEffect(() => {
    if (activeConvId !== null && !isStreaming) {
      setStreamingMessages([]);
    }
  }, [activeConvId, isStreaming]);

  const startNewConversation = useCallback(async () => {
    const conv = await createConv.mutateAsync({ data: { title: "New conversation" } });
    setActiveConvId(conv.id);
    setStreamingMessages([]);
    await queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [createConv, queryClient]);

  const handleDeleteConversation = useCallback(
    async (id: number, e: React.MouseEvent) => {
      e.stopPropagation();
      await deleteConv.mutateAsync({ id });
      if (activeConvId === id) {
        setActiveConvId(null);
        setStreamingMessages([]);
      }
      await queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
    },
    [deleteConv, activeConvId, queryClient]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;

      let convId = activeConvId;
      if (convId === null) {
        const title = text.slice(0, 60);
        const conv = await createConv.mutateAsync({ data: { title } });
        convId = conv.id;
        setActiveConvId(conv.id);
        await queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
      }

      const currentMessages: StreamingMessage[] = [
        ...(activeConv?.messages ?? []).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user", content: text },
        { role: "assistant", content: "", streaming: true },
      ];
      setStreamingMessages(currentMessages);
      setIsStreaming(true);
      setInput("");

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const response = await fetch(`/api/anthropic/conversations/${convId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
          signal: abort.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error("Stream request failed");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantContent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.content) {
                assistantContent += parsed.content;
                setStreamingMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: assistantContent,
                    streaming: true,
                  };
                  return updated;
                });
              } else if (parsed.done) {
                setStreamingMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: assistantContent,
                    streaming: false,
                  };
                  return updated;
                });
              }
            } catch {
              // ignore malformed chunks
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") {
          setStreamingMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: "Something went wrong. Please try again.",
              streaming: false,
            };
            return updated;
          });
        }
      } finally {
        setIsStreaming(false);
        await queryClient.invalidateQueries({
          queryKey: getGetAnthropicConversationQueryKey(convId!),
        });
        await queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
        inputRef.current?.focus();
      }
    },
    [activeConvId, activeConv, createConv, isStreaming, queryClient]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <div className="flex h-[calc(100vh-5rem)] gap-4 animate-in fade-in duration-500">
      {/* Sidebar — conversation history */}
      <div className="w-56 shrink-0 flex flex-col gap-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 text-sm"
          onClick={startNewConversation}
          disabled={createConv.isPending}
        >
          <Plus className="h-4 w-4" />
          New chat
        </Button>

        <div className="flex-1 overflow-y-auto space-y-1">
          {loadingConvs ? (
            <div className="space-y-1.5 pt-1">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (conversations ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground px-1 pt-2">No conversations yet.</p>
          ) : (
            [...(conversations ?? [])].reverse().map((c) => (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => { setActiveConvId(c.id); setStreamingMessages([]); }}
                onKeyDown={(e) => { if (e.key === "Enter") { setActiveConvId(c.id); setStreamingMessages([]); } }}
                className={`w-full text-left text-xs px-3 py-2 rounded-md flex items-center justify-between group transition-colors cursor-pointer ${
                  activeConvId === c.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                <span className="truncate flex-1 mr-1">{c.title}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => handleDeleteConversation(c.id, e)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleDeleteConversation(c.id, e as unknown as React.MouseEvent); }}
                  className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity shrink-0 cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main chat area */}
      <Card className="flex-1 flex flex-col overflow-hidden bg-card border-border">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border shrink-0">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Otis AI</span>
          <span className="text-xs text-muted-foreground ml-1">
            — financial intelligence
          </span>
        </div>

        {/* Messages */}
        <CardContent className="flex-1 overflow-y-auto p-5 space-y-4">
          {activeConvId === null ? (
            /* Welcome / empty state */
            <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
              <div className="space-y-2">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <Bot className="h-6 w-6 text-primary" />
                </div>
                <h2 className="text-base font-semibold">Ask Otis anything</h2>
                <p className="text-sm text-muted-foreground max-w-xs">
                  I have real-time access to your accounts, bills, pay schedules, and forecast data.
                </p>
              </div>
              <div className="space-y-2 w-full max-w-sm">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => sendMessage(p)}
                    className="w-full text-left text-xs px-3 py-2.5 rounded-md border border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors flex items-center justify-between group"
                  >
                    <span>{p}</span>
                    <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          ) : loadingConv && displayMessages.length === 0 ? (
            <div className="space-y-4 pt-2">
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-16 w-3/4 ml-auto" />
            </div>
          ) : displayMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
              <p className="text-sm text-muted-foreground">Start the conversation below.</p>
              <div className="space-y-1.5 w-full max-w-sm">
                {SUGGESTED_PROMPTS.slice(0, 3).map((p) => (
                  <button
                    key={p}
                    onClick={() => sendMessage(p)}
                    className="w-full text-left text-xs px-3 py-2 rounded-md border border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            displayMessages.map((m, i) => (
              <MessageBubble key={i} role={m.role} content={m.content} streaming={m.streaming} />
            ))
          )}
          <div ref={bottomRef} />
        </CardContent>

        {/* Input */}
        <div className="p-4 border-t border-border bg-card shrink-0">
          <form className="flex gap-2" onSubmit={handleSubmit}>
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isStreaming ? "Otis is thinking..." : "Ask about your finances..."}
              className="flex-1 bg-background border-border focus-visible:ring-primary text-sm"
              disabled={isStreaming}
              autoFocus
            />
            <Button type="submit" disabled={isStreaming || !input.trim()} size="icon">
              <Send className="h-4 w-4" />
            </Button>
          </form>
          <p className="text-center text-xs text-muted-foreground mt-2">
            Otis uses your live financial data — accounts, bills, pay schedules, and forecast.
          </p>
        </div>
      </Card>
    </div>
  );
}
