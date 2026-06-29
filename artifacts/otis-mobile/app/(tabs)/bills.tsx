import { useGetUpcomingBills, useListBills, useUpdateBill } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BillFormModal } from "@/components/BillFormModal";
import type { BillFormData } from "@/components/BillFormModal";
import { useColors } from "@/hooks/useColors";

type BillItem = {
  id: number;
  billName: string;
  category: string;
  amount: number;
  daysUntilDue?: number;
  dueDate?: string;
  frequency?: string;
  isActive?: boolean;
  dueDay?: number;
};

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
  };
  return (map[category] as keyof typeof Feather.glyphMap) ?? "dollar-sign";
}

function formatDueDate(dueDate?: string): string {
  if (!dueDate) return "";
  const date = new Date(dueDate);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function BillsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"upcoming" | "all">("upcoming");
  const [modalVisible, setModalVisible] = useState(false);
  const [editingBill, setEditingBill] = useState<BillFormData | undefined>();

  const {
    data: upcomingBills,
    isLoading: upcomingLoading,
    refetch: refetchUpcoming,
  } = useGetUpcomingBills();

  const {
    data: allBills,
    isLoading: allLoading,
    refetch: refetchAll,
  } = useListBills();

  const updateBill = useUpdateBill();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchUpcoming(), refetchAll()]);
    setRefreshing(false);
  }, [refetchUpcoming, refetchAll]);

  const handleSuccess = useCallback(() => {
    refetchUpcoming();
    refetchAll();
  }, [refetchUpcoming, refetchAll]);

  const handleOpenAdd = useCallback(() => {
    setEditingBill(undefined);
    setModalVisible(true);
  }, []);

  const handleOpenEdit = useCallback(
    (item: BillItem) => {
      const full = (allBills ?? []).find((b) => b.id === item.id);
      if (full) {
        setEditingBill({
          id: full.id,
          billName: full.billName,
          category: full.category,
          amount: full.amount,
          frequency: full.frequency,
          dueDay: full.dueDay,
          isActive: full.isActive ?? true,
        });
      } else {
        setEditingBill({
          id: item.id,
          billName: item.billName,
          category: item.category,
          amount: item.amount,
          frequency: item.frequency ?? "monthly",
          dueDay: item.dueDay ?? 1,
          isActive: item.isActive ?? true,
        });
      }
      setModalVisible(true);
    },
    [allBills]
  );

  const handleToggleActive = useCallback(
    (item: BillItem) => {
      updateBill.mutate(
        { id: item.id, data: { isActive: !item.isActive } },
        {
          onSuccess: () => {
            refetchAll();
            refetchUpcoming();
          },
          onError: () => {
            Alert.alert("Error", "Could not update the bill. Please try again.");
          },
        }
      );
    },
    [updateBill, refetchAll, refetchUpcoming]
  );

  const isLoading = tab === "upcoming" ? upcomingLoading : allLoading;
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
      marginBottom: 14,
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
    tabs: {
      flexDirection: "row",
      backgroundColor: colors.muted,
      borderRadius: colors.radius,
      padding: 3,
    },
    tabBtn: {
      flex: 1,
      paddingVertical: 7,
      alignItems: "center",
      borderRadius: colors.radius - 2,
    },
    tabBtnActive: {
      backgroundColor: colors.card,
    },
    tabText: {
      fontSize: 13,
      fontFamily: "Inter_500Medium",
      color: colors.mutedForeground,
    },
    tabTextActive: {
      color: colors.foreground,
    },
    listContent: {
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: Platform.OS === "web" ? 34 : 100,
    },
    billCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      marginBottom: 8,
    },
    billCardInactive: {
      opacity: 0.55,
    },
    iconContainer: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 14,
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
      flexDirection: "row",
      alignItems: "center",
      marginTop: 3,
      gap: 6,
    },
    billCategory: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    freqBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      backgroundColor: colors.muted,
      borderRadius: 4,
    },
    freqText: {
      fontSize: 10,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      textTransform: "capitalize",
    },
    inactiveBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      backgroundColor: colors.muted,
      borderRadius: 4,
    },
    inactiveText: {
      fontSize: 10,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
    },
    billRight: {
      alignItems: "flex-end",
      gap: 6,
    },
    billAmount: {
      fontSize: 16,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    dueChip: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    dueChipUrgent: {
      backgroundColor: `${colors.expense}22`,
    },
    dueChipSoon: {
      backgroundColor: `${colors.amber}22`,
    },
    dueChipOk: {
      backgroundColor: colors.muted,
    },
    dueText: {
      fontSize: 11,
      fontFamily: "Inter_500Medium",
    },
    dueTextUrgent: {
      color: colors.expense,
    },
    dueTextSoon: {
      color: colors.amber,
    },
    dueTextOk: {
      color: colors.mutedForeground,
    },
    dateText: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    editChevron: {
      marginLeft: 10,
      alignSelf: "center",
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
  });

  const displayBills: BillItem[] =
    tab === "upcoming"
      ? (upcomingBills ?? []).map((b) => ({
          id: b.id,
          billName: b.billName,
          category: b.category,
          amount: b.amount,
          daysUntilDue: b.daysUntilDue,
          dueDate: b.dueDate,
        }))
      : (allBills ?? []).map((b) => ({
          id: b.id,
          billName: b.billName,
          category: b.category,
          amount: b.amount,
          frequency: b.frequency,
          isActive: b.isActive,
          dueDay: b.dueDay,
        }));

  const renderBill = ({ item }: { item: BillItem }) => {
    const isUpcoming = tab === "upcoming";
    const isUrgent = item.daysUntilDue !== undefined && item.daysUntilDue <= 3;
    const isSoon = item.daysUntilDue !== undefined && item.daysUntilDue <= 7;

    return (
      <TouchableOpacity
        style={[styles.billCard, item.isActive === false && styles.billCardInactive]}
        onPress={() => handleOpenEdit(item)}
        activeOpacity={0.75}
      >
        <View style={styles.iconContainer}>
          <Feather
            name={getCategoryIcon(item.category)}
            size={18}
            color={colors.mutedForeground}
          />
        </View>

        <View style={styles.billInfo}>
          <Text style={styles.billName}>{item.billName}</Text>
          <View style={styles.billMeta}>
            <Text style={styles.billCategory}>{item.category}</Text>
            {item.frequency && (
              <View style={styles.freqBadge}>
                <Text style={styles.freqText}>{item.frequency}</Text>
              </View>
            )}
            {item.isActive === false && (
              <View style={styles.inactiveBadge}>
                <Text style={styles.inactiveText}>Inactive</Text>
              </View>
            )}
          </View>
        </View>

        <View style={styles.billRight}>
          <Text style={styles.billAmount}>
            $
            {item.amount.toLocaleString("en-US", {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </Text>

          {item.daysUntilDue !== undefined && (
            <View
              style={[
                styles.dueChip,
                isUrgent
                  ? styles.dueChipUrgent
                  : isSoon
                    ? styles.dueChipSoon
                    : styles.dueChipOk,
              ]}
            >
              <Text
                style={[
                  styles.dueText,
                  isUrgent
                    ? styles.dueTextUrgent
                    : isSoon
                      ? styles.dueTextSoon
                      : styles.dueTextOk,
                ]}
              >
                {item.daysUntilDue === 0
                  ? "Today"
                  : item.daysUntilDue === 1
                    ? "Tomorrow"
                    : `${item.daysUntilDue}d`}
              </Text>
            </View>
          )}

          {item.dueDate && (
            <Text style={styles.dateText}>{formatDueDate(item.dueDate)}</Text>
          )}

          {!isUpcoming && (
            <Switch
              value={item.isActive ?? true}
              onValueChange={() => handleToggleActive(item)}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor={colors.primaryForeground}
            />
          )}
        </View>

        {!isUpcoming && (
          <Feather
            name="chevron-right"
            size={16}
            color={colors.mutedForeground}
            style={styles.editChevron}
          />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.headerLabel}>Bills & Subscriptions</Text>
          <TouchableOpacity style={styles.addBtn} onPress={handleOpenAdd}>
            <Feather name="plus" size={20} color={colors.primaryForeground} />
          </TouchableOpacity>
        </View>
        <View style={styles.tabs}>
          <TouchableOpacity
            style={[styles.tabBtn, tab === "upcoming" && styles.tabBtnActive]}
            onPress={() => setTab("upcoming")}
          >
            <Text style={[styles.tabText, tab === "upcoming" && styles.tabTextActive]}>
              Upcoming
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, tab === "all" && styles.tabBtnActive]}
            onPress={() => setTab("all")}
          >
            <Text style={[styles.tabText, tab === "all" && styles.tabTextActive]}>
              All Bills
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {isLoading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={displayBills}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderBill}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          scrollEnabled={!!displayBills.length}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Feather
                name="check-circle"
                size={36}
                color={colors.mutedForeground}
              />
              <Text style={styles.emptyText}>
                {tab === "upcoming" ? "No upcoming bills" : "No bills yet"}
              </Text>
            </View>
          }
        />
      )}

      <BillFormModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onSuccess={handleSuccess}
        initialData={editingBill}
      />
    </View>
  );
}
