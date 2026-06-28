import { useColorScheme } from "react-native";

import colors from "@/constants/colors";

type Palette = typeof colors.dark;

export function useColors(): Palette & { radius: number } {
  const scheme = useColorScheme();
  const palette: Palette = scheme === "dark" ? colors.dark : colors.light;
  return { ...palette, radius: colors.radius };
}
