import { useCreateBill, useDeleteBill, useUpdateBill } from "@workspace/api-client-react";
import type { BillInput, BillUpdate } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useColors } from "@/hooks/useColors";

const CATEGORIES = [
  "Housing",
  "Utilities",
  "Insurance",
  "Subscriptions",
  "Transportation",
  "Food",
  "Healthcare",
  "Entertainment",
  "Education",
  "Other",
] as const;

const FREQUENCIES = [
  { label: "Monthly", value: "monthly" },
  { label: "Weekly", value: "weekly" },
  { label: "Biweekly", value: "biweekly" },
  { label: "Quarterly", value: "quarterly" },
  { label: "Annual", value: "annually" },
] as const;

type FrequencyValue = (typeof FREQUENCIES)[number]["value"];

export type BillFormData = {
  id?: number;
  billName: string;
  category: string;
  amount: number;
  frequency: string;
  dueDay: number;
  isActive: boolean;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialData?: BillFormData;
};

function FormLabel({ text, colors }: { text: string; colors: ReturnType<typeof useColors> }) {
  return (
    <Text
      style={{
        fontSize: 11,
        color: colors.mutedForeground,
        fontFamily: "Inter_600SemiBold",
        letterSpacing: 0.8,
        textTransform: "uppercase",
        marginBottom: 8,
        marginTop: 20,
      }}
    >
      {text}
    </Text>
  );
}

