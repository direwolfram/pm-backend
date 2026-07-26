# Quick Commerce Enterprise UI Design System

## 1. Purpose

This design system defines the visual language, layout rules, interaction patterns, and reusable components for a backend enterprise application used to manage quick commerce operations, including:

- Inventory
- Warehouses and dark stores
- Products and catalog data
- Purchase orders
- Stock transfers
- Picking and packing
- Deliveries and dispatch
- Suppliers
- Returns and adjustments
- Users, teams, and permissions
- Operational reporting

The interface should feel calm, precise, trustworthy, and operationally efficient. It should support dense information without looking visually heavy.

---

## 2. Design Direction

### Overall look and feel

Use a restrained enterprise UI with:

- White and very light gray backgrounds
- Thin neutral borders
- Soft shadows used sparingly
- Compact, rounded components
- High information density
- Generous page margins
- Small but readable typography
- Clear visual hierarchy through spacing, weight, and contrast
- Blue as the primary interaction color
- Semantic colors reserved for status and alerts

The visual style should feel modern and premium, but not decorative. Avoid oversized cards, excessive gradients, large illustrations, and unnecessary color.

### Design qualities

The interface should be:

- **Quiet:** neutral surfaces and minimal visual noise
- **Dense:** optimized for operational workflows
- **Structured:** strong alignment and predictable component placement
- **Scannable:** tables, filters, labels, and status indicators should be easy to parse
- **Actionable:** primary actions must be obvious without dominating the interface
- **Consistent:** similar tasks should use the same component and layout patterns

---

## 3. Design Principles

### 3.1 Prioritize operational clarity

Show the most important operational information first. Use progressive disclosure for secondary details.

Examples:

- Show low-stock risk before general stock totals
- Show delayed orders before completed orders
- Show warehouse exceptions before routine activity
- Show inventory variance before historical audit data

### 3.2 Use color only when it communicates meaning

Most of the interface should remain neutral. Use color for:

- Primary actions
- Selected states
- Status labels
- Alerts and exceptions
- Progress and completion

Do not use color as decoration.

### 3.3 Keep actions close to context

Place actions near the data they affect.

Examples:

- “Adjust stock” near stock details
- “Assign picker” in the order row or detail panel
- “Create transfer” near warehouse stock
- “Approve purchase order” in the purchase order review area

### 3.4 Prefer structured surfaces over floating cards

Use sections, grouped rows, and bordered panels. Avoid excessive card grids unless the information is truly modular.

### 3.5 Design for exception management

The system should help operators quickly identify and resolve:

- Low stock
- Negative stock
- Expiring inventory
- Delayed dispatches
- Failed picks
- Unassigned orders
- Purchase order discrepancies
- Warehouse capacity issues
- Delivery SLA risk

---

## 4. Foundation Tokens

## 4.1 Color palette

### Neutral colors

| Token | Value | Usage |
|---|---:|---|
| `--color-bg-page` | `#F8F8F7` | Main application background |
| `--color-bg-surface` | `#FFFFFF` | Cards, tables, panels, modals |
| `--color-bg-subtle` | `#F5F5F4` | Secondary surfaces and selected sidebar items |
| `--color-bg-muted` | `#EFEFEE` | Disabled controls and inactive fills |
| `--color-border` | `#E4E4E2` | Default borders |
| `--color-border-strong` | `#D4D4D1` | Emphasized separators |
| `--color-text-primary` | `#171717` | Main text |
| `--color-text-secondary` | `#6B6B73` | Supporting text |
| `--color-text-muted` | `#9999A1` | Placeholder, inactive, helper text |
| `--color-icon` | `#73737A` | Default icon color |

### Primary colors

| Token | Value | Usage |
|---|---:|---|
| `--color-primary` | `#2563EB` | Primary actions, selected state, links |
| `--color-primary-hover` | `#1D4ED8` | Hover state |
| `--color-primary-active` | `#1E40AF` | Active or pressed state |
| `--color-primary-subtle` | `#EFF6FF` | Selected chips, active table row, soft highlights |
| `--color-primary-border` | `#BFDBFE` | Selected component borders |

### Semantic colors

