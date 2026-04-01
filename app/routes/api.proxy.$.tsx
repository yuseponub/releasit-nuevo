import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { calcBundlePrice, distributePrice } from "../models/bundle-pricing.server";

/**
 * App Proxy handler (catch-all route).
 * Shopify routes /apps/releasitnuevo/* → /api/proxy/*
 * The `authenticate.public.appProxy` validates the request signature.
 */

// Helper to extract the sub-path from the proxy request
function getProxyPath(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("path") || url.pathname;
}

// Safely parse request body (handles JSON, form-encoded, or empty)
async function parseBody(request: Request): Promise<any> {
  try {
    const clone = request.clone();
    const text = await clone.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // Try form-encoded
      const params = new URLSearchParams(text);
      const obj: any = {};
      params.forEach((v, k) => { obj[k] = v; });
      return obj;
    }
  } catch {
    return {};
  }
}

// GET requests
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const path = getProxyPath(request);
  console.log("[AppProxy GET]", path);

  // Ping/test endpoint - no auth needed
  if (path.includes("ping")) {
    return json({ ok: true, timestamp: Date.now() });
  }

  if (path.includes("products")) {
    return handleGetProducts(request);
  }

  return json({ error: "Not found", path }, { status: 404 });
};

// POST requests
export const action = async ({ request }: ActionFunctionArgs) => {
  const path = getProxyPath(request);
  console.log("[AppProxy POST]", path);

  let body: any;
  try {
    body = await parseBody(request);
    console.log("[AppProxy] Body keys:", Object.keys(body));
  } catch (e: any) {
    console.error("[AppProxy] Body parse error:", e.message);
    return json({ success: false, error: "No se pudo leer el cuerpo de la peticion" }, { status: 400 });
  }

  try {
    if (path.includes("create-order")) {
      return await handleCreateOrder(request, body);
    }

    if (path.includes("create-draft")) {
      return await handleCreateDraft(request, body);
    }

    return json({ error: "Not found", path }, { status: 404 });
  } catch (e: any) {
    console.error("[AppProxy] Unhandled error:", e.message, e.stack);
    return json({ success: false, error: e.message || "Error interno" }, { status: 500 });
  }
};

// ----- Helper: Resolve variant IDs by title if non-numeric -----
async function resolveVariantIds(admin: any, items: any[]) {
  const needsResolution = items.some((i: any) => !/^\d+$/.test(String(i.variantId)));
  if (!needsResolution) return items;

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

    console.log("[ResolveVariants] Available products:", products.map((p: any) => p.title));

    return items.map((item: any) => {
      const vid = String(item.variantId);
      if (/^\d+$/.test(vid)) return item;

      const itemTitle = (item.title || "").toLowerCase();
      const keyPart = vid.split("-variant-")[0].replace(/-/g, " ");

      const match = products.find((p: any) =>
        p.title.includes(keyPart) ||
        keyPart.includes(p.title.split(" ")[0]) ||
        itemTitle.includes(p.title.split(" ")[0])
      );

      if (match) {
        console.log(`[ResolveVariants] "${item.title}" → ${match.variantId}`);
        return { ...item, variantId: match.variantId };
      }

      console.warn(`[ResolveVariants] FAILED for: "${item.title}" (${vid})`);
      return item;
    });
  } catch (e) {
    console.error("[ResolveVariants] Error:", e);
    return items;
  }
}

// ----- Handler: Get Products -----
async function handleGetProducts(request: Request) {
  try {
    const { admin } = await authenticate.public.appProxy(request);

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
    console.error("[GetProducts] Error:", e);
    return json({ products: [] });
  }
}