export function BillFormModal({ visible, onClose, onSuccess, initialData }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const isEdit = !!initialData?.id;

  const [billName, setBillName] = useState("");
  const [category, setCategory] = useState<string>("Housing");
  const [amountStr, setAmountStr] = useState("");
  const [frequency, setFrequency] = useState<FrequencyValue>("monthly");
  const [dueDayStr, setDueDayStr] = useState("1");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (visible && initialData) {
      setBillName(initialData.billName);
      setCategory(initialData.category);
      setAmountStr(String(initialData.amount));
      setFrequency((initialData.frequency as FrequencyValue) ?? "monthly");
      setDueDayStr(String(initialData.dueDay));
      setIsActive(initialData.isActive ?? true);
    } else if (visible && !initialData) {
      setBillName("");
      setCategory("Housing");
      setAmountStr("");
      setFrequency("monthly");
      setDueDayStr("1");
      setIsActive(true);
    }
  }, [visible, initialData]);

  const createBill = useCreateBill({
    mutation: {
      onSuccess: () => {
        onSuccess();
        onClose();
      },
      onError: () => {
        Alert.alert("Error", "Could not add the bill. Please try again.");
      },
    },
  });

  const updateBill = useUpdateBill({
    mutation: {
      onSuccess: () => {
        onSuccess();
        onClose();
      },
      onError: () => {
        Alert.alert("Error", "Could not save changes. Please try again.");
      },
    },
  });

  const deleteBill = useDeleteBill({
    mutation: {
      onSuccess: () => {
        onSuccess();
        onClose();
      },
      onError: () => {
        Alert.alert("Error", "Could not delete the bill. Please try again.");
      },
    },
  });

  const isSubmitting =
    createBill.isPending || updateBill.isPending || deleteBill.isPending;

  function validate(): string | null {
    if (!billName.trim()) return "Bill name is required.";
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) return "Enter a valid amount greater than 0.";
    const dueDay = parseInt(dueDayStr, 10);
    if (isNaN(dueDay) || dueDay < 1 || dueDay > 31) return "Due day must be between 1 and 31.";
    return null;
  }

  function handleSubmit() {
    const error = validate();
    if (error) {
      Alert.alert("Invalid input", error);
      return;
    }

    const amount = parseFloat(amountStr);
    const dueDay = parseInt(dueDayStr, 10);

    if (isEdit && initialData?.id) {
      const data: BillUpdate = {
        billName: billName.trim(),
        category,
        amount,
        frequency,
        dueDay,
        isActive,
      };
      updateBill.mutate({ id: initialData.id, data });
    } else {
      const data: BillInput = {
        billName: billName.trim(),
        category,
        amount,
        frequency,
        dueDay,
        isActive,
      };
      createBill.mutate({ data });
    }
  }

  function handleDelete() {
    if (!initialData?.id) return;
    Alert.alert(
      "Delete bill",
      `Remove "${initialData.billName}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteBill.mutate({ id: initialData.id as number }),
        },
      ]
    );
  }

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      maxHeight: "90%",
    },
    handle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginTop: 12,
      marginBottom: 4,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 4,
    },
    title: {
      fontSize: 18,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    closeBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingBottom: 8,
    },
    input: {
      backgroundColor: colors.muted,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
      fontSize: 15,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    pillRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    pill: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.muted,
    },
    pillActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    pillText: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
    },
    pillTextActive: {
      color: colors.primaryForeground,
    },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: colors.muted,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    toggleLabel: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
    },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: Math.max(insets.bottom, 24),
      gap: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    submitBtn: {
      backgroundColor: colors.primary,
      borderRadius: colors.radius,
      paddingVertical: 14,
      alignItems: "center",
    },
    submitBtnDisabled: {
      opacity: 0.5,
    },
    submitBtnText: {
      fontSize: 15,
      color: colors.primaryForeground,
      fontFamily: "Inter_600SemiBold",
    },
    deleteBtn: {
      borderRadius: colors.radius,
      paddingVertical: 13,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.destructive,
    },
    deleteBtnText: {
      fontSize: 15,
      color: colors.destructive,
      fontFamily: "Inter_500Medium",
    },
  });

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Text style={styles.title}>{isEdit ? "Edit Bill" : "Add Bill"}</Text>
              <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <KeyboardAwareScrollViewCompat
              style={{ flex: 0 }}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              <FormLabel text="Bill Name" colors={colors} />
              <TextInput
                style={styles.input}
                value={billName}
                onChangeText={setBillName}
                placeholder="e.g. Netflix, Rent"
                placeholderTextColor={colors.mutedForeground}
                returnKeyType="done"
                autoCorrect={false}
              />

              <FormLabel text="Category" colors={colors} />
              <View style={styles.pillRow}>
                {CATEGORIES.map((cat) => (
                  <TouchableOpacity
                    key={cat}
                    style={[styles.pill, category === cat && styles.pillActive]}
                    onPress={() => setCategory(cat)}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        category === cat && styles.pillTextActive,
                      ]}
                    >
                      {cat}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <FormLabel text="Amount ($/mo)" colors={colors} />
              <TextInput
                style={styles.input}
                value={amountStr}
                onChangeText={setAmountStr}
                placeholder="0.00"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
                returnKeyType="done"
              />

              <FormLabel text="Frequency" colors={colors} />
              <View style={styles.pillRow}>
                {FREQUENCIES.map((f) => (
                  <TouchableOpacity
                    key={f.value}
                    style={[styles.pill, frequency === f.value && styles.pillActive]}
                    onPress={() => setFrequency(f.value)}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        frequency === f.value && styles.pillTextActive,
                      ]}
                    >
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <FormLabel text="Due Day of Month" colors={colors} />
              <TextInput
                style={styles.input}
                value={dueDayStr}
                onChangeText={setDueDayStr}
                placeholder="1–31"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                returnKeyType="done"
              />

              <FormLabel text="Status" colors={colors} />
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>
                  {isActive ? "Active" : "Inactive"}
                </Text>
                <Switch
                  value={isActive}
                  onValueChange={setIsActive}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor={colors.primaryForeground}
                />
              </View>
            </KeyboardAwareScrollViewCompat>

            <View style={styles.footer}>
              <TouchableOpacity
                style={[styles.submitBtn, isSubmitting && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting && !deleteBill.isPending ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={styles.submitBtnText}>
                    {isEdit ? "Save Changes" : "Add Bill"}
                  </Text>
                )}
              </TouchableOpacity>

              {isEdit && (
                <TouchableOpacity
                  style={[styles.deleteBtn, isSubmitting && styles.submitBtnDisabled]}
                  onPress={handleDelete}
                  disabled={isSubmitting}
                >
                  {deleteBill.isPending ? (
                    <ActivityIndicator color={colors.destructive} />
                  ) : (
                    <Text style={styles.deleteBtnText}>Delete Bill</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
