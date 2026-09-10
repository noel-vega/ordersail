import { Link } from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { useListLocationsQuery } from "../../locations/locations.hooks";

// Value is the location id as a string (kept string end-to-end like the
// status <Select> in create-product.view.tsx; caller does Number(value)).
export function LocationSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const locations = useListLocationsQuery();
  const items = locations.data?.items ?? [];

  if (!locations.isLoading && items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No locations yet.{" "}
        <Link to="/app/locations/create" className="underline">
          Create one
        </Link>{" "}
        first.
      </p>
    );
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next ?? "")}
      disabled={locations.isLoading}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select a location" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((location) => (
            <SelectItem key={location.id} value={String(location.id)}>
              {location.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
