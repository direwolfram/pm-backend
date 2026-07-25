import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ImagePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/convexClient";
import { formatDateTime, formatMoney, fromLocalInput, toLocalInput } from "@/lib/format";
import {
  ConfirmButton,
  Loading,
  PageHeader,
  StatusBadge,
  runMutation,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  PriceDoc,
  ProductDoc,
  ProductMediaDoc,
  SkuDoc,
  StoreDoc,
} from "../../convex/model";

type SkuRow = SkuDoc & { prices: PriceDoc[]; inventory: { store_id: string; quantity_available: number; status: string }[] };
type ProductDetailData = ProductDoc & {
  media: ProductMediaDoc[];
  similar: ProductDoc[];
  skus: SkuDoc[];
  brand_name?: string;
  category_name?: string;
};
type PriceRow = PriceDoc & { store_name: string; is_current: boolean };

const EMPTY_SKU = {
  sku_code: "",
  variant_label: "",
  pack_size: "",
  barcode: "",
  sort_order: 0,
  is_default: false,
  is_active: true,
};

export default function ProductDetail() {
  const { id = "" } = useParams();
  const product = useQuery(api.products.get, { id }) as ProductDetailData | undefined;
  const skuRows = useQuery(api.skus.listByProduct, { product_id: id }) as SkuRow[] | undefined;
  const stores =
    (useQuery(api.stores.list, { includeInactive: true, limit: 100 }) as
      | { data: StoreDoc[] }
      | undefined)?.data ?? [];
  const allProducts =
    (useQuery(api.products.list, { limit: 200 }) as
      | { data: { _id: string; name: string }[] }
      | undefined)?.data ?? [];

  const createSku = useMutation(api.skus.create);
  const updateSku = useMutation(api.skus.update);
  const removeSku = useMutation(api.skus.remove);
  const addMedia = useMutation(api.products.addMedia);
  const removeMedia = useMutation(api.products.removeMedia);
  const setSimilar = useMutation(api.products.setSimilar);

  const [skuDialog, setSkuDialog] = useState(false);
  const [editingSku, setEditingSku] = useState<SkuRow | null>(null);
  const [skuForm, setSkuForm] = useState(EMPTY_SKU);
  const [priceSku, setPriceSku] = useState<SkuRow | null>(null);
  const [mediaUrl, setMediaUrl] = useState("");

  if (!product || !skuRows) return <Loading />;

  const openSkuCreate = () => {
    setEditingSku(null);
    setSkuForm({ ...EMPTY_SKU, sort_order: skuRows.length });
    setSkuDialog(true);
  };
  const openSkuEdit = (s: SkuRow) => {
    setEditingSku(s);
    setSkuForm({
      sku_code: s.sku_code,
      variant_label: s.variant_label,
      pack_size: s.pack_size ?? "",
      barcode: s.barcode ?? "",
      sort_order: s.sort_order,
      is_default: s.is_default,
      is_active: s.is_active,
    });
    setSkuDialog(true);
  };
  const saveSku = async () => {
    const payload = {
      sku_code: skuForm.sku_code.trim(),
      variant_label: skuForm.variant_label.trim(),
      pack_size: skuForm.pack_size || undefined,
      barcode: skuForm.barcode || undefined,
      sort_order: Number(skuForm.sort_order) || 0,
      is_default: skuForm.is_default,
      is_active: skuForm.is_active,
    };
    const ok = editingSku
      ? await runMutation(() => updateSku({ id: editingSku._id, ...payload }), "SKU updated")
      : await runMutation(() => createSku({ product_id: id, ...payload }), "SKU created");
    if (ok) setSkuDialog(false);
  };

  const storeName = (sid: string) => stores.find((s) => s._id === sid)?.name ?? "Store";

  return (
    <div>
      <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
        <Link to="/products">
          <ArrowLeft className="mr-1 h-4 w-4" /> Products
        </Link>
      </Button>
      <PageHeader
        title={`${product.icon_emoji ?? "📦"} ${product.name}`}
        description={`${product.category_name ?? ""}${product.brand_name ? ` · ${product.brand_name}` : ""} · slug: ${product.slug}`}
        actions={<StatusBadge value={product.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">SKUs (purchasable variants)</CardTitle>
              <Button size="sm" onClick={openSkuCreate}>
                <Plus className="mr-1 h-4 w-4" /> Add SKU
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead className="text-center">Default</TableHead>
                    <TableHead className="text-center">Active</TableHead>
                    <TableHead>Stock by store</TableHead>
                    <TableHead className="w-40" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skuRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        No SKUs yet — add the first purchasable variant.
                      </TableCell>
                    </TableRow>
                  )}
                  {skuRows.map((s) => (
                    <TableRow key={s._id}>
                      <TableCell>
                        <p className="font-mono text-xs font-medium">{s.sku_code}</p>
                        {s.barcode && (
                          <p className="text-xs text-muted-foreground">{s.barcode}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{s.variant_label}</TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={s.is_default}
                          onCheckedChange={(v) =>
                            runMutation(() => updateSku({ id: s._id, is_default: v }))
                          }
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={s.is_active}
                          onCheckedChange={(v) =>
                            runMutation(() => updateSku({ id: s._id, is_active: v }))
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {s.inventory.length === 0 && (
                            <span className="text-xs text-muted-foreground">no stock rows</span>
                          )}
                          {s.inventory.map((inv) => (
                            <span key={inv.store_id} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                              {storeName(inv.store_id).replace("PocketMart ", "")}: {inv.quantity_available}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="outline" size="sm" onClick={() => setPriceSku(s)}>
                            Prices
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => openSkuEdit(s)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <ConfirmButton
                            trigger={
                              <Button variant="ghost" size="icon">
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            }
                            title={`Delete SKU ${s.sku_code}?`}
                            description="Deletes its prices and inventory rows."
                            onConfirm={() =>
                              runMutation(() => removeSku({ id: s._id }), "SKU deleted")
                            }
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Similar products</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
                {allProducts
                  .filter((p) => p._id !== id)
                  .map((p) => {
                    const checked = product.similar.some((sp) => sp._id === p._id);
                    return (
                      <label key={p._id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => {
                            const next = v
                              ? [...product.similar.map((sp) => sp._id), p._id]
                              : product.similar.map((sp) => sp._id).filter((x) => x !== p._id);
                            runMutation(() =>
                              setSimilar({ product_id: id, similar_product_ids: next }),
                            );
                          }}
                        />
                        {p.name}
                      </label>
                    );
                  })}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Media</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {product.media.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No images yet — paste a URL below.
                </p>
              )}
              {product.media.map((m) => (
                <div key={m._id} className="flex items-center gap-2 rounded-md border p-2">
                  <img src={m.url} alt={m.alt_text ?? ""} className="h-10 w-10 rounded object-cover" />
                  <p className="flex-1 truncate text-xs text-muted-foreground">{m.url}</p>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => runMutation(() => removeMedia({ id: m._id }))}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Input
                  placeholder="https://…/image.jpg"
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                />
                <Button
                  size="icon"
                  disabled={!mediaUrl.trim()}
                  onClick={async () => {
                    const ok = await runMutation(
                      () =>
                        addMedia({
                          product_id: id,
                          url: mediaUrl.trim(),
                          sort_order: product.media.length,
                        }),
                      "Image added",
                    );
                    if (ok) setMediaUrl("");
                  }}
                >
                  <ImagePlus className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ratings</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <p>
                ⭐ {product.rating_average.toFixed(1)} · {product.rating_count.toLocaleString()} reviews
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* SKU create/edit dialog */}
      <Dialog open={skuDialog} onOpenChange={setSkuDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSku ? "Edit SKU" : "Add SKU"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>SKU code *</Label>
              <Input value={skuForm.sku_code} onChange={(e) => setSkuForm({ ...skuForm, sku_code: e.target.value })} />
            </div>
            <div>
              <Label>Variant label *</Label>
              <Input placeholder="1.5 ltr, 6-pack…" value={skuForm.variant_label} onChange={(e) => setSkuForm({ ...skuForm, variant_label: e.target.value })} />
            </div>
            <div>
              <Label>Pack size</Label>
              <Input value={skuForm.pack_size} onChange={(e) => setSkuForm({ ...skuForm, pack_size: e.target.value })} />
            </div>
            <div>
              <Label>Barcode</Label>
              <Input value={skuForm.barcode} onChange={(e) => setSkuForm({ ...skuForm, barcode: e.target.value })} />
            </div>
            <div>
              <Label>Sort order</Label>
              <Input type="number" value={skuForm.sort_order} onChange={(e) => setSkuForm({ ...skuForm, sort_order: Number(e.target.value) })} />
            </div>
            <div className="flex items-end gap-6 pb-1">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={skuForm.is_default} onCheckedChange={(v) => setSkuForm({ ...skuForm, is_default: v })} />
                Default
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={skuForm.is_active} onCheckedChange={(v) => setSkuForm({ ...skuForm, is_active: v })} />
                Active
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSkuDialog(false)}>Cancel</Button>
            <Button onClick={saveSku} disabled={!skuForm.sku_code.trim() || !skuForm.variant_label.trim()}>
              {editingSku ? "Save changes" : "Create SKU"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Price manager dialog */}
      {priceSku && (
        <PriceDialog
          sku={priceSku}
          stores={stores}
          onClose={() => setPriceSku(null)}
        />
      )}
    </div>
  );
}

function PriceDialog({
  sku,
  stores,
  onClose,
}: {
  sku: SkuRow;
  stores: StoreDoc[];
  onClose: () => void;
}) {
  const prices = useQuery(api.prices.listBySku, { sku_id: sku._id }) as PriceRow[] | undefined;
  const upsert = useMutation(api.prices.upsert);
  const remove = useMutation(api.prices.remove);
  const [form, setForm] = useState({
    store_id: "base",
    sale_price: "",
    compare_at_price: "",
    starts_at: toLocalInput(Date.now()),
    ends_at: "",
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Prices — {sku.variant_label} <span className="font-mono text-xs">({sku.sku_code})</span>
          </DialogTitle>
        </DialogHeader>
        {!prices ? (
          <Loading />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead className="text-right">Sale</TableHead>
                  <TableHead className="text-right">Compare-at</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {prices.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                      No prices yet — add one below.
                    </TableCell>
                  </TableRow>
                )}
                {prices.map((p) => (
                  <TableRow key={p._id}>
                    <TableCell className="text-sm">{p.store_name}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatMoney(p.sale_price, p.currency)}
                      {p.is_current && <StatusBadge value="active" />}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatMoney(p.compare_at_price, p.currency)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(p.starts_at)} → {p.ends_at ? formatDateTime(p.ends_at) : "∞"}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => runMutation(() => remove({ id: p._id }))}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="mt-2 grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-5">
              <div>
                <Label>Store</Label>
                <Select value={form.store_id} onValueChange={(v) => setForm({ ...form, store_id: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="base">All stores (base)</SelectItem>
                    {stores.map((s) => (
                      <SelectItem key={s._id} value={s._id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Sale price (PHP) *</Label>
                <Input type="number" min="0" step="0.01" value={form.sale_price} onChange={(e) => setForm({ ...form, sale_price: e.target.value })} />
              </div>
              <div>
                <Label>Compare-at</Label>
                <Input type="number" min="0" step="0.01" value={form.compare_at_price} onChange={(e) => setForm({ ...form, compare_at_price: e.target.value })} />
              </div>
              <div>
                <Label>Starts</Label>
                <Input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
              </div>
              <div>
                <Label>Ends (optional)</Label>
                <Input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
              </div>
              <Button
                className="sm:col-span-5"
                disabled={!form.sale_price}
                onClick={async () => {
                  const ok = await runMutation(
                    () =>
                      upsert({
                        sku_id: sku._id,
                        store_id: form.store_id === "base" ? undefined : form.store_id,
                        sale_price: Number(form.sale_price),
                        compare_at_price: form.compare_at_price ? Number(form.compare_at_price) : undefined,
                        starts_at: fromLocalInput(form.starts_at),
                        ends_at: form.ends_at ? fromLocalInput(form.ends_at) : undefined,
                      }),
                    "Price saved",
                  );
                  if (ok) setForm({ ...form, sale_price: "", compare_at_price: "" });
                }}
              >
                Add price
              </Button>
            </div>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
