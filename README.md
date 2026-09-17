# n8n-nodes-weclapp

An [n8n](https://n8n.io/) community node for the [Weclapp](https://www.weclapp.com/) ERP/CRM platform. It lets you read and write Weclapp data — customers, orders, articles, shipments, documents, and more — directly from your n8n workflows, and react to Weclapp events in real time with the built-in trigger node.

## Installation

In your n8n instance, open **Settings → Community Nodes → Install** and enter:

```
n8n-nodes-weclapp
```

n8n will install the package and restart. The **Weclapp** and **Weclapp Trigger** nodes will appear in the node palette.

> Requires n8n ≥ 0.187.0 (community node support).

## Credentials

1. Log in to your Weclapp account.
2. Click your avatar (top-right) → **My Settings → API**.
3. Copy your **API token**.
4. In n8n, create a new **Weclapp API** credential:
   - **Subdomain** — the part before `.weclapp.com` in your URL (e.g. `mycompany` for `mycompany.weclapp.com`).
   - **API Token** — the token you copied above.

n8n will test the credential automatically against the `/user/count` endpoint.

## Weclapp Node

Performs CRUD operations on the following Weclapp resources:

| Resource | Create | Get by ID | Search | Count | Update | Delete | Download |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Party (Customer / Contact) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Article | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Article Category | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Sales Order | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Quotation | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Sales Invoice | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Sales Open Item | | ✓ | ✓ | ✓ | | ✓ | |
| Shipment | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Purchase Order | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Purchase Invoice | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Incoming Goods | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Comment | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Currency | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Document | | ✓ | ✓ | ✓ | | | ✓ |
| Manufacturer | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Accounting Transaction | | ✓ | ✓ | ✓ | | | |
| Variant Article | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Warehouse Stock | | ✓ | ✓ | ✓ | | | |
| Warehouse Stock Movement | | ✓ | ✓ | ✓ | | | |
| User | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |

> **Read-only resources** — Document, Accounting Transaction, Warehouse Stock, and Warehouse Stock Movement do not support Create, Update, or Delete.

### Operations

#### Get by ID

Fetches a single record by its Weclapp internal ID.

**Example — look up a customer:**
- Resource: `Party (Customer / Contact)`
- Operation: `Get by ID`
- Record ID: `{{ $json.partyId }}`

#### Search

Returns a list of records, with optional filtering, sorting, and pagination.

**Fields:**
- **Custom Query** — Weclapp filter syntax, e.g. `salesChannel-eq=NET1&createdDate-gt=1700000000000`. Multiple conditions are ANDed by default; use `or-`/`orGroupN-` prefixes for OR logic (see [Weclapp Query Syntax](#weclapp-query-syntax)).
- **Sort** — field name, prefix with `-` for descending, e.g. `-lastModifiedDate`.
- **Return All** — when enabled, fetches every page automatically. When disabled, use **Page** and **Page Size** to paginate manually.

**Example — find all open sales orders modified in the last hour:**
- Resource: `Sales Order`
- Operation: `Search`
- Custom Query: `orderStatusId-eq=OPEN&lastModifiedDate-gt={{ Date.now() - 3600000 }}`
- Return All: `true`

**Example — search for a customer by number:**
- Resource: `Party (Customer / Contact)`
- Custom Query: `customerNumber-eq=K10001`

##### Including referenced entities

Weclapp can return referenced records in the same request. Add [`includeReferencedEntities`](https://www.weclapp.com/api/#overview--getting-started) to the **Custom Query** field with a comma-separated list of **reference property paths**: `*Id` fields (`unitId`) or collection PK paths (`purchaseOrders.id`). Do not send the collection name alone (`purchaseOrders`) — Weclapp rejects that as an invalid reference property path.

```
includeReferencedEntities=unitId,articleCategoryId
```

Collection example:

```
includeReferencedEntities=purchaseOrders.id
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
status-eq=INCOMING_SHIPPED&purchaseOrders.purchaseOrderNumber-like=P%&includeReferencedEntities=purchaseOrders.id&properties=id,incomingGoodsNumber,purchaseOrders,purchaseOrder:purchaseOrderNumber
```

```json
{
  "id": "ig1",
  "incomingGoodsNumber": "WE-1",
  "purchaseOrders": [{ "id": "po1", "purchaseOrderNumber": "P-100" }]
}
```

##### Requesting additional properties

Some Weclapp fields are calculated or complexly determined and must be explicitly requested. Add [`additionalProperties`](https://www.weclapp.com/api/#overview--getting-started) to the **Custom Query** field with a comma-separated list of property names:

```
additionalProperties=currentSalesPrice
```

Weclapp returns an `additionalProperties` object where each property holds an array whose index aligns with the matching entity. The node maps each record's slice back onto that record under an `additionalProperties` key, so every item carries its own values. When **Return All** is enabled, the arrays are concatenated across pages in order to preserve that alignment.

**Example output** for `article` with Custom Query `additionalProperties=currentSalesPrice`:

```json
{
  "id": "1001",
  "articleNumber": "EPM242J",
  "additionalProperties": {
    "currentSalesPrice": {
      "articleUnitPrice": "39.95",
      "currencyId": "256",
      "quantity": "1",
      "reductionAdditionItems": []
    }
  }
}
```

#### Count

Returns the number of records matching an optional filter, without fetching the records themselves. Accepts the same **Custom Query** filter syntax as Search (and the required entity filters for Comment / Document). The output is a single item `{ "count": <number> }`.

**Example — count open sales orders:**
- Resource: `Sales Order`
- Operation: `Count`
- Custom Query: `orderStatusId-eq=OPEN`

#### Create

Creates a new record. Map the fields you want to set in the **Additional Fields** section using n8n expressions or fixed values.

**Example — create a sales order:**
- Resource: `Sales Order`
- Operation: `Create`
- Additional Fields → `customerId`: `{{ $json.customerId }}`

#### Update

Updates an existing record by ID. Only the fields you map are sent — unset fields are left unchanged.

**Example — mark a shipment as dispatched:**
- Resource: `Shipment`
- Operation: `Update`
- Record ID: `{{ $json.id }}`
- Additional Fields → `status`: `SHIPPED`

#### Delete

Deletes a record by ID (available for writable resources only). Returns `{ "success": true, "id": "<id>" }` on success.

**Example — delete a quotation:**
- Resource: `Quotation`
- Operation: `Delete`
- Record ID: `{{ $json.id }}`

#### Dry Run

Create, Update, and Delete expose a **Dry Run** toggle. When enabled, Weclapp runs its business logic and validates the payload but **persists nothing** — useful for validating input before committing changes. On success the response is returned without meta properties (`id`, `version`, `createdDate`, `lastModifiedDate`).

#### Download Document

Downloads a Weclapp document as a binary file (available for the **Document** resource only). The binary output can be passed to a Write Binary File node or an email attachment.

**Example — attach a PDF invoice to an email:**
1. Weclapp node: Resource `Document`, Operation `Download Document`, Record ID `{{ $json.documentId }}`
2. Send Email node: attach `{{ $binary.data }}`

## Weclapp Trigger Node

Starts a workflow automatically whenever a Weclapp entity is created, updated, or deleted. It registers a webhook in Weclapp on activation and removes it on deactivation — no manual webhook setup required.

**Configuration:**
- **Resource** — the entity type to watch. Supports all writable resources: Party, Article, Article Category, Sales Order, Quotation, Sales Invoice, Sales Open Item, Shipment, Purchase Order, Purchase Invoice, Incoming Goods, Comment, Currency, Document, Manufacturer, Variant Article, Accounting Transaction, and more.
- **Events** — one or more of `Created`, `Updated`, `Deleted`.

**Example — notify Slack when a new sales order arrives:**
1. Weclapp Trigger: Resource `Sales Order`, Events `Created`
2. Slack node: post `New order {{ $json.orderNumber }} from {{ $json.customerName }}`

**Example — sync customer updates to a CRM:**
1. Weclapp Trigger: Resource `Party (Customer / Contact)`, Events `Updated`
2. HTTP Request node: `PUT https://crm.example.com/contacts/{{ $json.id }}`

**Example — alert on shipment deletion:**
1. Weclapp Trigger: Resource `Shipment`, Events `Deleted`
2. Send Email node: notify the logistics team

> **Tip:** Before your first live run, use n8n's **Pin Data** feature on the trigger node to capture a sample payload. This enables field autocompletion in downstream nodes (IF, Switch, Set, etc.) without waiting for a real event.

## Weclapp Query Syntax

The **Custom Query** field uses Weclapp's native filter format:

```
fieldName-operator=value&anotherField-operator=value
```

Common operators:

| Operator | Meaning |
|---|---|
| `eq` | equals |
| `ne` | not equals |
| `lt` / `gt` | less / greater than |
| `le` / `ge` | less / greater than or equal |
| `like` | wildcard match (`%` = any chars) |
| `null` | field is null (`true`/`false`) |

Timestamps are Unix milliseconds (e.g. `1700000000000`).

### OR conditions

By default, multiple conditions are combined with AND. To combine conditions with OR, prefix them with `or-`:

```
or-name-eq=charlie&or-name-eq=chaplin
```

To mix AND and OR, assign conditions to numbered groups with `orGroupN-`. Conditions **within the same group** are ORed together, and separate groups are ANDed with each other:

```
orGroup1-shippingCarrierId-eq=213305372&orGroup1-shippingCarrierId-eq=113291681&orGroup2-status-eq=CANCELLED&orGroup2-status-eq=INCOMING_CANCELLED
```

This matches records whose carrier is one of the two IDs **and** whose status is `CANCELLED` or `INCOMING_CANCELLED`. Repeating the same key is required and fully supported — every value is sent to Weclapp.

> **Note:** Weclapp only allows filtering on filterable properties; computed `*Name` fields (e.g. `shippingCarrierName`) are generally not filterable in API v2 — filter by the corresponding `*Id` instead. Unknown *filter* properties are silently ignored by Weclapp, but unknown `sort` or `properties` values return an error. When Weclapp rejects a request, the node surfaces its exact message and the offending parameter.

See the [Weclapp API documentation](https://www.weclapp.com/api/) for the full list of filterable fields per entity.

## License

MIT — see [LICENSE](./LICENSE).
