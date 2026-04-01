import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { calcBundlePrice, distributePrice } from "../models/bundle-pricing.server";
import crypto from "crypto";

/**
 * App Proxy handler (catch-all route).
 * Uses manual HMAC verification + unauthenticated.admin for API access.
 */

function getProxyPath(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("path") || url.pathname;
}

// Verify Shopify app proxy HMAC signature
function verifyProxySignature(query: URLSearchParams): boolean {
  const signature = query.get("signature");
  if (!signature) return false;

  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) return false;

  const params: string[] = [];
  query.forEach((value, key) => {
    if (key !== "signature") {
      params.push(`${key}=${value}`);
    }
  });
  params.sort();
  const message = params.join("");

  const computed = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(signature, "hex")
  );
}

// Get admin API using existing session
async function getAdmin(shop: string) {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

// Authenticate proxy request: verify HMAC + get admin
async function authProxy(request: Request) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    throw new Error("Missing shop parameter");
  }

  const valid = verifyProxySignature(url.searchParams);
  if (!valid) {
    console.error("[authProxy] Invalid signature for shop:", shop);
    throw new Error("Invalid signature");
  }

  const admin = await getAdmin(shop);
  return { admin, shop };
}

// ===================== LOADER (GET) =====================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const path = getProxyPath(request);
  console.log("[AppProxy GET]", path);

  if (path.includes("ping")) {
    return json({ ok: true, timestamp: Date.now() });
  }

  if (path.includes("products")) {
    return handleGetProducts(request);
  }

  return json({ error: "Not found", path }, { status: 404 });
};

// ===================== ACTION (POST) =====================

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") || url.pathname;
    console.log("[AppProxy POST]", path);

    // Read body
    const bodyText = await request.text();
    let body: any = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        const params = new URLSearchParams(bodyText);
        body = Object.fromEntries(params);
      }
    }

    // Debug endpoint
    if (path.includes("test-post")) {
      return json({ ok: true, path, bodyLength: bodyText.length });
    }

    // Test auth with new manual verification
    if (path.includes("test-auth")) {
      try {
        const { admin, shop } = await authProxy(request);
        return json({ ok: true, shop, hasAdmin: !!admin });
      } catch (e: any) {
        return json({ ok: false, error: e.message });
      }
    }

    if (path.includes("create-order")) {
      return await handleCreateOrder(request, body);
    }

    if (path.includes("create-draft")) {
      return await handleCreateDraft(request, body);
    }

    return json({ error: "Not found", path }, { status: 404 });
  } catch (e: any) {
    console.error("[AppProxy] FATAL:", e.message, e.stack);
    return json({ success: false, error: "Error: " + (e.message || "desconocido") }, { status: 500 });
  }
};

// ===================== HANDLERS =====================

async function handleGetProducts(request: Request) {
  try {
    const { admin } = await authProxy(request);

    const response = await admin.graphql(`
      query {
        products(first: 10, query: "status:active") {
          edges {
            node {
              id
              title
              featuredImage { url }
              variants(first: 1) {
                edges {
                  node { id, price }
                }
              }
            }
          }
        }
      }
    `);

    const data = await response.json();
    const products = data.data.products.edges.map((edge: any) => {
      const node = edge.node;
      const variant = node.variants.edges[0]?.node;
      return {
        productId: node.id.replace("gid://shopify/Product/", ""),
        variantId: variant?.id.replace("gid://shopify/ProductVariant/", "") || "",
        title: node.title,
        image: node.featuredImage?.url || "",
        price: variant?.price || "0",
      };
    });

    return json({ products });
  } catch (e: any) {
    console.error("[GetProducts] Error:", e.message);
    return json({ products: [], error: e.message });
  }
}

