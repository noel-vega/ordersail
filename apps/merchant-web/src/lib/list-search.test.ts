import { describe, expect, it } from "vitest"
import { lastPage, PAGE_SIZE } from "./list-search"

describe("lastPage", () => {
  it("is 1 for an empty list", () => {
    expect(lastPage(0)).toBe(1)
  })

  it("counts a partial final page", () => {
    expect(lastPage(406)).toBe(21)
  })

  it("does not add a page when the total fills the last one exactly", () => {
    expect(lastPage(PAGE_SIZE * 3)).toBe(3)
  })
})
