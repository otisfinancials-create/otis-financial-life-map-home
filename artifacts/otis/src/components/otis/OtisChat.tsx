import { useState, useRef, useEffect, useCallback } from "react";
import { Send, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

function PawThinking() {
  return (
    <div className="flex items-start gap-3">
      <OtisAvatar />
      <div className="rounded-2xl rounded-tl-sm bg-teal-600/10 px-4 py-2.5 text-sm">
        <span className="inline-flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="animate-bounce text-base"
              style={{ animationDelay: `${i * 200}ms`, animationDuration: "1s" }}
            >
              🐾
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

function OtisAvatar() {
  return (
    <div className="h-8 w-8 rounded-full bg-teal-600 text-white flex items-center justify-center shrink-0 text-sm font-semibold shadow-sm">
      O
    </div>
  );
}

function MessageBubble({ role, content, streaming }: ChatMessage) {
  const isOtis = role === "assistant";
  return (
    <div className={`flex items-start gap-3 ${isOtis ? "" : "flex-row-reverse"}`}>
      {isOtis ? (
        <OtisAvatar />
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isStreamingRef = useRef(false);

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
            content: "Something went wrong on my end. Please try again. 🐾",
            streaming: false,
          };
          return updated;
        });
      } finally {
        isStreamingRef.current = false;
        setIsStreaming(false);
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
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <OtisAvatar />
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
              Ask me anything about your financial future. I know your numbers and I'm here to help. 🐾
            </div>
          </div>
        ) : (
          messages.map((m, i) =>
            m.streaming && m.content === "" ? (
              <PawThinking key={i} />
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
          onChange={(e) => setInput(e.target.value)}
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
