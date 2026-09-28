import { describe, expect, it } from "vitest";
import { formatCompactCents } from "./currency";

describe("formatCompactCents", () => {
  it.each([
    [0, "$0"],
    [95_000, "$950"],
    [123_456, "$1.2K"],
    [-50_000, "-$500"],
    [340_000_000, "$3.4M"],
  ])("%i → %s", (cents, label) => {
    expect(formatCompactCents(cents)).toBe(label);
  });
});
