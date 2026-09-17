# Expand Referenced Entities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search on every Weclapp resource expands `includeReferencedEntities` onto each record, including `onlyId` collections like `purchaseOrders`, and rewrites the outgoing query so `.id` includes and missing `entity:id` properties still work.

**Architecture:** Two pure helpers in `nodes/Weclapp/referencedEntities.ts` — `normalizeReferencedEntityQuery` rewrites search query pairs before the HTTP call; `buildReferenceIndex` + `resolveReferencedEntities` walk each result record and inline pool matches. `Weclapp.node.ts` search calls both; paging and pool merge stay in `transport/request.ts`.

**Tech Stack:** TypeScript, Jest (`ts-jest`), n8n `IDataObject` / `IExecuteFunctions`.

## Global Constraints

- Entity-agnostic: no OpenAPI field→entity map.
- Expand `onlyId` stubs in place; keep `*Id` scalars beside the expanded object.
- Unique-id fallback is conservative: only when no pool key was chosen from the field name, and only when the id appears in exactly one pool.
- An array item is a stub only when its only key is `id`. Rich nested rows are walked, never replaced.
- Query rewrite applies to Search only, not get-by-id / create / update / count.
- Do not git commit unless the user explicitly asks; skip each Commit step.

---

## File map

| File | Responsibility |
|---|---|
| Create: `nodes/Weclapp/referencedEntities.ts` | Query rewrite + pool index + per-record resolution |
| Create: `nodes/Weclapp/__tests__/referencedEntities.test.ts` | Unit tests for those helpers |
| Modify: `nodes/Weclapp/Weclapp.node.ts` | Search: normalize pairs; import helpers; delete inlined copies |
| Modify: `nodes/Weclapp/__tests__/node.test.ts` | Search integration: rewritten URL + expanded `purchaseOrders` |
| Modify: `README.md` | Document `onlyId` expansion and automatic `entity:id` |

---

### Task 1: Query rewrite helper

**Files:**
- Create: `nodes/Weclapp/referencedEntities.ts`
- Test: `nodes/Weclapp/__tests__/referencedEntities.test.ts`

**Interfaces:**
- Consumes: `QueryParamPairs` from `nodes/Weclapp/transport/request.ts` (`Array<[string, string | number]>`)
- Produces: `normalizeReferencedEntityQuery(pairs: QueryParamPairs): QueryParamPairs`

- [ ] **Step 1: Write the failing tests**

Create `nodes/Weclapp/__tests__/referencedEntities.test.ts`:

```typescript
import { normalizeReferencedEntityQuery } from '../referencedEntities';
import type { QueryParamPairs } from '../transport/request';

describe('normalizeReferencedEntityQuery', () => {
	it('strips .id / .ids from includeReferencedEntities and leaves unitId unchanged', () => {
		const pairs: QueryParamPairs = [
			['includeReferencedEntities', 'purchaseOrders.id,unitId,salesOrders.ids'],
		];
		expect(normalizeReferencedEntityQuery(pairs)).toEqual([
			['includeReferencedEntities', 'purchaseOrders,unitId,salesOrders'],
		]);
	});

	it('adds missing include fields and entity:id to properties, keeping user tokens', () => {
		const pairs: QueryParamPairs = [
			['includeReferencedEntities', 'purchaseOrders.id'],
			[
				'properties',
				'id,incomingGoodsNumber,status,incomingGoodsType,purchaseOrders,purchaseOrder:purchaseOrderNumber',
			],
		];
		const out = normalizeReferencedEntityQuery(pairs);
		expect(out.find(([k]) => k === 'includeReferencedEntities')?.[1]).toBe('purchaseOrders');
		const properties = String(out.find(([k]) => k === 'properties')?.[1]).split(',');
		expect(properties).toEqual([
			'id',
			'incomingGoodsNumber',
			'status',
			'incomingGoodsType',
			'purchaseOrders',
			'purchaseOrder:purchaseOrderNumber',
			'purchaseOrder:id',
		]);
	});

	it('adds the include field to properties when the user omitted it', () => {
		const pairs: QueryParamPairs = [
			['includeReferencedEntities', 'unitId'],
			['properties', 'id,articleNumber,unit:name'],
		];
		const properties = String(
			normalizeReferencedEntityQuery(pairs).find(([k]) => k === 'properties')?.[1],
		).split(',');
		expect(properties).toEqual(['id', 'articleNumber', 'unit:name', 'unitId', 'unit:id']);
	});

	it('does not rewrite relation filters', () => {
		const pairs: QueryParamPairs = [
			['status-eq', 'INCOMING_SHIPPED'],
			['purchaseOrders.purchaseOrderNumber-like', 'P%'],
			['includeReferencedEntities', 'purchaseOrders'],
		];
		expect(normalizeReferencedEntityQuery(pairs)).toEqual([
			['status-eq', 'INCOMING_SHIPPED'],
			['purchaseOrders.purchaseOrderNumber-like', 'P%'],
			['includeReferencedEntities', 'purchaseOrders'],
		]);
	});

	it('does not add a properties param when the user did not send one', () => {
		const pairs: QueryParamPairs = [['includeReferencedEntities', 'purchaseOrders.id']];
		expect(normalizeReferencedEntityQuery(pairs)).toEqual([
			['includeReferencedEntities', 'purchaseOrders'],
		]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest nodes/Weclapp/__tests__/referencedEntities.test.ts -v`

