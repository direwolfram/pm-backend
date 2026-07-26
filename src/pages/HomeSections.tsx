import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Archive,
  Copy,
  Eye,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { api } from "@/lib/convexClient";
import { formatDateTime, fromLocalInput, toLocalInput } from "@/lib/format";
import {
  ConfirmButton,
  EmptyState,
  Loading,
  PageHeader,
  StatusBadge,
  runMutation,
} from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  HomeSectionDoc,
  HomeSectionKind,
  HomeSectionResponse,
} from "../../convex/model";

type AdminSection = HomeSectionDoc & { preview: HomeSectionResponse };
type ListResult = { data: AdminSection[]; total: number; limit: number; offset: number };

type ConfigFieldType = "string" | "number" | "boolean" | "string[]";
type ConfigField = { key: string; label: string; type: ConfigFieldType };

type FormState = {
  key: string;
  kind: HomeSectionKind;
  title: string;
  subtitle: string;
  tab: string;
  sortOrder: string;
  isActive: boolean;
  allowEmpty: boolean;
  startsAt: string;
  endsAt: string;
  timezone: string;
  visibleDaysOfWeek: number[];
  visibleTimeWindows: string;
  storeIds: string;
  cityIds: string;
  regionIds: string;
  customerSegments: string;
  holidayTags: string;
  seasonalTags: string;
  minAppVersion: string;
  maxAppVersion: string;
  layoutVariant: string;
  backgroundColor: string;
  textColor: string;
  imageUrl: string;
  iconEmoji: string;
  maxItems: string;
  productIds: string;
  categoryIds: string;
  promotionIds: string;
  brandIds: string;
  config: Record<string, unknown>;
};

const KINDS: { value: HomeSectionKind; label: string }[] = [
  { value: "header", label: "Header" },
  { value: "search_bar", label: "Search bar" },
  { value: "category_tabs", label: "Category tabs" },
  { value: "hero_banner", label: "Hero banner" },
  { value: "bestseller_grid", label: "Bestseller grid" },
  { value: "promo_banner", label: "Promo banner" },
  { value: "promo_carousel", label: "Promo carousel" },
  { value: "shopping_list_card", label: "Shopping list card" },
  { value: "category_grid", label: "Category grid" },
  { value: "themed_product_section", label: "Themed products" },
  { value: "product_carousel", label: "Product carousel" },
  { value: "featured_products", label: "Featured products" },
  { value: "store_inventory_section", label: "Store inventory" },
  { value: "custom_cta", label: "Custom CTA" },
  { value: "spacer", label: "Spacer" },
];

