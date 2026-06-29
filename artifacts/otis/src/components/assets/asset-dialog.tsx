import { useState } from "react";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

import { useCreateAsset, useUpdateAsset, getListAssetsQueryKey, getGetAssetsSummaryQueryKey } from "@workspace/api-client-react";
import type { Asset } from "@workspace/api-client-react";

const assetSchema = z.object({
  assetName: z.string().min(2, { message: "Name must be at least 2 characters." }),
  assetType: z.string().min(1, { message: "Please select a type." }),
  institutionName: z.string().min(1, { message: "Please provide an institution name." }),
  currentBalance: z.coerce.number(),
  isAsset: z.boolean().default(true),
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

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(assetSchema),
    defaultValues: {
      assetName: asset?.assetName || "",
      assetType: asset?.assetType || "",
      institutionName: asset?.institutionName || "",
      currentBalance: asset?.currentBalance || 0,
      isAsset: asset?.isAsset ?? true,
    },
  });

  function onSubmit(data: AssetFormValues) {
    if (isEditing) {
      updateAsset.mutate({ id: asset.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAssetsSummaryQueryKey() });
          toast({ title: "Entry updated successfully" });
          setIsOpen(false);
          if (!isControlled) form.reset();
        },
        onError: () => {
          toast({ title: "Failed to update entry", variant: "destructive" });
        }
      });
    } else {
      createAsset.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAssetsSummaryQueryKey() });
          toast({ title: "Entry created successfully" });
          setIsOpen(false);
          if (!isControlled) form.reset();
        },
        onError: () => {
          toast({ title: "Failed to create entry", variant: "destructive" });
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
          <DialogTitle>{isEditing ? "Edit Entry" : "Add Asset or Liability"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Make changes to this entry." : "Add a new asset or liability manually."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="institutionName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Institution</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Zillow, Kelley Blue Book, Self" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="assetName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Asset or Liability Name</FormLabel>
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
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="real_estate">Real Estate</SelectItem>
                        <SelectItem value="vehicle">Vehicle</SelectItem>
                        <SelectItem value="personal_property">Personal Property</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
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
                    <FormLabel>Current Value</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="isAsset"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>Asset</FormLabel>
                    <FormDescription className="text-xs">
                      On adds to net worth; off counts as a liability
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createAsset.isPending || updateAsset.isPending}>
                {createAsset.isPending || updateAsset.isPending ? "Saving..." : isEditing ? "Save Changes" : "Add Entry"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
