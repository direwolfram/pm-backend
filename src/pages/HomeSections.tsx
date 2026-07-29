import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Archive,
  Clipboard,
  ClipboardPaste,
  Copy,
  Eye,
  FolderPlus,
  GripVertical,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Save,
  ToggleLeft,
  ToggleRight,
  Upload,
  X,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  HomeSectionCardType,
  HomeSectionDoc,
  HomeSectionKind,
  HomeSectionResponse,
} from "../../convex/model";

type AdminSection = HomeSectionDoc & { preview: HomeSectionResponse };
type ListResult = { data: AdminSection[]; total: number; limit: number; offset: number };
type TabLayout = { id: string; tab: string; overrideEnabled: boolean; updatedAt: number };

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
  cardType: HomeSectionCardType;
  layoutVariant: string;
  backgroundColor: string;
  backgroundImage: string;
  backgroundImageStorageId: string;
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

type CategoryFormState = {
  name: string;
  slug: string;
  sectionName: string;
  iconEmoji: string;
  backgroundColor: string;
  sortOrder: string;
};

const EMPTY_CATEGORY_FORM: CategoryFormState = {
  name: "",
  slug: "",
  sectionName: "",
  iconEmoji: "",
  backgroundColor: "",
  sortOrder: "0",
};

const CARD_TYPE_OPTIONS: { value: HomeSectionCardType; label: string }[] = [
  { value: "overlap", label: "Overlap" },
  { value: "small", label: "Small" },
  { value: "minimal", label: "Minimal" },
];

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
    { key: "backgroundColor", label: "Background color", type: "string" },
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
  cardType: "overlap",
  layoutVariant: "",
  backgroundColor: "",
  backgroundImage: "",
  backgroundImageStorageId: "",
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
    cardType: section.card_type ?? "overlap",
    layoutVariant: section.layoutVariant ?? "",
    backgroundColor: section.backgroundColor ?? "",
    backgroundImage: section.backgroundImage ?? "",
    backgroundImageStorageId: section.backgroundImageStorageId ?? "",
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
    card_type: form.cardType,
    layoutVariant: form.layoutVariant.trim() || undefined,
    backgroundColor: form.backgroundColor.trim() || undefined,
    backgroundImage: form.backgroundImage.trim() || undefined,
    backgroundImageStorageId: form.backgroundImageStorageId || undefined,
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

const CHROME_KIND_ORDER: HomeSectionKind[] = ["header", "search_bar", "category_tabs"];

function isChromeKind(kind: HomeSectionKind) {
  return CHROME_KIND_ORDER.includes(kind);
}

function sortSections(sections: AdminSection[]) {
  return [...sections].sort((a, b) => (a.sortOrder ?? a.sort_order ?? 0) - (b.sortOrder ?? b.sort_order ?? 0));
}

function sortTabs(tabs: string[]) {
  return Array.from(new Set(["All", ...tabs.filter(Boolean)])).sort((a, b) => {
    if (a === "All") return -1;
    if (b === "All") return 1;
    return a.localeCompare(b);
  });
}

