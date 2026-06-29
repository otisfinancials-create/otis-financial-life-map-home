import {
  useDeleteAccount,
  useGetAccountsSummary,
  useListAccounts,
} from "@workspace/api-client-react";
import type { Account } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AccountFormModal } from "@/components/AccountFormModal";
import type { AccountFormData } from "@/components/AccountFormModal";
import { useColors } from "@/hooks/useColors";

type AccountType =
  | "checking"
  | "savings"
  | "investment"
  | "retirement"
  | "loan"
  | "credit_card"
  | string;

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  investment: "Investment",
  retirement: "Retirement",
  loan: "Loan",
  credit_card: "Credit Card",
};

const ACCOUNT_TYPE_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  checking: "credit-card",
  savings: "archive",
  investment: "trending-up",
  retirement: "umbrella",
  loan: "minus-circle",
  credit_card: "credit-card",
};

function getAccountIcon(type: AccountType): keyof typeof Feather.glyphMap {
  return (ACCOUNT_TYPE_ICONS[type] as keyof typeof Feather.glyphMap) ?? "circle";
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function groupAccountsByType(
  accounts: Account[]
): Record<string, Account[]> {
  const groups: Record<string, Account[]> = {};
  for (const account of accounts) {
    const type = account.accountType;
    if (!groups[type]) groups[type] = [];
    groups[type].push(account);
  }
  return groups;
}

type SwipeableAccountCardProps = {
  account: Account;
  onEdit: (account: Account) => void;
  onDelete: (account: Account) => void;
};

function SwipeableAccountCard({
  account,
  onEdit,
  onDelete,
}: SwipeableAccountCardProps) {
  const colors = useColors();
  const swipeableRef = useRef<Swipeable>(null);

  const balance = account.currentBalance;
  const isLiability = !account.isAsset;

  const cardStyles = StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      marginBottom: 8,
    },
    iconWrap: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    info: {
      flex: 1,
    },
    name: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_500Medium",
    },
    institution: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    right: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    balancePositive: {
      fontSize: 16,
      color: colors.income,
      fontFamily: "Inter_600SemiBold",
    },
    balanceNegative: {
      fontSize: 16,
      color: colors.expense,
      fontFamily: "Inter_600SemiBold",
    },
    balanceNeutral: {
      fontSize: 16,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    deleteAction: {
      backgroundColor: colors.destructive,
      justifyContent: "center",
      alignItems: "center",
      width: 72,
      borderRadius: colors.radius,
      marginBottom: 8,
    },
  });

  const balanceStyle = isLiability
    ? cardStyles.balanceNegative
    : balance > 0
      ? cardStyles.balancePositive
      : cardStyles.balanceNeutral;

  const renderRightActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>
  ) => {
    const scale = dragX.interpolate({
      inputRange: [-80, 0],
      outputRange: [1, 0.5],
      extrapolate: "clamp",
    });
    return (
      <TouchableOpacity
        style={cardStyles.deleteAction}
        onPress={() => {
          swipeableRef.current?.close();
          onDelete(account);
        }}
        activeOpacity={0.8}
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          <Feather name="trash-2" size={20} color="#fff" />
        </Animated.View>
      </TouchableOpacity>
    );
  };

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      rightThreshold={60}
      overshootRight={false}
      friction={2}
    >
      <TouchableOpacity
        style={cardStyles.card}
        onPress={() => onEdit(account)}
        activeOpacity={0.75}
      >
        <View style={cardStyles.iconWrap}>
          <Feather
            name={getAccountIcon(account.accountType)}
            size={16}
            color={colors.mutedForeground}
          />
        </View>
        <View style={cardStyles.info}>
          <Text style={cardStyles.name}>{account.accountName}</Text>
          <Text style={cardStyles.institution}>{account.institutionName}</Text>
        </View>
        <View style={cardStyles.right}>
          <Text style={balanceStyle}>{formatCurrency(balance)}</Text>
          <Feather
            name="chevron-right"
            size={14}
            color={colors.mutedForeground}
          />
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
}

