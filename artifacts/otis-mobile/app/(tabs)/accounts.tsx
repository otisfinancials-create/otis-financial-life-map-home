import { useGetAccountsSummary, useListAccounts } from "@workspace/api-client-react";
import type { Account } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

type AccountType = "checking" | "savings" | "investment" | "retirement" | "loan" | "credit_card" | string;

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

function groupAccountsByType(accounts: Account[]): Record<string, Account[]> {
  const groups: Record<string, Account[]> = {};
  for (const account of accounts) {
    const type = account.accountType;
    if (!groups[type]) groups[type] = [];
    groups[type].push(account);
  }
  return groups;
}

export default function AccountsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const { data: summary, isLoading: summaryLoading, refetch: refetchSummary } = useGetAccountsSummary();
  const { data: accounts, isLoading: accountsLoading, refetch: refetchAccounts } = useListAccounts();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchSummary(), refetchAccounts()]);
    setRefreshing(false);
  }, [refetchSummary, refetchAccounts]);

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
    headerLabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      letterSpacing: 1.2,
      textTransform: "uppercase",
      marginBottom: 16,
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
      marginTop: 20,
      paddingHorizontal: 20,
    },
    sectionTitle: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      marginBottom: 10,
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
    bottomPad: {
      height: Platform.OS === "web" ? 34 : 100,
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
  const typeOrder = ["checking", "savings", "investment", "retirement", "loan", "credit_card"];
  const sortedTypes = Object.keys(grouped).sort(
    (a, b) => (typeOrder.indexOf(a) ?? 99) - (typeOrder.indexOf(b) ?? 99)
  );

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.header}>
        <Text style={styles.headerLabel}>Accounts</Text>
        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Net Worth</Text>
            <Text style={[styles.summaryValue, (summary?.netWorth ?? 0) >= 0 ? styles.summaryValuePositive : styles.summaryValueNegative]}>
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
        {sortedTypes.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Feather name="inbox" size={36} color={colors.mutedForeground} />
            <Text style={styles.emptyText}>No accounts yet</Text>
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
              {grouped[type].map((account) => {
                const balance = account.currentBalance;
                const isLiability = !account.isAsset;
                const balanceStyle = isLiability
                  ? styles.balanceNegative
                  : balance > 0
                    ? styles.balancePositive
                    : styles.balanceNeutral;
                return (
                  <View key={account.id} style={styles.accountCard}>
                    <View style={styles.accountIconContainer}>
                      <Feather
                        name={getAccountIcon(account.accountType)}
                        size={16}
                        color={colors.mutedForeground}
                      />
                    </View>
                    <View style={styles.accountInfo}>
                      <Text style={styles.accountName}>{account.accountName}</Text>
                      <Text style={styles.institutionName}>{account.institutionName}</Text>
                    </View>
                    <Text style={balanceStyle}>
                      {formatCurrency(balance)}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))
        )}
      </View>

      <View style={styles.bottomPad} />
    </ScrollView>
  );
}