async function handleCreateOrder(request: Request, body: any) {
  try {
    const { admin, shop } = await authProxy(request);
    console.log("[CreateOrder] Shop:", shop);

    const {
      firstName, lastName, phone, phoneConfirm,
      email, address, neighborhood, department, city,
      items,
    } = body;

    if (!firstName || !lastName || !phone || !address || !department || !city || !items?.length) {
      return json({ success: false, error: "Faltan campos requeridos" }, { status: 400 });
    }

    const totalQty = items.reduce((sum: number, i: any) => sum + i.quantity, 0);
    const bundlePrice = calcBundlePrice(totalQty);

    // Resolve variant IDs
    const resolvedItems = await resolveVariantIds(admin, items);
    console.log("[CreateOrder] Resolved:", resolvedItems.map((i: any) => ({ t: i.title, v: i.variantId })));

    const fullAddress = neighborhood ? `${address}, Barrio: ${neighborhood}` : address;

    // Distribute bundle price across line items
    const itemPrices = distributePrice(resolvedItems, totalQty);

    const lineItems = resolvedItems.map((item: any, idx: number) => {
      const vid = String(item.variantId);
      // Price per unit for this line item (total for this item / quantity)
      const lineTotal = itemPrices[idx];
      const pricePerUnit = Math.round(lineTotal / item.quantity);

      return {
        variantId: vid.startsWith("gid://") ? vid : `gid://shopify/ProductVariant/${vid}`,
        quantity: item.quantity,
        priceSet: {
          shopMoney: {
            amount: String(pricePerUnit),
            currencyCode: "COP",
          },
        },
      };
    });

    const orderResponse = await admin.graphql(`
      mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order { id, name }
          userErrors { field, message }
        }
      }
    `, {
      variables: {
        order: {
          lineItems,
          shippingAddress: {
            firstName, lastName, phone,
            address1: fullAddress,
            city, province: department,
            country: "Colombia", countryCode: "CO", zip: "000000",
          },
          billingAddress: {
            firstName, lastName, phone,
            address1: fullAddress,
            city, province: department,
            country: "Colombia", countryCode: "CO", zip: "000000",
          },
          email: email || undefined,
          phone,
          note: `Pedido COD - ReleasitNuevo\nBundle: ${totalQty} productos\nBarrio: ${neighborhood || 'N/A'}\nTel confirmado: ${phoneConfirm || 'N/A'}`,
          tags: ["releasitnuevo", "cod", `bundle-${totalQty}`],
          financialStatus: "PENDING",
          customAttributes: [
            { key: "source", value: "releasitnuevo" },
            { key: "bundle_size", value: String(totalQty) },
            { key: "neighborhood", value: neighborhood || "" },
          ],
        },
        options: {
          inventoryBehaviour: "DECREMENT_OBEYING_POLICY",
        },
      },
    });

    const orderData = await orderResponse.json();
    console.log("[CreateOrder] Response:", JSON.stringify(orderData));
    const orderResult = orderData.data?.orderCreate;

    if (orderResult?.userErrors?.length > 0) {
      return json({
        success: false,
        error: orderResult.userErrors.map((e: any) => e.message).join(", "),
      });
    }

    const orderId = orderResult?.order?.id || "";
    const orderName = orderResult?.order?.name || "";

    // Save to DB (non-fatal)
    try {
      await db.codOrder.create({
        data: {
          shop, shopifyOrderId: orderId, shopifyOrderName: orderName,
          firstName, lastName, phone, phoneConfirm, email,
          address: fullAddress, neighborhood, department, city,
          items: JSON.stringify(items),
          subtotal: bundlePrice, total: bundlePrice,
          bundleSize: totalQty, status: "pending",
        },
      });
    } catch (dbErr: any) {
      console.error("[CreateOrder] DB error (non-fatal):", dbErr.message);
    }

    try {
      await db.formSubmission.create({
        data: {
          shop, type: "COD_ORDER",
          data: JSON.stringify({ ...body, shopifyOrderId: orderId }),
          shopifyOrderId: orderId,
        },
      });
    } catch (_) {}

    return json({ success: true, orderId, orderName });
  } catch (e: any) {
    console.error("[CreateOrder] FATAL:", e.message, e.stack);
    return json({ success: false, error: "Error: " + e.message }, { status: 500 });
  }
}

