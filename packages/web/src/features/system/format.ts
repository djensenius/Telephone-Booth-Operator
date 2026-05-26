// Shared formatting helpers for system snapshot rendering. Used by both the
// full `LiveSystemPanel` page and the compact `SystemVitalsStrip` shown in
// the operator sidebar, so units and rounding stay identical between the
// two surfaces.

export function fmtPercent(used: number | null | undefined, total: number | null | undefined): string {
  if (typeof used !== "number" || typeof total !== "number" || total <= 0) return "—";
  return `${((used / total) * 100).toFixed(1)}%`;
}

export function fmtBytes(value: number | null | undefined): string {
  if (typeof value !== "number") return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function fmtUptime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number") return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const mins = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function fmtNumber(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" ? value.toFixed(digits) : "—";
}
