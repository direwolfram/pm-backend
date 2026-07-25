import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Search } from "lucide-react";
import { api } from "@/lib/convexClient";
import { formatDateTime, formatMoney } from "@/lib/format";
import {
  EmptyState,
  Loading,
  PageHeader,
  StatusBadge,
  runMutation,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OrderItemDoc, OrderListRow, PaymentDoc, StoreDoc } from "../../convex/model";

const ORDER_STATUSES = [
  "pending_payment",
  "confirmed",
  "picking",
  "packed",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "refunded",
];
const PAYMENT_STATUSES = ["pending", "authorized", "paid", "failed", "refunded"];

type OrderDetail = OrderListRow & {
  items: OrderItemDoc[];
  payment: PaymentDoc | null;
  customer_phone?: string;
  address_label?: string;
};

export default function Orders() {
  const [status, setStatus] = useState("all");
  const [storeId, setStoreId] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const stores =
    (useQuery(api.stores.list, { includeInactive: true, limit: 100 }) as
      | { data: StoreDoc[] }
      | undefined)?.data ?? [];
  const result = useQuery(api.orders.list, {
    status: status === "all" ? undefined : status,
    store_id: storeId === "all" ? undefined : storeId,
    search: search || undefined,
    limit: 200,
  }) as { data: OrderListRow[] } | undefined;

  return (
    <div>
      <PageHeader title="Orders" description="Track fulfilment, payment and delivery state." />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search order # or customer…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={storeId} onValueChange={setStoreId}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stores</SelectItem>
            {stores.map((s) => (
              <SelectItem key={s._id} value={s._id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!result ? (
        <Loading />
      ) : result.data.length === 0 ? (
        <EmptyState title="No orders found" hint="Orders appear here once customers check out." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Store</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Payment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.map((o) => (
                <TableRow key={o._id} className="cursor-pointer" onClick={() => setSelected(o._id)}>
                  <TableCell>
                    <p className="font-medium">{o.order_number}</p>
                    <p className="text-xs text-muted-foreground">{formatDateTime(o.placed_at)}</p>
                  </TableCell>
                  <TableCell className="text-sm">{o.customer_name}</TableCell>
                  <TableCell className="text-sm">{o.store_name}</TableCell>
                  <TableCell className="text-sm">{o.delivery_mode}</TableCell>
                  <TableCell className="text-right">{o.item_count}</TableCell>
                  <TableCell className="text-right font-medium">{formatMoney(o.total_amount, o.currency)}</TableCell>
                  <TableCell><StatusBadge value={o.status} /></TableCell>
                  <TableCell><StatusBadge value={o.payment_status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Sheet open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selected && <OrderDetailPanel id={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function OrderDetailPanel({ id }: { id: string }) {
  const order = useQuery(api.orders.get, { id }) as OrderDetail | undefined;
  const updateStatus = useMutation(api.orders.updateStatus);
  const updatePayment = useMutation(api.orders.updatePaymentStatus);

  if (!order) return <Loading />;

  return (
    <div className="space-y-5">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {order.order_number}
          <StatusBadge value={order.status} />
        </SheetTitle>
        <p className="text-sm text-muted-foreground">
          Placed {formatDateTime(order.placed_at)} · {order.delivery_mode}
          {order.estimated_delivery_at ? ` · ETA ${formatDateTime(order.estimated_delivery_at)}` : ""}
        </p>
      </SheetHeader>

      <div className="rounded-lg border p-3 text-sm">
        <p className="font-medium">{order.customer_name}</p>
        <p className="text-muted-foreground">{order.customer_phone}</p>
        <p className="mt-1 text-muted-foreground">{order.address_label}</p>
        <p className="mt-1 text-muted-foreground">Fulfilled by {order.store_name}</p>
        {order.customer_notes && <p className="mt-1 italic">“{order.customer_notes}”</p>}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Items</p>
        <div className="space-y-2">
          {order.items.map((i) => (
            <div key={i._id} className="flex justify-between rounded-md border p-2 text-sm">
              <div>
                <p className="font-medium">{i.product_name_snapshot}</p>
                <p className="text-xs text-muted-foreground">
                  {i.sku_label_snapshot} × {i.quantity} @ {formatMoney(i.unit_price)}
                </p>
              </div>
              <p className="font-medium">{formatMoney(i.line_total)}</p>
            </div>
          ))}
        </div>
        <Separator className="my-3" />
        <div className="space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{formatMoney(order.subtotal_amount)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span>-{formatMoney(order.discount_amount)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Delivery fee</span><span>{formatMoney(order.delivery_fee_amount)}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span>{formatMoney(order.total_amount)}</span></div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium">Order status</p>
          <Select
            value={order.status}
            onValueChange={(v) =>
              runMutation(
                () => updateStatus({ id: order._id, status: v }),
                "Status updated",
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORDER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">
            Transitions are validated server-side (e.g. picking → packed → out for delivery).
          </p>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Payment</p>
          <Select
            value={order.payment_status}
            onValueChange={(v) =>
              runMutation(
                () => updatePayment({ id: order._id, payment_status: v }),
                "Payment updated",
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYMENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {order.payment && (
            <p className="mt-1 text-xs text-muted-foreground">
              via {order.payment.provider}
              {order.payment.paid_at ? ` · paid ${formatDateTime(order.payment.paid_at)}` : ""}
            </p>
          )}
        </div>
      </div>
      <Button variant="outline" onClick={() => window.print()} className="hidden">
        Print
      </Button>
    </div>
  );
}
