import { useState, useRef, useEffect, useCallback } from "react";
import { Send, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OtisAvatar, type OtisAvatarState } from "@/components/OtisAvatar";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

export interface ChatDirective {
  text: string;
  send: boolean;
}

interface OtisChatProps {
  directive: ChatDirective | null;
  onDirectiveConsumed: () => void;
}

function DotsThinking() {
  return (
    <div className="flex items-start gap-3">
      <OtisAvatar state="idle" size="sm" />
      <div className="rounded-2xl rounded-tl-sm bg-teal-600/10 px-4 py-3 text-sm">
        <span className="inline-flex items-end gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-2 w-2 rounded-full bg-teal-600"
              style={{ animation: "otis-dot-bounce 1s ease-in-out infinite", animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function MessageBubble({ role, content, streaming }: ChatMessage) {
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
      <div
        className={`rounded-2xl px-4 py-2.5 text-sm max-w-[80%] leading-relaxed whitespace-pre-wrap ${
          isOtis
            ? "bg-teal-600 text-white rounded-tl-sm shadow-sm"
            : "bg-white text-foreground border border-border rounded-tr-sm"
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

export function OtisChat({ directive, onDirectiveConsumed }: OtisChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [avatarState, setAvatarState] = useState<OtisAvatarState>("idle");
  const [avatarMessage, setAvatarMessage] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isStreamingRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const talkingRef = useRef(false);

  const clearIdleTimer = () => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  useEffect(() => () => clearIdleTimer(), []);

  useEffect(() => {
    if (messages.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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
          .slice(-10)
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
        let buffer = "";

        const updateLast = (content: string, streaming: boolean) =>
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: "assistant", content, streaming };
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
              if (parsed.content) {
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
            <div className="text-xs text-muted-foreground">Your financial advisor, always at your side</div>
          </div>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={startNew} disabled={isStreaming}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Start New Conversation
          </Button>
        )}
      </div>

      <div className="px-4 py-4 space-y-4 max-h-[420px] overflow-y-auto">
        {messages.length === 0 && !isStreaming ? (
          <div className="text-center py-8">
            <div className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              Hi! I know your complete financial picture. What's on your mind today?
            </div>
          </div>
        ) : (
          messages.map((m, i) =>
            m.streaming && m.content === "" ? (
              <DotsThinking key={i} />
            ) : (
              <MessageBubble key={i} role={m.role} content={m.content} streaming={m.streaming} />
            ),
          )
        )}
        <div ref={bottomRef} />
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
        <Button type="submit" size="icon" disabled={isStreaming || !input.trim()} className="bg-teal-600 hover:bg-teal-700 text-white shrink-0">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
