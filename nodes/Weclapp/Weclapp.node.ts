import {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
	ResourceMapperFields,
	ResourceMapperValue,
} from 'n8n-workflow';

import {
	appendQuery,
	QueryParamPairs,
	weclappBinaryRequest,
	weclappRequest,
	weclappRequestAll,
} from './transport/request';
import {
	dryRunField,
	getByIdFields,
	operationOptions,
	READ_ONLY_RESOURCES,
	resourceOptions,
	searchFields,
} from './descriptions/shared';
import { partyCreateUpdateFields } from './descriptions/party';
import {
	quotationCreateUpdateFields,
	SALES_ENTITY_DATE_FIELDS,
	SALES_ENTITY_RESOURCES,
	salesInvoiceCreateUpdateFields,
	salesOpenItemCreateUpdateFields,
	salesOrderCreateUpdateFields,
} from './descriptions/salesEntities';
import {
	incomingGoodsCreateUpdateFields,
	PURCHASE_ENTITY_DATE_FIELDS,
	PURCHASE_ENTITY_RESOURCES,
	purchaseInvoiceCreateUpdateFields,
	purchaseOrderCreateUpdateFields,
	shipmentCreateUpdateFields,
} from './descriptions/purchaseEntities';
import {
	articleCategoryCreateUpdateFields,
	articleCreateUpdateFields,
	commentCreateUpdateFields,
	currencyCreateUpdateFields,
	entitySearchFilterFields,
	manufacturerCreateUpdateFields,
	OTHER_ENTITY_DATE_FIELDS,
	OTHER_ENTITY_RESOURCES,
	userCreateUpdateFields,
	variantArticleCreateUpdateFields,
} from './descriptions/remainingEntities';
import {
	buildReferenceIndex,
	normalizeReferencedEntityQuery,
	resolveReferencedEntities,
} from './referencedEntities';
import * as loadOptionsMethods from './methods/loadOptions';
import {
	buildWeclappCustomAttributes,
	getCustomAttributesForAccountingTransaction,
	getCustomAttributesForArticle,
	getCustomAttributesForArticleCategory,
	getCustomAttributesForComment,
	getCustomAttributesForCurrency,
	getCustomAttributesForDocument,
	getCustomAttributesForIncomingGoods,
	getCustomAttributesForManufacturer,
	getCustomAttributesForParty,
	getCustomAttributesForPurchaseInvoice,
	getCustomAttributesForPurchaseOrder,
	getCustomAttributesForQuotation,
	getCustomAttributesForSalesInvoice,
	getCustomAttributesForSalesOpenItem,
	getCustomAttributesForSalesOrder,
	getCustomAttributesForShipment,
	getCustomAttributesForUser,
	getCustomAttributesForVariantArticle,
} from './methods/customAttributes';

function convertDateFieldsToMs(body: IDataObject, resource: string): void {
	const fields =
		SALES_ENTITY_DATE_FIELDS[resource] ??
		PURCHASE_ENTITY_DATE_FIELDS[resource] ??
		OTHER_ENTITY_DATE_FIELDS[resource] ??
		[];
	for (const field of fields) {
		const val = body[field];
		if (typeof val === 'string' && val) {
			const ms = new Date(val).getTime();
			if (!isNaN(ms)) body[field] = ms;
		}
	}
}

function parseCustomQuery(raw: string): QueryParamPairs {
	const pairs: QueryParamPairs = [];
	for (const pair of raw.split('&')) {
		const eqIdx = pair.indexOf('=');
		if (eqIdx === -1) continue;
		const key = pair.slice(0, eqIdx).trim();
		const value = pair.slice(eqIdx + 1).trim();
		if (key) pairs.push([key, value]);
	}
	return pairs;
}