export default function HomeSections() {
  const [activeTab, setActiveTab] = useState("All");
  const [kindFilter, setKindFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const result = useQuery(api.homeSections.adminList, {
    kind: kindFilter === "all" ? undefined : kindFilter,
    state: stateFilter,
    limit: 300,
  }) as ListResult | undefined;
  const adminTabs = useQuery(api.homeSections.adminTabs, {}) as string[] | undefined;
  const tabLayouts = useQuery(api.homeSections.tabLayouts, {}) as TabLayout[] | undefined;

  const createSection = useMutation(api.homeSections.createSection);
  const updateSection = useMutation(api.homeSections.updateSection);
  const toggleSection = useMutation(api.homeSections.toggleSection);
  const duplicateSection = useMutation(api.homeSections.duplicateSection);
  const archiveSection = useMutation(api.homeSections.archiveSection);
  const restoreSection = useMutation(api.homeSections.restoreSection);
  const reorderSections = useMutation(api.homeSections.reorderSections);
  const setTabOverride = useMutation(api.homeSections.setTabOverride);
  const copySectionsFromTab = useMutation(api.homeSections.copySectionsFromTab);
  const pasteSectionToTab = useMutation(api.homeSections.pasteSectionToTab);
  const createHomeCategory = useMutation(api.homeSections.createHomeCategory);
  const seedDefaults = useMutation(api.homeSections.seedDefaults);

  const [editing, setEditing] = useState<AdminSection | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [preview, setPreview] = useState<HomeSectionResponse | null>(null);
  const [copySourceTab, setCopySourceTab] = useState("");
  const [copiedSection, setCopiedSection] = useState<AdminSection | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryForm, setCategoryForm] = useState<CategoryFormState>(EMPTY_CATEGORY_FORM);

  const rows = useMemo(
    () => result?.data.filter((section) => !isWireframeSection(section)),
    [result?.data],
  );
  const tabs = useMemo(
    () => sortTabs(adminTabs ?? (rows ?? []).map((section) => section.tab)),
    [adminTabs, rows],
  );
  const selectedTab = tabs.includes(activeTab) ? activeTab : (tabs[0] ?? "All");
  const currentLayout = useMemo(
    () => tabLayouts?.find((layout) => layout.tab === selectedTab),
    [selectedTab, tabLayouts],
  );
  const allRows = useMemo(
    () => sortSections((rows ?? []).filter((section) => section.tab === "All")),
    [rows],
  );
  const customRows = useMemo(
    () => sortSections((rows ?? []).filter((section) => section.tab === selectedTab)),
    [rows, selectedTab],
  );
  const overrideEnabled =
    selectedTab === "All" ? true : (currentLayout?.overrideEnabled ?? customRows.length > 0);
  const isInherited = selectedTab !== "All" && !overrideEnabled;
  const visibleRows = isInherited ? allRows : customRows;
  const chromeRows = useMemo(
    () =>
      CHROME_KIND_ORDER.map((kind) => visibleRows.find((section) => section.kind === kind)).filter(
        (section): section is AdminSection => !!section,
      ),
    [visibleRows],
  );
  const bodyRows = useMemo(
    () => visibleRows.filter((section) => !isChromeKind(section.kind)),
    [visibleRows],
  );
  const copySourceOptions = tabs.filter((tab) => tab !== selectedTab);
  const selectedCopySource = copySourceOptions.includes(copySourceTab)
    ? copySourceTab
    : (copySourceOptions[0] ?? "");
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const openCreate = () => {
    if (isInherited) return;
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      tab: selectedTab,
      sortOrder: String((visibleRows.length ? Math.max(...visibleRows.map((section) => section.sortOrder ?? section.sort_order ?? 0)) + 10 : 0)),
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

  const reorderVisibleRows = async (sectionId: string, direction: -1 | 1) => {
    if (isInherited) return;
    const index = bodyRows.findIndex((section) => section._id === sectionId);
    const target = index + direction;
    if (target < 0 || target >= bodyRows.length) return;
    const next = [...bodyRows];
    [next[index], next[target]] = [next[target], next[index]];
    await runMutation(
      () => reorderSections({ orderedIds: next.map((section) => section._id) }),
      "Order saved",
    );
  };

  const dropSection = async (targetId: string) => {
    if (!draggingId || draggingId === targetId || isInherited) return;
    const next = [...bodyRows];
    const from = next.findIndex((section) => section._id === draggingId);
    const to = next.findIndex((section) => section._id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDraggingId(null);
    await runMutation(
      () => reorderSections({ orderedIds: next.map((section) => section._id) }),
      "Order saved",
    );
  };

  const toggleOverride = async (enabled: boolean) => {
    await runMutation(
      () => setTabOverride({ tab: selectedTab, overrideEnabled: enabled }),
      enabled ? "Override enabled" : "Default layout restored",
    );
  };

  const copyFromSelectedTab = async () => {
    if (!selectedCopySource) return;
    await runMutation(
      () => copySectionsFromTab({ sourceTab: selectedCopySource, targetTab: selectedTab }),
      `Copied sections from ${selectedCopySource}`,
    );
  };

  const pasteCopiedSection = async () => {
    if (!copiedSection) return;
    await runMutation(
      () => pasteSectionToTab({ sectionId: copiedSection._id, targetTab: selectedTab }),
      `Pasted "${copiedSection.title || copiedSection.key}" into ${selectedTab}`,
    );
  };

  const openCategoryDialog = () => {
    setCategoryForm(EMPTY_CATEGORY_FORM);
    setCategoryOpen(true);
  };

  const saveCategory = async () => {
    const categoryName = categoryForm.name.trim();
    const ok = await runMutation(
      () =>
        createHomeCategory({
          name: categoryName,
          slug: categoryForm.slug.trim() || undefined,
          section_name: categoryForm.sectionName.trim() || undefined,
          icon_emoji: categoryForm.iconEmoji.trim() || undefined,
          background_color: categoryForm.backgroundColor.trim() || undefined,
          sort_order: categoryForm.sortOrder ? Number(categoryForm.sortOrder) : undefined,
        }),
      "Category created",
    );
    if (ok) {
      setCategoryOpen(false);
      setActiveTab(categoryName);
    }
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
            <Button variant="outline" onClick={openCategoryDialog}>
              <FolderPlus className="mr-2 h-4 w-4" /> New category
            </Button>
            <Button onClick={openCreate} disabled={isInherited}>
              <Plus className="mr-2 h-4 w-4" /> New section
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-2 md:grid-cols-2">
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
      </div>

      {!rows || !adminTabs || !tabLayouts ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No sections match these filters" />
      ) : (
        <Tabs value={selectedTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="overflow-x-auto">
            <TabsList className="h-auto w-max justify-start">
              {tabs.map((tab) => (
                <TabsTrigger key={tab} value={tab} className="min-w-24">
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {selectedTab !== "All" && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-4 py-3">
              <div>
                <p className="text-sm font-medium">{selectedTab} layout</p>
                <p className="text-xs text-muted-foreground">
                  {overrideEnabled
                    ? "This tab has its own sections. Reordering and edits affect this tab in the app."
                    : "This tab is inheriting the All layout in the app."}
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={overrideEnabled} onCheckedChange={toggleOverride} />
                Override
              </label>
            </div>
          )}

          <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium">Copy from another tab</p>
              <p className="text-xs text-muted-foreground">
                Duplicates the selected tab's visible layout into {selectedTab}.
                {copiedSection ? ` Clipboard: ${copiedSection.title || copiedSection.key}.` : ""}
              </p>
            </div>
            <div className="flex min-w-64 flex-wrap items-end gap-2">
              {copySourceOptions.length ? (
                <div className="min-w-44 flex-1">
                  <Label>Source tab</Label>
                  <Select value={selectedCopySource} onValueChange={setCopySourceTab}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {copySourceOptions.map((tab) => (
                        <SelectItem key={tab} value={tab}>{tab}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <Button
                variant="outline"
                onClick={copyFromSelectedTab}
                disabled={!selectedCopySource}
              >
                <Copy className="mr-2 h-4 w-4" /> Copy sections
              </Button>
              <Button
                variant="outline"
                onClick={pasteCopiedSection}
                disabled={!copiedSection}
              >
                <ClipboardPaste className="mr-2 h-4 w-4" /> Paste section
              </Button>
            </div>
          </div>

          <TabsContent value={selectedTab} className="space-y-3">
            {visibleRows.length === 0 ? (
              <EmptyState
                title="No sections in this tab"
                hint={isInherited ? "Inherited content is filtered out by the current filters." : undefined}
              />
            ) : (
              <>
                {chromeRows.length > 0 && (
                  <TopChromeGroup
                    sections={chromeRows}
                    disabled={isInherited}
                    onEdit={openEdit}
                    onPreview={setPreview}
                  />
                )}
                {bodyRows.map((section, index) => (
                  <Card
                    key={section._id}
                    draggable={!isInherited}
                    onDragStart={() => setDraggingId(section._id)}
                    onDragEnd={() => setDraggingId(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => dropSection(section._id)}
                    className={[
                      section.archivedAt ? "opacity-70" : "",
                      draggingId === section._id ? "border-primary" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 gap-3">
                          <button
                            type="button"
                            aria-label="Drag to reorder"
                            disabled={isInherited}
                            className="mt-0.5 rounded-md p-1 text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <GripVertical className="h-4 w-4" />
                          </button>
                          <div className="min-w-0">
                          <CardTitle className="text-base">
                            <span className="mr-2 font-mono text-xs text-muted-foreground">
                              #{index + 1}
                            </span>
                            {section.title || section.key}
                          </CardTitle>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <Badge variant="outline">{kindLabel(section.kind)}</Badge>
                            {isInherited ? <Badge variant="secondary">Inherited from All</Badge> : null}
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
                        </div>
                        <Switch
                          checked={section.isActive ?? section.is_active ?? false}
                          disabled={!!section.archivedAt || isInherited}
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
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isInherited || index === 0}
                          onClick={() => reorderVisibleRows(section._id, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isInherited || index === visibleRows.length - 1}
                          onClick={() => reorderVisibleRows(section._id, 1)}
                        >
                          ↓
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPreview(section.preview)}>
                          <Eye className="mr-1 h-4 w-4" /> Preview
                        </Button>
                        <Button size="sm" variant="ghost" disabled={isInherited} onClick={() => openEdit(section)}>
                          <Pencil className="mr-1 h-4 w-4" /> Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setCopiedSection(section)}
                        >
                          <Clipboard className="mr-1 h-4 w-4" /> Copy
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isInherited}
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
                            disabled={isInherited}
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
                              <Button size="sm" variant="ghost" disabled={isInherited}>
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
              </>
            )}
          </TabsContent>
        </Tabs>
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

      {categoryOpen && (
        <Dialog open onOpenChange={setCategoryOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>New category</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Name *"
                value={categoryForm.name}
                onChange={(name) => setCategoryForm({ ...categoryForm, name })}
              />
              <TextField
                label="Slug"
                value={categoryForm.slug}
                onChange={(slug) => setCategoryForm({ ...categoryForm, slug })}
              />
              <TextField
                label="Section name"
                value={categoryForm.sectionName}
                onChange={(sectionName) => setCategoryForm({ ...categoryForm, sectionName })}
              />
              <TextField
                label="Emoji"
                value={categoryForm.iconEmoji}
                onChange={(iconEmoji) => setCategoryForm({ ...categoryForm, iconEmoji })}
              />
              <ColorField
                label="Background color"
                value={categoryForm.backgroundColor}
                onChange={(backgroundColor) => setCategoryForm({ ...categoryForm, backgroundColor })}
              />
              <TextField
                label="Sort order"
                type="number"
                value={categoryForm.sortOrder}
                onChange={(sortOrder) => setCategoryForm({ ...categoryForm, sortOrder })}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCategoryOpen(false)}>Cancel</Button>
              <Button onClick={saveCategory} disabled={!categoryForm.name.trim()}>
                Create category
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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

function TopChromeGroup({
  sections,
  disabled,
  onEdit,
  onPreview,
}: {
  sections: AdminSection[];
  disabled: boolean;
  onEdit: (section: AdminSection) => void;
  onPreview: (preview: HomeSectionResponse) => void;
}) {
  const updateSection = useMutation(api.homeSections.updateSection);
  const toggleSection = useMutation(api.homeSections.toggleSection);
  const generateUploadUrl = useMutation(api.products.generateUploadUrl);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const groupColor = sections[0]?.backgroundColor ?? "";
  const groupImage = sections[0]?.preview.backgroundImage;
  const [color, setColor] = useState(groupColor);
  const [syncedColor, setSyncedColor] = useState(groupColor);
  if (groupColor !== syncedColor) {
    setSyncedColor(groupColor);
    setColor(groupColor);
  }

  const applyToAll = async (patch: Record<string, unknown>, message: string) => {
    await runMutation(async () => {
      for (const section of sections) {
        await updateSection({ id: section._id, patch });
      }
    }, message);
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    setUploading(true);
    await runMutation(async () => {
      const uploadUrl = await generateUploadUrl({});
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!response.ok) throw new Error(`Upload failed for ${file.name}`);
      const { storageId } = (await response.json()) as { storageId: string };
      for (const section of sections) {
        await updateSection({ id: section._id, patch: { backgroundImageStorageId: storageId } });
      }
    }, "Background image applied to header, search and tabs");
    setUploading(false);
  };

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Pin className="h-4 w-4 text-muted-foreground" /> Top chrome
        </CardTitle>
        <div className="mt-2 flex flex-wrap gap-1">
          <Badge variant="secondary">Pinned</Badge>
          <Badge variant="secondary">Required</Badge>
          {disabled ? <Badge variant="secondary">Inherited from All</Badge> : null}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Header, search bar and category tabs are pinned first in the app and share one background
          area. Set it for all three here, or edit each section individually.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/40 p-3">
          <div>
            <Label>Group background color</Label>
            <div className="flex gap-2">
              <Input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#ffffff"}
                onChange={(event) => setColor(event.target.value)}
                disabled={disabled}
                className="h-9 w-12 shrink-0 cursor-pointer p-1"
              />
              <Input
                value={color}
                placeholder="#FFFFFF"
                onChange={(event) => setColor(event.target.value)}
                disabled={disabled}
                className="w-28"
              />
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              applyToAll({ backgroundColor: color.trim() || undefined }, "Group background color applied")
            }
          >
            Apply to all
          </Button>
          <div>
            <Label>Group background image</Label>
            <div className="flex items-center gap-2">
              {groupImage ? (
                <img
                  src={groupImage}
                  alt="Group background"
                  className="h-9 w-16 rounded-md border object-cover"
                />
              ) : (
                <div className="flex h-9 w-16 items-center justify-center rounded-md border border-dashed text-[10px] text-muted-foreground">
                  None
                </div>
              )}
              <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || uploading}
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="mr-2 h-4 w-4" />
                {uploading ? "Uploading…" : "Upload for all"}
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          {sections.map((section) => (
            <div
              key={section._id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="h-8 w-12 shrink-0 rounded-md border bg-muted"
                  style={{
                    backgroundColor: section.backgroundColor || undefined,
                    backgroundImage: section.preview.backgroundImage
                      ? `url(${section.preview.backgroundImage})`
                      : undefined,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{kindLabel(section.kind)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {section.title || section.key}
                  </p>
                </div>
                <StatusBadge
                  value={
                    section.archivedAt
                      ? "hidden"
                      : section.isActive || section.is_active
                        ? "active"
                        : "inactive"
                  }
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={section.isActive ?? section.is_active ?? false}
                  disabled={disabled || !!section.archivedAt}
                  onCheckedChange={(isActive) =>
                    runMutation(
                      () => toggleSection({ id: section._id, isActive }),
                      isActive ? "Section enabled" : "Section disabled",
                    )
                  }
                />
                <Button size="sm" variant="ghost" onClick={() => onPreview(section.preview)}>
                  <Eye className="mr-1 h-4 w-4" /> Preview
                </Button>
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onEdit(section)}>
                  <Pencil className="mr-1 h-4 w-4" /> Edit
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
            <div>
              <Label>Product card type</Label>
              <Select
                value={form.cardType}
                onValueChange={(cardType) =>
                  setForm({ ...form, cardType: cardType as HomeSectionCardType })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CARD_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <TextField label="Layout variant" value={form.layoutVariant} onChange={(layoutVariant) => setForm({ ...form, layoutVariant })} />
            <ColorField label="Background color" value={form.backgroundColor} onChange={(backgroundColor) => setForm({ ...form, backgroundColor })} />
            <TextField label="Background image URL" value={form.backgroundImage} onChange={(backgroundImage) => setForm({ ...form, backgroundImage })} />
            <BackgroundImageField
              storageId={form.backgroundImageStorageId}
              url={form.backgroundImage}
              existingUrl={editing?.preview.backgroundImage}
              onChange={(backgroundImageStorageId) => setForm({ ...form, backgroundImageStorageId })}
            />
            <ColorField label="Text color" value={form.textColor} onChange={(textColor) => setForm({ ...form, textColor })} />
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

function BackgroundImageField({
  storageId,
  url,
  existingUrl,
  onChange,
}: {
  storageId: string;
  url: string;
  existingUrl?: string;
  onChange: (storageId: string) => void;
}) {
  const generateUploadUrl = useMutation(api.products.generateUploadUrl);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const preview = cleared
    ? undefined
    : (localPreview ?? (storageId ? existingUrl : undefined) ?? (url.trim() || undefined));

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    setUploading(true);
    await runMutation(async () => {
      const uploadUrl = await generateUploadUrl({});
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!response.ok) throw new Error(`Upload failed for ${file.name}`);
      const { storageId: id } = (await response.json()) as { storageId: string };
      onChange(id);
      setLocalPreview(URL.createObjectURL(file));
      setCleared(false);
    }, "Background image uploaded");
    setUploading(false);
  };

  const clear = () => {
    onChange("");
    setLocalPreview(null);
    setCleared(true);
  };

  return (
    <div className="sm:col-span-2">
      <Label>Background image</Label>
      <div className="mt-1 flex items-center gap-2">
        {preview ? (
          <img src={preview} alt="Background" className="h-9 w-16 rounded-md border object-cover" />
        ) : (
          <div className="flex h-9 w-16 items-center justify-center rounded-md border border-dashed text-[10px] text-muted-foreground">
            None
          </div>
        )}
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-2 h-4 w-4" />
          {uploading ? "Uploading…" : preview ? "Replace" : "Upload"}
        </Button>
        {preview && (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
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

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          type="color"
          value={pickerValue}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer p-1"
        />
        <Input
          value={value}
          placeholder="#FFFFFF"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
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
  if (field.key.toLowerCase().includes("color")) {
    return (
      <ColorField
        label={field.label}
        value={displayValue}
        onChange={onChange}
      />
    );
  }
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
