import { useGetDashboardSummary, useGetUpcomingBills } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

function formatCurrency(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000) {
    return `${value < 0 ? "-" : ""}$${(absValue / 1_000_000).toFixed(2)}M`;
  }
  if (absValue >= 1_000) {
    return `${value < 0 ? "-" : ""}$${(absValue / 1_000).toFixed(1)}K`;
  }
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatFullCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function getCategoryIcon(category: string): keyof typeof Feather.glyphMap {
  const map: Record<string, keyof typeof Feather.glyphMap> = {
    Housing: "home",
    Utilities: "zap",
    Insurance: "shield",
    Subscriptions: "repeat",
    Transportation: "truck",
    Food: "coffee",
    Healthcare: "activity",
    Entertainment: "tv",
    Education: "book",
    Savings: "piggy-bank" as keyof typeof Feather.glyphMap,
  };
  return (map[category] as keyof typeof Feather.glyphMap) ?? "dollar-sign";
}

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const { data: summary, isLoading: summaryLoading, refetch: refetchSummary, isError: summaryError } = useGetDashboardSummary();
  const { data: upcomingBills, isLoading: billsLoading, refetch: refetchBills } = useGetUpcomingBills();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchSummary(), refetchBills()]);
    setRefreshing(false);
  }, [refetchSummary, refetchBills]);

  const isLoading = summaryLoading || billsLoading;

  const topPadding = Platform.OS === "web" ? 67 : insets.top;

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      paddingTop: topPadding + 16,
      paddingHorizontal: 20,
      paddingBottom: 8,
    },
    headerLabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    heroCard: {
      marginHorizontal: 20,
      marginTop: 8,
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 24,
    },
    netWorthLabel: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      marginBottom: 6,
    },
    netWorthValue: {
      fontSize: 42,
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      letterSpacing: -1,
    },
    netWorthPositive: {
      color: colors.income,
    },
    statsRow: {
      flexDirection: "row",
      marginHorizontal: 20,
      marginTop: 12,
      gap: 10,
    },
    statCard: {
      flex: 1,
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
    },
    statLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      letterSpacing: 0.5,
      textTransform: "uppercase",
      marginBottom: 6,
    },
    statValue: {
      fontSize: 18,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    statValuePositive: {
      color: colors.income,
    },
    statValueNegative: {
      color: colors.expense,
    },
    section: {
      marginTop: 24,
      marginHorizontal: 20,
    },
    sectionHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 12,
    },
    sectionTitle: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    sectionCount: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    billRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      marginBottom: 8,
    },
    billIconContainer: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    billInfo: {
      flex: 1,
    },
    billName: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_500Medium",
    },
    billMeta: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    billRight: {
      alignItems: "flex-end",
    },
    billAmount: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    billDue: {
      fontSize: 11,
      fontFamily: "Inter_500Medium",
      marginTop: 2,
    },
    billDueUrgent: {
      color: colors.expense,
    },
    billDueSoon: {
      color: colors.amber,
    },
    billDueOk: {
      color: colors.mutedForeground,
    },
    loadingContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    errorText: {
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      fontSize: 14,
      textAlign: "center",
    },
    emptyText: {
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      fontSize: 14,
      textAlign: "center",
      paddingVertical: 16,
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

  if (summaryError) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <Feather name="wifi-off" size={32} color={colors.mutedForeground} />
        <Text style={[styles.errorText, { marginTop: 12 }]}>Could not connect to server</Text>
        <TouchableOpacity onPress={() => refetchSummary()} style={{ marginTop: 16, padding: 10 }}>
          <Text style={{ color: colors.primary, fontFamily: "Inter_500Medium" }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const netWorth = summary?.netWorth ?? 0;
  const cashFlow = summary?.monthlyCashFlow ?? 0;

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
        <Text style={styles.headerLabel}>Financial Overview</Text>
      </View>

      <View style={styles.heroCard}>
        <Text style={styles.netWorthLabel}>Net Worth</Text>
        <Text style={[styles.netWorthValue, netWorth >= 0 && styles.netWorthPositive]}>
          {formatFullCurrency(netWorth)}
        </Text>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>Income</Text>
          <Text style={[styles.statValue, styles.statValuePositive]}>
            {formatCurrency(summary?.monthlyIncome ?? 0)}
          </Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>Expenses</Text>
          <Text style={[styles.statValue, styles.statValueNegative]}>
            {formatCurrency(summary?.monthlyExpenses ?? 0)}
          </Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>Cash Flow</Text>
          <Text
            style={[
              styles.statValue,
              cashFlow >= 0 ? styles.statValuePositive : styles.statValueNegative,
            ]}
          >
            {formatCurrency(cashFlow)}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Upcoming Bills</Text>
          {(summary?.upcomingBillsCount ?? 0) > 0 && (
            <Text style={styles.sectionCount}>
              {summary?.upcomingBillsCount} due · ${(summary?.upcomingBillsTotal ?? 0).toFixed(0)} total
            </Text>
          )}
        </View>

        {!upcomingBills || upcomingBills.length === 0 ? (
          <Text style={styles.emptyText}>No upcoming bills</Text>
        ) : (
          upcomingBills.slice(0, 5).map((bill) => {
            const isUrgent = bill.daysUntilDue <= 3;
            const isSoon = bill.daysUntilDue <= 7;
            return (
              <View key={bill.id} style={styles.billRow}>
                <View style={styles.billIconContainer}>
                  <Feather
                    name={getCategoryIcon(bill.category)}
                    size={16}
                    color={colors.mutedForeground}
                  />
                </View>
                <View style={styles.billInfo}>
                  <Text style={styles.billName}>{bill.billName}</Text>
                  <Text style={styles.billMeta}>{bill.category}</Text>
                </View>
                <View style={styles.billRight}>
                  <Text style={styles.billAmount}>${bill.amount.toFixed(0)}</Text>
                  <Text
                    style={[
                      styles.billDue,
                      isUrgent
                        ? styles.billDueUrgent
                        : isSoon
                          ? styles.billDueSoon
                          : styles.billDueOk,
                    ]}
                  >
                    {bill.daysUntilDue === 0
                      ? "Due today"
                      : bill.daysUntilDue === 1
                        ? "Due tomorrow"
                        : `${bill.daysUntilDue}d`}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      <View style={styles.bottomPad} />
    </ScrollView>
  );
}
