import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import type { Location } from "merchant-sdk";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "ui/sheet";
import { Button } from "ui/button";
import { LoaderCircleIcon } from "lucide-react";
import { useUpdateLocationMutation } from "../locations.hooks";
import { ShipFromFields } from "../ship-from-fields";
import {
  shipFromDefaults,
  shipFromFormSchema,
  toShipFromBody,
  type ShipFromFormInput,
} from "../ship-from";

export function EditLocationSheet(props: {
  location: Location | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit ship-from details</SheetTitle>
          <SheetDescription>
            Used as the ship-from origin when quoting shipping rates and buying
            labels.
          </SheetDescription>
        </SheetHeader>
        {props.open && props.location && (
          <EditLocationForm
            location={props.location}
            onDone={() => props.onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// mounted only while the sheet is open, so defaultValues are always a fresh
// snapshot of the location
function EditLocationForm(props: { location: Location; onDone: () => void }) {
  const updateLocation = useUpdateLocationMutation();
  const form = useForm<
    ShipFromFormInput,
    unknown,
    z.output<typeof shipFromFormSchema>
  >({
    resolver: zodResolver(shipFromFormSchema),
    defaultValues: shipFromDefaults(props.location),
  });

  const handleSubmit = form.handleSubmit((data) => {
    updateLocation.mutate(
      { id: props.location.id, ...toShipFromBody(data) },
      // errors surface as a toast; only close the sheet on success
      { onSuccess: () => props.onDone() },
    );
  });

  return (
    <FormProvider {...form}>
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
        <div className="flex-1 space-y-4 px-4">
          <ShipFromFields />
        </div>

        <SheetFooter className="flex-row justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={updateLocation.isPending}
            onClick={props.onDone}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={updateLocation.isPending}>
            {updateLocation.isPending ? (
              <>
                <LoaderCircleIcon className="animate-spin" /> Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </SheetFooter>
      </form>
    </FormProvider>
  );
}
