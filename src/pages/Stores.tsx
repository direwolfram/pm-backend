import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { MapPin, Pencil, Plus, Trash2 } from "lucide-react";
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
import type { DeliveryZoneDoc, StoreDoc } from "../../convex/model";

type StoreRow = StoreDoc & { zone_count: number };

const EMPTY_STORE = { name: "", address: "", latitude: "", longitude: "", status: "active" };
const EMPTY_ZONE = {
  name: "",
  delivery_mode: "express",
  min_order_amount: "0",
  delivery_fee_amount: "0",
  estimated_minutes_min: "15",
  estimated_minutes_max: "30",
  is_active: true,
};

export default function Stores() {
  const result = useQuery(api.stores.list, { includeInactive: true, limit: 100 }) as
    | { data: StoreRow[] }
    | undefined;
  const create = useMutation(api.stores.create);
  const update = useMutation(api.stores.update);
  const remove = useMutation(api.stores.remove);

  const [storeDialog, setStoreDialog] = useState(false);
  const [editingStore, setEditingStore] = useState<StoreRow | null>(null);
  const [storeForm, setStoreForm] = useState(EMPTY_STORE);
  const [zonesStore, setZonesStore] = useState<StoreRow | null>(null);

  const saveStore = async () => {
    const payload = {
      name: storeForm.name.trim(),
      address: storeForm.address.trim(),
      latitude: Number(storeForm.latitude),
      longitude: Number(storeForm.longitude),
      status: storeForm.status,
    };
    if (!Number.isFinite(payload.latitude) || !Number.isFinite(payload.longitude)) return;
    const ok = editingStore
      ? await runMutation(() => update({ id: editingStore._id, ...payload }), "Store updated")
      : await runMutation(() => create(payload), "Store created");
    if (ok) setStoreDialog(false);
  };

  const rows = result?.data;

  return (
    <div>
      <PageHeader
        title="Stores & delivery zones"
        description="Dark stores that fulfil orders, with their delivery modes, fees and ETAs."
        actions={
          <Button
            onClick={() => {
              setEditingStore(null);
              setStoreForm(EMPTY_STORE);
              setStoreDialog(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> New store
          </Button>
        }
      />
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No stores yet" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((s) => (
            <Card key={s._id}>
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <CardTitle className="text-base">{s.name}</CardTitle>
                  <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                    <MapPin className="h-3.5 w-3.5" /> {s.address}
                  </p>
                </div>
                <StatusBadge value={s.status} />
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {s.zone_count} delivery zones · {s.latitude.toFixed(4)}, {s.longitude.toFixed(4)} · {s.timezone}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setZonesStore(s)}>
                    Manage zones
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingStore(s);
                      setStoreForm({
                        name: s.name,
                        address: s.address,
                        latitude: String(s.latitude),
                        longitude: String(s.longitude),
                        status: s.status,
                      });
                      setStoreDialog(true);
                    }}
                  >
                    <Pencil className="mr-1 h-4 w-4" /> Edit
                  </Button>
                  <ConfirmButton
                    trigger={
                      <Button size="sm" variant="ghost">
                        <Trash2 className="mr-1 h-4 w-4 text-destructive" /> Delete
                      </Button>
                    }
                    title={`Delete "${s.name}"?`}
                    description="Deletes its zones, prices and inventory rows. Stores with orders can't be deleted."
                    onConfirm={() => runMutation(() => remove({ id: s._id }), "Store deleted")}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={storeDialog} onOpenChange={setStoreDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingStore ? "Edit store" : "New store"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name *</Label>
              <Input value={storeForm.name} onChange={(e) => setStoreForm({ ...storeForm, name: e.target.value })} />
            </div>
            <div>
              <Label>Address *</Label>
              <Input value={storeForm.address} onChange={(e) => setStoreForm({ ...storeForm, address: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Latitude *</Label>
                <Input type="number" step="0.0000001" value={storeForm.latitude} onChange={(e) => setStoreForm({ ...storeForm, latitude: e.target.value })} />
              </div>
              <div>
                <Label>Longitude *</Label>
                <Input type="number" step="0.0000001" value={storeForm.longitude} onChange={(e) => setStoreForm({ ...storeForm, longitude: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={storeForm.status} onValueChange={(v) => setStoreForm({ ...storeForm, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">active</SelectItem>
                  <SelectItem value="inactive">inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStoreDialog(false)}>Cancel</Button>
            <Button onClick={saveStore} disabled={!storeForm.name.trim() || !storeForm.address.trim() || !storeForm.latitude || !storeForm.longitude}>
              {editingStore ? "Save changes" : "Create store"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {zonesStore && <ZonesDialog store={zonesStore} onClose={() => setZonesStore(null)} />}
    </div>
  );
}

function ZonesDialog({ store, onClose }: { store: StoreRow; onClose: () => void }) {
  const detail = useQuery(api.stores.get, { id: store._id }) as
    | (StoreDoc & { zones: DeliveryZoneDoc[] })
    | undefined;
  const createZone = useMutation(api.stores.createZone);
  const updateZone = useMutation(api.stores.updateZone);
  const removeZone = useMutation(api.stores.removeZone);
  const [form, setForm] = useState(EMPTY_ZONE);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Delivery zones — {store.name}</DialogTitle>
        </DialogHeader>
        {!detail ? (
          <Loading />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Zone</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead className="text-right">Min order</TableHead>
                  <TableHead className="text-right">Fee</TableHead>
                  <TableHead className="text-right">ETA</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.zones.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                      No zones yet — add one below.
                    </TableCell>
                  </TableRow>
                )}
                {detail.zones.map((z) => (
                  <TableRow key={z._id}>
                    <TableCell className="text-sm font-medium">{z.name}</TableCell>
                    <TableCell><StatusBadge value={z.delivery_mode} /></TableCell>
                    <TableCell className="text-right">{formatMoney(z.min_order_amount, z.currency)}</TableCell>
                    <TableCell className="text-right">{formatMoney(z.delivery_fee_amount, z.currency)}</TableCell>
                    <TableCell className="text-right text-sm">{z.estimated_minutes_min}–{z.estimated_minutes_max} min</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={z.is_active}
                        onCheckedChange={(v) => runMutation(() => updateZone({ id: z._id, is_active: v }))}
                      />
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => runMutation(() => removeZone({ id: z._id }))}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-4">
              <div>
                <Label>Zone name *</Label>
                <Input placeholder="Express — within 3 km" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Mode</Label>
                <Select value={form.delivery_mode} onValueChange={(v) => setForm({ ...form, delivery_mode: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["express", "savers", "sari-sari"].map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Min order (PHP)</Label>
                <Input type="number" min="0" value={form.min_order_amount} onChange={(e) => setForm({ ...form, min_order_amount: e.target.value })} />
              </div>
              <div>
                <Label>Delivery fee (PHP)</Label>
                <Input type="number" min="0" value={form.delivery_fee_amount} onChange={(e) => setForm({ ...form, delivery_fee_amount: e.target.value })} />
              </div>
              <div>
                <Label>ETA min (min)</Label>
                <Input type="number" min="0" value={form.estimated_minutes_min} onChange={(e) => setForm({ ...form, estimated_minutes_min: e.target.value })} />
              </div>
              <div>
                <Label>ETA max (min)</Label>
                <Input type="number" min="0" value={form.estimated_minutes_max} onChange={(e) => setForm({ ...form, estimated_minutes_max: e.target.value })} />
              </div>
              <Button
                className="sm:col-span-2"
                disabled={!form.name.trim()}
                onClick={async () => {
                  const ok = await runMutation(
                    () =>
                      createZone({
                        store_id: store._id,
                        name: form.name.trim(),
                        delivery_mode: form.delivery_mode,
                        min_order_amount: Number(form.min_order_amount) || 0,
                        delivery_fee_amount: Number(form.delivery_fee_amount) || 0,
                        estimated_minutes_min: Math.floor(Number(form.estimated_minutes_min) || 0),
                        estimated_minutes_max: Math.floor(Number(form.estimated_minutes_max) || 0),
                      }),
                    "Zone added",
                  );
                  if (ok) setForm(EMPTY_ZONE);
                }}
              >
                Add zone
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