export default function AccountsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingAccount, setEditingAccount] = useState<
    AccountFormData | undefined
  >();

  const {
    data: summary,
    isLoading: summaryLoading,
    refetch: refetchSummary,
  } = useGetAccountsSummary();
  const {
    data: accounts,
    isLoading: accountsLoading,
    refetch: refetchAccounts,
  } = useListAccounts();

  const deleteAccount = useDeleteAccount();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchSummary(), refetchAccounts()]);
    setRefreshing(false);
  }, [refetchSummary, refetchAccounts]);

  const handleSuccess = useCallback(() => {
    refetchSummary();
    refetchAccounts();
  }, [refetchSummary, refetchAccounts]);

  const handleOpenAdd = useCallback(() => {
    setEditingAccount(undefined);
    setModalVisible(true);
  }, []);

  const handleOpenEdit = useCallback((account: Account) => {
    setEditingAccount({
      id: account.id,
      accountName: account.accountName,
      institutionName: account.institutionName,
      accountType: account.accountType,
      currentBalance: account.currentBalance,
      isAsset: account.isAsset,
    });
    setModalVisible(true);
  }, []);

  const handleSwipeDelete = useCallback(
    (account: Account) => {
      Alert.alert(
        "Delete account",
        `Remove "${account.accountName}"? This cannot be undone.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              deleteAccount.mutate(
                { id: account.id },
                {
                  onSuccess: () => {
                    refetchSummary();
                    refetchAccounts();
                  },
                  onError: () => {
                    Alert.alert(
                      "Error",
                      "Could not delete the account. Please try again."
                    );
                  },
                }
              );
            },
          },
        ]
      );
    },
    [deleteAccount, refetchSummary, refetchAccounts]
  );

  const isLoading = summaryLoading || accountsLoading;
  const topPadding = Platform.OS === "web" ? 67 : insets.top;

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      paddingTop: topPadding + 16,
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    headerTop: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 16,
    },
    headerLabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    addBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    summaryRow: {
      flexDirection: "row",
      gap: 10,
    },
    summaryCard: {
      flex: 1,
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
    },
    summaryLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      letterSpacing: 0.5,
      textTransform: "uppercase",
      marginBottom: 6,
    },
    summaryValue: {
      fontSize: 18,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    summaryValuePositive: {
      color: colors.income,
    },
    summaryValueNegative: {
      color: colors.expense,
    },
    section: {
      paddingHorizontal: 20,
      marginTop: 20,
    },
    accountGroup: {
      marginBottom: 20,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 8,
      gap: 8,
    },
    groupLabel: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_600SemiBold",
    },
    accountCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      marginBottom: 8,
    },
    accountIconContainer: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    accountInfo: {
      flex: 1,
    },
    accountName: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_500Medium",
    },
    institutionName: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    accountRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    balancePositive: {
      fontSize: 16,
      color: colors.income,
      fontFamily: "Inter_600SemiBold",
    },
    balanceNegative: {
      fontSize: 16,
      color: colors.expense,
      fontFamily: "Inter_600SemiBold",
    },
    balanceNeutral: {
      fontSize: 16,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    deleteAction: {
      backgroundColor: colors.destructive,
      justifyContent: "center",
      alignItems: "center",
      width: 72,
      borderRadius: colors.radius,
      marginBottom: 8,
    },
    loadingContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    emptyContainer: {
      alignItems: "center",
      paddingTop: 60,
      gap: 12,
    },
    emptyText: {
      fontSize: 15,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    emptyHint: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
  });

  if (isLoading && !refreshing) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const grouped = groupAccountsByType(accounts ?? []);
  const typeOrder = [
    "checking",
    "savings",
    "investment",
    "retirement",
    "loan",
    "credit_card",
  ];
  const sortedTypes = Object.keys(grouped).sort(
    (a, b) =>
      (typeOrder.indexOf(a) ?? 99) - (typeOrder.indexOf(b) ?? 99)
  );

  const allAccounts = accounts ?? [];

  return (
    <View style={styles.container}>
      <FlatList
        data={[]}
        renderItem={null}
        ListHeaderComponent={
          <>
            <View style={styles.header}>
              <View style={styles.headerTop}>
                <Text style={styles.headerLabel}>Accounts</Text>
                <TouchableOpacity style={styles.addBtn} onPress={handleOpenAdd}>
                  <Feather name="plus" size={20} color={colors.primaryForeground} />
                </TouchableOpacity>
              </View>
              <View style={styles.summaryRow}>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Net Worth</Text>
                  <Text
                    style={[
                      styles.summaryValue,
                      (summary?.netWorth ?? 0) >= 0
                        ? styles.summaryValuePositive
                        : styles.summaryValueNegative,
                    ]}
                  >
                    {formatCurrency(summary?.netWorth ?? 0)}
                  </Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Assets</Text>
                  <Text style={[styles.summaryValue, styles.summaryValuePositive]}>
                    {formatCurrency(summary?.totalAssets ?? 0)}
                  </Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Liabilities</Text>
                  <Text style={[styles.summaryValue, styles.summaryValueNegative]}>
                    {formatCurrency(summary?.totalLiabilities ?? 0)}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.section}>
              {allAccounts.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Feather name="inbox" size={36} color={colors.mutedForeground} />
                  <Text style={styles.emptyText}>No accounts yet</Text>
                  <Text style={styles.emptyHint}>
                    Tap + to add your first account
                  </Text>
                </View>
              ) : (
                sortedTypes.map((type) => (
                  <View key={type} style={styles.accountGroup}>
                    <View style={styles.groupHeader}>
                      <Feather
                        name={getAccountIcon(type)}
                        size={14}
                        color={colors.mutedForeground}
                      />
                      <Text style={styles.groupLabel}>
                        {ACCOUNT_TYPE_LABELS[type] ?? type}
                      </Text>
                    </View>
                    {grouped[type].map((account) => (
                      <SwipeableAccountCard
                        key={account.id}
                        account={account}
                        onEdit={handleOpenEdit}
                        onDelete={handleSwipeDelete}
                      />
                    ))}
                  </View>
                ))
              )}
            </View>

            <View
              style={{
                height: Platform.OS === "web" ? 34 : 100,
              }}
            />
          </>
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
        keyExtractor={() => "header"}
      />

      <AccountFormModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onSuccess={handleSuccess}
        initialData={editingAccount}
      />
    </View>
  );
}