| State | Text | Background | Border |
|---|---:|---:|---:|
| Success | `#168A4A` | `#ECFDF3` | `#BBF7D0` |
| Warning | `#B66A00` | `#FFF8E6` | `#FDE6A7` |
| Danger | `#D92D20` | `#FEF3F2` | `#FECACA` |
| Info | `#2563EB` | `#EFF6FF` | `#BFDBFE` |
| Neutral | `#5F5F66` | `#F4F4F5` | `#E4E4E7` |

### Warehouse operational colors

Use these only where operational categories benefit from visual distinction:

| Category | Color |
|---|---:|
| Available inventory | Green |
| Reserved inventory | Blue |
| Inbound inventory | Purple |
| Damaged inventory | Red |
| Quarantined inventory | Amber |
| Expiring inventory | Orange |
| Transferred inventory | Cyan |

---

## 4.2 Typography

Use a neutral sans-serif typeface.

Preferred stack:

```css
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif;
```

### Type scale

| Style | Size | Line height | Weight | Usage |
|---|---:|---:|---:|---|
| Display | 28px | 36px | 600 | Rare, top-level landing pages |
| Page title | 22px | 30px | 600 | Main page heading |
| Section title | 16px | 24px | 600 | Section headers |
| Card title | 14px | 20px | 600 | Cards and grouped modules |
| Body | 14px | 20px | 400 | Default body and table text |
| Body small | 13px | 18px | 400 | Compact form and operational UI |
| Label | 12px | 16px | 500 | Field labels, column labels, metadata |
| Caption | 11px | 16px | 400 | Secondary metadata and helper text |

### Typography rules

- Use sentence case for labels and headings
- Avoid all caps except for short system codes or acronyms
- Use semibold sparingly
- Use tabular numbers for inventory, currency, counts, and timestamps
- Truncate long content with tooltips instead of wrapping dense tables excessively

---

## 4.3 Spacing

Use a 4px base spacing system.

```text
4, 8, 12, 16, 20, 24, 32, 40, 48, 64
```

Recommended usage:

- 4px: icon and text micro-spacing
- 8px: compact control spacing
- 12px: component internal spacing
- 16px: standard padding
- 20px: card or section padding
- 24px: section gap
- 32px: major layout gap
- 48px: large page section separation

---

## 4.4 Radius

| Token | Value | Usage |
|---|---:|---|
| `--radius-xs` | 4px | Tags, compact badges |
| `--radius-sm` | 6px | Inputs, buttons, small controls |
| `--radius-md` | 8px | Cards, tables, dropdowns |
| `--radius-lg` | 12px | Modals and major panels |
| `--radius-xl` | 16px | Large onboarding or feature cards |

Avoid pill-shaped controls unless the component is specifically a tag, status, or segmented selector.

---

## 4.5 Borders and shadows

### Borders

Use 1px borders with neutral gray.

```css
border: 1px solid #E4E4E2;
```

### Shadows

Use shadows only for elevated elements.

```css
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
--shadow-md: 0 4px 12px rgba(0, 0, 0, 0.06);
--shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.10);
```

Use cases:

- `shadow-sm`: buttons, compact cards
- `shadow-md`: dropdowns, popovers
- `shadow-lg`: modals and command palette

---

## 5. Application Shell

## 5.1 Desktop layout

Use a three-part application shell:

1. Global navigation rail
2. Contextual sidebar
3. Main content area

```text
┌──────────┬──────────────────┬────────────────────────────────────┐
│ App rail │ Section sidebar  │ Main content                       │
│ 56px     │ 220–260px        │ Flexible                           │
└──────────┴──────────────────┴────────────────────────────────────┘
```

### Global navigation rail

Width: `56px`

Contains icons for:

- Dashboard
- Orders
- Inventory
- Warehouses
- Purchasing
- Dispatch
- Catalog
- Suppliers
- Reports
- Users
- Settings

Rules:

- Icons use a 20px bounding box
- Selected item gets a soft neutral or blue background
- Use tooltips on hover
- Place user avatar and settings at the bottom

### Contextual sidebar

Width: `220px` to `260px`

Use for:

- Saved views
- Filters
- Warehouses
- Inventory categories
- Operational status groups
- Recently accessed objects

Sidebar sections should use compact 12px labels and 13px navigation items.

### Main content

Main content should:

- Use a white or light gray background
- Keep content aligned to a consistent horizontal grid
- Use 24px to 32px page padding
- Support full-width tables
- Use max-width constraints only on focused forms, onboarding, and configuration screens

