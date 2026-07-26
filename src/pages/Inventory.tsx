import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import { MapPin, Minus, Plus, Search, Snowflake } from "lucide-react";
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

type QuickCenter = {
  _id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  serviceablePincodes: string[];
  isActive: boolean;
  operatingHours: { open: number; close: number };
  capacity: number;
  coldChainEnabled: boolean;
};

type QuickProduct = {
  _id: string;
  sku?: string;
  name: string;
  brand?: string;
  basePrice?: number;
  weightKg?: number;
  volumeL?: number;
  isFragile?: boolean;
  isFlammable?: boolean;
  temperatureZone?: "ambient" | "chilled" | "frozen";
  packagingType?: string;
  isFreshProduce?: boolean;
  isReturnable?: boolean;
  isExpressAvailable?: boolean;
  isFrequentlyBought?: boolean;
  allowSubstitution?: boolean;
  substituteSkuIds?: string[];
};

type QuickInventoryRow = {
  _id: string;
  sku?: string;
  availableQuantity?: number;
  reservedQuantity?: number;
  inboundQuantity?: number;
  maxOrderQuantity?: number;
  replenishmentThreshold?: number;
  expectedReplenishmentAt?: number;
  lastUpdatedAt?: number;
  isActive?: boolean;
  sellableQuantity: number;
  isLowStock: boolean;
  isOutOfStock: boolean;
  status: string;
  product?: QuickProduct | null;
  fulfillmentCenter?: QuickCenter | null;
  pricing?: {
    dynamicPrice: number;
    flashSaleReservedQty: number;
    membershipExclusiveQty: number;
    discountStartAt?: number;
    discountEndAt?: number;
    isSurgeActive: boolean;
  } | null;
  batchCount: number;
  nearExpiryBatchCount: number;
  earliestExpiryDate?: number;
};

type QuickSummary = {
  total_skus: number;
  active_skus: number;
  in_stock: number;
  low_stock: number;
  out_of_stock: number;
  unavailable: number;
  available_units: number;
  reserved_units: number;
  inbound_units: number;
  sellable_units: number;
};

