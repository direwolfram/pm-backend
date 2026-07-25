import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/convexClient";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  CategoryDoc,
  HomeSectionDoc,
  PromotionDoc,
} from "../../convex/model";

type SectionItem = {
  _id: string;
  product_id?: string;
  category_id?: string;
  promotion_id?: string;
  sort_order: number;
  label: string;
  item_type: string;
};
type SectionRow = HomeSectionDoc & { items: SectionItem[] };

const KIND_LABEL: Record<string, string> = {
  product_carousel: "Product carousel",
  category_grid: "Category grid",
  bestseller_grid: "Bestseller grid",
  promo_banner: "Promo banner",
  shopping_list_card: "Shopping list card",
};

export default function HomeSections() {
  const sections = useQuery(api.homeSections.list, {}) as SectionRow[] | undefined;
  const create = useMutation(api.homeSections.create);
  const update = useMutation(api.homeSections.update);
  const remove = useMutation(api.homeSections.remove);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SectionRow | null>(null);
  const [form, setForm] = useState({ title: "", kind: "product_carousel", tab: "All", sort_order: 0, is_active: true });
  const [itemsSection, setItemsSection] = useState<SectionRow | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm({ title: "", kind: "product_carousel", tab: "All", sort_order: (sections?.length ?? 0), is_active: true });
    setOpen(true);
  };
  const openEdit = (s: SectionRow) => {
    setEditing(s);
    setForm({ title: s.title, kind: s.kind, tab: s.tab, sort_order: s.sort_order, is_active: s.is_active });
    setOpen(true);
  };
  const save = async () => {
    const ok = editing
      ? await runMutation(() => update({ id: editing._id, ...form, sort_order: Number(form.sort_order) || 0 }), "Section updated")
      : await runMutation(() => create({ ...form, sort_order: Number(form.sort_order) || 0 }), "Section created");
    if (ok) setOpen(false);
  };

  const tabs = Array.from(new Set((sections ?? []).map((s) => s.tab)));

  return (
    <div>
      <PageHeader
        title="Home sections"
        description="Controls what appears on the app's home screen — no app release needed."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> New section
          </Button>
        }
      />
      {!sections ? (
        <Loading />
      ) : sections.length === 0 ? (
        <EmptyState title="No home sections yet" />
      ) : (
        tabs.map((tab) => (
          <div key={tab} className="mb-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Tab: {tab}
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              {sections
                .filter((s) => s.tab === tab)
                .map((s) => (
                  <Card key={s._id} className={s.is_active ? "" : "opacity-60"}>
                    <CardHeader className="flex flex-row items-start justify-between pb-2">
                      <div>
                        <CardTitle className="text-base">
                          <span className="mr-2 text-xs text-muted-foreground">#{s.sort_order}</span>
                          {s.title}
                        </CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground">{KIND_LABEL[s.kind] ?? s.kind}</p>
                      </div>
                      <StatusBadge value={s.is_active ? "active" : "inactive"} />
                    </CardHeader>
                    <CardContent>
                      <div className="mb-3 flex flex-wrap gap-1">
                        {s.items.length === 0 && (
                          <span className="text-xs text-muted-foreground">No items</span>
                        )}
                        {s.items.slice(0, 8).map((i) => (
                          <span key={i._id} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                            {i.label}
                          </span>
                        ))}
                        {s.items.length > 8 && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                            +{s.items.length - 8} more
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setItemsSection(s)}>
                          Edit items
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(s)}>
                          <Pencil className="mr-1 h-4 w-4" /> Edit
                        </Button>
                        <ConfirmButton
                          trigger={
                            <Button size="sm" variant="ghost">
                              <Trash2 className="mr-1 h-4 w-4 text-destructive" /> Delete
                            </Button>
                          }
                          title={`Delete section "${s.title}"?`}
                          onConfirm={() => runMutation(() => remove({ id: s._id }), "Section deleted")}
                        />
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </div>
        ))
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit section" : "New section"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>Title *</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <Label>Kind</Label>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(KIND_LABEL).map(([k, l]) => (
                    <SelectItem key={k} value={k}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tab</Label>
              <Input placeholder="All" value={form.tab} onChange={(e) => setForm({ ...form, tab: e.target.value })} />
            </div>
            <div>
              <Label>Sort order</Label>
              <Input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
                Active
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={!form.title.trim()}>
              {editing ? "Save changes" : "Create section"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {itemsSection && (
        <ItemsDialog section={itemsSection} onClose={() => setItemsSection(null)} />
      )}
    </div>
  );
}

function ItemsDialog({ section, onClose }: { section: SectionRow; onClose: () => void }) {
  const setItemsMutation = useMutation(api.homeSections.setItems);
  const products =
    (useQuery(api.products.list, { limit: 200 }) as
      | { data: { _id: string; name: string }[] }
      | undefined)?.data ?? [];
  const categories =
    (useQuery(api.categories.list, { limit: 200 }) as
      | { data: CategoryDoc[] }
      | undefined)?.data ?? [];
  const promotions =
    (useQuery(api.promotions.list, { limit: 100 }) as
      | { data: PromotionDoc[] }
      | undefined)?.data ?? [];

  const [itemType, setItemType] = useState(
    section.kind === "category_grid" ? "category" : section.kind === "promo_banner" ? "promotion" : "product",
  );
  const [itemId, setItemId] = useState("");
  const [items, setItems] = useState(
    section.items.map((i) => ({
      product_id: i.product_id,
      category_id: i.category_id,
      promotion_id: i.promotion_id,
      sort_order: i.sort_order,
      label: i.label,
    })),
  );

  const options =
    itemType === "product"
      ? products.map((p) => ({ id: p._id, label: p.name }))
      : itemType === "category"
        ? categories.map((c) => ({ id: c._id, label: c.name }))
        : promotions.map((p) => ({ id: p._id, label: p.title }));

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Items — {section.title}</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Select value={itemType} onValueChange={(v) => { setItemType(v); setItemId(""); }}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="product">Product</SelectItem>
              <SelectItem value="category">Category</SelectItem>
              <SelectItem value="promotion">Promotion</SelectItem>
            </SelectContent>
          </Select>
          <Select value={itemId} onValueChange={setItemId}>
            <SelectTrigger className="flex-1"><SelectValue placeholder="Pick…" /></SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={!itemId}
            onClick={() => {
              const opt = options.find((o) => o.id === itemId);
              if (!opt) return;
              const key = `${itemType}_id` as "product_id" | "category_id" | "promotion_id";
              if (items.some((i) => i[key] === opt.id)) return;
              const newItem = {
                product_id: undefined as string | undefined,
                category_id: undefined as string | undefined,
                promotion_id: undefined as string | undefined,
                sort_order: items.length,
                label: opt.label,
              };
              newItem[key] = opt.id;
              setItems([...items, newItem]);
              setItemId("");
            }}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-2 space-y-1">
          {items.map((i, idx) => (
            <div key={idx} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
              <span className="w-6 text-xs text-muted-foreground">#{idx}</span>
              <span className="flex-1">{i.label}</span>
              <button onClick={() => setItems(items.filter((_, j) => j !== idx))}>
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          ))}
          {items.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No items yet.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={async () => {
              const ok = await runMutation(
                () =>
                  setItemsMutation({
                    section_id: section._id,
                    items: items.map((i, idx) => ({
                      product_id: i.product_id,
                      category_id: i.category_id,
                      promotion_id: i.promotion_id,
                      sort_order: idx,
                    })),
                  }),
                "Items saved",
              );
              if (ok) onClose();
            }}
          >
            Save items
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