---

## 5.2 Top bar

Height: `52px` to `60px`

Contains:

- Breadcrumbs or page title
- Optional search
- Secondary actions
- Primary action

Example:

```text
Inventory / Warehouse A / Stock movements        Export   + Adjust stock
```

The primary action should be the right-most control.

---

## 6. Core Layout Patterns

## 6.1 Data management page

Use for inventory, products, suppliers, users, orders, and warehouses.

Structure:

1. Page header
2. Alert or notification banner
3. KPI summary row
4. Tabs or segmented filter
5. Toolbar
6. Data table
7. Pagination footer

Example:

```text
Inventory
Live stock across all warehouses

[Low stock: 24] [Out of stock: 8] [Expiring: 13] [Inventory value: $184,520]

All | Low stock | Out of stock | Expiring

Search products...      Warehouse: All   Category: All   Filter   Export   + Add stock

Table
```

## 6.2 Detail page

Use for products, orders, warehouses, suppliers, and purchase orders.

Structure:

- Breadcrumb
- Object title and status
- Primary actions
- Summary panel
- Tabs
- Detail sections
- Activity log

Recommended tabs:

- Overview
- Inventory
- Orders
- Movements
- Activity
- Settings

## 6.3 Focused workflow

Use for:

- Create purchase order
- Review stock transfer
- Approve inventory adjustment
- Warehouse onboarding
- Bulk import

Use a centered layout with a maximum width of `760px` to `960px`.

Avoid the full sidebar if the workflow benefits from focus.

## 6.4 Operational dashboard

Use a structured, information-dense layout.

Recommended areas:

- Exception alert banner
- KPI cards
- Orders at risk
- Inventory risk
- Warehouse workload
- Picking progress
- Fulfillment SLA
- Delivery status

Use charts only when they help make a decision. Prefer tables and ranked exception lists for operational work.

---

## 7. Components

## 7.1 Buttons

### Primary button

Use for the main action on a page.

```text
Background: #2563EB
Text: white
Height: 34px or 36px
Padding: 0 14px
Radius: 6px
Font: 13px / 500
```

Examples:

- Create purchase order
- Add product
- Confirm transfer
- Save changes

### Secondary button

White background, neutral border, dark text.

Use for:

- Export
- Import
- Cancel
- Preview
- Duplicate

### Destructive button

Use red only for irreversible or high-impact actions.

Examples:

- Delete product
- Cancel order
- Reject adjustment
- Remove warehouse

### Icon button

- 32px square
- 16px or 18px icon
- Neutral border or transparent background
- Tooltip required

---

## 7.2 Form controls

### Input

```text
Height: 36px
Padding: 0 10px
Border: 1px solid #DCDCDC
Radius: 6px
Font: 13px
```

Focus state:

- Blue border
- Subtle blue ring

### Select

Use a standard dropdown with optional search for more than 8 items.

### Checkbox

Use a compact square checkbox.

- 16px size
- 4px radius
- Blue selected state

### Radio group

Use for mutually exclusive choices with 2 to 5 options.

### Toggle

Use only for immediate on/off settings.

Examples:

- Auto-replenishment enabled
- Allow backorders
- Warehouse active

Do not use toggles for actions that require saving or approval.

---

## 7.3 Search and filters

### Search input

Use a left-aligned search icon and placeholder text.

Examples:

- Search SKU, product, or barcode
- Search order or customer
- Search warehouse or zone

### Filter toolbar

Order controls as:

1. Search
2. Scope selector
3. Common filters
4. Advanced filter
5. Sort
6. Export
7. Primary action

### Filter chips

Use removable chips to display active filters.

Example:

```text
Warehouse: Cebu Hub ×   Status: Low stock ×   Category: Grocery ×
```

---

## 7.4 Tags and selection chips

Use compact rounded rectangles rather than fully rounded pills.

### Default tag

- White background
- Neutral border
- Gray text

### Selected tag

- Blue text
- Soft blue background
- Blue border

### Add tag

Use a dashed border and plus icon.

This pattern can be used for:

- Product categories
- Warehouse zones
- Supplier groups
- User teams
- Product handling requirements

---

## 7.5 Status badges

Status badges should be compact and semantic.

Examples:

