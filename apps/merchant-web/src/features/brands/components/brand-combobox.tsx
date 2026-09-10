import { useEffect, useState } from "react"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "ui/combobox"
import { useCreateBrandMutation, useListBrandsQuery } from "../brands.hooks"

type BrandOption = { value: number; label: string; isNew?: boolean }

export function BrandCombobox({
  value,
  onValueChange,
}: {
  value: number | null
  onValueChange: (value: number | null) => void
}) {
  const brandsQuery = useListBrandsQuery()
  const createBrand = useCreateBrandMutation()
  const [inputValue, setInputValue] = useState("")

  const options: BrandOption[] = (brandsQuery.data?.items ?? []).map((brand) => ({
    value: brand.id,
    label: brand.name,
  }))

  const query = inputValue.trim()
  const hasExactMatch = options.some(
    (option) => option.label.toLowerCase() === query.toLowerCase()
  )
  const items: BrandOption[] =
    query && !hasExactMatch
      ? [...options, { value: -1, label: query, isNew: true }]
      : options

  const selected = options.find((option) => option.value === value) ?? null

  // this is a fully controlled input, so nothing else keeps it in sync with
  // the selected item — without this, a value set from outside (e.g. a form
  // reset with existing data) or a fresh pick both leave the input showing
  // whatever text was last typed instead of the selected brand's name
  useEffect(() => {
    setInputValue(selected?.label ?? "")
  }, [selected?.label])

  const handleValueChange = (option: BrandOption | null) => {
    if (!option) {
      onValueChange(null)
      return
    }
    if (option.isNew) {
      createBrand.mutate(
        { name: option.label },
        {
          onSuccess: (brand) => {
            if (brand) onValueChange(brand.id)
          },
        }
      )
      return
    }
    onValueChange(option.value)
  }

  return (
    <Combobox
      autoHighlight
      items={items}
      value={selected}
      onValueChange={handleValueChange}
      inputValue={inputValue}
      onInputValueChange={setInputValue}
      isItemEqualToValue={(a: BrandOption, b: BrandOption) => a.value === b.value}
    >
      <ComboboxInput
        placeholder={
          brandsQuery.isLoading ? "Loading brands…" : "Select or create a brand"
        }
        disabled={brandsQuery.isLoading}
        showClear
      />
      <ComboboxContent>
        <ComboboxEmpty>No brands found.</ComboboxEmpty>
        <ComboboxList>
          {(option: BrandOption) => (
            <ComboboxItem key={option.value} value={option}>
              {option.isNew ? `Create "${option.label}"` : option.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
