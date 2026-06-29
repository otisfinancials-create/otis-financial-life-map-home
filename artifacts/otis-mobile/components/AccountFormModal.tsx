import {
  useCreateAccount,
  useDeleteAccount,
  useUpdateAccount,
} from "@workspace/api-client-react";
import type { AccountInput, AccountUpdate } from "@workspace/api-client-react";
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

const ACCOUNT_TYPES = [
  { label: "Checking", value: "checking" },
  { label: "Savings", value: "savings" },
  { label: "Investment", value: "investment" },
  { label: "Retirement", value: "retirement" },
  { label: "Loan", value: "loan" },
  { label: "Credit Card", value: "credit_card" },
] as const;

type AccountTypeValue = (typeof ACCOUNT_TYPES)[number]["value"];

function isLiabilityType(type: string): boolean {
  return type === "loan" || type === "credit_card";
}

export type AccountFormData = {
  id?: number;
  accountName: string;
  institutionName: string;
  accountType: string;
  currentBalance: number;
  isAsset: boolean;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialData?: AccountFormData;
};

function FormLabel({
  text,
  colors,
}: {
  text: string;
  colors: ReturnType<typeof useColors>;
}) {
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

export function AccountFormModal({
  visible,
  onClose,
  onSuccess,
  initialData,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const isEdit = !!initialData?.id;

  const [accountName, setAccountName] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [accountType, setAccountType] = useState<AccountTypeValue>("checking");
  const [balanceStr, setBalanceStr] = useState("0");
  const [isAsset, setIsAsset] = useState(true);

  useEffect(() => {
    if (visible && initialData) {
      setAccountName(initialData.accountName);
      setInstitutionName(initialData.institutionName);
      setAccountType((initialData.accountType as AccountTypeValue) ?? "checking");
      setBalanceStr(String(initialData.currentBalance));
      setIsAsset(initialData.isAsset);
    } else if (visible && !initialData) {
      setAccountName("");
      setInstitutionName("");
      setAccountType("checking");
      setBalanceStr("0");
      setIsAsset(true);
    }
  }, [visible, initialData]);

  const handleAccountTypeChange = (value: AccountTypeValue) => {
    setAccountType(value);
    setIsAsset(!isLiabilityType(value));
  };

  const createAccount = useCreateAccount({
    mutation: {
      onSuccess: () => {
        onSuccess();
        onClose();
      },
      onError: () => {
        Alert.alert("Error", "Could not add the account. Please try again.");
      },
    },
  });

  const updateAccount = useUpdateAccount({
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

  const deleteAccount = useDeleteAccount({
    mutation: {
      onSuccess: () => {
        onSuccess();
        onClose();
      },
      onError: () => {
        Alert.alert("Error", "Could not delete the account. Please try again.");
      },
    },
  });

  const isSubmitting =
    createAccount.isPending || updateAccount.isPending || deleteAccount.isPending;

  function validate(): string | null {
    if (!accountName.trim()) return "Account name is required.";
    if (!institutionName.trim()) return "Institution name is required.";
    const balance = parseFloat(balanceStr);
    if (isNaN(balance)) return "Enter a valid balance.";
    return null;
  }

  function handleSubmit() {
    const error = validate();
    if (error) {
      Alert.alert("Invalid input", error);
      return;
    }

    const balance = parseFloat(balanceStr);

    if (isEdit && initialData?.id) {
      const data: AccountUpdate = {
        accountName: accountName.trim(),
        institutionName: institutionName.trim(),
        accountType,
        currentBalance: balance,
        isAsset,
      };
      updateAccount.mutate({ id: initialData.id, data });
    } else {
      const data: AccountInput = {
        accountName: accountName.trim(),
        institutionName: institutionName.trim(),
        accountType,
        currentBalance: balance,
        isAsset,
      };
      createAccount.mutate({ data });
    }
  }

  function handleDelete() {
    if (!initialData?.id) return;
    Alert.alert(
      "Delete account",
      `Remove "${initialData.accountName}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteAccount.mutate({ id: initialData.id as number }),
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
    toggleHint: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
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
              <Text style={styles.title}>
                {isEdit ? "Edit Account" : "Add Account"}
              </Text>
              <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <KeyboardAwareScrollViewCompat
              style={{ flex: 0 }}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              <FormLabel text="Institution" colors={colors} />
              <TextInput
                style={styles.input}
                value={institutionName}
                onChangeText={setInstitutionName}
                placeholder="e.g. Chase, Vanguard, Fidelity"
                placeholderTextColor={colors.mutedForeground}
                returnKeyType="next"
                autoCorrect={false}
              />

              <FormLabel text="Account Name" colors={colors} />
              <TextInput
                style={styles.input}
                value={accountName}
                onChangeText={setAccountName}
                placeholder="e.g. Primary Checking, 401k"
                placeholderTextColor={colors.mutedForeground}
                returnKeyType="next"
                autoCorrect={false}
              />

              <FormLabel text="Account Type" colors={colors} />
              <View style={styles.pillRow}>
                {ACCOUNT_TYPES.map((type) => (
                  <TouchableOpacity
                    key={type.value}
                    style={[
                      styles.pill,
                      accountType === type.value && styles.pillActive,
                    ]}
                    onPress={() => handleAccountTypeChange(type.value)}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        accountType === type.value && styles.pillTextActive,
                      ]}
                    >
                      {type.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <FormLabel text="Current Balance ($)" colors={colors} />
              <TextInput
                style={styles.input}
                value={balanceStr}
                onChangeText={setBalanceStr}
                placeholder="0.00"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
                returnKeyType="done"
              />

              <FormLabel text="Asset Account" colors={colors} />
              <View style={styles.toggleRow}>
                <View>
                  <Text style={styles.toggleLabel}>
                    {isAsset ? "Asset" : "Liability"}
                  </Text>
                  <Text style={styles.toggleHint}>
                    {isAsset
                      ? "Adds to net worth"
                      : "Subtracts from net worth"}
                  </Text>
                </View>
                <Switch
                  value={isAsset}
                  onValueChange={setIsAsset}
                  disabled={isLiabilityType(accountType)}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor={colors.primaryForeground}
                />
              </View>
            </KeyboardAwareScrollViewCompat>

            <View style={styles.footer}>
              <TouchableOpacity
                style={[
                  styles.submitBtn,
                  isSubmitting && styles.submitBtnDisabled,
                ]}
                onPress={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting && !deleteAccount.isPending ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={styles.submitBtnText}>
                    {isEdit ? "Save Changes" : "Add Account"}
                  </Text>
                )}
              </TouchableOpacity>

              {isEdit && (
                <TouchableOpacity
                  style={[
                    styles.deleteBtn,
                    isSubmitting && styles.submitBtnDisabled,
                  ]}
                  onPress={handleDelete}
                  disabled={isSubmitting}
                >
                  {deleteAccount.isPending ? (
                    <ActivityIndicator color={colors.destructive} />
                  ) : (
                    <Text style={styles.deleteBtnText}>Delete Account</Text>
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