Expected: FAIL — `Cannot find module '../referencedEntities'`

- [ ] **Step 3: Write minimal implementation**

Create `nodes/Weclapp/referencedEntities.ts`:

```typescript
import type { IDataObject } from 'n8n-workflow';
import type { QueryParamPairs } from './transport/request';

function splitCsv(value: string): string[] {
	return value.split(',').map((token) => token.trim()).filter(Boolean);
}

function stripIdSuffix(token: string): string {
	if (token.endsWith('.ids')) return token.slice(0, -4);
	if (token.endsWith('.id')) return token.slice(0, -3);
	return token;
}

export function normalizeReferencedEntityQuery(pairs: QueryParamPairs): QueryParamPairs {
	const includeFields: string[] = [];
	const withIncludes = pairs.map(([key, value]): [string, string | number] => {
		if (key !== 'includeReferencedEntities') return [key, value];
		const tokens = splitCsv(String(value)).map(stripIdSuffix);
		includeFields.push(...tokens);
		return [key, tokens.join(',')];
	});

	return withIncludes.map(([key, value]) => {
		if (key !== 'properties') return [key, value];
		const tokens = splitCsv(String(value));
		const seen = new Set(tokens);
		const extra: string[] = [];
		for (const field of includeFields) {
			if (!seen.has(field)) {
				extra.push(field);
				seen.add(field);
			}
		}
		for (const token of tokens) {
			const colon = token.indexOf(':');
			if (colon <= 0) continue;
			const idToken = `${token.slice(0, colon)}:id`;
			if (!seen.has(idToken)) {
				extra.push(idToken);
				seen.add(idToken);
			}
		}
		return [key, [...tokens, ...extra].join(',')];
	});
}
```

Leave `IDataObject` imported; later tasks use it. If the linter flags an unused import, add a `export type ReferenceIndex` alias in this same file now:

```typescript
export type ReferenceIndex = Map<string, Map<unknown, IDataObject>>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest nodes/Weclapp/__tests__/referencedEntities.test.ts -v`

Expected: PASS (5 tests)

- [ ] **Step 5: Commit** (skip unless the user asked)

```bash
git add nodes/Weclapp/referencedEntities.ts nodes/Weclapp/__tests__/referencedEntities.test.ts
git commit -m "feat: rewrite includeReferencedEntities and properties on search"
```

---

### Task 2: Resolution helper

**Files:**
- Modify: `nodes/Weclapp/referencedEntities.ts`
- Test: `nodes/Weclapp/__tests__/referencedEntities.test.ts`

**Interfaces:**
- Consumes: `normalizeReferencedEntityQuery` from Task 1; Weclapp `referencedEntities` pool shape `{ [entityName: string]: IDataObject[] }`
- Produces:
  - `export type ReferenceIndex = Map<string, Map<unknown, IDataObject>>`
  - `buildReferenceIndex(pool: IDataObject): ReferenceIndex`
  - `resolveReferencedEntities(record: IDataObject, index: ReferenceIndex, visited?: WeakSet<object>): IDataObject`

