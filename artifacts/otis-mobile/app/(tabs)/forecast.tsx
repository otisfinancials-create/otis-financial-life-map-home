import { useGetMonthlyForecast } from "@workspace/api-client-react";
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
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { G, Rect, Text as SvgText, Line } from "react-native-svg";

import { useColors } from "@/hooks/useColors";

function formatCurrency(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000) {
    return `${value < 0 ? "-" : ""}$${(absValue / 1_000_000).toFixed(1)}M`;
  }
  if (absValue >= 1_000) {
    return `${value < 0 ? "-" : ""}$${(absValue / 1_000).toFixed(0)}K`;
  }
  return `${value < 0 ? "-" : ""}$${absValue.toFixed(0)}`;
}

function formatShortLabel(label: string): string {
  return label.slice(0, 3);
}

interface ForecastChartProps {
  data: Array<{
    label: string;
    totalIncome: number;
    totalExpenses: number;
    netCashFlow: number;
  }>;
  colors: ReturnType<typeof useColors>;
  width: number;
}

function ForecastChart({ data, colors, width }: ForecastChartProps) {
  const PADDING_LEFT = 48;
  const PADDING_RIGHT = 12;
  const PADDING_TOP = 12;
  const LABEL_HEIGHT = 28;
  const CHART_HEIGHT = 200;
  const HEIGHT = CHART_HEIGHT + LABEL_HEIGHT + PADDING_TOP;

  const chartWidth = width - PADDING_LEFT - PADDING_RIGHT;
  const numBars = data.length;
  const groupWidth = chartWidth / numBars;
  const barWidth = Math.max(4, groupWidth * 0.32);
  const gap = Math.max(2, groupWidth * 0.06);

  const maxIncome = Math.max(...data.map((d) => d.totalIncome), 1);
  const maxExpense = Math.max(...data.map((d) => Math.abs(d.totalExpenses)), 1);
  const maxVal = Math.max(maxIncome, maxExpense);

  const roundedMax = Math.ceil(maxVal / 1000) * 1000;

  const toY = (val: number) =>
    PADDING_TOP + CHART_HEIGHT - (val / roundedMax) * CHART_HEIGHT;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    value: f * roundedMax,
    y: PADDING_TOP + CHART_HEIGHT - f * CHART_HEIGHT,
  }));

  const gridColor = colors.border;
  const labelColor = colors.mutedForeground;
  const incomeColor = colors.income;
  const expenseColor = colors.expense;

  return (
    <Svg width={width} height={HEIGHT}>
      {yTicks.map((tick) => (
        <G key={tick.value}>
          <Line
            x1={PADDING_LEFT}
            y1={tick.y}
            x2={width - PADDING_RIGHT}
            y2={tick.y}
            stroke={gridColor}
            strokeWidth={0.5}
            strokeDasharray={tick.value === 0 ? undefined : "3,3"}
          />
          <SvgText
            x={PADDING_LEFT - 4}
            y={tick.y + 4}
            fontSize={9}
            fill={labelColor}
            textAnchor="end"
            fontFamily="Inter_400Regular"
          >
            {formatCurrency(tick.value)}
          </SvgText>
        </G>
      ))}

      {data.map((d, i) => {
        const groupX = PADDING_LEFT + i * groupWidth + groupWidth / 2;
        const incomeH = Math.max(2, (d.totalIncome / roundedMax) * CHART_HEIGHT);
        const expenseH = Math.max(2, (Math.abs(d.totalExpenses) / roundedMax) * CHART_HEIGHT);
        const incomeX = groupX - barWidth - gap / 2;
        const expenseX = groupX + gap / 2;
        const incomeY = toY(d.totalIncome);
        const expenseY = toY(Math.abs(d.totalExpenses));
        const labelX = groupX;
        const labelY = PADDING_TOP + CHART_HEIGHT + 18;

        return (
          <G key={d.label}>
            <Rect
              x={incomeX}
              y={incomeY}
              width={barWidth}
              height={incomeH}
              fill={incomeColor}
              rx={2}
            />
            <Rect
              x={expenseX}
              y={expenseY}
              width={barWidth}
              height={expenseH}
              fill={expenseColor}
              rx={2}
            />
            <SvgText
              x={labelX}
              y={labelY}
              fontSize={9}
              fill={labelColor}
              textAnchor="middle"
              fontFamily="Inter_400Regular"
            >
              {formatShortLabel(d.label)}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}

export default function ForecastScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const [refreshing, setRefreshing] = useState(false);

  const { data: forecast, isLoading, refetch, isError } = useGetMonthlyForecast();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const topPadding = Platform.OS === "web" ? 67 : insets.top;
  const chartWidth = screenWidth - 32;

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
    headerTitle: {
      fontSize: 24,
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      marginTop: 2,
    },
    card: {
      marginHorizontal: 16,
      marginTop: 16,
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
    },
    cardTitle: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 0.6,
      textTransform: "uppercase",
      marginBottom: 12,
    },
    legend: {
      flexDirection: "row",
      gap: 16,
      marginTop: 12,
    },
    legendItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    legendDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    legendLabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    summaryGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      marginTop: 4,
    },
    summaryCard: {
      flex: 1,
      minWidth: "45%",
      backgroundColor: colors.muted,
      borderRadius: colors.radius,
      padding: 12,
    },
    summaryLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      letterSpacing: 0.4,
      textTransform: "uppercase",
      marginBottom: 4,
    },
    summaryValue: {
      fontSize: 18,
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    summaryValuePositive: {
      color: colors.income,
    },
    summaryValueNegative: {
      color: colors.expense,
    },
    monthRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    monthLabel: {
      width: 48,
      fontSize: 13,
      color: colors.foreground,
      fontFamily: "Inter_500Medium",
    },
    monthBars: {
      flex: 1,
    },
    monthBarRow: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 3,
    },
    monthBarTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.muted,
      flex: 1,
    },
    monthBarFill: {
      height: 6,
      borderRadius: 3,
    },
    monthNet: {
      width: 64,
      alignItems: "flex-end",
    },
    monthNetValue: {
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
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

  if (isError || !forecast) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <Feather name="wifi-off" size={32} color={colors.mutedForeground} />
        <Text style={[styles.errorText, { marginTop: 12 }]}>
          Could not load forecast data
        </Text>
        <TouchableOpacity onPress={() => refetch()} style={{ marginTop: 16, padding: 10 }}>
          <Text style={{ color: colors.primary, fontFamily: "Inter_500Medium" }}>
            Retry
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  const totalIncome = forecast.reduce((s, m) => s + m.totalIncome, 0);
  const totalExpenses = forecast.reduce((s, m) => s + Math.abs(m.totalExpenses), 0);
  const netCashFlow = forecast.reduce((s, m) => s + m.netCashFlow, 0);
  const avgMonthly = forecast.length > 0 ? netCashFlow / forecast.length : 0;

  const maxBarVal = Math.max(
    ...forecast.map((m) => Math.max(m.totalIncome, Math.abs(m.totalExpenses))),
    1
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
        <Text style={styles.headerLabel}>12-Month Outlook</Text>
        <Text style={styles.headerTitle}>Cash Flow Forecast</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Income vs. Expenses</Text>
        <ForecastChart data={forecast} colors={colors} width={chartWidth} />
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.income }]} />
            <Text style={styles.legendLabel}>Income</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.expense }]} />
            <Text style={styles.legendLabel}>Expenses</Text>
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>12-Month Summary</Text>
        <View style={styles.summaryGrid}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Total Income</Text>
            <Text style={[styles.summaryValue, styles.summaryValuePositive]}>
              {formatCurrency(totalIncome)}
            </Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Total Expenses</Text>
            <Text style={[styles.summaryValue, styles.summaryValueNegative]}>
              {formatCurrency(totalExpenses)}
            </Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Net Cash Flow</Text>
            <Text
              style={[
                styles.summaryValue,
                netCashFlow >= 0 ? styles.summaryValuePositive : styles.summaryValueNegative,
              ]}
            >
              {formatCurrency(netCashFlow)}
            </Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Avg / Month</Text>
            <Text
              style={[
                styles.summaryValue,
                avgMonthly >= 0 ? styles.summaryValuePositive : styles.summaryValueNegative,
              ]}
            >
              {formatCurrency(avgMonthly)}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Month by Month</Text>
        {forecast.map((m, idx) => {
          const incomeRatio = m.totalIncome / maxBarVal;
          const expenseRatio = Math.abs(m.totalExpenses) / maxBarVal;
          const net = m.netCashFlow;
          return (
            <View
              key={m.label}
              style={[
                styles.monthRow,
                idx === forecast.length - 1 && { borderBottomWidth: 0 },
              ]}
            >
              <Text style={styles.monthLabel}>{formatShortLabel(m.label)}</Text>
              <View style={styles.monthBars}>
                <View style={styles.monthBarRow}>
                  <View style={styles.monthBarTrack}>
                    <View
                      style={[
                        styles.monthBarFill,
                        {
                          width: `${Math.round(incomeRatio * 100)}%`,
                          backgroundColor: colors.income,
                        },
                      ]}
                    />
                  </View>
                </View>
                <View style={styles.monthBarRow}>
                  <View style={styles.monthBarTrack}>
                    <View
                      style={[
                        styles.monthBarFill,
                        {
                          width: `${Math.round(expenseRatio * 100)}%`,
                          backgroundColor: colors.expense,
                        },
                      ]}
                    />
                  </View>
                </View>
              </View>
              <View style={styles.monthNet}>
                <Text
                  style={[
                    styles.monthNetValue,
                    { color: net >= 0 ? colors.income : colors.expense },
                  ]}
                >
                  {formatCurrency(net)}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      <View style={styles.bottomPad} />
    </ScrollView>
  );
}
