import { Field, FieldLabel } from "ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";

export type StockLocationOption = {
  id: number;
  name: string;
  // a variant's stock there, shown beside the name; null (unknown) or
  // omitted hides it
  stock?: number | null;
};

// where stock goes when there's more than one location to choose from.
// Nothing is preselected — which location is the merchant's call (OS-696)
export function StockLocationSelect(props: {
  label: string;
  locations: StockLocationOption[];
  value: number | null;
  onChange: (locationId: number | null) => void;
  error?: string;
}) {
  return (
    <Field data-invalid={!!props.error}>
      <FieldLabel>{props.label}</FieldLabel>
      <Select
        value={props.value}
        onValueChange={(next) => props.onChange(next)}
        items={props.locations.map((l) => ({ value: l.id, label: l.name }))}
      >
        <SelectTrigger>
          <SelectValue placeholder="Choose a location" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.locations.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                <span className="flex-1">{l.name}</span>
                {l.stock != null && (
                  <span className="text-muted-foreground">
                    {l.stock} in stock
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {props.error && (
        <p className="text-sm text-destructive">{props.error}</p>
      )}
    </Field>
  );
}