- [ ] **Step 1: Append the failing tests** to `nodes/Weclapp/__tests__/referencedEntities.test.ts`

Add this import next to the existing one:

```typescript
import {
	buildReferenceIndex,
	normalizeReferencedEntityQuery,
	resolveReferencedEntities,
} from '../referencedEntities';
import type { IDataObject } from 'n8n-workflow';
```

Append:

```typescript
describe('resolveReferencedEntities', () => {
	it('inlines *Id into a sibling and keeps the foreign key', () => {
		const index = buildReferenceIndex({
			unit: [{ id: '2770', name: 'Stk.' }],
		});
		expect(resolveReferencedEntities({ id: '1001', unitId: '2770' }, index)).toEqual({
			id: '1001',
			unitId: '2770',
			unit: { id: '2770', name: 'Stk.' },
		});
	});

	it('expands onlyId stubs in place from the singular pool name', () => {
		const index = buildReferenceIndex({
			purchaseOrder: [{ id: '1', purchaseOrderNumber: 'P-100' }],
		});
		const record: IDataObject = {
			id: 'ig1',
			purchaseOrders: [{ id: '1' }],
		};
		expect(resolveReferencedEntities(record, index)).toEqual({
			id: 'ig1',
			purchaseOrders: [{ id: '1', purchaseOrderNumber: 'P-100' }],
		});
	});

	it('does not hunt other pools when a named pool was chosen but the id is missing', () => {
		const index = buildReferenceIndex({
			purchaseOrder: [{ id: '9', purchaseOrderNumber: 'P-9' }],
			salesOrder: [{ id: '1', orderNumber: 'SO-1' }],
		});
		const record: IDataObject = { purchaseOrders: [{ id: '1' }] };
		expect(resolveReferencedEntities(record, index)).toEqual({
			purchaseOrders: [{ id: '1' }],
		});
	});

	it('unique-id fallback expands when exactly one pool contains the id', () => {
		const index = buildReferenceIndex({
			shipmentReturnDescription: [{ id: 'r1', name: 'damaged' }],
		});
		const record: IDataObject = { returnAssessments: [{ id: 'r1' }] };
		expect(resolveReferencedEntities(record, index)).toEqual({
			returnAssessments: [{ id: 'r1', name: 'damaged' }],
		});
	});

	it('unique-id fallback leaves the stub when two pools contain the id', () => {
		const index = buildReferenceIndex({
			purchaseOrder: [{ id: '1', purchaseOrderNumber: 'P-1' }],
			salesOrder: [{ id: '1', orderNumber: 'SO-1' }],
		});
		const record: IDataObject = { mysteryRefs: [{ id: '1' }] };
		expect(resolveReferencedEntities(record, index)).toEqual({
			mysteryRefs: [{ id: '1' }],
		});
	});

	it('resolves nested *Id fields and does not replace rich nested rows', () => {
		const index = buildReferenceIndex({
			article: [{ id: 'a1', name: 'Widget' }],
			purchaseOrder: [{ id: '1', purchaseOrderNumber: 'P-1' }],
		});
		const record: IDataObject = {
			purchaseOrders: [{ id: '1' }],
			incomingGoodsItems: [{ id: 'line1', quantity: '2', articleId: 'a1' }],
		};
		expect(resolveReferencedEntities(record, index)).toEqual({
			purchaseOrders: [{ id: '1', purchaseOrderNumber: 'P-1' }],
			incomingGoodsItems: [
				{ id: 'line1', quantity: '2', articleId: 'a1', article: { id: 'a1', name: 'Widget' } },
			],
		});
	});

	it('leaves unmatched *Id values untouched', () => {
		const index = buildReferenceIndex({ unit: [{ id: '2770', name: 'Stk.' }] });
		expect(resolveReferencedEntities({ unitId: '999' }, index)).toEqual({ unitId: '999' });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest nodes/Weclapp/__tests__/referencedEntities.test.ts -v`

Expected: FAIL — `buildReferenceIndex` / `resolveReferencedEntities` are not exported functions.

