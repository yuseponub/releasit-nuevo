import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, admin, payload } =
    await authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  switch (topic) {
    case "APP_UNINSTALLED":
      if (session) {
        await db.session.deleteMany({ where: { shop } });
      }
      break;

    case "ORDERS_CREATE":
      // Record order creation for monitoring
      await db.formSubmission.create({
        data: {
          shop,
          type: "ORDER_WEBHOOK",
          data: JSON.stringify(payload),
          shopifyOrderId: String(payload.id),
        },
      });
      break;

    case "DRAFT_ORDERS_CREATE":
      // Log draft order creation
      console.log(`Draft order created for shop ${shop}:`, payload.id);
      break;

    case "DRAFT_ORDERS_UPDATE":
      // Update draft order status if it was created by our app
      if (payload.id) {
        await db.draftOrder.updateMany({
          where: {
            shopifyDraftOrderId: String(payload.id),
            shop,
          },
          data: {
            status: payload.status || "open",
          },
        });
      }
      break;

    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
      // Privacy compliance webhooks
      break;

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};
