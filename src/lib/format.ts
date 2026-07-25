export function formatMoney(amount: number | undefined, currency = "PHP"): string {
  if (amount === undefined || amount === null) return "—";
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

export function formatDateTime(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** ms epoch -> value for <input type="datetime-local"> */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** value of <input type="datetime-local"> -> ms epoch */
export function fromLocalInput(value: string): number {
  return new Date(value).getTime();
}
