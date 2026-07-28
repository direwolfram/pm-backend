import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useNavigate } from "react-router";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/convexClient";
import { formatMoney } from "@/lib/format";
import {
  ConfirmButton,
  EmptyState,
  Loading,
  PageHeader,
  StatusBadge,
  runMutation,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import type {
  BrandDoc,
  CategoryDoc,
  ProductListRow,
} from "../../convex/model";

type ListResult = {
  data: ProductListRow[];
  total: number;
  totalIsExact: boolean;
  nextCursor: string | null;
  hasMore: boolean;
};

const EMPTY_FORM = {
  name: "",
  slug: "",
  status: "draft",
  primary_category_id: "",
  brand_id: "",
  sku: "",
  brand: "",
  basePrice: "",
  weightKg: "",
  volumeL: "",
  temperatureZone: "ambient",
  packagingType: "",
  searchKeywords: "",
  substituteSkuIds: "",
  substitutePriority: "0",
  allowSubstitution: false,
  isExpressAvailable: true,
  isFrequentlyBought: false,
  isFragile: false,
  isFlammable: false,
  isFreshProduce: false,
  isReturnable: true,
  tag: "",
  pack_type: "",
  shelf_life: "",
  flavour: "",
  finish: "",
  colour_family: "",
  badge_text: "",
  icon_emoji: "",
  image_color: "",
  paraben_free: false,
  description: "",
  images: "",
  attributes: "",
};

function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function csv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function Products() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [brandId, setBrandId] = useState<string>("all");

  const result = useQuery(api.products.listV2, {
    search: search || undefined,
    status: status === "all" ? undefined : status,
    category_id: categoryId === "all" ? undefined : categoryId,
    brand_id: brandId === "all" ? undefined : brandId,
    limit: 200,
  }) as ListResult | undefined;
  const categories =
    (useQuery(api.categories.list, { includeInactive: true, limit: 200 }) as
      | { data: CategoryDoc[] }
      | undefined)?.data ?? [];
  const brands =
    (useQuery(api.brands.list, { includeInactive: true, limit: 200 }) as
      | { data: BrandDoc[] }
      | undefined)?.data ?? [];

  const createProduct = useMutation(api.products.create);
  const updateProduct = useMutation(api.products.update);
  const removeProduct = useMutation(api.products.remove);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProductListRow | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = (p: ProductListRow) => {
    setEditing(p);
    setForm({
      name: p.name,
      slug: p.slug,
      status: p.status,
      primary_category_id: p.primary_category_id,
      brand_id: p.brand_id ?? "",
      sku: p.sku ?? "",
      brand: p.brand ?? "",
      basePrice: p.basePrice === undefined ? "" : String(p.basePrice),
      weightKg: p.weightKg === undefined ? "" : String(p.weightKg),
      volumeL: p.volumeL === undefined ? "" : String(p.volumeL),
      temperatureZone: p.temperatureZone ?? "ambient",
      packagingType: p.packagingType ?? "",
      searchKeywords: p.searchKeywords?.join(", ") ?? "",
      substituteSkuIds: p.substituteSkuIds?.join(", ") ?? "",
      substitutePriority:
        p.substitutePriority === undefined ? "0" : String(p.substitutePriority),
      allowSubstitution: p.allowSubstitution ?? false,
      isExpressAvailable: p.isExpressAvailable ?? true,
      isFrequentlyBought: p.isFrequentlyBought ?? false,
      isFragile: p.isFragile ?? false,
      isFlammable: p.isFlammable ?? false,
      isFreshProduce: p.isFreshProduce ?? false,
      isReturnable: p.isReturnable ?? true,
      tag: p.tag ?? "",
      pack_type: p.pack_type ?? "",
      shelf_life: p.shelf_life ?? "",
      flavour: p.flavour ?? "",
      finish: p.finish ?? "",
      colour_family: p.colour_family ?? "",
      badge_text: p.badge_text ?? "",
      icon_emoji: p.icon_emoji ?? "",
      image_color: p.image_color ?? "",
      paraben_free: p.paraben_free ?? false,
      description: p.description ?? "",
      images: p.images?.join(", ") ?? "",
      attributes:
        p.attributes
          ?.map((item) => `${item.key} | ${item.label} | ${item.value}`)
          .join("\n") ?? "",
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.primary_category_id) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      slug: form.slug.trim() || undefined,
      status: form.status,
      primary_category_id: form.primary_category_id,
      categoryId: form.primary_category_id,
      brand_id: form.brand_id || undefined,
      sku: form.sku || undefined,
      brand: form.brand || undefined,
      basePrice: optionalNumber(form.basePrice),
      weightKg: optionalNumber(form.weightKg),
      volumeL: optionalNumber(form.volumeL),
      temperatureZone: form.temperatureZone as "ambient" | "chilled" | "frozen",
      packagingType: form.packagingType || undefined,
      searchKeywords: csv(form.searchKeywords),
      images: csv(form.images),
      substituteSkuIds: csv(form.substituteSkuIds),
      substitutePriority: optionalNumber(form.substitutePriority) ?? 0,
      allowSubstitution: form.allowSubstitution,
      isExpressAvailable: form.isExpressAvailable,
      isFrequentlyBought: form.isFrequentlyBought,
      isFragile: form.isFragile,
      isFlammable: form.isFlammable,
      isFreshProduce: form.isFreshProduce,
      isReturnable: form.isReturnable,
      tag: form.tag || undefined,
      pack_type: form.pack_type || undefined,
      shelf_life: form.shelf_life || undefined,
      flavour: form.flavour || undefined,
      finish: form.finish || undefined,
      colour_family: form.colour_family || undefined,
      paraben_free: form.paraben_free,
      badge_text: form.badge_text || undefined,
      icon_emoji: form.icon_emoji || undefined,
      image_color: form.image_color || undefined,
      description: form.description || undefined,
      attributes: form.attributes
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|").map((part) => part.trim());
          if (parts.length >= 3) {
            return {
              key: parts[0],
              label: parts[1],
              value: parts.slice(2).join(" | "),
            };
          }
          const label = parts[0];
          return {
            key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
            label,
            value: parts[1] ?? "",
          };
        })
        .filter((item) => item.key && item.label),
    };
    const ok = editing
      ? await runMutation(
          () => updateProduct({ id: editing._id, ...payload }),
          "Product updated",
        )
      : await runMutation(() => createProduct(payload), "Product created");
    setSaving(false);
    if (ok) setDialogOpen(false);
  };

  const rows = useMemo(() => result?.data ?? [], [result]);
  const activeCount = rows.filter((p) => p.status === "active").length;
  const draftCount = rows.filter((p) => p.status === "draft").length;
  const discontinuedCount = rows.filter((p) => p.status === "discontinued").length;
  const totalSkus = rows.reduce((sum, p) => sum + p.sku_count, 0);
  const totalStock = rows.reduce((sum, p) => sum + p.total_stock, 0);

  return (
    <div>
      <PageHeader
        title="Products"
        description="Display items shown in the app. SKUs, prices and stock live on the product detail page."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> New product
          </Button>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Catalog items", result?.total ?? rows.length],
          ["Active products", activeCount],
          ["SKUs", totalSkus],
          ["Units in stock", totalStock],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-card px-4 py-3">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="numbers mt-1 text-2xl font-semibold leading-7">{value}</p>
          </div>
        ))}
      </div>

      <div className="mb-4 rounded-lg border bg-card p-3">
        <div className="mb-3 flex flex-wrap gap-1 rounded-md bg-muted p-1">
          {[
            ["all", "All"],
            ["active", "Active"],
            ["draft", `Draft ${draftCount}`],
            ["discontinued", `Discontinued ${discontinuedCount}`],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(value)}
              className={`h-8 rounded-md px-3 text-[13px] transition-colors ${
                status === value
                  ? "bg-card font-medium text-foreground shadow-[var(--shadow-sm)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search SKU, product, or category"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c._id} value={c._id}>
                  {c.icon_emoji} {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={brandId} onValueChange={setBrandId}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Brand" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All brands</SelectItem>
              {brands.map((b) => (
                <SelectItem key={b._id} value={b._id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!result ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No products found" hint="Adjust filters or create a new product." />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead className="text-right">SKUs</TableHead>
                <TableHead className="text-right">From</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p._id} className="cursor-pointer" onClick={() => navigate(`/products/${p._id}`)}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className="flex h-8 w-8 items-center justify-center rounded-md text-base"
                        style={{ backgroundColor: p.image_color ?? "#eee" }}
                      >
                        {p.icon_emoji ?? "📦"}
                      </span>
                      <div>
                        <Link
                          to={`/products/${p._id}`}
                          className="font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{p.slug}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{p.category_name}</TableCell>
                  <TableCell className="text-sm">{p.brand_name ?? p.brand ?? "—"}</TableCell>
                  <TableCell className="numbers text-right">{p.sku_count}</TableCell>
                  <TableCell className="numbers text-right">{formatMoney(p.default_price)}</TableCell>
                  <TableCell className="numbers text-right">{p.total_stock}</TableCell>
                  <TableCell>
                    <StatusBadge value={p.status} />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <ConfirmButton
                        trigger={
                          <Button variant="ghost" size="icon">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        }
                        title={`Delete "${p.name}"?`}
                        description="Deletes its SKUs, prices, inventory rows and media. Products referenced by orders can't be deleted — set them to discontinued instead."
                        onConfirm={() =>
                          runMutation(() => removeProduct({ id: p._id }), "Product deleted")
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit product" : "New product"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Slug</Label>
              <Input
                placeholder="Auto-generated from name when blank"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
              />
            </div>
            <div>
              <Label>Category *</Label>
              <Select
                value={form.primary_category_id}
                onValueChange={(v) => setForm({ ...form, primary_category_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c._id} value={c._id}>
                      {c.icon_emoji} {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Brand</Label>
              <Select value={form.brand_id} onValueChange={(v) => setForm({ ...form, brand_id: v === "none" ? "" : v })}>
                <SelectTrigger>
                  <SelectValue placeholder="No brand" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No brand</SelectItem>
                  {brands.map((b) => (
                    <SelectItem key={b._id} value={b._id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["draft", "active", "hidden", "discontinued"].map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tag</Label>
              <Input placeholder="Chilled, Bestseller…" value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} />
            </div>
            <div>
              <Label>Flavour</Label>
              <Input value={form.flavour} onChange={(e) => setForm({ ...form, flavour: e.target.value })} />
            </div>
            <div>
              <Label>Pack type</Label>
              <Input placeholder="Bottle, Pouch…" value={form.pack_type} onChange={(e) => setForm({ ...form, pack_type: e.target.value })} />
            </div>
            <div>
              <Label>Shelf life</Label>
              <Input value={form.shelf_life} onChange={(e) => setForm({ ...form, shelf_life: e.target.value })} />
            </div>
            <div>
              <Label>Finish</Label>
              <Input value={form.finish} onChange={(e) => setForm({ ...form, finish: e.target.value })} />
            </div>
            <div>
              <Label>Colour family</Label>
              <Input value={form.colour_family} onChange={(e) => setForm({ ...form, colour_family: e.target.value })} />
            </div>
            <div>
              <Label>Badge text</Label>
              <Input value={form.badge_text} onChange={(e) => setForm({ ...form, badge_text: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Label>Icon emoji</Label>
                <Input value={form.icon_emoji} onChange={(e) => setForm({ ...form, icon_emoji: e.target.value })} />
              </div>
              <div className="flex-1">
                <Label>Image color</Label>
                <Input placeholder="#B71C1C" value={form.image_color} onChange={(e) => setForm({ ...form, image_color: e.target.value })} />
              </div>
            </div>
            <div className="sm:col-span-2">
              <Label>Description</Label>
              <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Attributes</Label>
              <Textarea
                rows={3}
                placeholder="key | Label | Value"
                value={form.attributes}
                onChange={(e) => setForm({ ...form, attributes: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2 border-t pt-4">
              <h3 className="text-sm font-semibold">Quick commerce</h3>
            </div>
            <div>
              <Label>Product SKU</Label>
              <Input placeholder="QCI-001" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </div>
            <div>
              <Label>Brand label</Label>
              <Input placeholder="PocketMart, Nestlé…" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
            </div>
            <div>
              <Label>Base price</Label>
              <Input type="number" min="0" step="0.01" value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: e.target.value })} />
            </div>
            <div>
              <Label>Packaging type</Label>
              <Input placeholder="Bottle, pouch, carton…" value={form.packagingType} onChange={(e) => setForm({ ...form, packagingType: e.target.value })} />
            </div>
            <div>
              <Label>Weight (kg)</Label>
              <Input type="number" min="0" step="0.01" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: e.target.value })} />
            </div>
            <div>
              <Label>Volume (L)</Label>
              <Input type="number" min="0" step="0.01" value={form.volumeL} onChange={(e) => setForm({ ...form, volumeL: e.target.value })} />
            </div>
            <div>
              <Label>Temperature zone</Label>
              <Select value={form.temperatureZone} onValueChange={(v) => setForm({ ...form, temperatureZone: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ambient">Ambient</SelectItem>
                  <SelectItem value="chilled">Chilled</SelectItem>
                  <SelectItem value="frozen">Frozen</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Substitute priority</Label>
              <Input type="number" min="0" value={form.substitutePriority} onChange={(e) => setForm({ ...form, substitutePriority: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Search keywords</Label>
              <Input placeholder="milk, doodh, chilled drink" value={form.searchKeywords} onChange={(e) => setForm({ ...form, searchKeywords: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Image URLs</Label>
              <Input placeholder="https://…/a.jpg, https://…/b.jpg" value={form.images} onChange={(e) => setForm({ ...form, images: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Substitute SKUs</Label>
              <Input placeholder="QCI-002, QCI-003" value={form.substituteSkuIds} onChange={(e) => setForm({ ...form, substituteSkuIds: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:col-span-2 sm:grid-cols-4">
              <ToggleField label="Allow substitution" checked={form.allowSubstitution} onCheckedChange={(v) => setForm({ ...form, allowSubstitution: v })} />
              <ToggleField label="Express available" checked={form.isExpressAvailable} onCheckedChange={(v) => setForm({ ...form, isExpressAvailable: v })} />
              <ToggleField label="Frequently bought" checked={form.isFrequentlyBought} onCheckedChange={(v) => setForm({ ...form, isFrequentlyBought: v })} />
              <ToggleField label="Fresh produce" checked={form.isFreshProduce} onCheckedChange={(v) => setForm({ ...form, isFreshProduce: v })} />
              <ToggleField label="Returnable" checked={form.isReturnable} onCheckedChange={(v) => setForm({ ...form, isReturnable: v })} />
              <ToggleField label="Fragile" checked={form.isFragile} onCheckedChange={(v) => setForm({ ...form, isFragile: v })} />
              <ToggleField label="Flammable" checked={form.isFlammable} onCheckedChange={(v) => setForm({ ...form, isFlammable: v })} />
              <ToggleField label="Paraben free" checked={form.paraben_free} onCheckedChange={(v) => setForm({ ...form, paraben_free: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !form.name.trim() || !form.primary_category_id}>
              {saving ? "Saving…" : editing ? "Save changes" : "Create product"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToggleField({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
