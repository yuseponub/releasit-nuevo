import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { calcBundlePrice, distributePrice } from "../models/bundle-pricing.server";

/**
 * App Proxy handler.
 * Shopify routes /apps/releasitnuevo/* to this endpoint.
 * The `authenticate.public.appProxy` validates the request signature.
 */

// Helper to extract the sub-path from the proxy request
// Shopify proxies to: {url}/{remaining_path}?shop=...&signature=...
// So /apps/releasitnuevo/create-order → /api/proxy/create-order
function getProxyPath(request: Request): string {
  const url = new URL(request.url);
  // Check query param first (dev/testing), then pathname
  return url.searchParams.get("path") || url.pathname;
}

// GET requests - product listing
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const path = getProxyPath(request);

  // For the products endpoint
  if (path.includes("products")) {
    return handleGetProducts(request);
  }

  return json({ error: "Not found" }, { status: 404 });
};

// POST requests - create order, create draft
export const action = async ({ request }: ActionFunctionArgs) => {
  const path = getProxyPath(request);
  const body = await request.json();

  if (path.includes("create-order")) {
    return handleCreateOrder(request, body);
  }

  if (path.includes("create-draft")) {
    return handleCreateDraft(request, body);
  }

  return json({ error: "Not found" }, { status: 404 });
};

// ----- Helper: Resolve variant IDs by title if non-numeric -----
async function resolveVariantIds(admin: any, items: any[]) {
  const needsResolution = items.some((i: any) => !/^\d+$/.test(i.variantId));
  if (!needsResolution) return items;

  // Fetch all active products to find real variant IDs
  try {
    const response = await admin.graphql(`
      query {
        products(first: 20, query: "status:active") {
          edges {
            node {
              id
              title
              variants(first: 5) {
                edges {
                  node {
                    id
                    title
                  }
                }
              }
            }
          }
        }
      }
    `);

    const data = await response.json();
    const products = data.data.products.edges.map((e: any) => ({
      title: e.node.title.toLowerCase(),
      variantId: e.node.variants.edges[0]?.node.id || "",
    }));

    return items.map((item: any) => {
      if (/^\d+$/.test(item.variantId)) return item;

      const itemTitle = (item.title || "").toLowerCase();
      const keyPart = (item.variantId || "").split("-variant-")[0].replace(/-/g, " ");

      const match = products.find((p: any) =>
        p.title.includes(keyPart) || itemTitle.includes(p.title) || p.title.includes(itemTitle.split(" x")[0].trim())
      );

      if (match) {
        console.log(`Resolved variant: "${item.title}" → ${match.variantId}`);
        return { ...item, variantId: match.variantId };
      }

      console.warn(`Could not resolve variant for: "${item.title}" (${item.variantId})`);
      return item;
    });
  } catch (e) {
    console.error("Error resolving variant IDs:", e);
    return items;
  }
}