const CONFIG_FIELDS: Record<HomeSectionKind, ConfigField[]> = {
  header: [
    { key: "showLocation", label: "Show location", type: "boolean" },
    { key: "showProfile", label: "Show profile", type: "boolean" },
    { key: "showCart", label: "Show cart", type: "boolean" },
    { key: "backgroundImageUrl", label: "Background image URL", type: "string" },
    { key: "variant", label: "Variant", type: "string" },
  ],
  search_bar: [
    { key: "placeholder", label: "Placeholder", type: "string" },
    { key: "showMic", label: "Show mic", type: "boolean" },
    { key: "showScanner", label: "Show scanner", type: "boolean" },
    { key: "stickyOnScroll", label: "Sticky on scroll", type: "boolean" },
    { key: "variant", label: "Variant", type: "string" },
  ],
  category_tabs: [
    { key: "tabs", label: "Tabs", type: "string[]" },
    { key: "defaultTab", label: "Default tab", type: "string" },
    { key: "stickyOnScroll", label: "Sticky on scroll", type: "boolean" },
    { key: "variant", label: "Variant", type: "string" },
  ],
  hero_banner: [
    { key: "title", label: "Title", type: "string" },
    { key: "subtitle", label: "Subtitle", type: "string" },
    { key: "imageUrl", label: "Image URL", type: "string" },
    { key: "ctaLabel", label: "CTA label", type: "string" },
    { key: "ctaRoute", label: "CTA route", type: "string" },
    { key: "variant", label: "Variant", type: "string" },
  ],
  bestseller_grid: [
    { key: "categoryIds", label: "Category IDs", type: "string[]" },
    { key: "columns", label: "Columns", type: "number" },
    { key: "showMoreCount", label: "Show more count", type: "number" },
    { key: "maxItems", label: "Max items", type: "number" },
  ],
  promo_banner: [
    { key: "promotionIds", label: "Promotion IDs", type: "string[]" },
    { key: "title", label: "Title", type: "string" },
    { key: "subtitle", label: "Subtitle", type: "string" },
    { key: "backgroundColor", label: "Background color", type: "string" },
    { key: "ctaLabel", label: "CTA label", type: "string" },
    { key: "ctaRoute", label: "CTA route", type: "string" },
  ],
  promo_carousel: [
    { key: "promotionIds", label: "Promotion IDs", type: "string[]" },
    { key: "autoplay", label: "Autoplay", type: "boolean" },
    { key: "autoplayIntervalMs", label: "Autoplay interval ms", type: "number" },
    { key: "loop", label: "Loop", type: "boolean" },
    { key: "cardVariant", label: "Card variant", type: "string" },
  ],
  shopping_list_card: [
    { key: "title", label: "Title", type: "string" },
    { key: "subtitle", label: "Subtitle", type: "string" },
    { key: "ctaLabel", label: "CTA label", type: "string" },
    { key: "ctaRoute", label: "CTA route", type: "string" },
    { key: "iconName", label: "Icon name", type: "string" },
  ],
  category_grid: [
    { key: "categoryIds", label: "Category IDs", type: "string[]" },
    { key: "columns", label: "Columns", type: "number" },
    { key: "sectionTitle", label: "Section title", type: "string" },
    { key: "showIcons", label: "Show icons", type: "boolean" },
    { key: "maxItems", label: "Max items", type: "number" },
  ],
  themed_product_section: [
    { key: "productIds", label: "Product IDs", type: "string[]" },
    { key: "themeName", label: "Theme name", type: "string" },
    { key: "themeEmoji", label: "Theme emoji", type: "string" },
    { key: "backgroundColor", label: "Background color", type: "string" },
    { key: "titleColor", label: "Title color", type: "string" },
    { key: "maxItems", label: "Max items", type: "number" },
  ],
  product_carousel: [
    { key: "productIds", label: "Product IDs", type: "string[]" },
    { key: "categoryId", label: "Category ID", type: "string" },
    { key: "brandId", label: "Brand ID", type: "string" },
    { key: "title", label: "Title", type: "string" },
    { key: "subtitle", label: "Subtitle", type: "string" },
    { key: "maxItems", label: "Max items", type: "number" },
    { key: "showSeeAll", label: "Show see all", type: "boolean" },
    { key: "seeAllRoute", label: "See all route", type: "string" },
  ],
  featured_products: [
    { key: "productIds", label: "Product IDs", type: "string[]" },
    { key: "title", label: "Title", type: "string" },
    { key: "subtitle", label: "Subtitle", type: "string" },
    { key: "maxItems", label: "Max items", type: "number" },
    { key: "showSeeAll", label: "Show see all", type: "boolean" },
  ],
  store_inventory_section: [
    { key: "storeIds", label: "Store IDs", type: "string[]" },
    { key: "showInventorySummary", label: "Show inventory summary", type: "boolean" },
    { key: "showAvailability", label: "Show availability", type: "boolean" },
    { key: "statusFilter", label: "Status filter", type: "string" },
    { key: "maxItems", label: "Max items", type: "number" },
  ],
  custom_cta: [
    { key: "title", label: "Title", type: "string" },
    { key: "subtitle", label: "Subtitle", type: "string" },
    { key: "ctaLabel", label: "CTA label", type: "string" },
    { key: "ctaRoute", label: "CTA route", type: "string" },
    { key: "imageUrl", label: "Image URL", type: "string" },
    { key: "backgroundColor", label: "Background color", type: "string" },
  ],
  spacer: [{ key: "height", label: "Height", type: "number" }],
};

