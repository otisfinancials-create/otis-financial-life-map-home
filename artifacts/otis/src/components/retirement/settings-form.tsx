import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSaveRetirementSettings,
  getGetRetirementSettingsQueryKey,
  getGetRetirementSummaryQueryKey,
  getGetRetirementProjectionQueryKey,
} from "@workspace/api-client-react";
import type { RetirementSettings } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";

const settingsSchema = z
  .object({
    currentAge: z.coerce.number().int().min(1, "Enter your age").max(100),
    retirementAge: z.coerce.number().int().min(1).max(100),
    retirementGoal: z.coerce.number().min(0, "Enter a goal amount"),
    expectedReturnRate: z.coerce.number().min(0).max(100),
    inflationRate: z.coerce.number().min(0).max(100),
    monthlySpendingGoal: z.coerce.number().min(0),
    socialSecurityMonthly: z
      .union([z.coerce.number().min(0), z.literal("")])
      .optional(),
    retirementDurationYears: z.coerce.number().int().min(1).max(60),
  })
  .refine((data) => data.retirementAge > data.currentAge, {
    message: "Retirement age must be after your current age",
    path: ["retirementAge"],
  });

type SettingsFormValues = z.input<typeof settingsSchema>;

interface RetirementSettingsFormProps {
  settings: RetirementSettings;
}

export function RetirementSettingsForm({ settings }: RetirementSettingsFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      currentAge: settings.currentAge ?? ("" as unknown as number),
      retirementAge: settings.retirementAge,
      retirementGoal: settings.retirementGoal ?? ("" as unknown as number),
      expectedReturnRate: settings.expectedReturnRate,
      inflationRate: settings.inflationRate,
      monthlySpendingGoal: settings.monthlySpendingGoal ?? ("" as unknown as number),
      socialSecurityMonthly: settings.socialSecurityMonthly ?? "",
      retirementDurationYears: settings.retirementDurationYears,
    },
  });

  useEffect(() => {
    form.reset({
      currentAge: settings.currentAge ?? ("" as unknown as number),
      retirementAge: settings.retirementAge,
      retirementGoal: settings.retirementGoal ?? ("" as unknown as number),
      expectedReturnRate: settings.expectedReturnRate,
      inflationRate: settings.inflationRate,
      monthlySpendingGoal: settings.monthlySpendingGoal ?? ("" as unknown as number),
      socialSecurityMonthly: settings.socialSecurityMonthly ?? "",
      retirementDurationYears: settings.retirementDurationYears,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const saveSettings = useSaveRetirementSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetRetirementSettingsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetRetirementSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetRetirementProjectionQueryKey() });
        toast({ title: "Assumptions saved", description: "Your projection has been updated." });
      },
      onError: () => toast({ title: "Could not save your assumptions", variant: "destructive" }),
    },
  });

  const onSubmit = (raw: SettingsFormValues) => {
    const values = settingsSchema.parse(raw);
    saveSettings.mutate({
      data: {
        currentAge: values.currentAge,
        retirementAge: values.retirementAge,
        retirementGoal: values.retirementGoal,
        expectedReturnRate: values.expectedReturnRate,
        inflationRate: values.inflationRate,
        monthlySpendingGoal: values.monthlySpendingGoal,
        socialSecurityMonthly:
          values.socialSecurityMonthly === "" || values.socialSecurityMonthly === undefined
            ? null
            : values.socialSecurityMonthly,
        retirementDurationYears: values.retirementDurationYears,
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your retirement assumptions</CardTitle>
        <CardDescription>
          A few numbers help us paint an accurate picture. You can fine-tune these anytime.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <FormField
                control={form.control}
                name="currentAge"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current age</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" max="100" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="retirementAge"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Planned retirement age</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" max="100" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="retirementGoal"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Retirement goal ($)</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" step="10000" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expectedReturnRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected annual return (%)</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" max="100" step="0.1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="inflationRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected inflation (%)</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" max="100" step="0.1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="monthlySpendingGoal"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly spending in retirement ($)</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" step="100" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="socialSecurityMonthly"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Social Security estimate ($/mo, optional)</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" step="50" placeholder="From SSA.gov" {...field} value={field.value ?? ""} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="retirementDurationYears"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected retirement duration (years)</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" max="60" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={saveSettings.isPending}>
                {saveSettings.isPending ? "Saving..." : "Save assumptions"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
