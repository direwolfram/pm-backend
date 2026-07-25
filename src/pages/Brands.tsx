import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BrandDoc } from "../../convex/model";

type Row = BrandDoc & { product_count: number };

export default function Brands() {
  const [search, setSearch] = useState("");
  const result = useQuery(api.brands.list, {
    search: search || undefined,
    includeInactive: true,
    limit: 300,
  }) as { data: Row[] } | undefined;
  const create = useMutation(api.brands.create);
  const update = useMutation(api.brands.update);
  const remove = useMutation(api.brands.remove);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState({ name: "", logo_color: "", is_active: true });

  const rows = result?.data;

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", logo_color: "", is_active: true });
    setOpen(true);
  };
  const openEdit = (b: Row) => {
    setEditing(b);
    setForm({ name: b.name, logo_color: b.logo_color ?? "", is_active: b.is_active });
    setOpen(true);
  };
  const save = async () => {
    const ok = editing
      ? await runMutation(
          () =>
            update({
              id: editing._id,
              name: form.name.trim(),
              logo_color: form.logo_color || undefined,
              is_active: form.is_active,
            }),
          "Brand updated",
        )
      : await runMutation(
          () =>
            create({
              name: form.name.trim(),
              logo_color: form.logo_color || undefined,
              is_active: form.is_active,
            }),
          "Brand created",
        );
    if (ok) setOpen(false);
  };

  return (
    <div>
      <PageHeader
        title="Brands"
        description="Brand metadata attached to products."
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> New brand
          </Button>
        }
      />
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search brands…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No brands found" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Brand</TableHead>
                <TableHead className="text-right">Products</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b._id}>
                  <TableCell>
                    <span
                      className="mr-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold text-white align-middle"
                      style={{ backgroundColor: b.logo_color ?? "#666" }}
                    >
                      {b.name.slice(0, 1)}
                    </span>
                    <span className="font-medium">{b.name}</span>
                  </TableCell>
                  <TableCell className="text-right">{b.product_count}</TableCell>
                  <TableCell className="text-center">
                    <StatusBadge value={b.is_active ? "active" : "inactive"} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(b)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <ConfirmButton
                        trigger={
                          <Button variant="ghost" size="icon">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        }
                        title={`Delete "${b.name}"?`}
                        description="Products keep existing with no brand (set null), matching the SQL schema."
                        onConfirm={() => runMutation(() => remove({ id: b._id }), "Brand deleted")}
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
            <DialogTitle>{editing ? "Edit brand" : "New brand"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label>Logo color</Label>
              <Input placeholder="#B71C1C" value={form.logo_color} onChange={(e) => setForm({ ...form, logo_color: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
              Active
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={!form.name.trim()}>
              {editing ? "Save changes" : "Create brand"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
