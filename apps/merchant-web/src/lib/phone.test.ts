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

  it("emits E.164 for a local-format US number", () => {
    expect(phoneSchema.parse("(201) 555-0123")).toBe("+12015550123");
  });
});

describe("optionalPhoneSchema", () => {
  it("emits null for a blank box", () => {
    expect(optionalPhoneSchema.parse("  ")).toBeNull();
  });

  it("emits E.164 for a number", () => {
    expect(optionalPhoneSchema.parse("201-555-0123")).toBe("+12015550123");
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