- [ ] **Step 3: Write minimal implementation**

Append to `nodes/Weclapp/referencedEntities.ts` (keep the Task 1 exports):

```typescript
export type ReferenceIndex = Map<string, Map<unknown, IDataObject>>;

export function buildReferenceIndex(pool: IDataObject): ReferenceIndex {
	const index: ReferenceIndex = new Map();
	for (const [entityName, entities] of Object.entries(pool)) {
		if (!Array.isArray(entities)) continue;
		const byId = new Map<unknown, IDataObject>();
		for (const entity of entities as IDataObject[]) {
			if (entity && entity.id !== undefined) byId.set(entity.id, entity);
		}
		index.set(entityName, byId);
	}
	return index;
}

function isOnlyIdStub(value: unknown): value is IDataObject {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value as object).length === 1 &&
		(value as IDataObject).id !== undefined
	);
}

function namedPoolForCollection(field: string, index: ReferenceIndex): Map<unknown, IDataObject> | undefined {
	const exact = index.get(field);
	if (exact) return exact;
	if (field.endsWith('s')) {
		const singular = index.get(field.slice(0, -1));
		if (singular) return singular;
	}
	return undefined;
}

function uniquePoolMatch(id: unknown, index: ReferenceIndex): IDataObject | undefined {
	let found: IDataObject | undefined;
	for (const byId of index.values()) {
		const match = byId.get(id);
		if (!match) continue;
		if (found) return undefined;
		found = match;
	}
	return found;
}

function lookupStub(
	id: unknown,
	namedPool: Map<unknown, IDataObject> | undefined,
	index: ReferenceIndex,
): IDataObject | undefined {
	if (namedPool) return namedPool.get(id);
	return uniquePoolMatch(id, index);
}

export function resolveReferencedEntities(
	record: IDataObject,
	index: ReferenceIndex,
	visited: WeakSet<object> = new WeakSet(),
): IDataObject {
	if (visited.has(record)) return record;
	visited.add(record);
	const resolved: IDataObject = { ...record };

	for (const [field, value] of Object.entries(record)) {
		if (field.endsWith('Ids') && Array.isArray(value)) {
			const byId = index.get(field.slice(0, -3));
			if (byId) {
				resolved[field.slice(0, -3)] = value.map((id) => {
					const match = byId.get(id);
					return match ? resolveReferencedEntities(match, index, visited) : id;
				});
			}
		} else if (field.endsWith('Id') && (typeof value === 'string' || typeof value === 'number')) {
			const byId = index.get(field.slice(0, -2));
			const match = byId?.get(value);
			if (match) resolved[field.slice(0, -2)] = resolveReferencedEntities(match, index, visited);
		} else if (Array.isArray(value)) {
			const namedPool = namedPoolForCollection(field, index);
			resolved[field] = value.map((item) => {
				if (isOnlyIdStub(item)) {
					const match = lookupStub(item.id, namedPool, index);
					return match ? resolveReferencedEntities(match, index, visited) : item;
				}
				if (item && typeof item === 'object' && !Array.isArray(item)) {
					return resolveReferencedEntities(item as IDataObject, index, visited);
				}
				return item;
			});
		} else if (value && typeof value === 'object') {
			resolved[field] = resolveReferencedEntities(value as IDataObject, index, visited);
		}
	}

	return resolved;
}
```

