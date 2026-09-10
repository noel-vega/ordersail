import { useEffect, useRef, useState } from "react"
import { SearchIcon } from "lucide-react"
import { InputGroup, InputGroupAddon, InputGroupInput } from "ui/input-group"
import { Field, FieldLabel } from "ui/field"

// A search box that debounces before pushing the term up (the list pages put
// `q` in the URL, so we don't want a navigation per keystroke). `initialValue`
// seeds the box from the URL on mount; typing is local until it settles.
export function ListSearchInput({
  initialValue,
  onDebouncedChange,
  placeholder,
  delayMs = 300,
}: {
  initialValue: string
  onDebouncedChange: (value: string) => void
  placeholder: string
  delayMs?: number
}) {
  const [value, setValue] = useState(initialValue)
  const onChangeRef = useRef(onDebouncedChange)
  onChangeRef.current = onDebouncedChange

  useEffect(() => {
    const t = setTimeout(() => onChangeRef.current(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])

  return (
    <Field className="max-w-xs">
      <FieldLabel>Search</FieldLabel>
      <InputGroup>
        <InputGroupInput
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder={placeholder}
        />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
    </Field>
  )
}
