import {
  useCreateAnthropicConversation,
  useListAnthropicConversations,
  useListAnthropicMessages,
} from "@workspace/api-client-react";
import type { AnthropicConversation, AnthropicMessage } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { fetch } from "expo/fetch";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";

import { useColors } from "@/hooks/useColors";

const SUGGESTED_PROMPTS = [
  "What's my net worth breakdown?",
  "Which bills are due soon?",
  "How is my cash flow trending?",
  "What are my biggest expenses?",
];

type DisplayMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
};

function MessageBubble({ message, colors }: { message: DisplayMessage; colors: ReturnType<typeof useColors> }) {
  const isUser = message.role === "user";
  const styles = StyleSheet.create({
    container: {
      marginBottom: 12,
      paddingHorizontal: 16,
      alignItems: isUser ? "flex-end" : "flex-start",
    },
    bubble: {
      maxWidth: "85%",
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: isUser ? colors.primary : colors.card,
      borderWidth: isUser ? 0 : 1,
      borderColor: colors.border,
    },
    text: {
      fontSize: 15,
      color: isUser ? colors.primaryForeground : colors.foreground,
      fontFamily: "Inter_400Regular",
      lineHeight: 22,
    },
    cursor: {
      color: colors.primary,
      fontFamily: "Inter_400Regular",
    },
  });

  return (
    <View style={styles.container}>
      <View style={styles.bubble}>
        <Text style={styles.text}>
          {message.content}
          {message.isStreaming && <Text style={styles.cursor}>▊</Text>}
        </Text>
      </View>
    </View>
  );
}