If Task 1 already declared `export type ReferenceIndex`, do not duplicate it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest nodes/Weclapp/__tests__/referencedEntities.test.ts -v`

Expected: PASS (all query rewrite + resolution tests)

- [ ] **Step 5: Commit** (skip unless the user asked)

```bash
git add nodes/Weclapp/referencedEntities.ts nodes/Weclapp/__tests__/referencedEntities.test.ts
git commit -m "feat: resolve onlyId collections and nested referenced entities"
```

---

### Task 3: Wire helpers into Search

**Files:**
- Modify: `nodes/Weclapp/Weclapp.node.ts`
- Test: existing `nodes/Weclapp/__tests__/referencedEntities.test.ts` (no new tests required if helpers stay covered); run the full Jest suite after the wire-up

**Interfaces:**
- Consumes: `normalizeReferencedEntityQuery`, `buildReferenceIndex`, `resolveReferencedEntities` from `./referencedEntities`
- Produces: Search `customQuery` pairs are normalized before `weclappRequest` / `weclappRequestAll`. Count still uses raw `parseCustomQuery` only.

- [ ] **Step 1: Confirm current search does not rewrite the query**

In `nodes/Weclapp/__tests__/node.test.ts`, the helpers `makeExecuteContext` and `run` already exist. Add this test **before** changing the node (it should fail once wired, so write the assertion you want after the change, then implement):

```typescript
describe('Weclapp node - search referenced entities', () => {
	it('rewrites includeReferencedEntities and expands purchaseOrders in place', async () => {
		const { ctx, mockHttpRequest } = makeExecuteContext(
			{
				resource: 'incomingGoods',
				operation: 'search',
				customQuery:
					'status-eq=INCOMING_SHIPPED&incomingGoodsType-eq=STANDARD&purchaseOrders.purchaseOrderNumber-like=P%&includeReferencedEntities=purchaseOrders.id&properties=id,incomingGoodsNumber,status,incomingGoodsType,purchaseOrders,purchaseOrder:purchaseOrderNumber',
				returnAll: false,
				page: 1,
				pageSize: 100,
				sort: '-lastModifiedDate',
			},
			{
				statusCode: 200,
				body: {
					result: [
						{
							id: 'ig1',
							incomingGoodsNumber: 'WE-1',
							status: 'INCOMING_SHIPPED',
							incomingGoodsType: 'STANDARD',
							purchaseOrders: [{ id: 'po1' }],
						},
					],
					referencedEntities: {
						purchaseOrder: [{ id: 'po1', purchaseOrderNumber: 'P-100' }],
					},
				},
			},
		);
		const out = await run(ctx);
		const url = (mockHttpRequest.mock.calls[0][1] as { url: string }).url;
		expect(url).toContain('includeReferencedEntities=purchaseOrders');
		expect(url).not.toContain('purchaseOrders.id');
		expect(url).toContain('purchaseOrder%3Aid');
		expect(url).toContain('purchaseOrders.purchaseOrderNumber-like=P%25');
		expect(out[0].json.purchaseOrders).toEqual([{ id: 'po1', purchaseOrderNumber: 'P-100' }]);
	});
});
```

`URLSearchParams` encodes `:` as `%3A` and `%` as `%25`. If the assertion on `purchaseOrder%3Aid` fails because of encoding differences, decode the query and assert on the decoded string instead:

```typescript
const decoded = decodeURIComponent(url);
expect(decoded).toContain('purchaseOrder:id');
expect(decoded).toContain('includeReferencedEntities=purchaseOrders');
expect(decoded).not.toMatch(/includeReferencedEntities=purchaseOrders\.id/);
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx jest nodes/Weclapp/__tests__/node.test.ts -v`

Expected: FAIL — URL still contains `purchaseOrders.id` and/or `purchaseOrders` is still `[{ id: 'po1' }]` without `purchaseOrderNumber`.

- [ ] **Step 3: Wire the helpers**

In `nodes/Weclapp/Weclapp.node.ts`:

1. Add import:

```typescript
import {
	buildReferenceIndex,
	normalizeReferencedEntityQuery,
	resolveReferencedEntities,
} from './referencedEntities';
```

2. Delete the local `buildReferenceIndex` and `resolveReferencedEntities` functions (the block from the `weclapp's referencedEntities is a de-duplicated lookup pool` comment through the end of `resolveReferencedEntities`). Keep `parseCustomQuery`.

3. In the search branch, immediately after `if (customQuery) pairs.push(...parseCustomQuery(customQuery));` add:

```typescript
					const normalized = normalizeReferencedEntityQuery(pairs);
					pairs.length = 0;
					pairs.push(...normalized);
```

