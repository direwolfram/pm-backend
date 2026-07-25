import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import {
  AlertTriangle,
  Package,
  ShoppingCart,
  Users,
  Wallet,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/convexClient";
import { formatMoney, formatDateTime } from "@/lib/format";
import {
  EmptyState,
  Loading,
  PageHeader,
  StatusBadge,
  runMutation,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardStats, OrderListRow } from "../../convex/model";
import { useState } from "react";

type LowStockRow = {
  _id: string;
  product_name: string;
  variant_label: string;
  store_name: string;
  quantity_available: number;
  low_stock_threshold: number;
  status: string;
};

export default function Dashboard() {
  const stats = useQuery(api.dashboard.stats, {}) as DashboardStats | undefined;
  const recent = useQuery(api.dashboard.recentOrders, { limit: 8 }) as
    | OrderListRow[]
    | undefined;
  const lowStock = useQuery(api.dashboard.lowStockAlerts, { limit: 12 }) as
    | LowStockRow[]
    | undefined;
  const seed = useMutation(api.seed.run);
  const [seeding, setSeeding] = useState(false);

  if (!stats || !recent || !lowStock) return <Loading />;

  if (stats.total_products === 0) {
    return (
      <div>
        <PageHeader title="Dashboard" description="Your store is empty — load the sample catalog to explore." />
        <EmptyState
          title="No data yet"
          hint="Seed the database with a sample Philippine grocery catalog: 2 stores, 20 products with SKUs, prices, stock, promotions, home sections, customers and orders. You can edit or delete everything afterwards."
          action={
            <Button
              disabled={seeding}
              onClick={async () => {
                setSeeding(true);
                await runMutation(() => seed({}), "Sample catalog loaded");
                setSeeding(false);
              }}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              {seeding ? "Seeding…" : "Load sample catalog"}
            </Button>
          }
        />
      </div>
    );
  }

  const cards = [
    { label: "Revenue (all time)", value: formatMoney(stats.revenue_total), sub: `${formatMoney(stats.revenue_today)} today`, icon: Wallet },
    { label: "Orders", value: String(stats.total_orders), sub: `${stats.orders_today} today`, icon: ShoppingCart },
    { label: "Products", value: String(stats.total_products), sub: `${stats.active_products} active · ${stats.total_skus} SKUs`, icon: Package },
    { label: "Customers", value: String(stats.total_customers), sub: `${stats.open_tickets} open tickets`, icon: Users },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Store performance at a glance."
        actions={
          stats.active_promotions > 0 ? (
            <StatusBadge value={`${stats.active_promotions} promos running`} />
          ) : undefined
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {c.label}
              </CardTitle>
              <c.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{c.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{c.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent orders</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/orders">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((o) => (
                  <TableRow key={o._id}>
                    <TableCell>
                      <Link to="/orders" className="font-medium hover:underline">
                        {o.order_number}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(o.placed_at)}
                      </p>
                    </TableCell>
                    <TableCell className="text-sm">{o.customer_name}</TableCell>
                    <TableCell>
                      <StatusBadge value={o.status} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatMoney(o.total_amount, o.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Stock alerts
              {(stats.low_stock_count + stats.out_of_stock_count) > 0 && (
                <StatusBadge value={`${stats.low_stock_count} low · ${stats.out_of_stock_count} out`} />
              )}
            </CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/inventory">Manage</Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {lowStock.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                All SKUs are healthy. 🎉
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lowStock.map((r) => (
                    <TableRow key={r._id}>
                      <TableCell>
                        <p className="text-sm font-medium">{r.product_name}</p>
                        <p className="text-xs text-muted-foreground">{r.variant_label}</p>
                      </TableCell>
                      <TableCell className="text-sm">{r.store_name}</TableCell>
                      <TableCell className="text-right font-medium">
                        {r.quantity_available}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={r.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
