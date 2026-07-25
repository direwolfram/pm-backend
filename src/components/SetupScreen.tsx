import { ShoppingCart, KeyRound, Globe, Rocket } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Shown when VITE_CONVEX_URL isn't configured (i.e. the backend hasn't been
 * connected to a real Convex deployment yet). Everything else in the app is
 * ready — this screen explains the 3-step activation.
 */
export default function SetupScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-sky-50 p-6">
      <Card className="w-full max-w-2xl shadow-lg">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600 text-white">
              <ShoppingCart className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-xl">PocketMart Admin Backoffice</CardTitle>
              <p className="text-sm text-muted-foreground">
                Quick-commerce control panel — backend ready, one step to go live
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The full backend (30 tables: catalog, SKUs, pricing, per-store
            inventory, promotions, home feed, orders, customers) and this admin
            UI are built and waiting for your Convex deployment. Activation:
          </p>
          {[
            {
              icon: Globe,
              title: "1 · Create a Convex project",
              body: "Go to dashboard.convex.dev → New Project (free). Open Settings → Deploy Keys and generate a deploy key.",
            },
            {
              icon: KeyRound,
              title: "2 · Share the credentials",
              body: "Paste the deployment URL (https://….convex.cloud) and the deploy key back in the chat. Nothing else needed.",
            },
            {
              icon: Rocket,
              title: "3 · Go live",
              body: "The backend functions deploy, the sample grocery catalog seeds itself, and this panel becomes fully interactive — inventory, pricing, promos, orders.",
            },
          ].map((s) => (
            <div key={s.title} className="flex gap-3 rounded-lg border bg-white p-3">
              <s.icon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-sm text-muted-foreground">{s.body}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