Do **not** call `normalizeReferencedEntityQuery` in the count branch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest nodes/Weclapp/__tests__/node.test.ts nodes/Weclapp/__tests__/referencedEntities.test.ts -v`

Expected: PASS

Then: `npx jest`

Expected: PASS (full suite)

- [ ] **Step 5: Commit** (skip unless the user asked)

```bash
git add nodes/Weclapp/Weclapp.node.ts nodes/Weclapp/__tests__/node.test.ts
git commit -m "feat: apply referenced-entity rewrite and resolution on search"
```

---

### Task 4: README

**Files:**
- Modify: `README.md` (section `##### Including referenced entities`)

**Interfaces:**
- Consumes: behavior from Tasks 1–3
- Produces: docs for `*Id` (unchanged shape), `onlyId` collections, `.id` stripping, automatic `entity:id`

- [ ] **Step 1: Replace the referenced-entities README section**

Keep the heading and the Weclapp docs link. Replace the body so it matches this:

````markdown
##### Including referenced entities

Weclapp can return referenced records in the same request. Add [`includeReferencedEntities`](https://www.weclapp.com/api/#overview--getting-started) to the **Custom Query** field with a comma-separated list of reference properties (`unitId`, `purchaseOrders`, …). A trailing `.id` / `.ids` is stripped (`purchaseOrders.id` → `purchaseOrders`).

```
includeReferencedEntities=unitId,articleCategoryId
```

Weclapp returns a single, de-duplicated `referencedEntities` pool shared across the whole result set — it is **not** aligned to individual records. The node resolves each record against that pool and does not attach the pool as a sidecar:

- A field named `<type>Id` is resolved to a sibling object under `<type>` (`unitId` → `unit`).
- A field named `<type>Ids` is resolved to a sibling array under `<type>`.
- An array of `{ "id" }` stubs (e.g. `purchaseOrders`) is **expanded in place** from the matching pool (`purchaseOrder`). Nested rows that already have other fields (e.g. `incomingGoodsItems`) are not replaced.

When **Return All** is enabled, the pool is merged across pages and de-duplicated by `id` before resolution.

If **properties** is set, the node adds any missing include fields and `entity:id` selectors so pooled records can be matched. You do not need to add `purchaseOrder:id` by hand.

**Example — article `*Id`:** Custom Query `includeReferencedEntities=unitId`

```json
{
  "id": "1001",
  "articleNumber": "EPM242J",
  "unitId": "2770",
  "unit": { "id": "2770", "name": "Stk." }
}
```

**Example — incoming goods `onlyId` collection:** Custom Query

```
status-eq=INCOMING_SHIPPED&purchaseOrders.purchaseOrderNumber-like=P%&includeReferencedEntities=purchaseOrders&properties=id,incomingGoodsNumber,purchaseOrders,purchaseOrder:purchaseOrderNumber
```

```json
{
  "id": "ig1",
  "incomingGoodsNumber": "WE-1",
  "purchaseOrders": [{ "id": "po1", "purchaseOrderNumber": "P-100" }]
}
```
````

- [ ] **Step 2: Skim the README for contradictions**

Confirm the old note that the user must include `unit:id` themselves is gone or replaced by the automatic-`entity:id` sentence.

- [ ] **Step 3: Commit** (skip unless the user asked)

```bash
git add README.md
git commit -m "docs: describe onlyId referenced-entity expansion"
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| `normalizeReferencedEntityQuery` helper | 1 |
| Strip `.id` / `.ids`; do not invent include tokens | 1 |
| Add include fields + `entity:id` only when `properties` exists | 1 |
| Leave relation filters untouched | 1 |
| `buildReferenceIndex` + `resolveReferencedEntities` | 2 |
| `*Id` / `*Ids` unchanged, no unique-id fallback | 2 |
| `onlyId` stubs expanded in place; singular pool name | 2 |
| Named pool miss does not hunt other pools | 2 |
| Conservative unique-id fallback (exactly one pool) | 2 |
| Nested `*Id`; rich rows not replaced | 2 |
| Unmatched values left untouched | 2 |
| Search-only wire-up; count unchanged | 3 |
| Incoming-goods integration: URL + expanded POs | 3 |
| Empty result + pool fallback stays in the node | 3 (untouched existing branch) |
| README `*Id` + `onlyId` + auto `entity:id` | 4 |
| No OpenAPI map; get-by-id/create/update/count out of scope | all |
