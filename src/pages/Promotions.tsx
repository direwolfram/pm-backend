import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/convexClient";
import { formatDateTime, formatMoney, fromLocalInput, toLocalInput } from "@/lib/format";
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
  PromotionDoc,
  PromotionTargetDoc,
} from "../../convex/model";

type Row = PromotionDoc & { target_count: number; is_running: boolean };
type Target = {
  product_id?: string;
  sku_id?: string;
  category_id?: string;
  brand_id?: string;
  label: string;
};

const EMPTY = {
  kind: "banner",
  title: "",
  subtitle: "",
  description: "",
  background_color: "",
  discount_type: "none",
  discount_value: "",
  coupon_code: "",
  minimum_order_amount: "",
  max_discount_amount: "",
  starts_at: toLocalInput(Date.now()),
  ends_at: toLocalInput(Date.now() + 7 * 86400000),
  is_active: true,
};

export default function Promotions() {
  const result = useQuery(api.promotions.list, { limit: 200 }) as
    | { data: Row[] }
    | undefined;
  const create = useMutation(api.promotions.create);
  const update = useMutation(api.promotions.update);
  const remove = useMutation(api.promotions.remove);
  const setTargetsMutation = useMutation(api.promotions.setTargets);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [targets, setTargets] = useState<Target[] | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setTargets([]);
    setOpen(true);
  };

  const rows = result?.data;

  return (
    <div>
      <PageHeader
        title="Promotions"
        description="Banners, coupons and product discounts. Windows and targets control what the app shows."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> New promotion
          </Button>
        }
      />
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No promotions yet" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Promotion</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Discount</TableHead>
                <TableHead>Window</TableHead>
                <TableHead className="text-right">Targets</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p._id}>
                  <TableCell>
                    <p className="font-medium">{p.title}</p>
                    {p.coupon_code && (
                      <p className="font-mono text-xs text-muted-foreground">code: {p.coupon_code}</p>
                    )}
                  </TableCell>
                  <TableCell><StatusBadge value={p.kind} /></TableCell>
                  <TableCell className="text-sm">
                    {p.discount_type === "percent"
                      ? `${p.discount_value}% off`
                      : p.discount_type === "fixed"
                        ? `${formatMoney(p.discount_value)} off`
                        : p.discount_type === "free_delivery"
                          ? "free delivery"
                          : "—"}
                    {p.minimum_order_amount ? (
                      <p className="text-xs text-muted-foreground">min {formatMoney(p.minimum_order_amount)}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(p.starts_at)}
                    <br />→ {formatDateTime(p.ends_at)}
                  </TableCell>
                  <TableCell className="text-right">{p.target_count || "—"}</TableCell>
                  <TableCell>
                    <StatusBadge value={p.is_running ? "active" : p.is_active ? "inactive" : "hidden"} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <EditPromotionButton
                        promo={p}
                        onEdit={(f) => {
                          setEditing(p);
                          setForm(f);
                          setTargets(null);
                          setOpen(true);
                        }}
                      />
                      <ConfirmButton
                        trigger={
                          <Button variant="ghost" size="icon">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        }
                        title={`Delete "${p.title}"?`}
                        onConfirm={() => runMutation(() => remove({ id: p._id }), "Promotion deleted")}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {open && (
        <PromotionDialog
          editing={editing}
          form={form}
          setForm={setForm}
          targets={targets}
          setTargets={setTargets}
          onClose={() => setOpen(false)}
          onSave={async () => {
            const payload = {
              kind: form.kind,
              title: form.title.trim(),
              subtitle: form.subtitle || undefined,
              description: form.description || undefined,
              background_color: form.background_color || undefined,
              discount_type: form.discount_type === "none" ? undefined : form.discount_type,
              discount_value: form.discount_value ? Number(form.discount_value) : undefined,
              coupon_code: form.coupon_code || undefined,
              minimum_order_amount: form.minimum_order_amount ? Number(form.minimum_order_amount) : undefined,
              max_discount_amount: form.max_discount_amount ? Number(form.max_discount_amount) : undefined,
              starts_at: fromLocalInput(form.starts_at),
              ends_at: fromLocalInput(form.ends_at),
              is_active: form.is_active,
            };
            const cleanTargets = (targets ?? []).map(({ product_id, sku_id, category_id, brand_id }) => ({
              product_id,
              sku_id,
              category_id,
              brand_id,
            }));
            if (editing) {
              const ok = await runMutation(
                () => update({ id: editing._id, ...payload }),
                "Promotion updated",
              );
              if (ok) {
                if (targets !== null) {
                  await runMutation(
                    () =>
                      setTargetsMutation({
                        promotion_id: editing._id,
                        targets: cleanTargets,
                      }),
                    "Targets updated",
                  );
                }
                setOpen(false);
              }
              return;
            }
            const ok = await runMutation(
              () => create({ ...payload, targets: cleanTargets }),
              "Promotion created",
            );
            if (ok) setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** Loads a promotion's targets when the edit icon is clicked. */
function EditPromotionButton({
  promo,
  onEdit,
}: {
  promo: Row;
  onEdit: (form: typeof EMPTY) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() =>
        onEdit(
          {
            kind: promo.kind,
            title: promo.title,
            subtitle: promo.subtitle ?? "",
            description: promo.description ?? "",
            background_color: promo.background_color ?? "",
            discount_type: promo.discount_type ?? "none",
            discount_value: promo.discount_value?.toString() ?? "",
            coupon_code: promo.coupon_code ?? "",
            minimum_order_amount: promo.minimum_order_amount?.toString() ?? "",
            max_discount_amount: promo.max_discount_amount?.toString() ?? "",
            starts_at: toLocalInput(promo.starts_at),
            ends_at: toLocalInput(promo.ends_at),
            is_active: promo.is_active,
          },
        )
      }
    >
      <Pencil className="h-4 w-4" />
    </Button>
  );
}

function PromotionDialog({
  editing,
  form,
  setForm,
  targets,
  setTargets,
  onClose,
  onSave,
}: {
  editing: Row | null;
  form: typeof EMPTY;
  setForm: (f: typeof EMPTY) => void;
  targets: Target[] | null;
  setTargets: (t: Target[] | null) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const products =
    (useQuery(api.products.listV2, { limit: 200 }) as
      | { data: { _id: string; name: string }[] }
      | undefined)?.data ?? [];
  const categories =
    (useQuery(api.categories.list, { limit: 200 }) as
      | { data: CategoryDoc[] }
      | undefined)?.data ?? [];
  const brands =
    (useQuery(api.brands.list, { includeInactive: true, limit: 200 }) as
      | { data: BrandDoc[] }
      | undefined)?.data ?? [];
  const existingTargets = useQuery(
    api.promotions.get,
    editing ? { id: editing._id } : "skip",
  ) as (PromotionDoc & { targets: PromotionTargetDoc[] }) | undefined;

  const [targetType, setTargetType] = useState("product");
  const [targetId, setTargetId] = useState("");

  const effectiveTargets: Target[] =
    targets === null && editing && existingTargets
      ? existingTargets.targets.map((t) => ({
          product_id: t.product_id,
          sku_id: t.sku_id,
          category_id: t.category_id,
          brand_id: t.brand_id,
          label: t.product_id
            ? `Product: ${products.find((p) => p._id === t.product_id)?.name ?? t.product_id}`
            : t.category_id
              ? `Category: ${categories.find((c) => c._id === t.category_id)?.name ?? t.category_id}`
              : t.brand_id
                ? `Brand: ${brands.find((b) => b._id === t.brand_id)?.name ?? t.brand_id}`
                : `SKU: ${t.sku_id}`,
        }))
      : (targets ?? []);

  const setAll = (t: Target[]) => setTargets(t);

  const options =
    targetType === "product"
      ? products.map((p) => ({ id: p._id, label: p.name }))
      : targetType === "category"
        ? categories.map((c) => ({ id: c._id, label: c.name }))
        : brands.map((b) => ({ id: b._id, label: b.name }));

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit promotion" : "New promotion"}</DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1 sm:grid-cols-2">
          <div>
            <Label>Kind</Label>
            <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["banner", "carousel", "coupon", "product_discount"].map((k) => (
                  <SelectItem key={k} value={k}>{k.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Title *</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div>
            <Label>Subtitle</Label>
            <Input value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} />
          </div>
          <div>
            <Label>Background color</Label>
            <Input placeholder="#B71C1C" value={form.background_color} onChange={(e) => setForm({ ...form, background_color: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <Label>Description</Label>
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <Label>Discount type</Label>
            <Select value={form.discount_type} onValueChange={(v) => setForm({ ...form, discount_type: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (display only)</SelectItem>
                <SelectItem value="percent">Percent</SelectItem>
                <SelectItem value="fixed">Fixed amount</SelectItem>
                <SelectItem value="free_delivery">Free delivery</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Discount value</Label>
            <Input type="number" min="0" placeholder={form.discount_type === "percent" ? "15" : "50"} value={form.discount_value} onChange={(e) => setForm({ ...form, discount_value: e.target.value })} />
          </div>
          <div>
            <Label>Coupon code</Label>
            <Input placeholder="POCKET50" value={form.coupon_code} onChange={(e) => setForm({ ...form, coupon_code: e.target.value.toUpperCase() })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Min order</Label>
              <Input type="number" min="0" value={form.minimum_order_amount} onChange={(e) => setForm({ ...form, minimum_order_amount: e.target.value })} />
            </div>
            <div>
              <Label>Max discount</Label>
              <Input type="number" min="0" value={form.max_discount_amount} onChange={(e) => setForm({ ...form, max_discount_amount: e.target.value })} />
            </div>
          </div>
          <div>
            <Label>Starts</Label>
            <Input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
          </div>
          <div>
            <Label>Ends</Label>
            <Input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
              Active
            </label>
          </div>

          <div className="sm:col-span-2">
            <Label>Targets (optional)</Label>
            <div className="mt-1 flex gap-2">
              <Select value={targetType} onValueChange={(v) => { setTargetType(v); setTargetId(""); }}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="product">Product</SelectItem>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="brand">Brand</SelectItem>
                </SelectContent>
              </Select>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Pick…" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={!targetId}
                onClick={() => {
                  const opt = options.find((o) => o.id === targetId);
                  if (!opt) return;
                  const key = `${targetType}_id` as "product_id" | "category_id" | "brand_id";
                  if (effectiveTargets.some((t) => t[key] === opt.id)) return;
                  setAll([...effectiveTargets, { [key]: opt.id, label: `${targetType[0].toUpperCase() + targetType.slice(1)}: ${opt.label}` }]);
                  setTargetId("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {effectiveTargets.map((t, i) => (
                <span key={i} className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs">
                  {t.label}
                  <button onClick={() => setAll(effectiveTargets.filter((_, j) => j !== i))}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} disabled={!form.title.trim()}>
            {editing ? "Save changes" : "Create promotion"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