| Domain | Statuses |
|---|---|
| Inventory | In stock, Low stock, Out of stock, Expiring, Damaged |
| Orders | New, Picking, Packed, Ready, Dispatched, Delivered, Cancelled |
| Purchase orders | Draft, Pending approval, Ordered, Partially received, Received, Closed |
| Transfers | Draft, Scheduled, In transit, Received, Reconciled |
| Warehouse | Active, At capacity, Maintenance, Offline |
| Delivery | Assigned, En route, Delayed, Delivered, Failed |

Badge design:

- Height: 22px
- Padding: 0 7px
- Font: 11px / 500
- Radius: 5px
- Optional 6px status dot or 12px icon

---

## 7.6 Cards

Use cards sparingly.

### KPI card

Recommended size: flexible width, 72px to 88px height.

Contains:

- 12px label
- 20px to 24px metric
- Optional icon
- Optional delta or supporting label

Examples:

- Orders today
- Picking now
- Low-stock SKUs
- Warehouse utilization
- Late deliveries

### Selection card

Use for onboarding, preferences, or workflow choices.

Structure:

- Icon
- Title
- One-line description
- Checkbox in top-right

Selected state:

- Blue border
- Soft blue background or blue icon

### Action card

Use to promote an optional feature or setup step.

Example:

```text
Enable cycle counting
Improve stock accuracy with recurring count plans.     Enable
```

Use soft amber for recommended operational setup, not promotional upsell.

---

## 7.7 Tables

Tables are the primary component for enterprise data.

### Table styling

- Header height: 38px to 42px
- Row height: 44px to 52px
- 13px body text
- 12px header labels
- Horizontal row separators
- Optional vertical separators only for very wide tables
- Hover state: subtle gray background
- Selected row: subtle blue background

### Table behavior

Support:

- Column sorting
- Column resizing
- Column visibility
- Sticky header
- Sticky primary identifier column
- Row selection
- Bulk actions
- Inline status changes
- Context menu
- Pagination

### Recommended inventory columns

- Product
- SKU
- Warehouse
- Available
- Reserved
- Inbound
- Reorder point
- Stock status
- Last updated

### Recommended order columns

- Order number
- Customer
- Warehouse
- Items
- Total
- Fulfillment status
- Delivery status
- SLA
- Created

### Numeric alignment

- Right-align quantities, money, percentages, and durations
- Left-align names, labels, and statuses
- Use tabular numbers

### Bulk actions

When rows are selected, replace the standard toolbar with contextual actions.

Example:

```text
12 selected   Transfer stock   Adjust quantity   Export   Clear selection
```

---

## 7.8 Empty states

Use compact, centered empty states.

Structure:

1. Minimal line illustration or abstract placeholder
2. Clear title
3. One-sentence explanation
4. One primary action

Example:

```text
No stock transfers yet
Create a transfer to move inventory between warehouses.

Create transfer
```

Avoid decorative illustrations that compete with the message.

---

## 7.9 Alerts and banners

Use horizontal banners at the top of the page for operational exceptions.

Types:

- Warning
- Danger
- Info
- Success

Example:

```text
12 orders may miss the 30-minute fulfillment target.   Review affected orders
```

Structure:

- Icon
- Message
- Optional linked action
- Dismiss icon

---

## 7.10 Tabs and segmented controls

Use tabs for major content sections.

Use segmented controls for quick dataset filtering.

Examples:

```text
All | Active | Low stock | Out of stock
```

Segmented controls should have a subtle neutral background with a white selected segment.

---

## 7.11 Pagination

Display:

- Current visible range
- Total count
- Previous and next
- Compact page numbers

Example:

```text
Showing 1–25 of 428 products                      ‹ 1 2 3 … 18 ›
```

---

## 7.12 Side panels and drawers

Use right-side drawers for quick inspection and editing without losing table context.

Recommended width:

- 420px for simple details
- 520px to 640px for complex forms

Use cases:

- Product quick view
- Inventory adjustment
- Assign order picker
- View supplier details
- Review stock movement

---

## 7.13 Modal dialogs

Use modals only when the action blocks the current workflow.

Sizes:

- Small: 400px
- Medium: 560px
- Large: 760px

Use a sticky footer for actions in long dialogs.

Destructive confirmation should explicitly name the affected object.

---

## 7.14 Activity timeline

Use for:

- Inventory adjustments
- Purchase order history
- Order status changes
- Transfer events
- User permission changes

