import {
	buildReferenceIndex,
	normalizeReferencedEntityQuery,
	resolveReferencedEntities,
} from '../referencedEntities';
import type { IDataObject } from 'n8n-workflow';
import type { QueryParamPairs } from '../transport/request';

describe('normalizeReferencedEntityQuery', () => {
	it('keeps includeReferencedEntities paths like purchaseOrders.id and leaves unitId unchanged', () => {
		const pairs: QueryParamPairs = [
			['includeReferencedEntities', 'purchaseOrders.id,unitId,salesOrders.ids'],
		];
		expect(normalizeReferencedEntityQuery(pairs)).toEqual([
			['includeReferencedEntities', 'purchaseOrders.id,unitId,salesOrders.ids'],
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
		expect(out.find(([k]) => k === 'includeReferencedEntities')?.[1]).toBe('purchaseOrders.id');
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
			['includeReferencedEntities', 'purchaseOrders.id'],
		];
		expect(normalizeReferencedEntityQuery(pairs)).toEqual([
			['status-eq', 'INCOMING_SHIPPED'],
			['purchaseOrders.purchaseOrderNumber-like', 'P%'],
			['includeReferencedEntities', 'purchaseOrders.id'],
		]);
	});

	it('does not add a properties param when the user did not send one', () => {
		const pairs: QueryParamPairs = [['includeReferencedEntities', 'purchaseOrders.id']];
		expect(normalizeReferencedEntityQuery(pairs)).toEqual([
			['includeReferencedEntities', 'purchaseOrders.id'],
		]);
	});

	it('adds the collection field to properties from an include path, not the .id path itself', () => {
		const pairs: QueryParamPairs = [
			['includeReferencedEntities', 'purchaseOrders.id'],
			['properties', 'id,incomingGoodsNumber'],
		];
		const properties = String(
			normalizeReferencedEntityQuery(pairs).find(([k]) => k === 'properties')?.[1],
		).split(',');
		expect(properties).toEqual(['id', 'incomingGoodsNumber', 'purchaseOrders']);
	});
});

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
