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
import type { AddressDoc, CustomerDoc, OrderDoc, SupportTicketDoc } from "../../convex/model";

type Row = CustomerDoc & { order_count: number; total_spend: number };
type Detail = CustomerDoc & {
  addresses: AddressDoc[];
  settings: {
    theme: string;
    preferred_delivery_mode: string;
    push_notifications_enabled: boolean;
    sms_notifications_enabled: boolean;
    whatsapp_notifications_enabled: boolean;
  } | null;
  recent_orders: OrderDoc[];
  tickets: SupportTicketDoc[];
};

export default function Customers() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);

  const result = useQuery(api.customers.list, {
    search: search || undefined,
    status: status === "all" ? undefined : status,
    limit: 200,
  }) as { data: Row[] } | undefined;

  return (
    <div>
      <PageHeader title="Customers" description="Registered customers, their spend and account state." />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search name, phone, email…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["guest", "active", "blocked", "deleted"].map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!result ? (
        <Loading />
      ) : result.data.length === 0 ? (
        <EmptyState title="No customers found" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">Lifetime spend</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.map((c) => (
                <TableRow key={c._id} className="cursor-pointer" onClick={() => setSelected(c._id)}>
                  <TableCell>
                    <p className="font-medium">{c.display_name ?? "(no name)"}</p>
                    <p className="text-xs text-muted-foreground">{c.email ?? ""}</p>
                  </TableCell>
                  <TableCell className="text-sm">{c.phone_country_code}{c.phone_number}</TableCell>
                  <TableCell className="text-right">{c.order_count}</TableCell>
                  <TableCell className="text-right font-medium">{formatMoney(c.total_spend)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDateTime(c.created_at)}</TableCell>
                  <TableCell><StatusBadge value={c.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Sheet open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selected && <CustomerDetailPanel id={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CustomerDetailPanel({ id }: { id: string }) {
  const customer = useQuery(api.customers.get, { id }) as Detail | undefined;
  const setStatus = useMutation(api.customers.setStatus);

  if (!customer) return <Loading />;

  return (
    <div className="space-y-5">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {customer.display_name ?? "(no name)"}
          <StatusBadge value={customer.status} />
        </SheetTitle>
        <p className="text-sm text-muted-foreground">
          {customer.phone_country_code}{customer.phone_number}
          {customer.email ? ` · ${customer.email}` : ""}
          {customer.referral_code ? ` · ref: ${customer.referral_code}` : ""}
        </p>
      </SheetHeader>

      <div>
        <p className="mb-1 text-sm font-medium">Account status</p>
        <Select
          value={customer.status}
          onValueChange={(v) =>
            runMutation(() => setStatus({ id: customer._id, status: v }), "Status updated")
          }
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {["guest", "active", "blocked", "deleted"].map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Addresses</p>
        {customer.addresses.length === 0 && (
          <p className="text-sm text-muted-foreground">None saved.</p>
        )}
        <div className="space-y-2">
          {customer.addresses.map((a) => (
            <div key={a._id} className="rounded-md border p-2 text-sm">
              <p className="font-medium">
                {a.title} {a.is_default && <StatusBadge value="active" />}
              </p>
              <p className="text-muted-foreground">{a.full_address}</p>
            </div>
          ))}
        </div>
      </div>

      {customer.settings && (
        <div className="text-sm">
          <p className="mb-1 font-medium">Settings</p>
          <p className="text-muted-foreground">
            theme: {customer.settings.theme} · delivery: {customer.settings.preferred_delivery_mode} · push{" "}
            {customer.settings.push_notifications_enabled ? "on" : "off"} · SMS{" "}
            {customer.settings.sms_notifications_enabled ? "on" : "off"} · WhatsApp{" "}
            {customer.settings.whatsapp_notifications_enabled ? "on" : "off"}
          </p>
        </div>
      )}

      <Separator />

      <div>
        <p className="mb-2 text-sm font-medium">Recent orders</p>
        {customer.recent_orders.length === 0 && (
          <p className="text-sm text-muted-foreground">No orders yet.</p>
        )}
        <div className="space-y-2">
          {customer.recent_orders.map((o) => (
            <div key={o._id} className="flex items-center justify-between rounded-md border p-2 text-sm">
              <div>
                <p className="font-medium">{o.order_number}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(o.placed_at)}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge value={o.status} />
                <span className="font-medium">{formatMoney(o.total_amount)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {customer.tickets.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Support tickets</p>
          <div className="space-y-2">
            {customer.tickets.map((t) => (
              <div key={t._id} className="rounded-md border p-2 text-sm">
                <div className="flex justify-between">
                  <p className="font-medium">{t.subject}</p>
                  <StatusBadge value={t.status} />
                </div>
                <p className="text-muted-foreground">{t.latest_message}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
