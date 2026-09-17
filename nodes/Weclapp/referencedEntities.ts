import type { IDataObject } from 'n8n-workflow';
import type { QueryParamPairs } from './transport/request';

function splitCsv(value: string): string[] {
	return value.split(',').map((token) => token.trim()).filter(Boolean);
}

/** Weclapp include paths use `.id` (e.g. purchaseOrders.id); properties list the collection field. */
function sourceFieldFromIncludePath(token: string): string {
	if (token.endsWith('.ids')) return token.slice(0, -4);
	if (token.endsWith('.id')) return token.slice(0, -3);
	return token;
}

export function normalizeReferencedEntityQuery(pairs: QueryParamPairs): QueryParamPairs {
	const includeFields: string[] = [];
	const withIncludes = pairs.map(([key, value]): [string, string | number] => {
		if (key !== 'includeReferencedEntities') return [key, value];
		const tokens = splitCsv(String(value));
		includeFields.push(...tokens.map(sourceFieldFromIncludePath));
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
