# Product — Feature Reference

End-to-end reference for the Product / inventory feature: data model, stock rules, stats, backend endpoints, frontend wiring, and current implementation notes. Read this first when asked to work on product CRUD, stock decrement, product stats, or the All Products dashboard.

---

## 1. What this feature does

Lets a shop user manage a product catalog and inventory overview:

- **Create / edit / delete** products under `/dashboard/product/*`.
- **List** products with search, brand/HSN filters, pagination, and KPI cards at `/dashboard/product/all`.
- **View** product metadata, stock, pricing, and image thumbnails in the table.
- **Track stock** in a lightweight product-level `stock` field, backed by the inventory system.
- **Show shop-wide stats**: total products, total stock, out-of-stock count, inventory value.

This feature is hybrid: product cards are backed by the product document, while stock decrements are enforced atomically through the inventory service during order creation.

---

## 2. Backend data model

Products live under `backend/src/api/products/schema/product.schema.ts`.

### `Product` highlights

- `name` — display name, required.
- `sku` — product code / search key.
- `brand` — brand string used for page faceted filtering.
- `hsn` — HSN code for GST classification.
- `description` — optional details.
- `purchasePrice` — last purchase cost used for inventory value calculations.
- `sellPrice` — selling price shown in product list and order lines.
- `stock` — current physical inventory count.
- `measuringUnit` — unit label shown next to stock quantities.
- `images` — `MediaMetadata` references used for thumbnail previews.
- `shop` — owning shop tenant.
- `inventory` — array of inventory batch references, populated via the inventory service.

### Inventory / stock relationship

- `stock` is the denormalized, fast-access current count.
- `purchasePrice` and `stock` together drive `totalInventoryValue` in product stats.
- Actual batch inventory records are maintained by `backend/src/api/inventory/inventory.service.ts`.

---

## 3. Backend services & endpoints

Controller: `backend/src/api/products/product.controller.ts`, base path `shop/:shopId/product`.

| Method | Path          | Purpose                                                                                                                                                                  |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/stats`      | Shop-wide product KPI aggregation. Must be declared before `/:productId` in the controller to avoid Nest route collision with `stats` being interpreted as a product id. |
| GET    | `/:productId` | Retrieve one product (excludes `inventory`).                                                                                                                             |
| POST   | `/paginated`  | Paginated, searchable product list. Accepts `filter`, `sort`, `limit`, `page`.                                                                                           |
| POST   | `/`           | Create a product. Optional inventory batch data may be attached and persisted too.                                                                                       |
| PATCH  | `/:productId` | Update a product.                                                                                                                                                        |
| DELETE | `/:productId` | Remove a product.                                                                                                                                                        |

### `ProductService` behavior

- `createProduct(shopId, newProduct)`
  - Validates `shopId` as a Mongo ObjectId.
  - Creates the product document and optionally creates inventory batches via `InventoryService.addInventoryBulk`.
  - Updates the product's `inventory` reference array when new batches are added.

- `getProductById(productId)`
  - Returns the product without inventory details but with `images` populated.

- `getPaginatedProducts(shopId, query)`
  - Uses `ProductRepository.findWithPagination()`.
  - Filters by shop and any supplied server-side criteria.

- `updateProductById(productId, product)`
  - Validates the id and updates the document.

- `deleteProductById(productId)`
  - Deletes the product document by id.

- `getShopProductStats(shopId)`
  - Aggregates all products for the shop and returns:
    - `totalProducts`
    - `totalStock`
    - `outOfStockCount`
    - `totalInventoryValue`
  - Uses a `$match` + `$group` aggregation on the `products` collection.

- `assertAndDecrementStock(shopId, lines)`
  - Called from order creation to enforce inventory availability.
  - Uses conditional `$inc` updates with `stock: { $gte: quantity }`.
  - Rolls back any successful decrements if a later line fails.

### Important implementation note

- `backend/src/api/products/product.controller.ts` contains two `@Get('stats')` methods in the current code snapshot; the effective route must be the static `stats` handler placed before `@Get(':productId')`.
- If `stats` is declared after `:productId`, Nest matches the URL as a dynamic param and converts `stats` into an ObjectId, causing a `CastError`.

---

## 4. Frontend wiring

### API client

`frontend/src/shared/api/product.api.ts` exposes:

- `createProduct(shopId, product)`
- `getPaginatedProducts(shopId, limit, page, filter, sort)`
- `deleteProduct(shopId, productId)`
- `getProductStats(shopId)`
- `getProduct(shopId, productId)`
- `updateProduct(shopId, productId, product)`

`getProductStats()` calls `/api/v1/shop/${shopId}/product/stats`.

### React hooks

`frontend/src/features/product/hooks/use-product-stats.hook.ts`

- Fetches shop-level stats using React Query.
- Keeps `All Products` KPI cards in sync with the shop, not just the current page.

`frontend/src/features/product/hooks/use-get-paginated-products.hook.ts`

- Fetches page data with filters and search.

### All Products page

File: `frontend/src/pages/dashboard/product/all-products.page.tsx`

- Uses `usePaginatedProducts` and `useProductStats`.
- Shows KPI cards for `Products`, `Total Stock`, `Out of Stock`, and `Stock Value`.
- Falls back to page-derived totals when stats are not yet loaded.
- Supports:
  - debounced search across `name`, `sku`, and `brand`
  - server-side brand and HSN filters
  - pagination with `Pagination` component
  - edit/delete actions per row
  - table loading/fetching states with `LinearProgress` and skeletons
- Aligns visually with the existing All Customers KPI + paginated list pattern.

---

## 5. Known issues and current context

- The `stats` route is static and must not be shadowed by the dynamic `:productId` route.
- `stock` may be absent on some products; the page uses `0` default values in totals.
- Current frontend behavior is designed so KPI cards remain consistent even when the visible page is filtered or paginated.
- This doc is intended to help future LLMs preserve context around the product stats endpoint, route ordering, and the dashboard-style list page.

---

## 6. References

- Backend controller: `backend/src/api/products/product.controller.ts`
- Backend service: `backend/src/api/products/product.service.ts`
- Frontend API: `frontend/src/shared/api/product.api.ts`
- Frontend hook: `frontend/src/features/product/hooks/use-product-stats.hook.ts`
- Frontend page: `frontend/src/pages/dashboard/product/all-products.page.tsx`