const EMPTY_FORM: FormState = {
  key: "",
  kind: "product_carousel",
  title: "",
  subtitle: "",
  tab: "All",
  sortOrder: "0",
  isActive: true,
  allowEmpty: false,
  startsAt: "",
  endsAt: "",
  timezone: "Asia/Manila",
  visibleDaysOfWeek: [],
  visibleTimeWindows: "",
  storeIds: "",
  cityIds: "",
  regionIds: "",
  customerSegments: "",
  holidayTags: "",
  seasonalTags: "",
  minAppVersion: "",
  maxAppVersion: "",
  layoutVariant: "",
  backgroundColor: "",
  textColor: "",
  imageUrl: "",
  iconEmoji: "",
  maxItems: "",
  productIds: "",
  categoryIds: "",
  promotionIds: "",
  brandIds: "",
  config: {},
};

function csv(values?: string[]) {
  return values?.join(", ") ?? "";
}

function parseCsv(value: string) {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function parseTimeWindows(value: string) {
  const windows = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [start, end] = line.split("-").map((part) => part.trim());
      return { start, end };
    });
  return windows.length ? windows : undefined;
}

function formatWindows(windows?: { start: string; end: string }[]) {
  return windows?.map((window) => `${window.start}-${window.end}`).join("\n") ?? "";
}

function sectionToForm(section: AdminSection): FormState {
  return {
    ...EMPTY_FORM,
    key: section.key ?? "",
    kind: section.kind,
    title: section.title ?? "",
    subtitle: section.subtitle ?? "",
    tab: section.tab,
    sortOrder: String(section.sortOrder ?? section.sort_order ?? 0),
    isActive: section.isActive ?? section.is_active ?? false,
    allowEmpty: section.allowEmpty ?? false,
    startsAt: section.startsAt ? toLocalInput(section.startsAt) : "",
    endsAt: section.endsAt ? toLocalInput(section.endsAt) : "",
    timezone: section.timezone ?? "Asia/Manila",
    visibleDaysOfWeek: section.visibleDaysOfWeek ?? [],
    visibleTimeWindows: formatWindows(section.visibleTimeWindows),
    storeIds: csv(section.storeIds),
    cityIds: csv(section.cityIds),
    regionIds: csv(section.regionIds),
    customerSegments: csv(section.customerSegments),
    holidayTags: csv(section.holidayTags),
    seasonalTags: csv(section.seasonalTags),
    minAppVersion: section.minAppVersion ?? "",
    maxAppVersion: section.maxAppVersion ?? "",
    layoutVariant: section.layoutVariant ?? "",
    backgroundColor: section.backgroundColor ?? "",
    textColor: section.textColor ?? "",
    imageUrl: section.imageUrl ?? "",
    iconEmoji: section.iconEmoji ?? "",
    maxItems: section.maxItems === undefined ? "" : String(section.maxItems),
    productIds: csv(section.productIds),
    categoryIds: csv(section.categoryIds),
    promotionIds: csv(section.promotionIds),
    brandIds: csv(section.brandIds),
    config: section.config ?? {},
  };
}