export default function Inventory() {
  const [mode, setMode] = useState<"quick" | "legacy">("quick");
  const storesResult = useQuery(api.stores.list, {
    includeInactive: true,
    limit: 100,
  }) as { data: StoreDoc[] } | undefined;
  const stores = storesResult?.data ?? [];
  const centers = (useQuery(api.quickInventory.listFulfillmentCenters, {
    includeInactive: true,
  }) as QuickCenter[] | undefined) ?? [];
  const [storeId, setStoreId] = useState<string>("");
  const effectiveStore = storeId || stores[0]?._id || "";
  const [centerId, setCenterId] = useState<string>("all");
  const effectiveCenter = centerId === "all" ? undefined : centerId;

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
  const quickRows = useQuery(api.quickInventory.listByCenter, {
    fulfillmentCenterId: effectiveCenter,
    status: status === "all" ? undefined : status,
    search: search || undefined,
    limit: 500,
  }) as QuickInventoryRow[] | undefined;
  const quickSummary = useQuery(api.quickInventory.summaryByCenter, {
    fulfillmentCenterId: effectiveCenter,
  }) as QuickSummary | undefined;

  const adjust = useMutation(api.inventory.adjust);
  const setThreshold = useMutation(api.inventory.setThreshold);
  const setUnavailable = useMutation(api.inventory.setUnavailable);
  const upsert = useMutation(api.inventory.upsert);

  const [addOpen, setAddOpen] = useState(false);

  const rows = useMemo(() => result?.data ?? [], [result]);
  const selectedCenter = centers.find((c) => c._id === effectiveCenter);

  return (
    <div>
      <PageHeader
        title="Inventory"
        description={
          mode === "quick"
            ? "Real-time stock, reservations, replenishment, batches, pricing, and fulfillment center coverage."
            : "Legacy stock per store and SKU. Status derives automatically from quantity vs. threshold."
        }
        actions={
          mode === "legacy" ? (
            <Button onClick={() => setAddOpen(true)} disabled={!effectiveStore}>
            <Plus className="mr-2 h-4 w-4" /> Add stock row
          </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex w-fit rounded-md bg-muted p-1">
        {[
          ["quick", "Quick Commerce"],
          ["legacy", "Legacy Stock"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setMode(value as "quick" | "legacy");
              setStatus("all");
              setSearch("");
            }}
            className={`h-8 rounded-md px-3 text-[13px] transition-colors ${
              mode === value
                ? "bg-card font-medium text-foreground shadow-[var(--shadow-sm)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "quick" ? (
        <QuickCommerceInventory
          centers={centers}
          selectedCenter={selectedCenter}
          centerId={centerId}
          setCenterId={setCenterId}
          status={status}
          setStatus={setStatus}
          search={search}
          setSearch={setSearch}
          rows={quickRows}
          summary={quickSummary}
        />
      ) : (
        <LegacyInventory
          stores={stores}
          storesLoaded={storesResult !== undefined}
          effectiveStore={effectiveStore}
          setStoreId={setStoreId}
          status={status}
          setStatus={setStatus}
          search={search}
          setSearch={setSearch}
          rows={rows}
          result={result}
          summary={summary}
          adjust={adjust}
          setThreshold={setThreshold}
          setUnavailable={setUnavailable}
          upsert={upsert}
          setAddOpen={setAddOpen}
        />
      )}

      {mode === "legacy" && addOpen && effectiveStore && (
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

function QuickCommerceInventory({
  centers,
  selectedCenter,
  centerId,
  setCenterId,
  status,
  setStatus,
  search,
  setSearch,
  rows,
  summary,
}: {
  centers: QuickCenter[];
  selectedCenter?: QuickCenter;
  centerId: string;
  setCenterId: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  search: string;
  setSearch: (value: string) => void;
  rows?: QuickInventoryRow[];
  summary?: QuickSummary;
}) {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={centerId} onValueChange={setCenterId}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Fulfillment center" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All fulfillment centers</SelectItem>
            {centers.map((center) => (
              <SelectItem key={center._id} value={center._id}>
                {center.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-52 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search product, SKU, brand, or center"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
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
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["Sellable units", summary.sellable_units],
            ["Available", summary.available_units],
            ["Reserved", summary.reserved_units],
            ["Inbound", summary.inbound_units],
            ["Active SKUs", `${summary.active_skus}/${summary.total_skus}`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <p className="numbers mt-1 text-2xl font-semibold leading-7">{value}</p>
            </div>
          ))}
        </div>
      )}

      {selectedCenter && (
        <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 text-sm md:grid-cols-[1.3fr_1fr_1fr]">
          <div>
            <p className="flex items-center gap-2 font-medium">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              {selectedCenter.name}
            </p>
            <p className="mt-1 text-muted-foreground">{selectedCenter.address}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Coverage</p>
            <p className="mt-1">{selectedCenter.serviceablePincodes.join(", ")}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Capacity and cold chain</p>
            <p className="mt-1 flex items-center gap-2">
              {selectedCenter.capacity} concurrent orders
              {selectedCenter.coldChainEnabled && <Snowflake className="h-4 w-4 text-primary" />}
            </p>
          </div>
        </div>
      )}

      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No quick-commerce inventory rows"
          hint="Seed or add quick inventory rows to show center-based availability, reservations, batches, and pricing."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product / SKU</TableHead>
                <TableHead>Center</TableHead>
                <TableHead className="text-right">Sellable</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="text-right">Inbound</TableHead>
                <TableHead className="text-right">Max/order</TableHead>
                <TableHead className="text-right">Threshold</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Handling</TableHead>
                <TableHead>Batches</TableHead>
                <TableHead>Pricing</TableHead>
                <TableHead>Replenishment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r._id}>
                  <TableCell>
                    {r.product?._id ? (
                      <Link to={`/products/${r.product._id}`} className="font-medium hover:underline">
                        {r.product.name}
                      </Link>
                    ) : (
                      <span className="font-medium">(deleted product)</span>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {r.product?.brand ?? "No brand"} · <span className="font-mono">{r.sku}</span>
                    </p>
                  </TableCell>
                  <TableCell>
                    <p className="text-sm">{r.fulfillmentCenter?.name ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.fulfillmentCenter?.serviceablePincodes?.slice(0, 3).join(", ") ?? "No coverage"}
                    </p>
                  </TableCell>
                  <TableCell className="numbers text-right font-medium">{r.sellableQuantity}</TableCell>
                  <TableCell className="numbers text-right">{r.availableQuantity ?? 0}</TableCell>
                  <TableCell className="numbers text-right">{r.reservedQuantity ?? 0}</TableCell>
                  <TableCell className="numbers text-right">{r.inboundQuantity ?? 0}</TableCell>
                  <TableCell className="numbers text-right">{r.maxOrderQuantity ?? "—"}</TableCell>
                  <TableCell className="numbers text-right">{r.replenishmentThreshold ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge value={r.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <MetaTag value={r.product?.temperatureZone} />
                      <MetaTag value={r.product?.packagingType} />
                      {r.product?.isFragile && <MetaTag value="fragile" />}
                      {r.product?.isFreshProduce && <MetaTag value="fresh" />}
                      {r.product?.isExpressAvailable === false && <MetaTag value="no express" />}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <span className="text-foreground">{r.batchCount}</span> batches
                    {r.nearExpiryBatchCount > 0 && (
                      <span className="ml-1 text-[#B66A00]">· {r.nearExpiryBatchCount} near expiry</span>
                    )}
                    <p>{r.earliestExpiryDate ? `FIFO ${formatDateTime(r.earliestExpiryDate)}` : "No batch expiry"}</p>
                  </TableCell>
                  <TableCell className="text-xs">
                    <p>{formatMoney(r.pricing?.isSurgeActive ? r.pricing.dynamicPrice : r.product?.basePrice)}</p>
                    <p className="text-muted-foreground">
                      {r.pricing?.isSurgeActive ? "Surge active" : "Base price"}
                    </p>
                    {(r.pricing?.flashSaleReservedQty ?? 0) > 0 && (
                      <p className="text-muted-foreground">{r.pricing?.flashSaleReservedQty} flash reserved</p>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.expectedReplenishmentAt ? formatDateTime(r.expectedReplenishmentAt) : "No ETA"}
                    <p>Updated {formatDateTime(r.lastUpdatedAt)}</p>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

function MetaTag({ value }: { value?: string }) {
  if (!value) return null;
  return (
    <span className="rounded-[5px] border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {value}
    </span>
  );
}

function LegacyInventory({
  stores,
  storesLoaded,
  effectiveStore,
  setStoreId,
  status,
  setStatus,
  search,
  setSearch,
  rows,
  result,
  summary,
  adjust,
  setThreshold,
  setUnavailable,
  upsert,
  setAddOpen,
}: {
  stores: StoreDoc[];
  storesLoaded: boolean;
  effectiveStore: string;
  setStoreId: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  search: string;
  setSearch: (value: string) => void;
  rows: InventoryRow[];
  result?: { data: InventoryRow[] };
  summary?: Summary;
  adjust: ReturnType<typeof useMutation>;
  setThreshold: ReturnType<typeof useMutation>;
  setUnavailable: ReturnType<typeof useMutation>;
  upsert: ReturnType<typeof useMutation>;
  setAddOpen: (value: boolean) => void;
}) {
  if (!storesLoaded) return <Loading />;
  if (stores.length === 0) {
    return <EmptyState title="No stores found" hint="Create a store before adding legacy stock rows." />;
  }

  return (
    <>
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
          <span className="rounded-[5px] bg-muted px-3 py-1">{summary.total_skus} SKUs · {summary.total_units} units</span>
          <span className="rounded-[5px] bg-[#ECFDF3] px-3 py-1 text-[#168A4A]">{summary.in_stock} in stock</span>
          <span className="rounded-[5px] bg-[#FFF8E6] px-3 py-1 text-[#B66A00]">{summary.low_stock} low</span>
          <span className="rounded-[5px] bg-[#FEF3F2] px-3 py-1 text-[#D92D20]">{summary.out_of_stock} out</span>
          <span className="rounded-[5px] bg-muted px-3 py-1 text-muted-foreground">{summary.unavailable} unavailable</span>
          <span className="rounded-[5px] bg-[#EFF6FF] px-3 py-1 text-primary">{summary.reserved_units} reserved</span>
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
        <div className="overflow-hidden rounded-lg border bg-card">
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
                  <TableCell className="numbers text-right">{r.quantity_reserved}</TableCell>
                  <TableCell className="numbers text-right">
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
    </>
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