// ----- Handler: Create Order -----
async function handleCreateOrder(request: Request, body: any) {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    const shop = session?.shop || "unknown";
    console.log("[CreateOrder] Shop:", shop);

    if (!admin) {
      return json({ success: false, error: "No autenticado" }, { status: 401 });
    }

    const {
      firstName, lastName, phone, phoneConfirm,
      email, address, neighborhood, department, city,
      items, bundleSize, total,
    } = body;

    // Validate required fields
    if (!firstName || !lastName || !phone || !address || !department || !city || !items?.length) {
      console.error("[CreateOrder] Missing fields:", { firstName: !!firstName, lastName: !!lastName, phone: !!phone, address: !!address, department: !!department, city: !!city, items: items?.length });
      return json({ success: false, error: "Faltan campos requeridos" }, { status: 400 });
    }

    const totalQty = items.reduce((sum: number, i: any) => sum + i.quantity, 0);
    const bundlePrice = calcBundlePrice(totalQty);

    // Resolve variant IDs
    const resolvedItems = await resolveVariantIds(admin, items);
    console.log("[CreateOrder] Resolved items:", resolvedItems.map((i: any) => ({ title: i.title, variantId: i.variantId })));

    const fullAddress = neighborhood
      ? `${address}, Barrio: ${neighborhood}`
      : address;

    const lineItems = resolvedItems.map((item: any) => {
      const vid = String(item.variantId);
      return {
        variantId: vid.startsWith("gid://") ? vid : `gid://shopify/ProductVariant/${vid}`,
        quantity: item.quantity,
      };
    });

    console.log("[CreateOrder] Line items:", JSON.stringify(lineItems));

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
          lineItems,
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
    console.log("[CreateOrder] Shopify response:", JSON.stringify(orderData));
    const orderResult = orderData.data?.orderCreate;

    if (orderResult?.userErrors?.length > 0) {
      console.error("[CreateOrder] User errors:", orderResult.userErrors);
      return json({
        success: false,
        error: orderResult.userErrors.map((e: any) => e.message).join(", "),
      });
    }

    const orderId = orderResult?.order?.id || "";
    const orderName = orderResult?.order?.name || "";

    // Save to local database
    try {
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
    } catch (dbErr: any) {
      console.error("[CreateOrder] DB save error (non-fatal):", dbErr.message);
    }

    // Log submission
    try {
      await db.formSubmission.create({
        data: {
          shop,
          type: "COD_ORDER",
          data: JSON.stringify({ ...body, shopifyOrderId: orderId }),
          shopifyOrderId: orderId,
        },
      });
    } catch (_) { /* ignore */ }

    return json({ success: true, orderId, orderName });
  } catch (e: any) {
    console.error("[CreateOrder] FATAL:", e.message, e.stack);

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
    } catch (_) { /* ignore */ }

    return json({ success: false, error: "Error del servidor: " + e.message }, { status: 500 });
  }
}

// ----- Handler: Create Draft Order (Abandonment) -----
async function handleCreateDraft(request: Request, body: any) {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    const shop = session?.shop || "unknown";

    if (!admin) {
      return json({ success: false, error: "No autenticado" }, { status: 401 });
    }

    const { firstName, lastName, phone, items } = body;

    if (!firstName || !phone) {
      return json({ success: false, error: "Nombre y telefono requeridos" }, { status: 400 });
    }

    const resolvedItems = items?.length > 0
      ? await resolveVariantIds(admin, items)
      : [];

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
      console.error("[CreateDraft] User errors:", draftResult.userErrors);
      return json({
        success: false,
        error: draftResult.userErrors.map((e: any) => e.message).join(", "),
      });
    }

    const draftOrderId = draftResult?.draftOrder?.id || "";

    try {
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
    } catch (dbErr: any) {
      console.error("[CreateDraft] DB error (non-fatal):", dbErr.message);
    }

    try {
      await db.formSubmission.create({
        data: {
          shop,
          type: "DRAFT_ORDER",
          data: JSON.stringify(body),
          shopifyOrderId: draftOrderId,
        },
      });
    } catch (_) { /* ignore */ }

    return json({ success: true, draftOrderId });
  } catch (e: any) {
    console.error("[CreateDraft] FATAL:", e.message, e.stack);
    return json({ success: false, error: "Error del servidor: " + e.message }, { status: 500 });
  }
}
