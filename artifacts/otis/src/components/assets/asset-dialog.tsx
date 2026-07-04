import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

import { useCreateAsset, useUpdateAsset, getListAssetsQueryKey, getGetAssetsSummaryQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import type { Asset } from "@workspace/api-client-react";

export const ASSET_TYPE_OPTIONS = [
  { value: "real_estate", label: "Real Estate" },
  { value: "vehicle", label: "Vehicle" },
  { value: "personal_property", label: "Personal Property" },
  { value: "business_interest", label: "Business Interest" },
  { value: "other", label: "Other" },
] as const;

const assetSchema = z.object({
  assetName: z.string().min(2, { message: "Name must be at least 2 characters." }),
  assetType: z.string().min(1, { message: "Please select a type." }),
  currentBalance: z.coerce.number(),
  purchasePrice: z
    .string()
    .refine((v) => v === "" || (!isNaN(parseFloat(v)) && parseFloat(v) >= 0), { message: "Enter a valid amount." }),
  purchaseDate: z.string(),
  notes: z.string(),
});

type AssetFormValues = z.infer<typeof assetSchema>;

interface AssetDialogProps {
  asset?: Asset;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AssetDialog({ asset, trigger, open, onOpenChange }: AssetDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined && onOpenChange !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? onOpenChange : setInternalOpen;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createAsset = useCreateAsset();
  const updateAsset = useUpdateAsset();
  const isEditing = !!asset;

  const defaults = (): AssetFormValues => ({
    assetName: asset?.assetName || "",
    assetType: asset?.assetType || "",
    currentBalance: asset?.currentBalance || 0,
    purchasePrice: asset?.purchasePrice != null ? String(asset.purchasePrice) : "",
    purchaseDate: asset?.purchaseDate || "",
    notes: asset?.notes || "",
  });

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(assetSchema),
    defaultValues: defaults(),
  });

  useEffect(() => {
    if (isOpen) {
      form.reset(defaults());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, asset?.id]);

  function onSubmit(values: AssetFormValues) {
    const data = {
      assetName: values.assetName,
      assetType: values.assetType,
      currentBalance: values.currentBalance,
      purchasePrice: values.purchasePrice !== "" ? parseFloat(values.purchasePrice) : null,
      purchaseDate: values.purchaseDate || null,
      notes: values.notes || null,
    };
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAssetsSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    };
    if (isEditing) {
      updateAsset.mutate({ id: asset.id, data }, {
        onSuccess: () => {
          invalidate();
          toast({ title: "Asset updated successfully" });
          setIsOpen(false);
          if (!isControlled) form.reset();
        },
        onError: () => {
          toast({ title: "Failed to update asset", variant: "destructive" });
        }
      });
    } else {
      createAsset.mutate({ data }, {
        onSuccess: () => {
          invalidate();
          toast({ title: "Asset created successfully" });
          setIsOpen(false);
          if (!isControlled) form.reset();
        },
        onError: () => {
          toast({ title: "Failed to create asset", variant: "destructive" });
        }
      });
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isControlled) {
      form.reset();
    }
    setIsOpen(newOpen);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Asset" : "Add Asset"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Make changes to this asset." : "Add an item you own to track its value."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="assetName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Asset Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Primary Residence, 2022 Tesla" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="assetType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Asset Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ASSET_TYPE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currentBalance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Estimated Value</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="purchasePrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Purchase Price (optional)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0.00" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="purchaseDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Purchase Date (optional)</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Optional notes about this asset" rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createAsset.isPending || updateAsset.isPending}>
                {createAsset.isPending || updateAsset.isPending ? "Saving..." : isEditing ? "Save Changes" : "Add Asset"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
