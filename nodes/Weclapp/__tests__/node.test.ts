import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { Weclapp } from '../Weclapp.node';

type Params = Record<string, unknown>;

interface HttpResponse {
	statusCode: number;
	body: unknown;
	headers?: Record<string, string>;
}

function makeExecuteContext(params: Params, response: HttpResponse = { statusCode: 200, body: {} }) {
	const mockHttpRequest = jest.fn().mockResolvedValue(response);
	const ctx = {
		getInputData: jest.fn().mockReturnValue([{ json: {} }]),
		getNodeParameter: jest.fn((name: string, _itemIndex?: number, fallback?: unknown) => {
			if (name in params) return params[name];
			return fallback;
		}),
		getCredentials: jest.fn().mockResolvedValue({ subdomain: 'acme' }),
		continueOnFail: jest.fn().mockReturnValue(false),
		helpers: { httpRequestWithAuthentication: mockHttpRequest },
		getNode: jest.fn().mockReturnValue({
			id: 'n1',
			name: 'Weclapp',
			type: 'Weclapp',
			typeVersion: 1,
			position: [0, 0] as [number, number],
			parameters: {},
		}),
	} as unknown as IExecuteFunctions;
	return { ctx, mockHttpRequest };
}

async function run(ctx: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const node = new Weclapp();
	const result = await node.execute.call(ctx);
	return result[0];
}

describe('Weclapp node - count operation', () => {
	it('calls GET /{resource}/count and returns a numeric count', async () => {
		const { ctx, mockHttpRequest } = makeExecuteContext(
			{ resource: 'salesOrder', operation: 'count', customQuery: 'status-eq=OPEN' },
			{ statusCode: 200, body: { result: '42' } },
		);
		const out = await run(ctx);
		const opts = mockHttpRequest.mock.calls[0][1] as { method: string; url: string };
		expect(opts.method).toBe('GET');
		expect(opts.url).toContain('/salesOrder/count');
		expect(opts.url).toContain('status-eq=OPEN');
		expect(out).toEqual([{ json: { count: 42 }, pairedItem: { item: 0 } }]);
	});

	it('coerces a numeric result and defaults to 0 when missing', async () => {
		const { ctx } = makeExecuteContext(
			{ resource: 'article', operation: 'count' },
			{ statusCode: 200, body: {} },
		);
		const out = await run(ctx);
		expect(out[0].json).toEqual({ count: 0 });
	});

	it('includes entityName and entityId for the comment resource', async () => {
		const { ctx, mockHttpRequest } = makeExecuteContext(
			{ resource: 'comment', operation: 'count', entityName: 'salesOrder', entityId: '123' },
			{ statusCode: 200, body: { result: 3 } },
		);
		await run(ctx);
		const url = (mockHttpRequest.mock.calls[0][1] as { url: string }).url;
		expect(url).toContain('/comment/count');
		expect(url).toContain('entityName=salesOrder');
		expect(url).toContain('entityId=123');
	});
});

describe('Weclapp node - delete operation', () => {
	it('calls DELETE /{resource}/id/{id} and returns success', async () => {
		const { ctx, mockHttpRequest } = makeExecuteContext(
			{ resource: 'salesOrder', operation: 'delete', id: '789', dryRun: false },
			{ statusCode: 204, body: '' },
		);
		const out = await run(ctx);
		const opts = mockHttpRequest.mock.calls[0][1] as { method: string; url: string; qs?: object };
		expect(opts.method).toBe('DELETE');
		expect(opts.url).toBe('https://acme.weclapp.com/webapp/api/v2/salesOrder/id/789');
		expect(opts.qs).toBeUndefined();
		expect(out).toEqual([{ json: { success: true, id: '789' }, pairedItem: { item: 0 } }]);
	});

	it('adds dryRun=true and flags it in the output when enabled', async () => {
		const { ctx, mockHttpRequest } = makeExecuteContext(
			{ resource: 'salesOrder', operation: 'delete', id: '789', dryRun: true },
			{ statusCode: 200, body: '' },
		);
		const out = await run(ctx);
		const opts = mockHttpRequest.mock.calls[0][1] as { qs: { dryRun: boolean } };
		expect(opts.qs).toEqual({ dryRun: true });
		expect(out[0].json).toEqual({ success: true, id: '789', dryRun: true });
	});

	it('throws when the record ID is missing', async () => {
		const { ctx } = makeExecuteContext({ resource: 'salesOrder', operation: 'delete', id: '' });
		await expect(run(ctx)).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('rejects delete on a read-only resource', async () => {
		const { ctx } = makeExecuteContext({ resource: 'warehouseStock', operation: 'delete', id: '1' });
		await expect(run(ctx)).rejects.toBeInstanceOf(NodeOperationError);
	});
});

describe('Weclapp node - dryRun on create and update', () => {
	it('appends dryRun=true alongside ignoreMissingProperties on create', async () => {
		const { ctx, mockHttpRequest } = makeExecuteContext(
			{
				resource: 'currency',
				operation: 'create',
				createFields: { name: 'Test' },
				customAttributes: null,
				dryRun: true,
			},
			{ statusCode: 201, body: { id: '1' } },
		);
		await run(ctx);
		const opts = mockHttpRequest.mock.calls[0][1] as { method: string; qs: object };
		expect(opts.method).toBe('POST');
		expect(opts.qs).toEqual({ ignoreMissingProperties: true, dryRun: true });
	});

	it('omits dryRun on create when disabled', async () => {
		const { ctx, mockHttpRequest } = makeExecuteContext(
			{
				resource: 'currency',
				operation: 'create',
				createFields: { name: 'Test' },
				customAttributes: null,
				dryRun: false,
			},
			{ statusCode: 201, body: { id: '1' } },
		);
		await run(ctx);
		const opts = mockHttpRequest.mock.calls[0][1] as { qs: object };
		expect(opts.qs).toEqual({ ignoreMissingProperties: true });
	});

	it('appends dryRun=true on update', async () => {
		const { ctx, mockHttpRequest } = makeExecuteContext(
			{
				resource: 'currency',
				operation: 'update',
				id: '5',
				updateFields: { name: 'Test' },
				customAttributes: null,
				dryRun: true,
			},
			{ statusCode: 200, body: { id: '5' } },
		);
		await run(ctx);
		const opts = mockHttpRequest.mock.calls[0][1] as { method: string; url: string; qs: object };
		expect(opts.method).toBe('PUT');
		expect(opts.url).toContain('/currency/id/5');
		expect(opts.qs).toEqual({ ignoreMissingProperties: true, dryRun: true });
	});
});

describe('Weclapp node - search referenced entities', () => {
	it('keeps purchaseOrders.id on includeReferencedEntities and expands purchaseOrders in place', async () => {
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
		expect(url).toContain('includeReferencedEntities=purchaseOrders.id');
		expect(url).toContain('purchaseOrder%3Aid');
		expect(url).toContain('purchaseOrders.purchaseOrderNumber-like=P%25');
		expect(out[0].json.purchaseOrders).toEqual([{ id: 'po1', purchaseOrderNumber: 'P-100' }]);
	});
});
