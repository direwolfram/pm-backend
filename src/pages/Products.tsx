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
import type { BrandDoc, CategoryDoc, ProductListRow } from "../../convex/model";

type ListResult = { data: ProductListRow[]; total: number };

const EMPTY_FORM = {
  name: "",
  status: "draft",
  primary_category_id: "",
  brand_id: "",
  tag: "",
  pack_type: "",
  flavour: "",
  badge_text: "",
  icon_emoji: "",
  image_color: "",
  description: "",
};

export default function Products() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [brandId, setBrandId] = useState<string>("all");

  const result = useQuery(api.products.list, {
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
      status: p.status,
      primary_category_id: p.primary_category_id,
      brand_id: p.brand_id ?? "",
      tag: p.tag ?? "",
      pack_type: p.pack_type ?? "",
      flavour: p.flavour ?? "",
      badge_text: p.badge_text ?? "",
      icon_emoji: p.icon_emoji ?? "",
      image_color: p.image_color ?? "",
      description: p.description ?? "",
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.primary_category_id) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      status: form.status,
      primary_category_id: form.primary_category_id,
      brand_id: form.brand_id || undefined,
      tag: form.tag || undefined,
      pack_type: form.pack_type || undefined,
      flavour: form.flavour || undefined,
      badge_text: form.badge_text || undefined,
      icon_emoji: form.icon_emoji || undefined,
      image_color: form.image_color || undefined,
      description: form.description || undefined,
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

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search products…"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["draft", "active", "hidden", "discontinued"].map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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

      {!result ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No products found" hint="Adjust filters or create a new product." />
      ) : (
        <div className="rounded-lg border">
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
                  <TableCell className="text-sm">{p.brand_name ?? "—"}</TableCell>
                  <TableCell className="text-right">{p.sku_count}</TableCell>
                  <TableCell className="text-right">{formatMoney(p.default_price)}</TableCell>
                  <TableCell className="text-right">{p.total_stock}</TableCell>
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit product" : "New product"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
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
