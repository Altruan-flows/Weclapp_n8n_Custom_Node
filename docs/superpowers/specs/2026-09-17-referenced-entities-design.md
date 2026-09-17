# Expand referenced entities on all Weclapp resources

Date: 2026-09-17

## Problem

Weclapp search can return a top-level `referencedEntities` pool when the query includes `includeReferencedEntities`. The node already inlines `*Id` / `*Ids` foreign keys (e.g. `unitId` → `unit`) onto each record and drops the shared pool.

That misses Weclapp’s other reference shape: `onlyId` collections such as `incomingGoods.purchaseOrders`, `shipment.salesOrders`, and `purchaseInvoice.purchaseOrders`. Those stay as `[{ "id": "..." }]` even when the pool has the full records.

A typical incoming-goods query also fails before resolution:

```
includeReferencedEntities=purchaseOrders.id
properties=id,incomingGoodsNumber,status,incomingGoodsType,purchaseOrders,purchaseOrder:purchaseOrderNumber
```

`includeReferencedEntities` expects a primary-key field (`purchaseOrders`), not a path. `purchaseOrder:purchaseOrderNumber` without `purchaseOrder:id` leaves pooled objects with no `id`, so nothing can be matched.

Nested relation filters (`purchaseOrders.purchaseOrderNumber-like=P%`) only restrict which incoming goods are returned. They do not expand the PO.

## Decisions

- Expand `onlyId` collections **in place** (the stub array becomes the full referenced records).
- **Rewrite the outgoing search query** so common include/properties mistakes still work.
- Stay **entity-agnostic**: no OpenAPI field→entity map.
- Unique-id fallback is **conservative** (see Resolution).

Out of scope: get-by-id / create / update / count, attaching the raw pool as a sidecar, generating a spec map, irregular English plurals beyond dropping a trailing `s`.

## Architecture

Two pure helpers, used only by Search:

1. `normalizeReferencedEntityQuery(pairs)` — rewrite `includeReferencedEntities` and `properties` after `parseCustomQuery`.
2. `resolveReferencedEntities(record, index)` — walk each search record and inline matches.

Paging, pool merge, and `additionalProperties` stay in `transport/request.ts`. Put the helpers in a small module next to the node (e.g. `nodes/Weclapp/referencedEntities.ts`) so they can be unit-tested without executing the whole node.

## Request rewrite

Runs after `parseCustomQuery`, before the HTTP call. Other filters are unchanged.

### `includeReferencedEntities`

- Split on commas, trim.
- If a token ends with `.id` or `.ids`, strip that suffix (`purchaseOrders.id` → `purchaseOrders`).
- Do not add include tokens the user did not write.
- Rejoin and send once.

### `properties` (only if that param is already present)

- Keep every token the user wrote.
- For each rewritten include field, add it if missing so the record still has stubs / `*Id`s to expand.
- For each `entity:prop` token, add `entity:id` if missing.
- If `properties` is absent, add nothing (Weclapp already returns full objects).

Example. Input:

```
status-eq=INCOMING_SHIPPED&incomingGoodsType-eq=STANDARD&purchaseOrders.purchaseOrderNumber-like=P%&includeReferencedEntities=purchaseOrders.id&properties=id,incomingGoodsNumber,status,incomingGoodsType,purchaseOrders,purchaseOrder:purchaseOrderNumber
```

Sent to Weclapp:

```
status-eq=INCOMING_SHIPPED
incomingGoodsType-eq=STANDARD
purchaseOrders.purchaseOrderNumber-like=P%
includeReferencedEntities=purchaseOrders
properties=id,incomingGoodsNumber,status,incomingGoodsType,purchaseOrders,purchaseOrder:purchaseOrderNumber,purchaseOrder:id
```

## Resolution

Build the existing `entityName → id → entity` index from the (possibly page-merged) pool. Walk each record as a tree (top-level object and nested objects/arrays). Skip already-visited objects.

For each object:

1. **`*Id` / `*Ids`** — unchanged. Resolve only against a pool named `field` minus `Id`/`Ids`. Attach under that pool name. No unique-id fallback.
2. **`onlyId` stubs** — an array item is a stub only when it is an object whose **only** key is `id`. Rich nested rows (`incomingGoodsItems` with quantities, article ids, etc.) are never replaced; they are walked for `*Id` / nested stubs. Stub items are expanded in place. Choose the pool from the **array field name** as follows:
   - exact field name (`purchaseOrders`)
   - else drop a single trailing `s` only if that key exists in the index (`purchaseOrder`)
   - else **unique-id fallback**, and only then: fill an id only when it appears in **exactly one** pool. Zero matches or two or more pools → leave the stub.
3. If a pool key **was** chosen in (1) or (2) and that id is missing from it, leave the value unchanged. Do not hunt other pools.
4. No first-match, index alignment, or fuzzy names.

`*Id` scalars stay beside the expanded object (`unitId` + `unit`). `onlyId` collections are replaced in place (`purchaseOrders` becomes full POs).

Unmatched stubs stay stubs. If Weclapp returns a pool but no primary records, keep today’s fallback of surfacing the raw pool.

## Testing

Unit-test the two helpers (not private methods of `Weclapp`).

Query rewrite:

- `purchaseOrders.id` → `purchaseOrders`; `unitId` unchanged.
- `properties` with `purchaseOrder:purchaseOrderNumber` gains `purchaseOrder:id` and keeps `purchaseOrders`.
- Filters such as `purchaseOrders.purchaseOrderNumber-like=P%` are not rewritten.
- No `properties` param → no properties added.

Resolution:

- `unitId` still inlines `unit` and keeps `unitId`.
- `purchaseOrders: [{ id }]` expands in place from pool `purchaseOrder`.
- Named pool chosen but id missing → stub left; other pools are not searched.
- Unique-id fallback: one pool contains the id → expand; two pools contain it → stub.
- Nested `incomingGoodsItems[].articleId` still resolves when `article` is in the pool.
- Full nested rows (`incomingGoodsItems` with more than `id`) are not replaced by unique-id or name matching.
- Unmatched ids left untouched.

Search integration (mocked HTTP): incoming-goods custom query as in the example; assert the rewritten URL and that each item’s `purchaseOrders` entries include `purchaseOrderNumber`.

## README

Document both shapes:

- `*Id` example unchanged (`unitId` → `unit`).
- `onlyId` example: incoming goods + `includeReferencedEntities=purchaseOrders` (mention `.id` is accepted and stripped).
- Note that `entity:prop` no longer requires the user to add `entity:id` by hand; the node adds it when `properties` is present.
- Keep the explanation that the pool is de-duplicated and resolved per record, not attached as a sidecar.
