import { useState } from "react"
import { CalendarIcon, ChevronDownIcon } from "lucide-react"
import { Button } from "ui/button"
import { Calendar } from "ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "ui/popover"
import { cn } from "ui/utils"
import {
  MAX_RANGE_DAYS,
  PRESET_LABELS,
  RANGE_PRESETS,
  type RangePreset,
  formatRangeLabel,
  fromLocalDate,
  rangeDays,
  toLocalDate,
} from "../dashboard-range"

type Draft = { from?: Date; to?: Date } | undefined

// Presets on the left, a custom range calendar on the right (OS-193). A
// preset applies immediately; a custom range applies on "Apply" so a
// half-picked range never fires a query.
export function DateRangePicker(props: {
  preset: RangePreset | "custom"
  // the resolved dates, once the API has answered; the trigger falls back to
  // the preset's name until then
  from?: string
  to?: string
  // today in the account's zone, from the API; days after it are disabled.
  // Not the browser's today — the two differ when the zones do (OS-193)
  today?: string
  onPresetChange: (preset: RangePreset) => void
  onCustomChange: (range: { from: string; to: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>()

  const resolvedLabel =
    props.from && props.to ? formatRangeLabel(props.from, props.to) : undefined
  const presetLabel =
    props.preset === "custom" ? "Custom" : PRESET_LABELS[props.preset]

  const draftFrom = draft?.from ? fromLocalDate(draft.from) : undefined
  const draftTo = draft?.to ? fromLocalDate(draft.to) : undefined
  const draftTooLong =
    draftFrom && draftTo ? rangeDays(draftFrom, draftTo) > MAX_RANGE_DAYS : false

  function handleOpenChange(next: boolean) {
    // seed the calendar with what's showing, so "Custom" starts from it
    if (next) {
      setDraft(
        props.from && props.to
          ? { from: toLocalDate(props.from), to: toLocalDate(props.to) }
          : undefined,
      )
    }
    setOpen(next)
  }

  function choosePreset(preset: RangePreset) {
    props.onPresetChange(preset)
    setOpen(false)
  }

  function applyCustom() {
    if (!draftFrom || draftTooLong) return
    // a single click selects one day
    props.onCustomChange({ from: draftFrom, to: draftTo ?? draftFrom })
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="justify-start gap-2"
            aria-label={`Date range: ${presetLabel}${resolvedLabel ? `, ${resolvedLabel}` : ""}`}
          />
        }
      >
        <CalendarIcon />
        <span className="font-medium">{presetLabel}</span>
        {resolvedLabel && (
          <span className="hidden text-muted-foreground sm:inline">
            {resolvedLabel}
          </span>
        )}
        <ChevronDownIcon className="ml-auto" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
        <div className="flex flex-col sm:flex-row">
          <ul
            className="flex flex-wrap gap-1 border-b p-2 sm:w-40 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0"
            aria-label="Presets"
          >
            {RANGE_PRESETS.map((preset) => (
              <li key={preset}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={props.preset === preset}
                  className={cn(
                    "w-full justify-start",
                    props.preset === preset && "bg-muted font-medium",
                  )}
                  onClick={() => choosePreset(preset)}
                >
                  {PRESET_LABELS[preset]}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-col">
            <Calendar
              mode="range"
              selected={draft?.from ? { from: draft.from, to: draft.to } : undefined}
              onSelect={(range) => setDraft(range)}
              defaultMonth={draft?.to ?? draft?.from}
              disabled={{
                after: props.today ? toLocalDate(props.today) : new Date(),
              }}
              numberOfMonths={1}
            />
            <div className="flex items-center justify-between gap-2 border-t p-2">
              <p
                className={cn(
                  "text-xs text-muted-foreground",
                  draftTooLong && "text-destructive",
                )}
                aria-live="polite"
              >
                {draftTooLong
                  ? "Pick 2 years or less"
                  : draftFrom
                    ? formatRangeLabel(draftFrom, draftTo ?? draftFrom)
                    : "Pick a start date"}
              </p>
              <Button
                type="button"
                size="sm"
                disabled={!draftFrom || draftTooLong}
                onClick={applyCustom}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
