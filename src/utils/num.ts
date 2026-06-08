// Shared numeric rounding helpers.
export function round2(n: number): number { return Math.round(n * 100) / 100; }
export function round1(n: number): number { return Math.round(n * 10) / 10; }

// Currency formatter: $#,##0.00, empty string for null/undefined.
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
