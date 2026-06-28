import { cn } from "@/lib/utils";

interface FormatCurrencyProps {
  amount: number;
  className?: string;
  showSign?: boolean;
  compact?: boolean;
}

export function FormatCurrency({ amount, className, showSign = false, compact = false }: FormatCurrencyProps) {
  const isNegative = amount < 0;
  
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: compact ? 0 : 2,
  }).format(Math.abs(amount));

  return (
    <span 
      className={cn(
        "font-mono tracking-tight",
        isNegative ? "text-destructive" : "",
        className
      )}
    >
      {showSign && isNegative ? "-" : showSign && amount > 0 ? "+" : ""}
      {formatted}
    </span>
  );
}
