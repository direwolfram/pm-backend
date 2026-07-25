import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import { Minus, Plus, Search } from "lucide-react";
import { api } from "@/lib/convexClient";
import { formatDateTime } from "@/lib/format";
import {
  EmptyState,
  Loading,
  PageHeader,
  StatusBadge,
  runMutation,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InventoryRow, StoreDoc } from "../../convex/model";

type Summary = {
  total_skus: number;
  in_stock: number;
  low_stock: number;
  out_of_stock: number;
  unavailable: number;
  total_units: number;
  reserved_units: number;
};

type SkuOption = {
  _id: string;
  sku_code: string;
  variant_label: string;
  product_name: string;
};

export default function Inventory() {
  const stores =
    (useQuery(api.stores.list, { includeInactive: true, limit: 100 }) as
      | { data: StoreDoc[] }
      | undefined)?.data ?? [];
  const [storeId, setStoreId] = useState<string>("");
  const effectiveStore = storeId || stores[0]?._id || "";

  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");

  const result = useQuery(
    api.inventory.listByStore,
    effectiveStore
      ? {
          store_id: effectiveStore,
          status: status === "all" ? undefined : status,
          search: search || undefined,
          limit: 300,
        }
      : "skip",
  ) as { data: InventoryRow[] } | undefined;
  const summary = useQuery(
    api.inventory.summaryByStore,
    effectiveStore ? { store_id: effectiveStore } : "skip",
  ) as Summary | undefined;

  const adjust = useMutation(api.inventory.adjust);
  const setThreshold = useMutation(api.inventory.setThreshold);
  const setUnavailable = useMutation(api.inventory.setUnavailable);
  const upsert = useMutation(api.inventory.upsert);

  const [addOpen, setAddOpen] = useState(false);

  const rows = useMemo(() => result?.data ?? [], [result]);

  if (stores.length === 0) return <Loading />;

  return (
    <div>
      <PageHeader
        title="Inventory"
        description="Stock per store and SKU. Status derives automatically from quantity vs. threshold."
        actions={
          <Button onClick={() => setAddOpen(true)} disabled={!effectiveStore}>
            <Plus className="mr-2 h-4 w-4" /> Add stock row
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={effectiveStore} onValueChange={setStoreId}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Pick a store" />
          </SelectTrigger>
          <SelectContent>
            {stores.map((s) => (
              <SelectItem key={s._id} value={s._id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-52 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search product, SKU, variant…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["in_stock", "low_stock", "out_of_stock", "unavailable"].map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {summary && (
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-muted px-3 py-1">{summary.total_skus} SKUs · {summary.total_units} units</span>
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">{summary.in_stock} in stock</span>
          <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">{summary.low_stock} low</span>
          <span className="rounded-full bg-rose-100 px-3 py-1 text-rose-800">{summary.out_of_stock} out</span>
          <span className="rounded-full bg-slate-200 px-3 py-1 text-slate-700">{summary.unavailable} unavailable</span>
          <span className="rounded-full bg-sky-100 px-3 py-1 text-sky-800">{summary.reserved_units} reserved</span>
        </div>
      )}

      {!result ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No inventory rows"
          hint="Add a stock row to start tracking a SKU at this store."
          action={
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Add stock row
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product / SKU</TableHead>
                <TableHead className="text-center">Available</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="text-right">Threshold</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Restock ETA</TableHead>
                <TableHead className="text-center">Unavailable</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r._id}>
                  <TableCell>
                    <Link to={`/products/${r.product_id}`} className="font-medium hover:underline">
                      {r.product_name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {r.variant_label} · <span className="font-mono">{r.sku_code}</span>
                    </p>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          runMutation(() =>
                            adjust({ sku_id: r.sku_id, store_id: effectiveStore, delta: -1 }),
                          )
                        }
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <InlineNumber
                        value={r.quantity_available}
                        onCommit={(v) =>
                          runMutation(
                            () =>
                              upsert({
                                sku_id: r.sku_id,
                                store_id: effectiveStore,
                                quantity_available: v,
                              }),
                            "Quantity updated",
                          )
                        }
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          runMutation(() =>
                            adjust({ sku_id: r.sku_id, store_id: effectiveStore, delta: 1 }),
                          )
                        }
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{r.quantity_reserved}</TableCell>
                  <TableCell className="text-right">
                    <InlineNumber
                      value={r.low_stock_threshold}
                      small
                      onCommit={(v) =>
                        runMutation(
                          () =>
                            setThreshold({
                              sku_id: r.sku_id,
                              store_id: effectiveStore,
                              low_stock_threshold: v,
                            }),
                          "Threshold updated",
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={r.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.restock_at ? formatDateTime(r.restock_at) : "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    <Button
                      variant={r.status === "unavailable" ? "default" : "outline"}
                      size="sm"
                      onClick={() =>
                        runMutation(() =>
                          setUnavailable({
                            sku_id: r.sku_id,
                            store_id: effectiveStore,
                            unavailable: r.status !== "unavailable",
                          }),
                        )
                      }
                    >
                      {r.status === "unavailable" ? "Re-enable" : "Disable"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {addOpen && effectiveStore && (
        <AddStockDialog
          storeId={effectiveStore}
          onClose={() => setAddOpen(false)}
          onSave={async (skuId, qty, threshold) => {
            const ok = await runMutation(
              () =>
                upsert({
                  sku_id: skuId,
                  store_id: effectiveStore,
                  quantity_available: qty,
                  low_stock_threshold: threshold,
                }),
              "Stock row saved",
            );
            if (ok) setAddOpen(false);
          }}
        />
      )}
    </div>
  );
}

function InlineNumber({
  value,
  onCommit,
  small,
}: {
  value: number;
  onCommit: (v: number) => void;
  small?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  if (!editing) {
    return (
      <button
        className={`rounded px-2 py-0.5 font-semibold hover:bg-muted ${small ? "text-sm font-normal" : "min-w-10 text-center"}`}
        onClick={() => {
          setDraft(String(value));
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }
  return (
    <Input
      autoFocus
      type="number"
      min="0"
      className="h-7 w-20 px-1 text-center"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const v = Number(draft);
        if (Number.isFinite(v) && v >= 0 && v !== value) onCommit(Math.floor(v));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

function AddStockDialog({
  storeId,
  onClose,
  onSave,
}: {
  storeId: string;
  onClose: () => void;
  onSave: (skuId: string, qty: number, threshold: number) => void;
}) {
  const [search, setSearch] = useState("");
  const skus = useQuery(api.skus.listAll, { search: search || undefined }) as
    | SkuOption[]
    | undefined;
  const [skuId, setSkuId] = useState("");
  const [qty, setQty] = useState("0");
  const [threshold, setThreshold] = useState("5");
  void storeId;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add stock row</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Find SKU</Label>
            <Input placeholder="Search by product, SKU code, variant…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1">
            {!skus ? (
              <Loading />
            ) : (
              skus.map((s) => (
                <button
                  key={s._id}
                  className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${skuId === s._id ? "bg-emerald-50 ring-1 ring-emerald-500" : ""}`}
                  onClick={() => setSkuId(s._id)}
                >
                  {s.product_name} — {s.variant_label}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{s.sku_code}</span>
                </button>
              ))
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quantity available</Label>
              <Input type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <Label>Low-stock threshold</Label>
              <Input type="number" min="0" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!skuId} onClick={() => onSave(skuId, Math.max(0, Math.floor(Number(qty) || 0)), Math.max(0, Math.floor(Number(threshold) || 0)))}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
