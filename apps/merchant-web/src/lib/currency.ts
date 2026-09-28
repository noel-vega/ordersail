const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatCents(cents: number) {
  return currencyFormatter.format(cents / 100);
}

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  // currency's default minimum of 2 would pad $950 to $950.0
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

// for chart axes: $0 · $950 · $1.2K · $3.4M
export function formatCompactCents(cents: number) {
  return compactCurrencyFormatter.format(cents / 100);
}

// for binding a cents value to a dollar-denominated number input
export function centsToDollars(cents: number) {
  return cents / 100;
}

// avoids float drift (e.g. 19.99 * 100 === 1998.9999999999998)
export function dollarsToCents(dollars: number) {
  return Math.round(dollars * 100);
}
