import { useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ImagePlus, Minus, Pencil, Plus, Star, Trash2, Upload } from "lucide-react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type {
  PriceDoc,
  ProductAttribute,
  BrandDoc,
  CategoryDoc,
  ProductDoc,
  ProductMediaDoc,
  SkuDoc,
  StoreDoc,
  InventoryStatus,
} from "../../convex/model";

type InventoryCell = {
  _id?: string;
  sku_id?: string;
  store_id?: string;
  quantity_available?: number;
  quantity_reserved?: number;
  low_stock_threshold?: number;
  status?: InventoryStatus;
  restock_at?: number;
  updated_at?: number;
};
type SkuRow = SkuDoc & { prices: PriceDoc[]; inventory: InventoryCell[] };
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

const EMPTY_PRODUCT_FORM = {
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

function attributesToText(attributes?: ProductAttribute[]) {
  return (
    attributes
      ?.map((item) => `${item.key} | ${item.label} | ${item.value}`)
      .join("\n") ?? ""
  );
}

function parseAttributes(value: string): ProductAttribute[] {
  return value
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
    .filter((item) => item.key && item.label);
}

export default function ProductDetail() {
  const { id = "" } = useParams();
  const product = useQuery(api.products.get, { id }) as ProductDetailData | undefined;
  const skuRows = useQuery(api.skus.listByProduct, { product_id: id }) as SkuRow[] | undefined;
  const stores =
    (useQuery(api.stores.list, { includeInactive: true, limit: 100 }) as
      | { data: StoreDoc[] }
      | undefined)?.data ?? [];
  const categories =
    (useQuery(api.categories.list, { includeInactive: true, limit: 200 }) as
      | { data: CategoryDoc[] }
      | undefined)?.data ?? [];
  const brands =
    (useQuery(api.brands.list, { includeInactive: true, limit: 200 }) as
      | { data: BrandDoc[] }
      | undefined)?.data ?? [];
  const allProducts =
    (useQuery(api.products.list, { limit: 200 }) as
      | { data: { _id: string; name: string }[] }
      | undefined)?.data ?? [];

  const updateProduct = useMutation(api.products.update);
  const createSku = useMutation(api.skus.create);
  const updateSku = useMutation(api.skus.update);
  const removeSku = useMutation(api.skus.remove);
  const addMedia = useMutation(api.products.addMedia);
  const removeMedia = useMutation(api.products.removeMedia);
  const generateUploadUrl = useMutation(api.products.generateUploadUrl);
  const setShowcaseMedia = useMutation(api.products.setShowcaseMedia);
  const createCategory = useMutation(api.categories.create);
  const createBrand = useMutation(api.brands.create);
  const setSimilar = useMutation(api.products.setSimilar);

  const [skuDialog, setSkuDialog] = useState(false);
  const [editingSku, setEditingSku] = useState<SkuRow | null>(null);
  const [skuForm, setSkuForm] = useState(EMPTY_SKU);
  const [priceSku, setPriceSku] = useState<SkuRow | null>(null);

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
        description={[
          product.category_name,
          product.sku ? `SKU ${product.sku}` : undefined,
          product.brand_name ?? product.brand,
        ].filter(Boolean).join(" · ")}
        actions={<StatusBadge value={product.status} />}
      />

      <ProductIdentityMediaCard
        key={product._id}
        product={product}
        categories={categories}
        brands={brands}
        updateProduct={updateProduct}
        createCategory={createCategory}
        createBrand={createBrand}
        addMedia={addMedia}
        removeMedia={removeMedia}
        generateUploadUrl={generateUploadUrl}
        setShowcaseMedia={setShowcaseMedia}
      />

      <ProductPropertiesCard
        product={product}
        categories={categories}
        brands={brands}
        updateProduct={updateProduct}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
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
                          {s.inventory
                            .filter((inv) => inv.store_id)
                            .map((inv) => (
                              <span
                                key={inv.store_id}
                                className="rounded bg-muted px-1.5 py-0.5 text-xs"
                              >
                                {storeName(inv.store_id!).replace("PocketMart ", "")}:{" "}
                                {inv.quantity_available ?? 0}
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

          <ProductInventory skus={skuRows} stores={stores} />

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

function ProductIdentityMediaCard({
  product,
  categories,
  brands,
  updateProduct,
  createCategory,
  createBrand,
  addMedia,
  removeMedia,
  generateUploadUrl,
  setShowcaseMedia,
}: {
  product: ProductDetailData;
  categories: CategoryDoc[];
  brands: BrandDoc[];
  updateProduct: ReturnType<typeof useMutation>;
  createCategory: ReturnType<typeof useMutation>;
  createBrand: ReturnType<typeof useMutation>;
  addMedia: ReturnType<typeof useMutation>;
  removeMedia: ReturnType<typeof useMutation>;
  generateUploadUrl: ReturnType<typeof useMutation>;
  setShowcaseMedia: ReturnType<typeof useMutation>;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(product.name);
  const [sku, setSku] = useState(product.sku ?? "");
  const [status, setStatus] = useState(product.status);
  const [categoryId, setCategoryId] = useState(product.primary_category_id);
  const [brandId, setBrandId] = useState(product.brand_id ?? "none");
  const [description, setDescription] = useState(product.description ?? "");
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [brandDialogOpen, setBrandDialogOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newBrandName, setNewBrandName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingBrand, setAddingBrand] = useState(false);
  const showcase = product.media.find((item) => item.is_showcase) ?? product.media[0];
  const hasChanges =
    name !== product.name ||
    sku !== (product.sku ?? "") ||
    status !== product.status ||
    categoryId !== product.primary_category_id ||
    brandId !== (product.brand_id ?? "none") ||
    description !== (product.description ?? "");

  const saveBasics = async () => {
    if (!name.trim() || !categoryId) return;
    setSaving(true);
    const ok = await runMutation(
      () =>
        updateProduct({
          id: product._id,
          name: name.trim(),
          sku: sku.trim() || undefined,
          status,
          primary_category_id: categoryId,
          categoryId,
          brand_id: brandId === "none" ? undefined : brandId,
          description: description.trim() || undefined,
        }),
      "Product updated",
    );
    setSaving(false);
    if (!ok) {
      setName(product.name);
      setSku(product.sku ?? "");
      setStatus(product.status);
      setCategoryId(product.primary_category_id);
      setBrandId(product.brand_id ?? "none");
      setDescription(product.description ?? "");
    }
  };

  const addCategory = async () => {
    if (!newCategoryName.trim()) return;
    setAddingCategory(true);
    let createdId = "";
    const ok = await runMutation(async () => {
      createdId = await createCategory({
        name: newCategoryName.trim(),
        sort_order: categories.length,
        is_active: true,
      });
    }, "Category added");
    setAddingCategory(false);
    if (ok && createdId) {
      setCategoryId(createdId);
      setNewCategoryName("");
      setCategoryDialogOpen(false);
    }
  };

  const addBrand = async () => {
    if (!newBrandName.trim()) return;
    setAddingBrand(true);
    let createdId = "";
    const ok = await runMutation(async () => {
      createdId = await createBrand({
        name: newBrandName.trim(),
        is_active: true,
      });
    }, "Brand added");
    setAddingBrand(false);
    if (ok && createdId) {
      setBrandId(createdId);
      setNewBrandName("");
      setBrandDialogOpen(false);
    }
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    setUploading(true);
    await runMutation(async () => {
      for (const [index, file] of files.entries()) {
        const uploadUrl = await generateUploadUrl({});
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!response.ok) throw new Error(`Upload failed for ${file.name}`);
        const { storageId } = (await response.json()) as { storageId: string };
        await addMedia({
          product_id: product._id,
          storage_id: storageId,
          alt_text: file.name,
          sort_order: product.media.length + index,
        });
      }
    }, files.length === 1 ? "Image uploaded" : `${files.length} images uploaded`);
    setUploading(false);
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) await uploadFiles(event.target.files);
    event.target.value = "";
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    await uploadFiles(event.dataTransfer.files);
  };

  return (
    <>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Product Overview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={!name.trim() ? "border-destructive bg-destructive/5" : undefined}
              />
              {!name.trim() && (
                <p className="mt-1 text-xs text-destructive">Name cannot be blank</p>
              )}
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                rows={7}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Plain text product description"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label>SKU</Label>
                <Input value={sku} onChange={(event) => setSku(event.target.value)} />
              </div>
              <div>
                <Label>Status</Label>
                <Select value={status} onValueChange={(value) => setStatus(value as ProductDoc["status"])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["draft", "active", "hidden", "discontinued"].map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Category</Label>
                <Select
                  value={categoryId}
                  onValueChange={(value) => {
                    if (value === "__add_category") {
                      setCategoryDialogOpen(true);
                      return;
                    }
                    setCategoryId(value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__add_category">+ Add category</SelectItem>
                    {categories.map((category) => (
                      <SelectItem key={category._id} value={category._id}>
                        {category.icon_emoji} {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Brand</Label>
                <Select
                  value={brandId}
                  onValueChange={(value) => {
                    if (value === "__add_brand") {
                      setBrandDialogOpen(true);
                      return;
                    }
                    setBrandId(value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No brand" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No brand</SelectItem>
                    <SelectItem value="__add_brand">+ Add brand</SelectItem>
                    {brands.map((brand) => (
                      <SelectItem key={brand._id} value={brand._id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={saveBasics} disabled={saving || !name.trim() || !categoryId || !hasChanges}>
                {saving ? "Saving..." : "Save overview"}
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            <Label>Showcase photo</Label>
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border bg-muted">
              {showcase ? (
                <img
                  src={showcase.url}
                  alt={showcase.alt_text ?? product.name}
                  className="h-full w-full object-contain"
                />
              ) : (
                <ImagePlus className="h-9 w-9 text-muted-foreground" />
              )}
            </div>
          </div>
        </div>

        <div>
          <Label>Media</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onFileChange}
          />
          <div
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragActive(false);
            }}
            onDrop={onDrop}
            className={`mt-2 rounded-md border border-dashed p-3 ${
              dragActive ? "border-primary bg-primary/5" : "border-muted-foreground/30"
            }`}
          >
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {product.media.map((media) => {
                const isShowcase = media._id === showcase?._id;
                return (
                  <div key={media._id} className="group relative overflow-hidden rounded-md border bg-background">
                    <div className="aspect-square bg-muted">
                      <img
                        src={media.url}
                        alt={media.alt_text ?? product.name}
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <div className="absolute left-2 top-2 flex gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant={isShowcase ? "default" : "secondary"}
                        className="h-8 w-8"
                        onClick={() =>
                          runMutation(
                            () =>
                              setShowcaseMedia({
                                product_id: product._id,
                                media_id: media._id,
                              }),
                            "Showcase photo updated",
                          )
                        }
                      >
                        <Star className={`h-4 w-4 ${isShowcase ? "fill-current" : ""}`} />
                      </Button>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="absolute right-2 top-2 h-8 w-8 opacity-100"
                      onClick={() => runMutation(() => removeMedia({ id: media._id }), "Image removed")}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                    <p className="truncate px-2 py-1.5 text-xs text-muted-foreground">
                      {media.alt_text || media.url}
                    </p>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex aspect-square flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted/30 text-sm text-muted-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Upload className="h-6 w-6" />
                <span>{uploading ? "Uploading..." : "Upload images"}</span>
              </button>
            </div>
          </div>
        </div>
        </CardContent>
      </Card>

      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add category</DialogTitle>
          </DialogHeader>
          <div>
            <Label>Category name</Label>
            <Input
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              placeholder="Fresh Produce"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCategoryDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addCategory} disabled={addingCategory || !newCategoryName.trim()}>
              {addingCategory ? "Adding..." : "Add category"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={brandDialogOpen} onOpenChange={setBrandDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add brand</DialogTitle>
          </DialogHeader>
          <div>
            <Label>Brand name</Label>
            <Input
              value={newBrandName}
              onChange={(event) => setNewBrandName(event.target.value)}
              placeholder="PocketMart"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBrandDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addBrand} disabled={addingBrand || !newBrandName.trim()}>
              {addingBrand ? "Adding..." : "Add brand"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProductPropertiesCard({
  product,
  categories,
  brands,
  updateProduct,
}: {
  product: ProductDetailData;
  categories: CategoryDoc[];
  brands: BrandDoc[];
  updateProduct: ReturnType<typeof useMutation>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_PRODUCT_FORM);

  const openEdit = () => {
    setForm({
      name: product.name,
      slug: product.slug,
      status: product.status,
      primary_category_id: product.primary_category_id,
      brand_id: product.brand_id ?? "",
      sku: product.sku ?? "",
      brand: product.brand ?? "",
      basePrice: product.basePrice === undefined ? "" : String(product.basePrice),
      weightKg: product.weightKg === undefined ? "" : String(product.weightKg),
      volumeL: product.volumeL === undefined ? "" : String(product.volumeL),
      temperatureZone: product.temperatureZone ?? "ambient",
      packagingType: product.packagingType ?? "",
      searchKeywords: product.searchKeywords?.join(", ") ?? "",
      substituteSkuIds: product.substituteSkuIds?.join(", ") ?? "",
      substitutePriority:
        product.substitutePriority === undefined
          ? "0"
          : String(product.substitutePriority),
      allowSubstitution: product.allowSubstitution ?? false,
      isExpressAvailable: product.isExpressAvailable ?? true,
      isFrequentlyBought: product.isFrequentlyBought ?? false,
      isFragile: product.isFragile ?? false,
      isFlammable: product.isFlammable ?? false,
      isFreshProduce: product.isFreshProduce ?? false,
      isReturnable: product.isReturnable ?? true,
      tag: product.tag ?? "",
      pack_type: product.pack_type ?? "",
      shelf_life: product.shelf_life ?? "",
      flavour: product.flavour ?? "",
      finish: product.finish ?? "",
      colour_family: product.colour_family ?? "",
      badge_text: product.badge_text ?? "",
      icon_emoji: product.icon_emoji ?? "",
      image_color: product.image_color ?? "",
      paraben_free: product.paraben_free ?? false,
      description: product.description ?? "",
      images: product.images?.join(", ") ?? "",
      attributes: attributesToText(product.attributes),
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.primary_category_id) return;
    setSaving(true);
    const ok = await runMutation(
      () =>
        updateProduct({
          id: product._id,
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
          attributes: parseAttributes(form.attributes),
        }),
      "Product updated",
    );
    setSaving(false);
    if (ok) setDialogOpen(false);
  };

  const arrayValue = (value?: string[]) => (value?.length ? value.join(", ") : undefined);
  const yesNo = (value?: boolean) =>
    value === undefined ? "—" : value ? "✅ Yes" : "❌ No";
  const attrValue = (value?: ProductAttribute[]) =>
    value?.length
      ? value.map((item) => `${item.label}: ${item.value}`).join("; ")
      : undefined;
  const formatValue = (value: ReactNode) =>
    value === undefined || value === null || value === "" ? "—" : value;

  const pricing = [
    ["Base Price", formatMoney(product.basePrice)],
    ["Promotional Price", "—"],
    ["Cost Price", "—"],
    ["Margin", "—"],
    ["Price Last Updated", formatDateTime(product.updated_at)],
  ] as const;
  const productAttributes = [
    ["Packaging", product.packagingType ?? product.pack_type],
    ["Weight", product.weightKg === undefined ? undefined : `${product.weightKg} kg`],
    ["Volume", product.volumeL === undefined ? undefined : `${product.volumeL} L`],
    ["Storage Temperature", product.temperatureZone],
    ["Fresh Produce", yesNo(product.isFreshProduce)],
    ["Fragile", yesNo(product.isFragile)],
    ["Flammable", yesNo(product.isFlammable)],
    ["Returnable", yesNo(product.isReturnable)],
  ] as const;
  const warehouse = [
    ["Express Delivery", yesNo(product.isExpressAvailable)],
    ["Allow Substitution", yesNo(product.allowSubstitution)],
    ["Substitute Products", arrayValue(product.substituteSkuIds)],
    ["Substitution Priority", product.substitutePriority],
    ["Shelf Life", product.shelf_life],
    ["Storage Notes", "—"],
  ] as const;
  const merchandising = [
    ["Images", `${product.media.length} media item${product.media.length === 1 ? "" : "s"}`],
    ["Search Keywords", arrayValue(product.searchKeywords)],
    ["Product Badge", product.badge_text],
    ["Tag", product.tag],
    ["Product Emoji", product.icon_emoji],
    ["Image Color", product.image_color],
    ["Attributes", attrValue(product.attributes)],
    ["Flavor", product.flavour],
    ["Finish", product.finish],
    ["Color Family", product.colour_family],
  ] as const;
  const customerMetrics = [
    ["Average Rating", product.rating_average.toFixed(1)],
    ["Rating Count", product.rating_count.toLocaleString()],
    ["Frequently Bought", yesNo(product.isFrequentlyBought)],
    ["Sales Rank", "—"],
    ["Popularity Score", "—"],
  ] as const;
  const systemInfo = [
    ["Created At", formatDateTime(product.created_at)],
    ["Updated At", formatDateTime(product.updated_at)],
    ["Slug", product.slug],
    ["Database ID", product._id],
    ["Category ID", product.categoryId],
    ["Brand ID", product.brand_id],
    ["Primary Category ID", product.primary_category_id],
    ["Creation Time", formatDateTime(product._creationTime)],
  ] as const;

  return (
    <>
      <div className="mt-6 space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Pricing</CardTitle>
            <Button variant="outline" size="sm" onClick={openEdit}>
              <Pencil className="mr-2 h-4 w-4" /> Edit Product
            </Button>
          </CardHeader>
          <CardContent>
            <InfoGrid items={pricing} formatValue={formatValue} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Product Attributes</CardTitle>
          </CardHeader>
          <CardContent>
            <InfoGrid items={productAttributes} formatValue={formatValue} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Warehouse & Fulfillment</CardTitle>
          </CardHeader>
          <CardContent>
            <InfoGrid items={warehouse} formatValue={formatValue} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Merchandising</CardTitle>
          </CardHeader>
          <CardContent>
            <InfoGrid items={merchandising} formatValue={formatValue} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customer Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <InfoGrid items={customerMetrics} formatValue={formatValue} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-2">
            <Accordion type="single" collapsible>
              <AccordionItem value="system-information" className="border-b-0">
                <AccordionTrigger>System Information</AccordionTrigger>
                <AccordionContent>
                  <InfoGrid items={systemInfo} formatValue={formatValue} />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit product properties</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <ReadonlyField label="_id" value={product._id} />
            <ReadonlyField label="_creationTime" value={formatDateTime(product._creationTime)} />
            <ReadonlyField label="created_at" value={formatDateTime(product.created_at)} />
            <ReadonlyField label="updated_at" value={formatDateTime(product.updated_at)} />
            <ReadonlyField label="rating_average" value={String(product.rating_average)} />
            <ReadonlyField label="rating_count" value={product.rating_count.toLocaleString()} />

            <div className="sm:col-span-2">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Slug</Label>
              <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
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
                  {categories.map((category) => (
                    <SelectItem key={category._id} value={category._id}>
                      {category.icon_emoji} {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Brand</Label>
              <Select value={form.brand_id || "none"} onValueChange={(v) => setForm({ ...form, brand_id: v === "none" ? "" : v })}>
                <SelectTrigger>
                  <SelectValue placeholder="No brand" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No brand</SelectItem>
                  {brands.map((brand) => (
                    <SelectItem key={brand._id} value={brand._id}>
                      {brand.name}
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
                  {["draft", "active", "hidden", "discontinued"].map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <TextInput label="Product SKU" value={form.sku} onChange={(value) => setForm({ ...form, sku: value })} />
            <TextInput label="Brand label" value={form.brand} onChange={(value) => setForm({ ...form, brand: value })} />
            <TextInput label="Tag" value={form.tag} onChange={(value) => setForm({ ...form, tag: value })} />
            <TextInput label="Pack type" value={form.pack_type} onChange={(value) => setForm({ ...form, pack_type: value })} />
            <TextInput label="Shelf life" value={form.shelf_life} onChange={(value) => setForm({ ...form, shelf_life: value })} />
            <TextInput label="Flavour" value={form.flavour} onChange={(value) => setForm({ ...form, flavour: value })} />
            <TextInput label="Finish" value={form.finish} onChange={(value) => setForm({ ...form, finish: value })} />
            <TextInput label="Colour family" value={form.colour_family} onChange={(value) => setForm({ ...form, colour_family: value })} />
            <TextInput label="Badge text" value={form.badge_text} onChange={(value) => setForm({ ...form, badge_text: value })} />
            <TextInput label="Icon emoji" value={form.icon_emoji} onChange={(value) => setForm({ ...form, icon_emoji: value })} />
            <TextInput label="Image color" value={form.image_color} onChange={(value) => setForm({ ...form, image_color: value })} />
            <TextInput label="Packaging type" value={form.packagingType} onChange={(value) => setForm({ ...form, packagingType: value })} />
            <NumberInput label="Base price" value={form.basePrice} step="0.01" onChange={(value) => setForm({ ...form, basePrice: value })} />
            <NumberInput label="Weight (kg)" value={form.weightKg} step="0.01" onChange={(value) => setForm({ ...form, weightKg: value })} />
            <NumberInput label="Volume (L)" value={form.volumeL} step="0.01" onChange={(value) => setForm({ ...form, volumeL: value })} />
            <NumberInput label="Substitute priority" value={form.substitutePriority} onChange={(value) => setForm({ ...form, substitutePriority: value })} />
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
            <div className="sm:col-span-2">
              <Label>Description</Label>
              <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Search keywords</Label>
              <Input value={form.searchKeywords} onChange={(e) => setForm({ ...form, searchKeywords: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Images</Label>
              <Input value={form.images} onChange={(e) => setForm({ ...form, images: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Substitute SKUs</Label>
              <Input value={form.substituteSkuIds} onChange={(e) => setForm({ ...form, substituteSkuIds: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label>Attributes</Label>
              <Textarea rows={3} placeholder="key | Label | Value" value={form.attributes} onChange={(e) => setForm({ ...form, attributes: e.target.value })} />
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
              {saving ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InfoGrid({
  items,
  formatValue,
}: {
  items: readonly (readonly [string, ReactNode])[];
  formatValue: (value: ReactNode) => ReactNode;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0 rounded-md border bg-card px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 break-words text-sm text-foreground">{formatValue(value)}</p>
        </div>
      ))}
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input value={value} readOnly className="bg-muted" />
    </div>
  );
}

function TextInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function NumberInput({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: string;
  step?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        min="0"
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
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

function ProductInventory({
  skus,
  stores,
}: {
  skus: SkuRow[];
  stores: StoreDoc[];
}) {
  const adjust = useMutation(api.inventory.adjust);
  const upsert = useMutation(api.inventory.upsert);
  const setThreshold = useMutation(api.inventory.setThreshold);
  const setUnavailable = useMutation(api.inventory.setUnavailable);

  const inventoryFor = (sku: SkuRow, storeId: string) =>
    sku.inventory.find((row) => row.store_id === storeId);

  const stockSummary = skus.reduce(
    (sum, sku) =>
      sum +
      sku.inventory.reduce(
        (skuSum, row) => skuSum + (row.quantity_available ?? 0),
        0,
      ),
    0,
  );

  const saveQuantity = (
    sku: SkuRow,
    store: StoreDoc,
    row: InventoryCell | undefined,
    quantity: number,
  ) =>
    runMutation(
      () =>
        upsert({
          sku_id: sku._id,
          store_id: store._id,
          quantity_available: quantity,
          low_stock_threshold: row?.low_stock_threshold ?? 5,
          restock_at: row?.restock_at,
          unavailable: row?.status === "unavailable",
        }),
      row ? "Quantity updated" : "Stock row created",
    );

  const saveThreshold = (
    sku: SkuRow,
    store: StoreDoc,
    row: InventoryCell | undefined,
    threshold: number,
  ) =>
    row
      ? runMutation(
          () =>
            setThreshold({
              sku_id: sku._id,
              store_id: store._id,
              low_stock_threshold: threshold,
            }),
          "Threshold updated",
        )
      : runMutation(
          () =>
            upsert({
              sku_id: sku._id,
              store_id: store._id,
              quantity_available: 0,
              low_stock_threshold: threshold,
            }),
          "Stock row created",
        );

  const saveRestockAt = (
    sku: SkuRow,
    store: StoreDoc,
    row: InventoryCell | undefined,
    restockAt?: number,
  ) =>
    runMutation(
      () =>
        upsert({
          sku_id: sku._id,
          store_id: store._id,
          quantity_available: row?.quantity_available ?? 0,
          low_stock_threshold: row?.low_stock_threshold ?? 5,
          restock_at: restockAt,
          unavailable: row?.status === "unavailable",
        }),
      row ? "Restock ETA updated" : "Stock row created",
    );

  const changeQuantity = (
    sku: SkuRow,
    store: StoreDoc,
    row: InventoryCell | undefined,
    delta: number,
  ) => {
    if (row) {
      return runMutation(() =>
        adjust({
          sku_id: sku._id,
          store_id: store._id,
          delta,
        }),
      );
    }
    return saveQuantity(sku, store, row, Math.max(0, delta));
  };

  const toggleUnavailable = (
    sku: SkuRow,
    store: StoreDoc,
    row: InventoryCell | undefined,
  ) =>
    row
      ? runMutation(() =>
          setUnavailable({
            sku_id: sku._id,
            store_id: store._id,
            unavailable: row.status !== "unavailable",
          }),
        )
      : runMutation(
          () =>
            upsert({
              sku_id: sku._id,
              store_id: store._id,
              quantity_available: 0,
              low_stock_threshold: 5,
              unavailable: true,
            }),
          "Stock row created",
        );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Inventory by store</CardTitle>
        <div className="text-xs text-muted-foreground">
          {stockSummary.toLocaleString()} total available
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {skus.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Add a SKU before tracking inventory.
          </div>
        ) : stores.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Create a store before tracking inventory.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead className="text-center">Available</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Threshold</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Restock ETA</TableHead>
                  <TableHead className="text-center">Unavailable</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skus.flatMap((sku) =>
                  stores.map((store) => {
                    const row = inventoryFor(sku, store._id);
                    const quantity = row?.quantity_available ?? 0;
                    const threshold = row?.low_stock_threshold ?? 5;
                    const status = row?.status ?? "out_of_stock";
                    return (
                      <TableRow key={`${sku._id}-${store._id}`}>
                        <TableCell>
                          <p className="text-sm font-medium">{sku.variant_label}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {sku.sku_code}
                          </p>
                        </TableCell>
                        <TableCell>
                          <p className="text-sm">{store.name}</p>
                          {store.status !== "active" && (
                            <p className="text-xs text-muted-foreground">{store.status}</p>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-7 w-7"
                              disabled={quantity <= 0}
                              onClick={() => changeQuantity(sku, store, row, -1)}
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                            <InlineNumber
                              value={quantity}
                              onCommit={(value) => saveQuantity(sku, store, row, value)}
                            />
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => changeQuantity(sku, store, row, 1)}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="numbers text-right">
                          {row?.quantity_reserved ?? 0}
                        </TableCell>
                        <TableCell className="numbers text-right">
                          <InlineNumber
                            value={threshold}
                            small
                            onCommit={(value) => saveThreshold(sku, store, row, value)}
                          />
                        </TableCell>
                        <TableCell>
                          <StatusBadge value={status} />
                        </TableCell>
                        <TableCell>
                          <InlineRestockDate
                            value={row?.restock_at}
                            onCommit={(value) => saveRestockAt(sku, store, row, value)}
                          />
                        </TableCell>
                        <TableCell className="text-center">
                          <Button
                            variant={status === "unavailable" ? "default" : "outline"}
                            size="sm"
                            onClick={() => toggleUnavailable(sku, store, row)}
                          >
                            {status === "unavailable" ? "Re-enable" : "Disable"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  }),
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InlineNumber({
  value,
  onCommit,
  small,
}: {
  value: number;
  onCommit: (value: number) => void;
  small?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  if (!editing) {
    return (
      <button
        type="button"
        className={`rounded px-2 py-0.5 font-semibold hover:bg-muted ${
          small ? "text-sm font-normal" : "min-w-10 text-center"
        }`}
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
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = Number(draft);
        if (Number.isFinite(next) && next >= 0 && next !== value) {
          onCommit(Math.floor(next));
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") setEditing(false);
      }}
    />
  );
}

function InlineRestockDate({
  value,
  onCommit,
}: {
  value?: number;
  onCommit: (value?: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ? toLocalInput(value) : "");

  if (!editing) {
    return (
      <button
        type="button"
        className="rounded px-2 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted"
        onClick={() => {
          setDraft(value ? toLocalInput(value) : "");
          setEditing(true);
        }}
      >
        {value ? formatDateTime(value) : "Set ETA"}
      </button>
    );
  }

  return (
    <Input
      autoFocus
      type="datetime-local"
      className="h-8 w-44"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = draft ? fromLocalInput(draft) : undefined;
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") setEditing(false);
      }}
    />
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
  const [form, setForm] = useState(() => ({
    store_id: "base",
    sale_price: "",
    compare_at_price: "",
    starts_at: toLocalInput(Date.now()),
    ends_at: "",
  }));

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
