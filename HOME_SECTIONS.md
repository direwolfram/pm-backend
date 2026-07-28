# Backend-Driven Home Sections

Convex module: `convex/homeSections.ts`

Frontend contract: `src/lib/homeSectionTypes.ts`

## Queries

- `homeSections.tabs()`
- `homeSections.list({ tab?, store_id?, city_id?, region_id?, customerSegment?, holidayTags?, seasonalTags?, appVersion?, now?, limit?, offset? })`
- `homeSections.get({ id })`
- `homeSections.adminList({ tab?, kind?, state?, limit?, offset? })`

## Mutations

- `homeSections.createSection(args)`
- `homeSections.updateSection({ id, patch })`
- `homeSections.toggleSection({ id, isActive })`
- `homeSections.reorderSections({ orderedIds })`
- `homeSections.duplicateSection({ id })`
- `homeSections.archiveSection({ id })`
- `homeSections.restoreSection({ id })`
- `homeSections.seedDefaults({ replaceExisting? })`

## Example `homeSections.list` Response

```json
{
  "data": [
    {
      "id": "js7...",
      "key": "bestsellers_default",
      "kind": "bestseller_grid",
      "title": "Bestsellers",
      "subtitle": null,
      "tab": "All",
      "sortOrder": 40,
      "layoutVariant": null,
      "config": {
        "columns": 2,
        "showMoreCount": 4,
        "maxItems": 8
      },
      "resolvedData": {
        "products": [],
        "categories": [],
        "promotions": [],
        "stores": []
      }
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

## Frontend Rendering

Render by `section.kind`:

- `header` -> `Header`
- `search_bar` -> `SearchBar`
- `category_tabs` -> tab control
- `hero_banner` -> hero banner
- `bestseller_grid` -> `BestsellerGrid`
- `promo_banner` -> `Banner`
- `promo_carousel` -> `PromoCarousel`
- `shopping_list_card` -> `ShoppingListCard`
- `category_grid` -> `CategoryGrid`
- `themed_product_section` -> `FreshDaySection` or themed equivalent
- `product_carousel` -> `ProductSection`
- `featured_products` -> `ProductSection`
- `store_inventory_section` -> store/inventory block
- `custom_cta` -> CTA component
- `spacer` -> view with configured height

## Migration Notes

The previous schema stored a small section row plus `home_section_items`.
The new contract stores targeting, schedule, design, linked IDs, and config
directly on `home_sections`. The legacy item table remains in the schema so old
databases continue validating, but new frontend renderers should use
`homeSections.list` and ignore `home_section_items`.

To migrate existing data, run `homeSections.seedDefaults({ replaceExisting:
true })` after catalog data is present, or create/edit sections from the admin
Home sections screen. New mutations enforce unique `key`, valid references,
valid dates, valid time windows, non-negative `sortOrder`, app-version ranges,
and per-kind config fields.

## Top-chrome ordering contract

`homeSections.list` always returns top chrome first, in this order, per tab:

1. `header` (sortOrder 0, never sticky)
2. `search_bar` (sortOrder 10, `config.stickyOnScroll: true`)
3. `category_tabs` (sortOrder 20, `config.stickyOnScroll: true`)
4. Body sections (sortOrder 30+), in stable `sortOrder` order

Sort orders 0-29 are reserved for top chrome; create/update/reorder mutations
reject body sections saved inside that band. Only one section per top-chrome
kind is allowed per tab (pass `allowDuplicateTopChrome` to override), and the
list query dedupes duplicates defensively. Tabs with their own override layout
but no top chrome inherit the missing chrome sections from the `All` tab.