// ----- Handler: Get Products -----
async function handleGetProducts(request: Request) {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);

    if (!admin) {
      return json({ products: [] });
    }

    const response = await admin.graphql(`
      query {
        products(first: 10, query: "status:active") {
          edges {
            node {
              id
              title
              featuredImage {
                url
              }
              variants(first: 1) {
                edges {
                  node {
                    id
                    price
                  }
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
  } catch (e) {
    console.error("Error fetching products:", e);
    return json({ products: [] });
  }
}

// ----- Handler: Create Order -----
async function handleCreateOrder(request: Request, body: any) {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    const shop = session?.shop || "unknown";

    if (!admin) {
      return json({ success: false, error: "Not authenticated" }, { status: 401 });
    }

    const {
      firstName, lastName, phone, phoneConfirm,
      email, address, neighborhood, department, city,
      items, bundleSize, total,
    } = body;

    // Validate required fields
    if (!firstName || !lastName || !phone || !address || !department || !city || !items?.length) {
      return json({ success: false, error: "Faltan campos requeridos" }, { status: 400 });
    }

    const totalQty = items.reduce((sum: number, i: any) => sum + i.quantity, 0);
    const bundlePrice = calcBundlePrice(totalQty);
    const itemPrices = distributePrice(items, totalQty);

    // Resolve variant IDs - if any are non-numeric, look them up by title
    const resolvedItems = await resolveVariantIds(admin, items);

    // Create order via GraphQL Admin API
    const fullAddress = neighborhood
      ? `${address}, Barrio: ${neighborhood}`
      : address;

    const orderResponse = await admin.graphql(`
      mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order {
            id
            name
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        order: {
          lineItems: resolvedItems.map((item: any) => ({
            variantId: item.variantId.startsWith("gid://")
              ? item.variantId
              : `gid://shopify/ProductVariant/${item.variantId}`,
            quantity: item.quantity,
          })),
          shippingAddress: {
            firstName,
            lastName,
            phone,
            address1: fullAddress,
            city,
            province: department,
            country: "Colombia",
            countryCode: "CO",
            zip: "000000",
          },
          billingAddress: {
            firstName,
            lastName,
            phone,
            address1: fullAddress,
            city,
            province: department,
            country: "Colombia",
            countryCode: "CO",
            zip: "000000",
          },
          email: email || undefined,
          phone,
          note: `Pedido COD - ReleasitNuevo\nBundle: ${totalQty} productos\nBarrio: ${neighborhood || 'N/A'}\nTelefono confirmado: ${phoneConfirm || 'N/A'}`,
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
    const orderResult = orderData.data?.orderCreate;

    if (orderResult?.userErrors?.length > 0) {
      console.error("Order creation errors:", orderResult.userErrors);
      return json({
        success: false,
        error: orderResult.userErrors.map((e: any) => e.message).join(", "),
      });
    }

    const orderId = orderResult?.order?.id || "";
    const orderName = orderResult?.order?.name || "";

    // Save to local database
    await db.codOrder.create({
      data: {
        shop,
        shopifyOrderId: orderId,
        shopifyOrderName: orderName,
        firstName,
        lastName,
        phone,
        phoneConfirm,
        email,
        address: fullAddress,
        neighborhood,
        department,
        city,
        items: JSON.stringify(items),
        subtotal: bundlePrice,
        total: bundlePrice,
        bundleSize: totalQty,
        status: "pending",
      },
    });

    // Log submission
    await db.formSubmission.create({
      data: {
        shop,
        type: "COD_ORDER",
        data: JSON.stringify({ ...body, shopifyOrderId: orderId }),
        shopifyOrderId: orderId,
      },
    });

    return json({
      success: true,
      orderId,
      orderName,
    });
  } catch (e: any) {
    console.error("Error creating order:", e);

    // Log failure
    try {
      await db.formSubmission.create({
        data: {
          shop: "unknown",
          type: "COD_ORDER",
          data: JSON.stringify(body),
          success: false,
          error: e.message,
        },
      });
    } catch (_) { /* ignore logging errors */ }

    return json({ success: false, error: "Error interno del servidor" }, { status: 500 });
  }
}

// ----- Handler: Create Draft Order (Abandonment) -----
async function handleCreateDraft(request: Request, body: any) {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    const shop = session?.shop || "unknown";

    if (!admin) {
      return json({ success: false, error: "Not authenticated" }, { status: 401 });
    }

    const { firstName, lastName, phone, items } = body;

    if (!firstName || !phone) {
      return json({ success: false, error: "Nombre y telefono requeridos" }, { status: 400 });
    }

    // Resolve variant IDs before creating draft
    const resolvedItems = items?.length > 0
      ? await resolveVariantIds(admin, items)
      : [];

    const lineItems = resolvedItems.length > 0
      ? resolvedItems.map((item: any) => ({
          variantId: item.variantId.startsWith("gid://")
            ? item.variantId
            : `gid://shopify/ProductVariant/${item.variantId}`,
          quantity: item.quantity || 1,
        }))
      : [];

    const draftResponse = await admin.graphql(`
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        input: {
          lineItems: lineItems.length > 0 ? lineItems : undefined,
          note: `Abandono parcial - ReleasitNuevo\nNombre: ${firstName} ${lastName || ''}\nTelefono: ${phone}`,
          tags: ["releasitnuevo", "abandono"],
          shippingAddress: {
            firstName,
            lastName: lastName || ".",
            phone,
            address1: "Pendiente",
            city: "Pendiente",
            province: "Pendiente",
            country: "Colombia",
            countryCode: "CO",
            zip: "000000",
          },
          customAttributes: [
            { key: "source", value: "releasitnuevo-abandono" },
          ],
        },
      },
    });

    const draftData = await draftResponse.json();
    const draftResult = draftData.data?.draftOrderCreate;

    if (draftResult?.userErrors?.length > 0) {
      console.error("Draft order errors:", draftResult.userErrors);
      return json({
        success: false,
        error: draftResult.userErrors.map((e: any) => e.message).join(", "),
      });
    }

    const draftOrderId = draftResult?.draftOrder?.id || "";

    // Save to local database
    await db.draftOrder.create({
      data: {
        shop,
        shopifyDraftOrderId: draftOrderId,
        firstName,
        lastName,
        phone,
        items: items ? JSON.stringify(items) : null,
        status: "open",
      },
    });

    // Log submission
    await db.formSubmission.create({
      data: {
        shop,
        type: "DRAFT_ORDER",
        data: JSON.stringify(body),
        shopifyOrderId: draftOrderId,
      },
    });

    return json({ success: true, draftOrderId });
  } catch (e: any) {
    console.error("Error creating draft order:", e);
    return json({ success: false, error: "Error interno del servidor" }, { status: 500 });
  }
}
