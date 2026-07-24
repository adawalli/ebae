import type { Item } from "@/lib/types";

// The full Item shape in one place, so a new field on Item is added here once instead of in
// every test file that builds one. Tests spread only the fields they assert on; the defaults
// cover the rest.
export function mkItem(over: Partial<Item> = {}): Item {
  return {
    itemId: "v1|1|0",
    title: "Sonos Era 300",
    price: 179.95,
    currency: "USD",
    shippingCost: 0,
    buyingOption: "FIXED_PRICE",
    condition: "Used",
    conditionId: "3000",
    imageUrl: null,
    itemUrl: "https://www.ebay.com/itm/1",
    itemEndDate: null,
    bestOffer: false,
    ...over,
  };
}