function cleanPayload(form: FormState) {
  const payload = {
    key: form.key.trim(),
    kind: form.kind,
    title: form.title.trim() || undefined,
    subtitle: form.subtitle.trim() || undefined,
    tab: form.tab.trim(),
    sortOrder: Number(form.sortOrder),
    isActive: form.isActive,
    allowEmpty: form.allowEmpty,
    startsAt: form.startsAt ? fromLocalInput(form.startsAt) : undefined,
    endsAt: form.endsAt ? fromLocalInput(form.endsAt) : undefined,
    timezone: form.timezone.trim() || undefined,
    visibleDaysOfWeek: form.visibleDaysOfWeek.length ? form.visibleDaysOfWeek : undefined,
    visibleTimeWindows: parseTimeWindows(form.visibleTimeWindows),
    storeIds: parseCsv(form.storeIds),
    cityIds: parseCsv(form.cityIds),
    regionIds: parseCsv(form.regionIds),
    customerSegments: parseCsv(form.customerSegments),
    holidayTags: parseCsv(form.holidayTags),
    seasonalTags: parseCsv(form.seasonalTags),
    minAppVersion: form.minAppVersion.trim() || undefined,
    maxAppVersion: form.maxAppVersion.trim() || undefined,
    layoutVariant: form.layoutVariant.trim() || undefined,
    backgroundColor: form.backgroundColor.trim() || undefined,
    textColor: form.textColor.trim() || undefined,
    imageUrl: form.imageUrl.trim() || undefined,
    iconEmoji: form.iconEmoji.trim() || undefined,
    maxItems: form.maxItems ? Number(form.maxItems) : undefined,
    productIds: parseCsv(form.productIds),
    categoryIds: parseCsv(form.categoryIds),
    promotionIds: parseCsv(form.promotionIds),
    brandIds: parseCsv(form.brandIds),
    config: Object.fromEntries(
      Object.entries(form.config).filter(([, value]) => {
        if (value === undefined || value === "") return false;
        return !(Array.isArray(value) && value.length === 0);
      }),
    ),
  };
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

function kindLabel(kind: HomeSectionKind) {
  return KINDS.find((item) => item.value === kind)?.label ?? kind;
}

function isWireframeSection(section: AdminSection) {
  return /^wirefram/i.test(section.tab) || section.key?.startsWith("wireframe_") === true;
}

export default function HomeSections() {
  const [tabFilter, setTabFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const result = useQuery(api.homeSections.adminList, {
    tab: tabFilter === "all" ? undefined : tabFilter,
    kind: kindFilter === "all" ? undefined : kindFilter,
    state: stateFilter,
    limit: 300,
  }) as ListResult | undefined;

  const createSection = useMutation(api.homeSections.createSection);
  const updateSection = useMutation(api.homeSections.updateSection);
  const toggleSection = useMutation(api.homeSections.toggleSection);
  const duplicateSection = useMutation(api.homeSections.duplicateSection);
  const archiveSection = useMutation(api.homeSections.archiveSection);
  const restoreSection = useMutation(api.homeSections.restoreSection);
  const reorderSections = useMutation(api.homeSections.reorderSections);
  const seedDefaults = useMutation(api.homeSections.seedDefaults);

  const [editing, setEditing] = useState<AdminSection | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [preview, setPreview] = useState<HomeSectionResponse | null>(null);

  const rows = useMemo(
    () => result?.data.filter((section) => !isWireframeSection(section)),
    [result?.data],
  );
  const tabs = useMemo(
    () => Array.from(new Set((rows ?? []).map((section) => section.tab))).sort(),
    [rows],
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, AdminSection[]>();
    for (const section of rows ?? []) {
      const list = grouped.get(section.tab) ?? [];
      list.push(section);
      grouped.set(section.tab, list);
    }
    return Array.from(grouped.entries()).map(([tab, sections]) => ({
      tab,
      sections: sections.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    }));
  }, [rows]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      sortOrder: String((rows?.length ?? 0) * 10),
    });
    setEditorOpen(true);
  };

  const openEdit = (section: AdminSection) => {
    setEditing(section);
    setForm(sectionToForm(section));
    setEditorOpen(true);
  };

  const save = async () => {
    const payload = cleanPayload(form);
    const ok = editing
      ? await runMutation(
          () => updateSection({ id: editing._id, patch: payload }),
          "Section updated",
        )
      : await runMutation(() => createSection(payload), "Section created");
    if (ok) {
      setEditing(null);
      setForm(EMPTY_FORM);
      setEditorOpen(false);
    }
  };

  const reorderWithinTab = async (tab: string, sectionId: string, direction: -1 | 1) => {
    const tabRows = (rows ?? [])
      .filter((section) => section.tab === tab)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const index = tabRows.findIndex((section) => section._id === sectionId);
    const target = index + direction;
    if (target < 0 || target >= tabRows.length) return;
    const next = [...tabRows];
    [next[index], next[target]] = [next[target], next[index]];
    await runMutation(
      () => reorderSections({ orderedIds: next.map((section) => section._id) }),
      "Order saved",
    );
  };

  return (
    <div>
      <PageHeader
        title="Home sections"
        description="Backend-driven home layout, visibility rules, targeting, and resolved data preview."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                runMutation(
                  () => seedDefaults({ replaceExisting: false }),
                  "Default sections seeded",
                )
              }
            >
              <Save className="mr-2 h-4 w-4" /> Seed defaults
            </Button>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> New section
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-2 md:grid-cols-4">
        <Select value={tabFilter} onValueChange={setTabFilter}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tabs</SelectItem>
            {tabs.map((tab) => (
              <SelectItem key={tab} value={tab}>{tab}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {KINDS.map((kind) => (
              <SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={stateFilter} onValueChange={setStateFilter}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Not archived</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="scheduled">Scheduled</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Filter tab name"
          value={tabFilter === "all" ? "" : tabFilter}
          onChange={(event) => setTabFilter(event.target.value || "all")}
        />
      </div>

      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No sections match these filters" />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.tab}>
              <h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">
                {group.tab}
              </h2>
              <div className="grid gap-3 xl:grid-cols-2">
                {group.sections.map((section) => (
                  <Card key={section._id} className={section.archivedAt ? "opacity-70" : ""}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <CardTitle className="text-base">
                            <span className="mr-2 font-mono text-xs text-muted-foreground">
                              #{section.sortOrder ?? section.sort_order ?? 0}
                            </span>
                            {section.title || section.key}
                          </CardTitle>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <Badge variant="outline">{kindLabel(section.kind)}</Badge>
                            <StatusBadge
                              value={
                                section.archivedAt
                                  ? "hidden"
                                  : section.isActive || section.is_active
                                    ? "active"
                                    : "inactive"
                              }
                            />
                            {section.startsAt || section.endsAt ? (
                              <Badge variant="secondary">scheduled</Badge>
                            ) : null}
                          </div>
                        </div>
                        <Switch
                          checked={section.isActive ?? section.is_active ?? false}
                          disabled={!!section.archivedAt}
                          onCheckedChange={(isActive) =>
                            runMutation(
                              () => toggleSection({ id: section._id, isActive }),
                              isActive ? "Section enabled" : "Section disabled",
                            )
                          }
                        />
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                        <p><span className="font-medium text-foreground">Key:</span> {section.key}</p>
                        <p><span className="font-medium text-foreground">Timezone:</span> {section.timezone || "—"}</p>
                        <p><span className="font-medium text-foreground">Starts:</span> {formatDateTime(section.startsAt)}</p>
                        <p><span className="font-medium text-foreground">Ends:</span> {formatDateTime(section.endsAt)}</p>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        <Badge variant="secondary">
                          {section.preview.resolvedData.products?.length ?? 0} products
                        </Badge>
                        <Badge variant="secondary">
                          {section.preview.resolvedData.categories?.length ?? 0} categories
                        </Badge>
                        <Badge variant="secondary">
                          {section.preview.resolvedData.promotions?.length ?? 0} promotions
                        </Badge>
                        <Badge variant="secondary">
                          {section.preview.resolvedData.stores?.length ?? 0} stores
                        </Badge>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-1">
                        <Button size="sm" variant="outline" onClick={() => reorderWithinTab(section.tab, section._id, -1)}>
                          ↑
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => reorderWithinTab(section.tab, section._id, 1)}>
                          ↓
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPreview(section.preview)}>
                          <Eye className="mr-1 h-4 w-4" /> Preview
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(section)}>
                          <Pencil className="mr-1 h-4 w-4" /> Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            runMutation(
                              () => duplicateSection({ id: section._id }),
                              "Section duplicated",
                            )
                          }
                        >
                          <Copy className="mr-1 h-4 w-4" /> Duplicate
                        </Button>
                        {section.archivedAt ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              runMutation(
                                () => restoreSection({ id: section._id }),
                                "Section restored",
                              )
                            }
                          >
                            <RotateCcw className="mr-1 h-4 w-4" /> Restore
                          </Button>
                        ) : (
                          <ConfirmButton
                            trigger={
                              <Button size="sm" variant="ghost">
                                <Archive className="mr-1 h-4 w-4 text-destructive" /> Archive
                              </Button>
                            }
                            title={`Archive "${section.title || section.key}"?`}
                            confirmLabel="Archive"
                            onConfirm={() =>
                              runMutation(
                                () => archiveSection({ id: section._id }),
                                "Section archived",
                              )
                            }
                          />
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {editorOpen && (
        <SectionDialog
          editing={editing}
          form={form}
          setForm={setForm}
          onClose={() => {
            setEditing(null);
            setForm(EMPTY_FORM);
            setEditorOpen(false);
          }}
          onSave={save}
        />
      )}

      {preview && (
        <Dialog open onOpenChange={() => setPreview(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Resolved data preview</DialogTitle>
            </DialogHeader>
            <pre className="max-h-[65vh] overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(preview, null, 2)}
            </pre>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function SectionDialog({
  editing,
  form,
  setForm,
  onClose,
  onSave,
}: {
  editing: AdminSection | null;
  form: FormState;
  setForm: (form: FormState) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit section" : "Create section"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          <EditorGroup title="Basic">
            <TextField label="Key *" value={form.key} onChange={(key) => setForm({ ...form, key })} />
            <div>
              <Label>Kind *</Label>
              <Select
                value={form.kind}
                onValueChange={(kind) =>
                  setForm({ ...form, kind: kind as HomeSectionKind })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((kind) => (
                    <SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <TextField label="Title" value={form.title} onChange={(title) => setForm({ ...form, title })} />
            <TextField label="Subtitle" value={form.subtitle} onChange={(subtitle) => setForm({ ...form, subtitle })} />
            <TextField label="Tab *" value={form.tab} onChange={(tab) => setForm({ ...form, tab })} />
            <TextField label="Sort order *" type="number" value={form.sortOrder} onChange={(sortOrder) => setForm({ ...form, sortOrder })} />
            <SwitchField icon="active" label="Active" checked={form.isActive} onChange={(isActive) => setForm({ ...form, isActive })} />
            <SwitchField icon="empty" label="Allow empty" checked={form.allowEmpty} onChange={(allowEmpty) => setForm({ ...form, allowEmpty })} />
          </EditorGroup>

          <EditorGroup title="Schedule">
            <TextField label="Starts at" type="datetime-local" value={form.startsAt} onChange={(startsAt) => setForm({ ...form, startsAt })} />
            <TextField label="Ends at" type="datetime-local" value={form.endsAt} onChange={(endsAt) => setForm({ ...form, endsAt })} />
            <TextField label="Timezone" value={form.timezone} onChange={(timezone) => setForm({ ...form, timezone })} />
            <DayPicker value={form.visibleDaysOfWeek} onChange={(visibleDaysOfWeek) => setForm({ ...form, visibleDaysOfWeek })} />
            <div className="sm:col-span-2">
              <Label>Visible time windows</Label>
              <Textarea
                placeholder="09:00-12:00&#10;17:00-22:00"
                value={form.visibleTimeWindows}
                onChange={(event) =>
                  setForm({ ...form, visibleTimeWindows: event.target.value })
                }
              />
            </div>
          </EditorGroup>

          <EditorGroup title="Targeting">
            <TextField label="Store IDs" value={form.storeIds} onChange={(storeIds) => setForm({ ...form, storeIds })} />
            <TextField label="City IDs" value={form.cityIds} onChange={(cityIds) => setForm({ ...form, cityIds })} />
            <TextField label="Region IDs" value={form.regionIds} onChange={(regionIds) => setForm({ ...form, regionIds })} />
            <TextField label="Customer segments" value={form.customerSegments} onChange={(customerSegments) => setForm({ ...form, customerSegments })} />
            <TextField label="Holiday tags" value={form.holidayTags} onChange={(holidayTags) => setForm({ ...form, holidayTags })} />
            <TextField label="Seasonal tags" value={form.seasonalTags} onChange={(seasonalTags) => setForm({ ...form, seasonalTags })} />
            <TextField label="Min app version" value={form.minAppVersion} onChange={(minAppVersion) => setForm({ ...form, minAppVersion })} />
            <TextField label="Max app version" value={form.maxAppVersion} onChange={(maxAppVersion) => setForm({ ...form, maxAppVersion })} />
          </EditorGroup>

          <EditorGroup title="Design">
            <TextField label="Layout variant" value={form.layoutVariant} onChange={(layoutVariant) => setForm({ ...form, layoutVariant })} />
            <TextField label="Background color" value={form.backgroundColor} onChange={(backgroundColor) => setForm({ ...form, backgroundColor })} />
            <TextField label="Text color" value={form.textColor} onChange={(textColor) => setForm({ ...form, textColor })} />
            <TextField label="Image URL" value={form.imageUrl} onChange={(imageUrl) => setForm({ ...form, imageUrl })} />
            <TextField label="Icon emoji" value={form.iconEmoji} onChange={(iconEmoji) => setForm({ ...form, iconEmoji })} />
          </EditorGroup>

          <EditorGroup title="Data">
            <TextField label="Product IDs" value={form.productIds} onChange={(productIds) => setForm({ ...form, productIds })} />
            <TextField label="Category IDs" value={form.categoryIds} onChange={(categoryIds) => setForm({ ...form, categoryIds })} />
            <TextField label="Promotion IDs" value={form.promotionIds} onChange={(promotionIds) => setForm({ ...form, promotionIds })} />
            <TextField label="Brand IDs" value={form.brandIds} onChange={(brandIds) => setForm({ ...form, brandIds })} />
            <TextField label="Max items" type="number" value={form.maxItems} onChange={(maxItems) => setForm({ ...form, maxItems })} />
          </EditorGroup>

          <EditorGroup title="Config">
            {CONFIG_FIELDS[form.kind].map((field) => (
              <ConfigFieldInput
                key={field.key}
                field={field}
                value={form.config[field.key]}
                onChange={(value) =>
                  setForm({
                    ...form,
                    config: { ...form.config, [field.key]: value },
                  })
                }
              />
            ))}
          </EditorGroup>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} disabled={!form.key.trim() || !form.tab.trim()}>
            {editing ? "Save changes" : "Create section"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditorGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function SwitchField({
  label,
  checked,
  onChange,
  icon,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  icon: "active" | "empty";
}) {
  const Icon = icon === "active" ? ToggleRight : ToggleLeft;
  return (
    <label className="flex items-center gap-2 pt-6 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} />
      <Icon className="h-4 w-4 text-muted-foreground" />
      {label}
    </label>
  );
}

function DayPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (value: number[]) => void;
}) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div className="sm:col-span-2">
      <Label>Visible days</Label>
      <div className="mt-2 flex flex-wrap gap-1">
        {days.map((day, index) => {
          const selected = value.includes(index);
          return (
            <Button
              key={day}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              onClick={() =>
                onChange(
                  selected
                    ? value.filter((current) => current !== index)
                    : [...value, index].sort(),
                )
              }
            >
              {day}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function ConfigFieldInput({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 pt-6 text-sm">
        <Switch checked={Boolean(value)} onCheckedChange={onChange} />
        {field.label}
      </label>
    );
  }
  const displayValue = Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
  return (
    <TextField
      label={field.label}
      type={field.type === "number" ? "number" : "text"}
      value={displayValue}
      onChange={(next) => {
        if (field.type === "number") onChange(next === "" ? undefined : Number(next));
        else if (field.type === "string[]") onChange(parseCsv(next) ?? []);
        else onChange(next);
      }}
    />
  );
}
