import { useMemo } from "react"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "ui/combobox"

// every IANA zone the browser knows. Chrome's list leaves out "UTC" itself
// (only "Etc/…" aliases), which is the account default — so it's added back,
// along with the current value in case this browser's ICU data lacks it
function timeZoneOptions(current: string): string[] {
  const zones = new Set(Intl.supportedValuesOf("timeZone"))
  zones.add("UTC")
  if (current) zones.add(current)
  return [...zones].sort()
}

export function TimezoneCombobox(props: {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
}) {
  const items = useMemo(() => timeZoneOptions(props.value), [props.value])

  return (
    <Combobox
      autoHighlight
      items={items}
      value={props.value}
      onValueChange={(value: string | null) => {
        if (value) props.onValueChange(value)
      }}
      disabled={props.disabled}
    >
      <ComboboxInput placeholder="Search time zones" disabled={props.disabled} />
      <ComboboxContent>
        <ComboboxEmpty>No time zones found.</ComboboxEmpty>
        <ComboboxList>
          {(zone: string) => (
            <ComboboxItem key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