export default function AIScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [selectedConvId, setSelectedConvId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingMessages, setStreamingMessages] = useState<DisplayMessage[]>([]);
  const [showConversations, setShowConversations] = useState(false);

  const { data: conversations, isLoading: convsLoading, refetch: refetchConvs } = useListAnthropicConversations();
  const { data: serverMessages, isLoading: messagesLoading, refetch: refetchMessages } = useListAnthropicMessages(
    selectedConvId ?? 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled: selectedConvId !== null } as any }
  );
  const createConversation = useCreateAnthropicConversation();

  useEffect(() => {
    if (conversations && conversations.length > 0 && selectedConvId === null) {
      setSelectedConvId(conversations[0].id);
    }
  }, [conversations, selectedConvId]);

  useEffect(() => {
    if (serverMessages) {
      const msgs: DisplayMessage[] = serverMessages.map((m: AnthropicMessage) => ({
        id: String(m.id),
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      setStreamingMessages(msgs);
    }
  }, [serverMessages]);

  const handleNewConversation = useCallback(async () => {
    const conv = await createConversation.mutateAsync({
      data: { title: "New conversation" },
    });
    setSelectedConvId(conv.id);
    setStreamingMessages([]);
    setShowConversations(false);
    await refetchConvs();
  }, [createConversation, refetchConvs]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || !selectedConvId || sending) return;

    const userMsg: DisplayMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text.trim(),
    };

    const assistantMsgId = `assistant-${Date.now()}`;
    const assistantMsg: DisplayMessage = {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      isStreaming: true,
    };

    setStreamingMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setSending(true);

    try {
      const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
        ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
        : "";

      const response = await fetch(`${baseUrl}/api/anthropic/conversations/${selectedConvId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ content: text.trim() }),
      });

      if (!response.ok) throw new Error("Failed to send message");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as { content?: string; text?: string };
            const chunk = parsed.content ?? parsed.text ?? "";
            if (chunk) {
              fullContent += chunk;
              setStreamingMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, content: fullContent } : m
                )
              );
            }
          } catch {
          }
        }
      }

      setStreamingMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, isStreaming: false } : m
        )
      );
    } catch {
      setStreamingMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: "Something went wrong. Please try again.", isStreaming: false }
            : m
        )
      );
    } finally {
      setSending(false);
    }
  }, [selectedConvId, sending]);

  const topPadding = Platform.OS === "web" ? 67 : insets.top;
  const bottomPadding = Platform.OS === "web" ? 34 : insets.bottom;

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingTop: topPadding + 12,
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 10,
    },
    headerTitle: {
      flex: 1,
      fontSize: 16,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    headerBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    convPanel: {
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      maxHeight: 180,
    },
    convItem: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    convItemActive: {
      backgroundColor: `${colors.primary}15`,
    },
    convTitle: {
      fontSize: 13,
      color: colors.foreground,
      fontFamily: "Inter_500Medium",
    },
    convTitleActive: {
      color: colors.primary,
    },
    convDate: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    messagesContainer: {
      flex: 1,
    },
    messagesContent: {
      paddingTop: 16,
      paddingBottom: 16,
    },
    suggestionsContainer: {
      paddingHorizontal: 16,
      paddingTop: 24,
      gap: 8,
    },
    suggestionsLabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      marginBottom: 4,
    },
    suggestionChip: {
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    suggestionText: {
      fontSize: 14,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
    },
    inputBar: {
      flexDirection: "row",
      alignItems: "flex-end",
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: bottomPadding + 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
      gap: 8,
    },
    textInput: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      backgroundColor: colors.card,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
      paddingVertical: 10,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
      fontSize: 15,
    },
    sendBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    sendBtnDisabled: {
      backgroundColor: colors.muted,
    },
    loadingContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    otisLabel: {
      fontSize: 24,
      color: colors.primary,
      fontFamily: "Inter_700Bold",
      textAlign: "center",
      marginBottom: 4,
    },
    otisSubtitle: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
    },
  });

  const selectedConvTitle = conversations?.find((c: AnthropicConversation) => c.id === selectedConvId)?.title ?? "Otis AI";

  const messages = streamingMessages;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{selectedConvTitle}</Text>
        </View>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => setShowConversations((v) => !v)}
        >
          <Feather name="list" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerBtn} onPress={handleNewConversation}>
          <Feather name="plus" size={18} color={colors.foreground} />
        </TouchableOpacity>
      </View>

      {showConversations && (
        <FlatList
          style={styles.convPanel}
          data={conversations ?? []}
          keyExtractor={(item: AnthropicConversation) => String(item.id)}
          renderItem={({ item }: { item: AnthropicConversation }) => (
            <TouchableOpacity
              style={[styles.convItem, item.id === selectedConvId && styles.convItemActive]}
              onPress={() => {
                setSelectedConvId(item.id);
                setShowConversations(false);
              }}
            >
              <Text style={[styles.convTitle, item.id === selectedConvId && styles.convTitleActive]}
                numberOfLines={1}
              >
                {item.title || "Conversation"}
              </Text>
              <Text style={styles.convDate}>
                {new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={{ padding: 16, alignItems: "center" }}>
              <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontSize: 14 }}>
                No conversations yet
              </Text>
            </View>
          }
          scrollEnabled={!!(conversations && conversations.length > 3)}
          showsVerticalScrollIndicator={false}
        />
      )}

      {messagesLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          style={styles.messagesContainer}
          contentContainerStyle={styles.messagesContent}
          data={[...messages].reverse()}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MessageBubble message={item} colors={colors} />}
          inverted
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
          ListFooterComponent={
            messages.length === 0 ? (
              <View style={styles.suggestionsContainer}>
                <Text style={styles.otisLabel}>Otis</Text>
                <Text style={styles.otisSubtitle}>Your financial AI assistant</Text>
                <Text style={[styles.suggestionsLabel, { marginTop: 20 }]}>Suggested</Text>
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <TouchableOpacity
                    key={prompt}
                    style={styles.suggestionChip}
                    onPress={() => {
                      if (selectedConvId) {
                        sendMessage(prompt);
                      } else {
                        handleNewConversation().then(() => sendMessage(prompt));
                      }
                    }}
                  >
                    <Text style={styles.suggestionText}>{prompt}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null
          }
        />
      )}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.textInput}
          value={input}
          onChangeText={setInput}
          placeholder="Ask Otis anything..."
          placeholderTextColor={colors.mutedForeground}
          multiline
          returnKeyType="send"
          onSubmitEditing={() => {
            if (selectedConvId) {
              sendMessage(input);
            } else {
              handleNewConversation().then(() => sendMessage(input));
            }
          }}
          blurOnSubmit={false}
          editable={!sending}
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!input.trim() || sending) && styles.sendBtnDisabled]}
          onPress={() => {
            if (selectedConvId) {
              sendMessage(input);
            } else {
              handleNewConversation().then(() => sendMessage(input));
            }
          }}
          disabled={!input.trim() || sending}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Feather name="send" size={16} color={input.trim() ? colors.primaryForeground : colors.mutedForeground} />
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
