import { useState } from "react"
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "ui/combobox"
import { useCreateCategoryMutation, useListCategoriesQuery } from "../categories.hooks"

type CategoryOption = { value: number; label: string; isNew?: boolean }

export function CategoryCombobox({
  value,
  onValueChange,
}: {
  value: number[]
  onValueChange: (value: number[]) => void
}) {
  const categoriesQuery = useListCategoriesQuery()
  const createCategory = useCreateCategoryMutation()
  const [inputValue, setInputValue] = useState("")
  const anchorRef = useComboboxAnchor()

  const options: CategoryOption[] = (categoriesQuery.data?.items ?? []).map(
    (category) => ({ value: category.id, label: category.name })
  )

  const query = inputValue.trim()
  const hasExactMatch = options.some(
    (option) => option.label.toLowerCase() === query.toLowerCase()
  )
  const items: CategoryOption[] =
    query && !hasExactMatch
      ? [...options, { value: -1, label: query, isNew: true }]
      : options

  const selected = value
    .map((id) => options.find((option) => option.value === id))
    .filter((option): option is CategoryOption => option != null)

  const handleValueChange = (next: CategoryOption[]) => {
    const created = next.find((option) => option.isNew)
    if (created) {
      createCategory.mutate(
        { name: created.label },
        {
          onSuccess: (category) => {
            if (!category) return
            onValueChange([
              ...next.filter((option) => !option.isNew).map((option) => option.value),
              category.id,
            ])
          },
        }
      )
      setInputValue("")
      return
    }
    onValueChange(next.map((option) => option.value))
    setInputValue("")
  }

  return (
    <Combobox
      multiple
      autoHighlight
      items={items}
      value={selected}
      onValueChange={handleValueChange}
      inputValue={inputValue}
      onInputValueChange={setInputValue}
      isItemEqualToValue={(a: CategoryOption, b: CategoryOption) => a.value === b.value}
    >
      <ComboboxChips ref={anchorRef}>
        {selected.map((option) => (
          <ComboboxChip key={option.value}>{option.label}</ComboboxChip>
        ))}
        <ComboboxChipsInput
          placeholder={
            categoriesQuery.isLoading
              ? "Loading categories…"
              : "Select or create categories"
          }
          disabled={categoriesQuery.isLoading}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchorRef}>
        <ComboboxEmpty>No categories found.</ComboboxEmpty>
        <ComboboxList>
          {(option: CategoryOption) => (
            <ComboboxItem key={option.value} value={option}>
              {option.isNew ? `Create "${option.label}"` : option.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