async function handleCreateDraft(request: Request, body: any) {
  try {
    const { admin, shop } = await authProxy(request);

    const { firstName, lastName, phone, items } = body;
    if (!firstName || !phone) {
      return json({ success: false, error: "Nombre y telefono requeridos" }, { status: 400 });
    }

    const resolvedItems = items?.length > 0 ? await resolveVariantIds(admin, items) : [];
    const lineItems = resolvedItems.length > 0
      ? resolvedItems.map((item: any) => {
          const vid = String(item.variantId);
          return {
            variantId: vid.startsWith("gid://") ? vid : `gid://shopify/ProductVariant/${vid}`,
            quantity: item.quantity || 1,
          };
        })
      : [];

    const draftResponse = await admin.graphql(`
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id }
          userErrors { field, message }
        }
      }
    `, {
      variables: {
        input: {
          lineItems: lineItems.length > 0 ? lineItems : undefined,
          note: `Abandono parcial - ReleasitNuevo\nNombre: ${firstName} ${lastName || ''}\nTel: ${phone}`,
          tags: ["releasitnuevo", "abandono"],
          shippingAddress: {
            firstName, lastName: lastName || ".",
            phone, address1: "Pendiente",
            city: "Pendiente", province: "Pendiente",
            country: "Colombia", countryCode: "CO", zip: "000000",
          },
          customAttributes: [{ key: "source", value: "releasitnuevo-abandono" }],
        },
      },
    });

    const draftData = await draftResponse.json();
    const draftResult = draftData.data?.draftOrderCreate;

    if (draftResult?.userErrors?.length > 0) {
      return json({
        success: false,
        error: draftResult.userErrors.map((e: any) => e.message).join(", "),
      });
    }

    const draftOrderId = draftResult?.draftOrder?.id || "";

    try {
      await db.draftOrder.create({
        data: {
          shop, shopifyDraftOrderId: draftOrderId,
          firstName, lastName, phone,
          items: items ? JSON.stringify(items) : null,
          status: "open",
        },
      });
    } catch (dbErr: any) {
      console.error("[CreateDraft] DB error:", dbErr.message);
    }

    try {
      await db.formSubmission.create({
        data: { shop, type: "DRAFT_ORDER", data: JSON.stringify(body), shopifyOrderId: draftOrderId },
      });
    } catch (_) {}

    return json({ success: true, draftOrderId });
  } catch (e: any) {
    console.error("[CreateDraft] FATAL:", e.message, e.stack);
    return json({ success: false, error: "Error: " + e.message }, { status: 500 });
  }
}

// ===================== HELPERS =====================

// Hardcoded variant ID map (config key → real Shopify variant ID)
const VARIANT_ID_MAP: Record<string, string> = {
  "elixir": "47357476634860",
  "ashwagandha": "47357499277548",
  "magnesio": "47357496197356",
  "magnesio-forte": "47357496197356",
  "melatonina-magnesio": "47357476634860",
  "melatonina": "47357476634860",
};

function resolveVariantIds(admin: any, items: any[]) {
  return items.map((item: any) => {
    const vid = String(item.variantId || "");

    // Already a real numeric ID
    if (/^\d+$/.test(vid)) return item;
    // Already a GID
    if (vid.startsWith("gid://")) return item;

    // Extract config key: "elixir-variant-1" → "elixir", "ashwagandha-1" → "ashwagandha"
    const configKey = vid.split("-variant-")[0].replace(/-\d+$/, "");
    const realId = VARIANT_ID_MAP[configKey];

    if (realId) {
      console.log(`[Resolve] "${item.title}" (${vid}) → ${realId}`);
      return { ...item, variantId: realId };
    }

    console.warn(`[Resolve] No mapping for: "${item.title}" (${vid})`);
    return item;
  });
}
