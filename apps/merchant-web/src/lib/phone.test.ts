import { describe, expect, it } from "vitest";
import { formatPhone, optionalPhoneSchema, phoneSchema, toE164 } from "./phone";

describe("toE164 (OS-687)", () => {
  it.each([
    ["(201) 555-0123", "+12015550123"],
    ["201-555-0123", "+12015550123"],
    ["2015550123", "+12015550123"],
    ["+1 201 555 0123", "+12015550123"],
    ["+44 20 7183 8750", "+442071838750"],
  ])("%s -> %s", (input, e164) => expect(toE164(input)).toBe(e164));

  it.each(["", "asdf", "555-5555", "(555) 555-0100", "201-555-0123 ext. 12"])(
    "rejects %p",
    (input) => expect(toE164(input)).toBeNull(),
  );
});

describe("phoneSchema", () => {
  it("requires a value", () => {
    expect(phoneSchema.safeParse("").success).toBe(false);
  });

  it("rejects garbage", () => {
    expect(phoneSchema.safeParse("asdf").success).toBe(false);
  });

  it("accepts a local-format US number", () => {
    expect(phoneSchema.safeParse("(201) 555-0123").success).toBe(true);
  });
});

describe("optionalPhoneSchema", () => {
  it("accepts a blank box", () => {
    expect(optionalPhoneSchema.safeParse("  ").success).toBe(true);
  });

  it("still rejects garbage", () => {
    expect(optionalPhoneSchema.safeParse("asdf").success).toBe(false);
  });
});

describe("formatPhone", () => {
  it("shows North American numbers in national format", () => {
    expect(formatPhone("+12015550123")).toBe("(201) 555-0123");
  });

  it("shows other numbers in international format", () => {
    expect(formatPhone("+442071838750")).toBe("+44 20 7183 8750");
  });

  it("falls back to the stored value when it doesn't parse", () => {
    expect(formatPhone("asdf")).toBe("asdf");
  });
});
