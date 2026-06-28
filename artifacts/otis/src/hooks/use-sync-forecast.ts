import { useQueryClient } from "@tanstack/react-query";
import { useRegenerateForecast, getListForecastQueryKey, getGetMonthlyForecastQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export function useSyncForecast() {
  const queryClient = useQueryClient();
  const regenerate = useRegenerateForecast();
  const { toast } = useToast();

  function sync() {
    regenerate.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListForecastQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMonthlyForecastQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: () => {
        toast({
          title: "Forecast sync failed",
          description: "Your changes were saved but the forecast could not be updated. Go to Forecast and click Regenerate.",
          variant: "destructive",
        });
      },
    });
  }

  return { sync, isSyncing: regenerate.isPending };
}