Each event includes:

- Actor
- Action
- Object
- Timestamp
- Optional note

Example:

```text
Ana Cruz adjusted SKU PM-1042 from 18 to 16 units
Reason: Damaged during picking
Today, 2:14 PM
```

---

## 8. Quick Commerce Domain Patterns

## 8.1 Inventory overview

Recommended page structure:

- Inventory value
- Available units
- Low-stock SKUs
- Out-of-stock SKUs
- Expiring SKUs
- Inventory table

Primary actions:

- Add stock
- Create transfer
- Import inventory
- Export inventory

## 8.2 Product detail

Sections:

- Product identity
- SKU and barcode
- Category and brand
- Units and packaging
- Pricing
- Warehouse stock
- Reorder rules
- Supplier data
- Expiry and batch tracking
- Activity

Use grouped bordered rows for compact editable settings.

## 8.3 Warehouse overview

Show:

- Open orders
- Orders at risk
- Pickers active
- Current picking load
- Storage utilization
- Receiving queue
- Expiring stock
- Zone status

Provide a compact warehouse selector near the title.

## 8.4 Order management

Recommended views:

- All orders
- New
- Picking
- Packing
- Ready for dispatch
- Delayed
- Cancelled

Use status indicators and SLA countdowns directly in the table.

Example SLA cell:

```text
12 min left
At risk
```

## 8.5 Picking workflow

Use a focused workflow with:

- Order summary
- Product image thumbnail
- Product name and SKU
- Required quantity
- Picked quantity
- Bin location
- Substitution option
- Issue reporting

Status progression:

```text
Not started → Picking → Packed → Ready
```

## 8.6 Purchase order review

Use a review layout with:

- Line items on the left
- Supplier and delivery details on the right
- Sticky total
- Approve and reject actions

Highlight discrepancies between ordered and received quantities.

## 8.7 Stock transfer review

Show:

- Source warehouse
- Destination warehouse
- Transfer items
- Available stock after transfer
- Estimated arrival
- Transport method
- Approval status

Use warning callouts when the transfer may cause source stockouts.

## 8.8 Warehouse slot or dock scheduling

Use a calendar grid for receiving and dispatch appointments.

- Columns: days
- Rows: time slots
- Cards: supplier, vehicle, dock, status
- Empty slots: dashed border and plus icon

Statuses:

- Confirmed
- Pending
- Completed
- Missed
- Open slot

## 8.9 Role and permission management

Use a permission matrix for enterprise administration.

Columns:

- View
- Create
- Edit
- Approve
- Delete
- Export
- Manage users

Rows:

- Products
- Inventory
- Orders
- Warehouses
- Purchasing
- Suppliers
- Reports
- Settings

Support role templates and warehouse scope.

Example scope options:

- All warehouses
- Assigned warehouses
- Specific warehouse
- Own team only

---

## 9. Interaction States

Every interactive component should define:

- Default
- Hover
- Focus
- Active
- Selected
- Disabled
- Loading
- Error

### Loading

Use skeletons for data-heavy screens. Avoid full-page spinners.

### Saving

Use inline feedback:

- “Saving…”
- “Saved”
- Error with retry action

### Optimistic updates

Use for low-risk actions such as:

- Updating tags
- Changing filters
- Toggling preferences

Require confirmation for:

- Stock adjustments
- Order cancellation
- Purchase order approval
- User permission changes

---

## 10. Responsive Behavior

This is primarily a desktop enterprise application.

### Desktop

- Full rail + sidebar + content
- Dense tables
- Multi-column detail views

### Tablet

- Collapsible contextual sidebar
- Reduced visible table columns
- Right drawers may become full-height overlays

### Mobile

Support limited operational workflows only:

- Picking
- Receiving
- Cycle counting
- Barcode scanning
- Order handoff
- Delivery status

Do not attempt to compress full desktop administration into mobile.

---

## 11. Accessibility

- Maintain at least WCAG AA contrast
- Do not communicate status through color alone
- All icons require labels or tooltips
- Use visible keyboard focus states
- Support keyboard navigation for tables and menus
- Use semantic HTML for headings, tables, forms, and buttons
- Minimum target size: 32px desktop, 44px mobile
- Avoid placeholder-only labels
- Use descriptive error messages

---

## 12. Motion

