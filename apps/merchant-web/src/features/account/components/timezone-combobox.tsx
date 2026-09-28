import { useMemo } from "react"
import { canonicalTimeZone } from "../timezone"
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

// "America/New_York" -> "America/New York". The combobox filters on and fills
// its input with this label too, so typing "New York" finds the zone
function timeZoneLabel(zone: string): string {
  return zone.replaceAll("_", " ")
}

export function TimezoneCombobox(props: {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
}) {
  // the stored value in this browser's spelling, so an API-canonical legacy
  // name ("Asia/Calcutta") selects the listed "Asia/Kolkata" instead of
  // appearing as a second entry that a save snaps back to
  const value = canonicalTimeZone(props.value) ?? props.value
  const items = useMemo(() => timeZoneOptions(value), [value])

  return (
    <Combobox
      autoHighlight
      items={items}
      value={value}
      itemToStringLabel={timeZoneLabel}
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
              {timeZoneLabel(zone)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
