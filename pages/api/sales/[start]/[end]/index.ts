// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from 'next'
import { Client, Environment, ApiError } from "square";
import Airtable from "airtable"

interface OrderItemSummary {
  "square_object_id": string | undefined
  "quantity": number
  "profit": number | undefined
  "unit_cost": number | undefined
}

interface OrderSummary {
  "net_recieved": number,
  "items": OrderItemSummary[]
  "profit": number
}

interface SalesSummary {
  "profit": number,
  "net_recieved": number,
  "orders": OrderSummary[],
}


export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SalesSummary>
) {
  // Create a client for the Square API
  const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production
  });

  // Scream if we don't have a location
  if (!process.env.SQUARE_LOCATION_ID) {
    throw new Error("Square location ID not defined")
  }

  // Extract start and end times from path
  const { start, end } = req.query

  // If they aren't strings somehow, scream
  if (typeof start !== "string" || typeof end !== "string") {
    throw new Error("Invalid start/end time")
  }

  // Get orders at the location within the timeframe given
  const squareOrders = await client.ordersApi.searchOrders({
    locationIds: [process.env.SQUARE_LOCATION_ID],
    query: {
      filter: {
        dateTimeFilter: {
          createdAt: {
            startAt: new Date(start).toISOString(),
            endAt: new Date(end).toISOString()
          }
        }
      }
    }
  })

  if (!squareOrders.result.orders) {
    throw new Error("No orders in period")
  }

  // Set a JSON seralizer for BigInt types
  BigInt.prototype.toJSON = function () { return Number(this) }

  // Get item data from airtable
  const airtable = new Airtable()
  const results = await airtable.base(process.env.AIRTABLE_BASE_ID ?? '').table(process.env.AIRTABLE_ITEMS_TABLE_ID ?? '').select({ filterByFormula: "{Supplier}='Booker'" }).all()
  const airtableItemDetails = results.map(airtableItem => {
    return {
      "sku": String(airtableItem.get("Square Catalog ID")),
      "unit_cost_inc_vat": Number(airtableItem.get("Unit Price")) ?? 0,
    }
  })

  // Get item data from square
  const catalogVariationObjectIds = squareOrders.result.orders.map(order => order.lineItems?.map(item => item.catalogObjectId)).flat().filter(id => typeof id == 'string') as string[]
  const catalogVariationResponse = await client.catalogApi.batchRetrieveCatalogObjects({
    objectIds: catalogVariationObjectIds
  })

  // Map square variations to airtable items
  interface ISquareAirtableMap {
    [k: string]: {
      sku: string,
      unit_cost_inc_vat: number
    }
  }
  const squareAirtableMap: ISquareAirtableMap = Object.fromEntries(catalogVariationResponse.result.objects?.map(object => {
    const airtableItem = airtableItemDetails.find(airtableItem => airtableItem.sku == object.itemVariationData?.itemId)
    if (!airtableItem) {
      if (object.itemVariationData?.sku == "RNDUP") return [object.id, { "sku": "RNDUP", "unit_cost_inc_vat": 0 }]
      throw new Error(`Unable to find airtable item with ID ${object.itemVariationData?.itemId}`)
    }
    return [object.id, airtableItem]
  }) || []
  )

  // Map orders into summaries
  const orderSummaries = squareOrders.result.orders?.map(order => {
    const totalTendered = order.tenders?.reduce((a, b) => a + Number(b.amountMoney?.amount), 0) ?? 0;
    const totalSquareFees = order.tenders?.reduce((a, b) => a + Number(b.processingFeeMoney?.amount), 0) ?? 0;

    const itemSummaries: OrderItemSummary[] = order.lineItems?.map(item => {

      let unitCost: number | undefined = 0;

      // If there is a catalog object ID for the item, we'll try and get data from airtable
      if (item.catalogObjectId) {
        const airtableItem = squareAirtableMap[item.catalogObjectId]
        unitCost = undefined;
        if (airtableItem) {
          unitCost = 100 * airtableItem.unit_cost_inc_vat
        }
      } else if (item.itemType !== "CUSTOM_AMOUNT") {
        // If the item doesn't have an ID, and isn't a custom amount, scream
        throw new Error(`Item does not have a catalog ID (${item.name})`)
      }

      const lineUnitCost = (unitCost ?? 0) * Number(item.quantity)
      const proportionalSquareFee = totalTendered > 0 ? totalSquareFees * (Number(item.totalMoney?.amount) / totalTendered) : 0

      return {
        "square_object_id": item.catalogObjectId || undefined,
        "quantity": Number(item.quantity),
        "unit_cost": unitCost !== undefined ? Math.round(unitCost) : undefined,
        "total_money": item.totalMoney?.amount ?? 0,
        "fee": Math.round(proportionalSquareFee),
        "profit": unitCost !== undefined ? Math.round(Number(item.totalMoney?.amount) - lineUnitCost - proportionalSquareFee) : undefined // Profit = Total Money From Customer - Line Unit Cost - Proportional Square Fee
      }
    }) || []

    return {
      "net_recieved": totalTendered - totalSquareFees,
      "profit": itemSummaries.reduce((a, b) => a + (b.profit ?? 0), 0),
      "items": itemSummaries,
    }
  })

  res.status(200).json({
    "orders": orderSummaries,
    "profit": orderSummaries.reduce((a, b) => a + b.profit, 0),
    "net_recieved": orderSummaries.reduce((a, b) => a + b.net_recieved, 0)
  })
}
