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
  // the term the URL already has, so mounting with `initialValue` doesn't
  // push it back up — callers reset `page` to 1 on every push, which sent a
  // refresh or a deep link on `?page=3` back to page 1
  const pushedRef = useRef(initialValue)

  useEffect(() => {
    if (value === pushedRef.current) return
    const t = setTimeout(() => {
      pushedRef.current = value
      onChangeRef.current(value)
    }, delayMs)
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