Use subtle transitions only.

Recommended durations:

- Hover: 100ms
- Dropdown: 140ms
- Drawer: 180ms
- Modal: 180ms
- Toast: 200ms

Use ease-out for entrances and ease-in for exits.

Avoid bouncing, scaling, or decorative motion in operational workflows.

---

## 13. Iconography

Use a consistent outlined icon set such as Lucide.

Recommended size:

- 16px inside controls
- 18px in navigation
- 20px for main navigation
- 24px in empty states or onboarding cards

Use filled icons only for selected states or strong semantic meaning.

---

## 14. Content Style

### Labels

Use short, direct labels.

Preferred:

- Add product
- Create transfer
- Adjust stock
- Assign picker
- Mark received

Avoid:

- Initiate new product creation
- Perform inventory adjustment
- Proceed to assign a picker

### Status language

Use operationally clear language.

Preferred:

- Low stock
- Needs approval
- Delayed
- Partially received
- Ready for dispatch

### Helper text

Explain consequences, not obvious UI behavior.

Preferred:

> Orders from this warehouse will be paused while it is inactive.

Avoid:

> Toggle this switch to turn the warehouse off.

---

## 15. Example Page Blueprints

## 15.1 Inventory list

```text
Inventory                                           Import   + Add stock
Track available, reserved, and inbound units.

[Low stock 24] [Out of stock 8] [Expiring 13] [Value $184,520]

All   Low stock   Out of stock   Expiring

Search SKU, product, or barcode   Warehouse: All   Category: All   Filter

Product          SKU       Warehouse   Available   Reserved   Inbound   Status
Organic Milk     MLK-101   Cebu Hub   18          4          24        Low stock
Bananas 1kg      BAN-011   Mandaue    0           0          60        Out of stock

Showing 1–25 of 428 products                                 ‹ 1 2 3 … 18 ›
```

## 15.2 Warehouse dashboard

```text
Cebu Hub                                           Export   Manage warehouse
Operational overview for today

12 orders may miss the 30-minute fulfillment target. Review orders

[Orders today 348] [Picking 42] [Ready 28] [Late 9] [Utilization 82%]

Orders at risk
Inventory exceptions
Picker workload
Receiving schedule
```

## 15.3 Purchase order review

```text
Purchase order review
PO-2026-00182 · Metro Supplier Co.

Line item          Ordered   Received   Variance
Mineral Water      200       200        0
Instant Noodles    120       108        -12

Supplier details
Expected delivery
Receiving warehouse
Payment terms

Reject                    Approve and receive
```

---

## 16. Implementation Guidance

### Recommended component architecture

```text
AppShell
├── NavigationRail
├── ContextSidebar
├── TopBar
└── MainContent
    ├── PageHeader
    ├── AlertBanner
    ├── MetricRow
    ├── FilterToolbar
    ├── DataTable
    ├── DetailPanel
    └── Pagination
```

### Reusable primitives

Build these first:

- Button
- IconButton
- Input
- Select
- Checkbox
- Toggle
- Badge
- Tag
- Tabs
- SegmentedControl
- AlertBanner
- Card
- DataTable
- EmptyState
- Modal
- Drawer
- Tooltip
- DropdownMenu
- Pagination
- Skeleton
- Toast

### Suggested frontend stack

This system works well with:

- React or Next.js
- Tailwind CSS or CSS variables
- Radix UI primitives
- TanStack Table
- Lucide icons
- React Hook Form
- Zod validation

---

## 17. Final Visual Checklist

Before approving a screen, confirm:

- The primary action is clear
- The interface uses mostly neutral colors
- The page has consistent alignment
- Tables are compact but readable
- Status is not communicated by color alone
- Secondary information is visually quieter
- Empty states have one clear action
- Alerts are actionable
- Filters are easy to scan and remove
- Numeric data is aligned consistently
- Destructive actions are separated from routine actions
- Spacing follows the 4px system
- Components use consistent radii and borders
- The screen supports high-density operational use

---

## 18. Design Summary

The design should feel like a modern enterprise operations tool: precise, quiet, responsive, and highly structured. The dominant visual language is neutral white and gray surfaces, thin borders, compact controls, subtle blue interaction states, and semantic status colors. The application should make complex inventory, warehouse, and fulfillment workflows feel clear without oversimplifying the data.
