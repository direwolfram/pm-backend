import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Pencil, Plus, Trash2 } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CategoryDoc } from "../../convex/model";

type Row = CategoryDoc & { parent_name?: string; product_count: number };

const EMPTY = {
  name: "",
  slug: "",
  parent_id: "none",
  section_name: "",
  icon_emoji: "",
  background_color: "",
  sort_order: 0,
  is_active: true,
};

export default function Categories() {
  const result = useQuery(api.categories.list, { includeInactive: true, limit: 300 }) as
    | { data: Row[] }
    | undefined;
  const create = useMutation(api.categories.create);
  const update = useMutation(api.categories.update);
  const remove = useMutation(api.categories.remove);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState(EMPTY);

  const rows = result?.data;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  };
  const openEdit = (c: Row) => {
    setEditing(c);
    setForm({
      name: c.name,
      slug: c.slug,
      parent_id: c.parent_id ?? "none",
      section_name: c.section_name ?? "",
      icon_emoji: c.icon_emoji ?? "",
      background_color: c.background_color ?? "",
      sort_order: c.sort_order,
      is_active: c.is_active,
    });
    setOpen(true);
  };
  const save = async () => {
    const payload = {
      name: form.name.trim(),
      slug: form.slug.trim() || undefined,
      parent_id: form.parent_id === "none" ? undefined : form.parent_id,
      section_name: form.section_name || undefined,
      icon_emoji: form.icon_emoji || undefined,
      background_color: form.background_color || undefined,
      sort_order: Number(form.sort_order) || 0,
      is_active: form.is_active,
    };
    const ok = editing
      ? await runMutation(() => update({ id: editing._id, ...payload }), "Category updated")
      : await runMutation(() => create(payload), "Category created");
    if (ok) setOpen(false);
  };

  return (
    <div>
      <PageHeader
        title="Categories"
        description="Top-level sections and subcategories used for browsing and the home grid."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> New category
          </Button>
        }
      />
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No categories yet" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Parent</TableHead>
                <TableHead>Section</TableHead>
                <TableHead className="text-right">Sort</TableHead>
                <TableHead className="text-right">Products</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c._id}>
                  <TableCell>
                    <span
                      className="mr-2 inline-flex h-7 w-7 items-center justify-center rounded-md align-middle"
                      style={{ backgroundColor: c.background_color ?? "#eee" }}
                    >
                      {c.icon_emoji ?? "🗂️"}
                    </span>
                    <span className="font-medium">{c.name}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.slug}</TableCell>
                  <TableCell className="text-sm">{c.parent_name ?? "—"}</TableCell>
                  <TableCell className="text-sm">{c.section_name ?? "—"}</TableCell>
                  <TableCell className="text-right">{c.sort_order}</TableCell>
                  <TableCell className="text-right">{c.product_count}</TableCell>
                  <TableCell className="text-center">
                    <StatusBadge value={c.is_active ? "active" : "inactive"} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(c)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <ConfirmButton
                        trigger={
                          <Button variant="ghost" size="icon">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        }
                        title={`Delete "${c.name}"?`}
                        description="Children are re-parented to top level. Categories with products can't be deleted."
                        onConfirm={() => runMutation(() => remove({ id: c._id }), "Category deleted")}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit category" : "New category"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label>Slug (auto if empty)</Label>
              <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            </div>
            <div>
              <Label>Parent</Label>
              <Select value={form.parent_id} onValueChange={(v) => setForm({ ...form, parent_id: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Top level</SelectItem>
                  {(rows ?? [])
                    .filter((c) => c._id !== editing?._id)
                    .map((c) => (
                      <SelectItem key={c._id} value={c._id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Section name</Label>
              <Input placeholder="Food & Drinks…" value={form.section_name} onChange={(e) => setForm({ ...form, section_name: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Label>Emoji</Label>
                <Input value={form.icon_emoji} onChange={(e) => setForm({ ...form, icon_emoji: e.target.value })} />
              </div>
              <div className="flex-1">
                <Label>Color</Label>
                <Input placeholder="#E3F2FD" value={form.background_color} onChange={(e) => setForm({ ...form, background_color: e.target.value })} />
              </div>
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
            <Button onClick={save} disabled={!form.name.trim()}>
              {editing ? "Save changes" : "Create category"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
