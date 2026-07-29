type TableName =
  | "inventory"
  | "inventoryPricing"
  | "batches"
  | "products"
  | "customers"
  | "orders"
  | "order_items"
  | "fulfillmentCenters"
  | "stores"
  | "delivery_zones"
  | "skus"
  | "prices"
  | "pricesActive"
  | "priceTransitions"
  | "productSearchTokens"
  | "customerSearchTokens"
  | "listCounts"
  | "transitionState"
  | "metricAggregates"
  | "support_tickets"
  | "promotions"
  | "product_similar_products"
  | "product_media"
  | "categories"
  | "brands"
  | "home_section_items"
  | "promotion_targets";

type Row = Record<string, unknown> & { _id: string };

interface IndexRangeBuilder {
  eq(field: string, value: unknown): IndexRangeBuilder;
  lt(field: string, value: unknown): IndexRangeBuilder;
  lte(field: string, value: unknown): IndexRangeBuilder;
  gt(field: string, value: unknown): IndexRangeBuilder;
  gte(field: string, value: unknown): IndexRangeBuilder;
}

interface SearchFilterBuilder {
  search(field: string, term: string): SearchFilterBuilder;
  eq(field: string, value: unknown): SearchFilterBuilder;
}

interface QueryStats {
  collect: Record<string, number>;
  first: Record<string, number>;
  get: Record<string, number>;
  documentsReturned: Record<string, number>;
}

function bump(map: Record<string, number>, key: string, count = 1) {
  map[key] = (map[key] ?? 0) + count;
}

function tableKey(table: string, index?: string) {
  return index ? `${table}.${index}` : table;
}

export class FakeConvexDb {
  readonly stats: QueryStats = {
    collect: {},
    first: {},
    get: {},
    documentsReturned: {},
  };

  private readonly rows: Record<string, Row[]>;
  private readonly byId = new Map<string, Row>();

  constructor(rows: Partial<Record<TableName, Row[]>>) {
    this.rows = rows;
    for (const tableRows of Object.values(rows)) {
      for (const row of tableRows ?? []) {
        this.byId.set(row._id, row);
      }
    }
  }

  async get(id: string) {
    const row = this.byId.get(id) ?? null;
    const table = row?._table ?? "unknown";
    bump(this.stats.get, table);
    return row;
  }

  query(table: TableName) {
    const constraints = new Map<string, unknown>();
    let indexName: string | undefined;
    const query = {
      withIndex: (
        name: string,
        range?: (q: IndexRangeBuilder) => IndexRangeBuilder,
      ) => {
        indexName = name;
        const builder: IndexRangeBuilder = {
          eq: (field: string, value: unknown) => {
            constraints.set(field, value);
            return builder;
          },
          lt: (field: string, value: unknown) => {
            constraints.set(`${field}:lt`, value);
            return builder;
          },
          lte: (field: string, value: unknown) => {
            constraints.set(`${field}:lte`, value);
            return builder;
          },
          gt: (field: string, value: unknown) => {
            constraints.set(`${field}:gt`, value);
            return builder;
          },
          gte: (field: string, value: unknown) => {
            constraints.set(`${field}:gte`, value);
            return builder;
          },
        };
        range?.(builder);
        return query;
      },
      withSearchIndex: (
        name: string,
        searchFilter: (q: SearchFilterBuilder) => SearchFilterBuilder,
      ) => {
        indexName = `search:${name}`;
        const builder: SearchFilterBuilder = {
          search: (field: string, term: string) => {
            constraints.set(`search:${field}`, term.toLowerCase());
            return builder;
          },
          eq: (field: string, value: unknown) => {
            constraints.set(field, value);
            return builder;
          },
        };
        searchFilter(builder);
        return query;
      },
      order: () => {
        return query;
      },
      collect: async () => {
        const key = tableKey(table, indexName);
        const out = this.applyConstraints(table, constraints);
        bump(this.stats.collect, key);
        bump(this.stats.documentsReturned, key, out.length);
        return out;
      },
      take: async (n: number) => {
        const key = tableKey(table, indexName);
        const out = this.applyConstraints(table, constraints).slice(0, n);
        bump(this.stats.collect, key);
        bump(this.stats.documentsReturned, key, out.length);
        return out;
      },
      paginate: async ({ numItems, cursor }: { numItems: number; cursor?: string | null }) => {
        const key = tableKey(table, indexName);
        const all = this.applyConstraints(table, constraints);
        const start = cursor ? Number(cursor) : 0;
        const page = all.slice(start, start + numItems);
        const next = start + page.length;
        bump(this.stats.collect, key);
        bump(this.stats.documentsReturned, key, page.length);
        return {
          page,
          isDone: next >= all.length,
          continueCursor: String(next),
          nextCursor: String(next),
        };
      },
      first: async () => {
        const key = tableKey(table, indexName);
        const out = this.applyConstraints(table, constraints)[0] ?? null;
        bump(this.stats.first, key);
        bump(this.stats.documentsReturned, key, out ? 1 : 0);
        return out;
      },
    };
    return query;
  }

  private applyConstraints(table: TableName, constraints: Map<string, unknown>) {
    return (this.rows[table] ?? []).filter((row) => {
      for (const [field, expected] of constraints) {
        if (field.startsWith("search:")) {
          const realField = field.slice(7);
          const haystack = String(row[realField] ?? "").toLowerCase();
          const tokens = String(expected).split(/\s+/).filter(Boolean);
          if (!tokens.every((token) => haystack.includes(token))) return false;
        } else if (field.endsWith(":lt")) {
          const realField = field.slice(0, -3);
          if (!(row[realField] < expected)) return false;
        } else if (field.endsWith(":lte")) {
          const realField = field.slice(0, -4);
          if (!(row[realField] <= expected)) return false;
        } else if (field.endsWith(":gt")) {
          const realField = field.slice(0, -3);
          if (!(row[realField] > expected)) return false;
        } else if (field.endsWith(":gte")) {
          const realField = field.slice(0, -4);
          if (!(row[realField] >= expected)) return false;
        } else if (row[field] !== expected) {
          return false;
        }
      }
      return true;
    });
  }
}

export function doc<T extends Row>(table: TableName, row: T): T {
  return { ...row, _table: table };
}
