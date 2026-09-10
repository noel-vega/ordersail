import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { LoaderCircleIcon } from "lucide-react";
import type { PosDevicePairing } from "merchant-sdk";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "ui/sheet";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { useListLocationsQuery } from "../../locations/locations.hooks";
import { useCreatePosDeviceMutation } from "../pos-devices.hooks";
import { LocationSelect } from "../components/location-select";
import { PairingCodeReveal } from "../components/pairing-code-reveal";

const MintFormSchema = z.object({
  name: z.string().trim().min(1, "Enter a device name"),
  locationId: z.string().min(1, "Select a location"),
});
type MintForm = z.infer<typeof MintFormSchema>;

export function MintDeviceSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // holds the pairing result once the device is created; the sheet then
  // swaps from the form to the code reveal without closing
  const [minted, setMinted] = useState<
    { pairing: PosDevicePairing; locationName: string | null } | null
  >(null);

  function close() {
    props.onOpenChange(false);
    // let the sheet finish animating out before clearing
    setTimeout(() => setMinted(null), 200);
  }

  return (
    <Sheet open={props.open} onOpenChange={(open) => (open ? undefined : close())}>
      <SheetContent className="flex flex-col">
        {props.open && !minted && (
          <MintDeviceForm onMinted={(pairing, locationName) => setMinted({ pairing, locationName })} />
        )}
        {minted && (
          <PairingCodeReveal
            pairing={minted.pairing}
            locationName={minted.locationName}
            onDone={close}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function MintDeviceForm(props: {
  onMinted: (pairing: PosDevicePairing, locationName: string | null) => void;
}) {
  const createDevice = useCreatePosDeviceMutation();
  const locations = useListLocationsQuery();
  const [error, setError] = useState<string | null>(null);

  const form = useForm<MintForm>({
    resolver: zodResolver(MintFormSchema),
    defaultValues: { name: "", locationId: "" },
  });

  const handleSubmit = form.handleSubmit(async (data) => {
    setError(null);
    try {
      const result = await createDevice.mutateAsync({
        name: data.name.trim(),
        locationId: Number(data.locationId),
      });
      if (!result) {
        setError("Couldn't create the device — check the name and location.");
        return;
      }
      const locationName =
        locations.data?.items?.find((l) => l.id === Number(data.locationId))
          ?.name ?? null;
      props.onMinted(result, locationName);
    } catch {
      setError("Couldn't create the device — try again.");
    }
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>New POS device</SheetTitle>
        <SheetDescription>
          Give it a name and the location it sells from. You'll get a pairing
          code to enter on the tablet.
        </SheetDescription>
      </SheetHeader>

      <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
        <div className="flex-1 space-y-4 px-4">
          <Controller
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error}>
                <FieldLabel>Device name</FieldLabel>
                <Input autoFocus placeholder="e.g. Front counter" {...field} />
                {fieldState.error && (
                  <p className="text-sm text-destructive">
                    {fieldState.error.message}
                  </p>
                )}
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="locationId"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error}>
                <FieldLabel>Location</FieldLabel>
                <LocationSelect
                  value={field.value}
                  onChange={field.onChange}
                />
                {fieldState.error && (
                  <p className="text-sm text-destructive">
                    {fieldState.error.message}
                  </p>
                )}
              </Field>
            )}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <SheetFooter className="flex-row justify-end">
          <Button
            type="submit"
            disabled={
              createDevice.isPending || locations.data?.items.length === 0
            }
          >
            {createDevice.isPending ? (
              <>
                <LoaderCircleIcon className="animate-spin" /> Creating...
              </>
            ) : (
              "Create device"
            )}
          </Button>
        </SheetFooter>
      </form>
    </>
  );
}
