import { useState, type ReactNode } from "react";
import { Loader2, PackageOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  inactive: "bg-slate-100 text-slate-600 border-slate-200",
  draft: "bg-amber-100 text-amber-800 border-amber-200",
  hidden: "bg-slate-100 text-slate-600 border-slate-200",
  discontinued: "bg-rose-100 text-rose-800 border-rose-200",
  guest: "bg-slate-100 text-slate-600 border-slate-200",
  blocked: "bg-rose-100 text-rose-800 border-rose-200",
  deleted: "bg-rose-100 text-rose-800 border-rose-200",
  in_stock: "bg-emerald-100 text-emerald-800 border-emerald-200",
  low_stock: "bg-amber-100 text-amber-800 border-amber-200",
  out_of_stock: "bg-rose-100 text-rose-800 border-rose-200",
  unavailable: "bg-slate-200 text-slate-600 border-slate-300",
  pending_payment: "bg-amber-100 text-amber-800 border-amber-200",
  confirmed: "bg-sky-100 text-sky-800 border-sky-200",
  picking: "bg-indigo-100 text-indigo-800 border-indigo-200",
  packed: "bg-violet-100 text-violet-800 border-violet-200",
  out_for_delivery: "bg-cyan-100 text-cyan-800 border-cyan-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  cancelled: "bg-rose-100 text-rose-800 border-rose-200",
  refunded: "bg-slate-100 text-slate-600 border-slate-200",
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  authorized: "bg-sky-100 text-sky-800 border-sky-200",
  paid: "bg-emerald-100 text-emerald-800 border-emerald-200",
  failed: "bg-rose-100 text-rose-800 border-rose-200",
  open: "bg-amber-100 text-amber-800 border-amber-200",
  waiting_for_customer: "bg-sky-100 text-sky-800 border-sky-200",
  resolved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  closed: "bg-slate-100 text-slate-600 border-slate-200",
  banner: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  carousel: "bg-sky-100 text-sky-800 border-sky-200",
  coupon: "bg-amber-100 text-amber-800 border-amber-200",
  product_discount: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

export function StatusBadge({ value }: { value?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const cls =
    STATUS_STYLES[value] ?? "bg-slate-100 text-slate-700 border-slate-200";
  return (
    <Badge variant="outline" className={`font-medium ${cls}`}>
      {value.replace(/_/g, " ")}
    </Badge>
  );
}

export function Loading() {
  return (
    <div className="flex items-center justify-center py-16 text-muted-foreground">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-14 text-center">
      <PackageOpen className="mb-3 h-8 w-8 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ConfirmButton({
  trigger,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Runs a Convex mutation and surfaces errors via toast. Returns true on success. */
export async function runMutation(
  fn: () => Promise<unknown>,
  successMessage?: string,
): Promise<boolean> {
  const { toast } = await import("sonner");
  try {
    await fn();
    if (successMessage) toast.success(successMessage);
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return false;
  }
}
