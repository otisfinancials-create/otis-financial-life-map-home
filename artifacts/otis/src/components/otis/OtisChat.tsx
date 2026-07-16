import { useState, useRef, useEffect, useCallback } from "react";
import { Send, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useGetOtisHistory } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OtisAvatar, type OtisAvatarState } from "@/components/OtisAvatar";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  createdAt?: string;
  cachedAsOf?: string;
}

export interface ChatDirective {
  text: string;
  send: boolean;
}

interface OtisChatProps {
  directive: ChatDirective | null;
  onDirectiveConsumed: () => void;
}

// Module-level singleton store so the conversation persists across SPA
// navigation within a session. Cleared only by "Start New Conversation".
let chatStore: ChatMessage[] = [];
let historyLoaded = false;

const THIRTY_MINUTES = 30 * 60 * 1000;

function formatDivider(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAsOf(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DotsThinking() {
  return (
    <div className="flex items-start gap-3">
      <OtisAvatar state="idle" size="sm" />
      <div className="rounded-2xl rounded-tl-sm bg-[#56A0D3]/10 px-4 py-3 text-sm">
        <span className="inline-flex items-end gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-2 w-2 rounded-full bg-[#56A0D3]"
              style={{ animation: "otis-dot-bounce 1s ease-in-out infinite", animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="otis-markdown space-y-2">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
          hr: () => <hr className="my-2 border-white/30" />,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-white/20 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-white/25 px-2 py-1 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border border-white/25 px-2 py-1 text-left">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MessageBubble({ role, content, streaming, cachedAsOf }: ChatMessage) {
  const isOtis = role === "assistant";
  return (
    <div className={`flex items-start gap-3 ${isOtis ? "" : "flex-row-reverse"}`}>
      {isOtis ? (
        <OtisAvatar state="idle" size="sm" />
      ) : (
        <div className="h-8 w-8 rounded-full bg-secondary text-secondary-foreground border border-border flex items-center justify-center shrink-0 text-xs font-semibold">
          You
        </div>
      )}
      <div className={`flex flex-col ${isOtis ? "items-start" : "items-end"} max-w-[80%]`}>
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isOtis
              ? "bg-[#56A0D3] text-white rounded-tl-sm shadow-sm"
              : "bg-white text-foreground border border-border rounded-tr-sm whitespace-pre-wrap"
          }`}
        >
          {isOtis ? (
            <AssistantMarkdown content={content} />
          ) : (
            content
          )}
          {streaming && (
            <span className="inline-block w-1.5 h-4 bg-current opacity-70 ml-0.5 animate-pulse align-text-bottom" />
          )}
        </div>
        {isOtis && cachedAsOf && (
          <div className="mt-1 px-1 text-[11px] text-muted-foreground">as of {formatAsOf(cachedAsOf)}</div>
        )}
      </div>
    </div>
  );
}

export function OtisChat({ directive, onDirectiveConsumed }: OtisChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatStore);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [avatarState, setAvatarState] = useState<OtisAvatarState>("idle");
  const [avatarMessage, setAvatarMessage] = useState("");
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const isStreamingRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const talkingRef = useRef(false);

  // Load persisted history from the server the first time an empty session mounts.
  const { data: history } = useGetOtisHistory({
    query: {
      enabled: chatStore.length === 0 && !historyLoaded,
      staleTime: Infinity,
    } as never,
  });

  useEffect(() => {
    if (!history || historyLoaded || chatStore.length > 0) return;
    const mapped: ChatMessage[] = history.map((h) => ({
      role: h.role,
      content: h.content,
      createdAt: h.createdAt,
    }));
    historyLoaded = true;
    chatStore = mapped;
    setMessages(mapped);
  }, [history]);

  // Keep the module store in sync so navigating away/back preserves the chat.
  useEffect(() => {
    chatStore = messages;
  }, [messages]);

  const clearIdleTimer = () => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  useEffect(() => () => clearIdleTimer(), []);

  // Only auto-scroll the chat area (never the page) and only when the user is
  // already at/near the bottom — otherwise leave the viewport where they are.
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el || messages.length === 0) return;
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreamingRef.current) return;
      isStreamingRef.current = true;
      setIsStreaming(true);
      setInput("");
      clearIdleTimer();
      talkingRef.current = false;
      setAvatarState("thinking");
      setAvatarMessage("");

      let history: ChatMessage[] = [];
      setMessages((prev) => {
        history = prev.filter((m) => !m.streaming && m.content.trim().length > 0);
        return [...history, { role: "user", content: text }, { role: "assistant", content: "", streaming: true }];
      });

      try {
        const payload = [...history, { role: "user" as const, content: text }]
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }));

        const response = await fetch("/api/otis/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload }),
        });
        if (!response.ok || !response.body) throw new Error("Stream request failed");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantContent = "";
        let cachedAsOf: string | undefined;
        let buffer = "";

        const updateLast = (content: string, streaming: boolean) =>
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: "assistant", content, streaming, cachedAsOf };
            return updated;
          });

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.cachedAsOf) {
                cachedAsOf = parsed.cachedAsOf;
                updateLast(assistantContent, true);
              } else if (parsed.content) {
                assistantContent += parsed.content;
                if (!talkingRef.current) {
                  talkingRef.current = true;
                  setAvatarState("talking");
                }
                setAvatarMessage(assistantContent.slice(0, 60));
                updateLast(assistantContent, true);
              } else if (parsed.done) {
                updateLast(assistantContent, false);
              } else if (parsed.error) {
                updateLast(assistantContent || parsed.error, false);
              }
            } catch {
              // ignore malformed chunks
            }
          }
        }
        updateLast(assistantContent || "Hmm, I didn't catch that. Try again?", false);
      } catch {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Something went wrong on my end. Please try again.",
            streaming: false,
          };
          return updated;
        });
      } finally {
        isStreamingRef.current = false;
        setIsStreaming(false);
        // Linger in the talking state briefly, then return to idle breathing.
        clearIdleTimer();
        idleTimerRef.current = setTimeout(() => {
          setAvatarState("idle");
          setAvatarMessage("");
          talkingRef.current = false;
        }, 5000);
        inputRef.current?.focus();
      }
    },
    [],
  );

  useEffect(() => {
    if (!directive) return;
    if (directive.send) {
      void sendMessage(directive.text);
    } else {
      setInput(directive.text);
      inputRef.current?.focus();
    }
    onDirectiveConsumed();
  }, [directive, onDirectiveConsumed, sendMessage]);

  const startNew = () => {
    if (isStreamingRef.current) return;
    historyLoaded = true;
    chatStore = [];
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  };

  return (
    <div className="rounded-xl border border-border bg-stone-50/80 shadow-sm">
      <div className="flex items-center justify-between px-4 pb-3 pt-6 border-b border-border/60">
        <div className="flex items-center gap-4">
          <OtisAvatar state={avatarState} message={avatarMessage} size="md" />
          <div>
            <div className="text-sm font-semibold">Ask Otis</div>
            <div className="text-xs text-muted-foreground">Your non-judgmental best friend, always at your side</div>
          </div>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={startNew} disabled={isStreaming}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Start New Conversation
          </Button>
        )}
      </div>

      <div
        ref={scrollAreaRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="px-4 py-4 space-y-4 max-h-[420px] overflow-y-auto"
      >
        {messages.length === 0 && !isStreaming ? (
          <div className="text-center py-8">
            <div className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              Hi! I know your complete financial picture. What's on your mind today?
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const showDivider =
              !!m.createdAt &&
              !!prev?.createdAt &&
              new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > THIRTY_MINUTES;
            return (
              <div key={i} className="space-y-4">
                {showDivider && m.createdAt && (
                  <div className="flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[11px] text-muted-foreground">{formatDivider(m.createdAt)}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                {m.streaming && m.content === "" ? (
                  <DotsThinking />
                ) : (
                  <MessageBubble
                    role={m.role}
                    content={m.content}
                    streaming={m.streaming}
                    cachedAsOf={m.cachedAsOf}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      <form
        className="flex items-center gap-2 px-4 py-3 border-t border-border/60"
        onSubmit={(e) => {
          e.preventDefault();
          void sendMessage(input);
        }}
      >
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            const value = e.target.value;
            setInput(value);
            if (!isStreamingRef.current) {
              clearIdleTimer();
              talkingRef.current = false;
              setAvatarMessage("");
              setAvatarState(value.trim() ? "listening" : "idle");
            }
          }}
          placeholder='Try "Can I afford a kitchen remodel next year?"'
          className="bg-white"
          disabled={isStreaming}
        />
        <Button type="submit" size="icon" disabled={isStreaming || !input.trim()} className="bg-[#56A0D3] hover:bg-[#56A0D3]/90 text-white shrink-0">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
