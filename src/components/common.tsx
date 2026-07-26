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
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b pb-5">
      <div>
        <h1 className="text-[22px] font-semibold leading-[30px] tracking-normal">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-[#ECFDF3] text-[#168A4A] border-[#BBF7D0]",
  inactive: "bg-[#F4F4F5] text-[#5F5F66] border-[#E4E4E7]",
  draft: "bg-[#FFF8E6] text-[#B66A00] border-[#FDE6A7]",
  hidden: "bg-[#F4F4F5] text-[#5F5F66] border-[#E4E4E7]",
  discontinued: "bg-[#FEF3F2] text-[#D92D20] border-[#FECACA]",
  guest: "bg-[#F4F4F5] text-[#5F5F66] border-[#E4E4E7]",
  blocked: "bg-[#FEF3F2] text-[#D92D20] border-[#FECACA]",
  deleted: "bg-[#FEF3F2] text-[#D92D20] border-[#FECACA]",
  in_stock: "bg-[#ECFDF3] text-[#168A4A] border-[#BBF7D0]",
  low_stock: "bg-[#FFF8E6] text-[#B66A00] border-[#FDE6A7]",
  out_of_stock: "bg-[#FEF3F2] text-[#D92D20] border-[#FECACA]",
  unavailable: "bg-[#F4F4F5] text-[#5F5F66] border-[#E4E4E7]",
  pending_payment: "bg-[#FFF8E6] text-[#B66A00] border-[#FDE6A7]",
  confirmed: "bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]",
  picking: "bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]",
  packed: "bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]",
  out_for_delivery: "bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]",
  delivered: "bg-[#ECFDF3] text-[#168A4A] border-[#BBF7D0]",
  cancelled: "bg-[#FEF3F2] text-[#D92D20] border-[#FECACA]",
  refunded: "bg-[#F4F4F5] text-[#5F5F66] border-[#E4E4E7]",
  pending: "bg-[#FFF8E6] text-[#B66A00] border-[#FDE6A7]",
  authorized: "bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]",
  paid: "bg-[#ECFDF3] text-[#168A4A] border-[#BBF7D0]",
  failed: "bg-[#FEF3F2] text-[#D92D20] border-[#FECACA]",
  open: "bg-[#FFF8E6] text-[#B66A00] border-[#FDE6A7]",
  waiting_for_customer: "bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]",
  resolved: "bg-[#ECFDF3] text-[#168A4A] border-[#BBF7D0]",
  closed: "bg-[#F4F4F5] text-[#5F5F66] border-[#E4E4E7]",
  banner: "bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]",
  carousel: "bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]",
  coupon: "bg-[#FFF8E6] text-[#B66A00] border-[#FDE6A7]",
  product_discount: "bg-[#ECFDF3] text-[#168A4A] border-[#BBF7D0]",
};

export function StatusBadge({ value }: { value?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const cls =
    STATUS_STYLES[value] ?? "bg-[#F4F4F5] text-[#5F5F66] border-[#E4E4E7]";
  return (
    <Badge variant="outline" className={`capitalize ${cls}`}>
      {value.replace(/_/g, " ")}
    </Badge>
  );
}

export function Loading() {
  return (
    <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
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
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-card py-12 text-center">
      <PackageOpen className="mb-3 h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
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