export class Weclapp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Weclapp',
		name: 'weclapp',
		icon: 'file:weclapp.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with the Weclapp ERP/CRM API',
		defaults: {
			name: 'Weclapp',
		},
		usableAsTool: true,
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'weclappApi',
				required: true,
			},
		],
		properties: [
			resourceOptions,
			operationOptions,
			dryRunField,
			...getByIdFields,
			...searchFields,
			...entitySearchFilterFields,
			...partyCreateUpdateFields,
			...salesOrderCreateUpdateFields,
			...salesInvoiceCreateUpdateFields,
			...salesOpenItemCreateUpdateFields,
			...quotationCreateUpdateFields,
			...purchaseOrderCreateUpdateFields,
			...purchaseInvoiceCreateUpdateFields,
			...incomingGoodsCreateUpdateFields,
			...shipmentCreateUpdateFields,
			...articleCreateUpdateFields,
			...articleCategoryCreateUpdateFields,
			...commentCreateUpdateFields,
			...currencyCreateUpdateFields,
			...manufacturerCreateUpdateFields,
			...userCreateUpdateFields,
			...variantArticleCreateUpdateFields,
		],
	};

	methods = {
		loadOptions: loadOptionsMethods as Record<string, (this: ILoadOptionsFunctions) => Promise<INodePropertyOptions[]>>,
		resourceMapping: {
			getCustomAttributesForParty: getCustomAttributesForParty as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForSalesOrder: getCustomAttributesForSalesOrder as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForSalesInvoice: getCustomAttributesForSalesInvoice as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForSalesOpenItem: getCustomAttributesForSalesOpenItem as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForQuotation: getCustomAttributesForQuotation as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForPurchaseOrder: getCustomAttributesForPurchaseOrder as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForPurchaseInvoice: getCustomAttributesForPurchaseInvoice as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForIncomingGoods: getCustomAttributesForIncomingGoods as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForShipment: getCustomAttributesForShipment as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForArticle: getCustomAttributesForArticle as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForArticleCategory: getCustomAttributesForArticleCategory as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForComment: getCustomAttributesForComment as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForDocument: getCustomAttributesForDocument as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForAccountingTransaction: getCustomAttributesForAccountingTransaction as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForUser: getCustomAttributesForUser as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForCurrency: getCustomAttributesForCurrency as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForManufacturer: getCustomAttributesForManufacturer as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
			getCustomAttributesForVariantArticle: getCustomAttributesForVariantArticle as (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		if (
			READ_ONLY_RESOURCES.includes(resource) &&
			(operation === 'create' || operation === 'update' || operation === 'delete')
		) {
			throw new NodeOperationError(
				this.getNode(),
				`The "${resource}" resource does not support ${operation}.`,
			);
		}

		for (let i = 0; i < items.length; i++) {
			try {
				// ── Get by ID ──────────────────────────────────────────────────────────
				if (operation === 'getById') {
					const id = this.getNodeParameter('id', i) as string;
					if (!id) throw new NodeOperationError(this.getNode(), 'Record ID is required for the Get by ID operation.', { itemIndex: i });
					const result = await weclappRequest(this, 'GET', `/${resource}/id/${encodeURIComponent(id)}`);
					returnData.push({ json: result ?? {}, pairedItem: { item: i } });

				// ── Search ─────────────────────────────────────────────────────────────
				} else if (operation === 'search') {
					const customQuery = this.getNodeParameter('customQuery', i, '') as string;
					const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
					const sort = this.getNodeParameter('sort', i, '-lastModifiedDate') as string;

					const pairs: QueryParamPairs = [];
					if (sort) pairs.push(['sort', sort]);
					if (customQuery) pairs.push(...parseCustomQuery(customQuery));
					const normalized = normalizeReferencedEntityQuery(pairs);
					pairs.length = 0;
					pairs.push(...normalized);

					// comment and document require entityName + entityId as search params
					if (resource === 'comment' || resource === 'document') {
						const entityName = this.getNodeParameter('entityName', i, '') as string;
						const entityId = this.getNodeParameter('entityId', i, '') as string;
						if (entityName) pairs.push(['entityName', entityName]);
						if (entityId) pairs.push(['entityId', entityId]);
					}

					let records: IDataObject[];
					// weclapp returns `referencedEntities` as a top-level sibling of
					// `result` when the query includes `includeReferencedEntities`.
					let referencedEntities: IDataObject | undefined;
					// weclapp returns `additionalProperties` as a top-level sibling of
					// `result` when the query includes `additionalProperties`. It has the
					// shape `{ propertyName: value[] }` where each value's index aligns
					// with the entity at the same index in `result`.
					let additionalProperties: IDataObject | undefined;
					if (returnAll) {
						const queryResult = await weclappRequestAll(this, `/${resource}`, pairs);
						records = queryResult.records;
						referencedEntities = queryResult.referencedEntities;
						additionalProperties = queryResult.additionalProperties;
					} else {
						const page = this.getNodeParameter('page', i, 1) as number;
						const pageSize = this.getNodeParameter('pageSize', i, 100) as number;
						const endpoint = appendQuery(`/${resource}`, [...pairs, ['page', page], ['pageSize', pageSize]]);
						const result = await weclappRequest(this, 'GET', endpoint);
						records = ((result as IDataObject)?.result as IDataObject[]) ?? [];
						const refs = (result as IDataObject)?.referencedEntities;
						if (refs && typeof refs === 'object') {
							referencedEntities = refs as IDataObject;
						}
						const addl = (result as IDataObject)?.additionalProperties;
						if (addl && typeof addl === 'object') {
							additionalProperties = addl as IDataObject;
						}
					}

					// Build the id -> entity lookup once per page rather than per record.
					const refIndex = referencedEntities
						? buildReferenceIndex(referencedEntities)
						: undefined;
					records.forEach((record, idx) => {
						// Resolve each record's foreign keys against the shared pool so it
						// carries only its own references (e.g. its own shippingCarrier)
						// instead of the whole de-duplicated pool.
						const json: IDataObject = refIndex
							? resolveReferencedEntities(record, refIndex)
							: { ...record };
						// Attach only this record's slice of each additional property,
						// keyed by index as documented by weclapp.
						if (additionalProperties) {
							const perRecord: IDataObject = {};
							for (const [propertyName, values] of Object.entries(additionalProperties)) {
								if (Array.isArray(values)) perRecord[propertyName] = values[idx];
							}
							json.additionalProperties = perRecord;
						}
						returnData.push({ json, pairedItem: { item: i } });
					});

					// When the query only returned sibling data (no primary records)
					// still surface it so it isn't silently dropped.
					if (records.length === 0 && (referencedEntities || additionalProperties)) {
						returnData.push({
							json: {
								...(referencedEntities ? { referencedEntities } : {}),
								...(additionalProperties ? { additionalProperties } : {}),
							},
							pairedItem: { item: i },
						});
					}

				// ── Count ──────────────────────────────────────────────────────────────
				} else if (operation === 'count') {
					const customQuery = this.getNodeParameter('customQuery', i, '') as string;

					const pairs: QueryParamPairs = [];
					if (customQuery) pairs.push(...parseCustomQuery(customQuery));

					// comment and document require entityName + entityId as filters
					if (resource === 'comment' || resource === 'document') {
						const entityName = this.getNodeParameter('entityName', i, '') as string;
						const entityId = this.getNodeParameter('entityId', i, '') as string;
						if (entityName) pairs.push(['entityName', entityName]);
						if (entityId) pairs.push(['entityId', entityId]);
					}

					const endpoint = appendQuery(`/${resource}/count`, pairs);
					const result = await weclappRequest(this, 'GET', endpoint);
					const count = (result as IDataObject)?.result;
					returnData.push({
						json: { count: typeof count === 'string' ? Number(count) : count ?? 0 },
						pairedItem: { item: i },
					});

				// ── Create ─────────────────────────────────────────────────────────────
				} else if (operation === 'create') {
					const body = this.getNodeParameter('createFields', i, {}) as IDataObject;
					if (
						resource === 'party' ||
						SALES_ENTITY_RESOURCES.includes(resource) ||
						PURCHASE_ENTITY_RESOURCES.includes(resource) ||
						OTHER_ENTITY_RESOURCES.includes(resource)
					) {
						const customAttrsRMV = this.getNodeParameter('customAttributes', i, null) as ResourceMapperValue | null;
						const customAttrs = buildWeclappCustomAttributes(customAttrsRMV ?? { value: null });
						if (customAttrs.length > 0) body.customAttributes = customAttrs;
					}
					convertDateFieldsToMs(body, resource);
					const dryRun = this.getNodeParameter('dryRun', i, false) as boolean;
					const qs: IDataObject = { ignoreMissingProperties: true };
					if (dryRun) qs.dryRun = true;
					const result = await weclappRequest(this, 'POST', `/${resource}`, body, qs);
					returnData.push({ json: result ?? {}, pairedItem: { item: i } });

				// ── Update ─────────────────────────────────────────────────────────────
				} else if (operation === 'update') {
					const id = this.getNodeParameter('id', i) as string;
					if (!id) throw new NodeOperationError(this.getNode(), 'Record ID is required for the Update operation.', { itemIndex: i });
					const body = this.getNodeParameter('updateFields', i, {}) as IDataObject;
					if (
						resource === 'party' ||
						SALES_ENTITY_RESOURCES.includes(resource) ||
						PURCHASE_ENTITY_RESOURCES.includes(resource) ||
						OTHER_ENTITY_RESOURCES.includes(resource)
					) {
						const customAttrsRMV = this.getNodeParameter('customAttributes', i, null) as ResourceMapperValue | null;
						const customAttrs = buildWeclappCustomAttributes(customAttrsRMV ?? { value: null });
						if (customAttrs.length > 0) body.customAttributes = customAttrs;
					}
					convertDateFieldsToMs(body, resource);
					const dryRun = this.getNodeParameter('dryRun', i, false) as boolean;
					const qs: IDataObject = { ignoreMissingProperties: true };
					if (dryRun) qs.dryRun = true;
					const result = await weclappRequest(
						this, 'PUT', `/${resource}/id/${encodeURIComponent(id)}`, body, qs,
					);
					returnData.push({ json: result ?? {}, pairedItem: { item: i } });

				// ── Delete ─────────────────────────────────────────────────────────────
				} else if (operation === 'delete') {
					const id = this.getNodeParameter('id', i) as string;
					if (!id) throw new NodeOperationError(this.getNode(), 'Record ID is required for the Delete operation.', { itemIndex: i });
					const dryRun = this.getNodeParameter('dryRun', i, false) as boolean;
					const qs: IDataObject = {};
					if (dryRun) qs.dryRun = true;
					await weclappRequest(this, 'DELETE', `/${resource}/id/${encodeURIComponent(id)}`, undefined, qs);
					returnData.push({
						json: { success: true, id, ...(dryRun ? { dryRun: true } : {}) },
						pairedItem: { item: i },
					});

				// ── Download Document ──────────────────────────────────────────────────
				} else if (operation === 'downloadDocument') {
					if (resource !== 'document') {
						throw new NodeOperationError(
							this.getNode(),
							`The "downloadDocument" operation is only supported for the "document" resource.`,
							{ itemIndex: i },
						);
					}
					const id = this.getNodeParameter('id', i) as string;
					if (!id) throw new NodeOperationError(this.getNode(), 'Record ID is required for the Download Document operation.', { itemIndex: i });

					const binary = await weclappBinaryRequest(this, `/document/id/${encodeURIComponent(id)}/download`);
					if (!binary) {
						returnData.push({ json: { error: 'Document not found' }, pairedItem: { item: i } });
						continue;
					}

					const fileNameMatch = binary.contentDisposition.match(/filename[^;=\n]*=\s*(["']?)([^"'\n;]*)\1/);
					const fileName = fileNameMatch?.[2]?.trim() || `document-${id}`;

					const binaryData = await this.helpers.prepareBinaryData(binary.buffer, fileName, binary.contentType);
					returnData.push({
						json: { documentId: id, fileName, mimeType: binary.contentType },
						binary: { data: binaryData },
						pairedItem: { item: i },
					});

				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
