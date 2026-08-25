import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AlertsView } from "./alerts-view";
import type { Alert } from "@/lib/types";

const priceDrop: Alert = {
  id: 1,
  searchId: 1,
  searchQ: "Sonos Era 300",
  kind: "price_drop",
  previousPrice: 200,
  itemId: "v1|123|0",
  title: "Sonos Era 300",
  price: 180,
  currency: "USD",
  shippingCost: 0,
  buyingOption: "FIXED_PRICE",
  condition: "New",
  imageUrl: null,
  itemUrl: "https://ebay.test/123",
  createdAt: "2026-08-16T12:00:00.000Z",
};

test("price-drop history card highlights the reduction", () => {
  const html = renderToStaticMarkup(
    <AlertsView
      visibleAlerts={[priceDrop]}
      searches={[]}
      alertFilter="all"
      setAlertFilter={() => {}}
      failedImg={new Set()}
      setFailedImg={() => {}}
      clearAlerts={() => {}}
    />,
  );

  expect(html).toContain("1 alert · newest first");
  expect(html).toContain("Price drop");
  expect(html).toContain("▼ $20.00 · 10% price drop");
  expect(html).toContain("Was $200.00");
});

test("alert history prefers the name captured with an alert", () => {
  const html = renderToStaticMarkup(
    <AlertsView
      visibleAlerts={[{ ...priceDrop, searchName: "Sonos Plan B" } as Alert]}
      searches={[]}
      alertFilter="all"
      setAlertFilter={() => {}}
      failedImg={new Set()}
      setFailedImg={() => {}}
      clearAlerts={() => {}}
    />,
  );

  expect(html).toContain("Sonos Plan B");
});
