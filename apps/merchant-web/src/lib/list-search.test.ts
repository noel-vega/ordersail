import { describe, expect, it } from "vitest"
import { clampPage, lastPage, PAGE_SIZE } from "./list-search"

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

describe("clampPage", () => {
  it("keeps a page that has rows", () => {
    expect(clampPage(3, 406)).toBe(3)
    expect(clampPage(21, 406)).toBe(21)
  })

  it("moves a page past the end to the last page", () => {
    expect(clampPage(999, 406)).toBe(21)
  })

  it("moves to the previous page once a delete empties the last one", () => {
    expect(clampPage(3, PAGE_SIZE * 2)).toBe(2)
  })

  it("lands an empty list on page 1", () => {
    expect(clampPage(999, 0)).toBe(1)
  })
})
