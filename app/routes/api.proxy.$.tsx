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

    // Format phone to E.164 (+57 for Colombia)
    const formattedPhone = formatPhoneCO(phone);
    const formattedPhoneConfirm = phoneConfirm ? formatPhoneCO(phoneConfirm) : "";

    // Get client IP
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("cf-connecting-ip")
      || request.headers.get("x-real-ip")
      || "N/A";

    const mainQtyTotal = items.filter((i: any) => !i.isUpsell).reduce((sum: number, i: any) => sum + i.quantity, 0);
    const totalQty = items.reduce((sum: number, i: any) => sum + i.quantity, 0);
    const bundlePrice = calcBundlePrice(mainQtyTotal);
    const upsellTotal = items.filter((i: any) => i.isUpsell).reduce((sum: number, i: any) => sum + (i.upsellPrice || 49900), 0);
    const grandTotal = bundlePrice + upsellTotal;
    const itemsList = items.map((i: any) => `${i.title} x${i.quantity}${i.isUpsell ? ' (upsell $' + (i.upsellPrice || 49900).toLocaleString('es-CO') + ')' : ''}`).join(", ");

    // Separate main items from upsells
    const mainItems = items.filter((i: any) => !i.isUpsell);
    const upsellItems = items.filter((i: any) => i.isUpsell);

    // Resolve variant IDs for all items
    const resolvedMain = resolveVariantIds(admin, mainItems);
    const resolvedUpsells = resolveVariantIds(admin, upsellItems);

    console.log("[CreateOrder] Main:", resolvedMain.map((i: any) => ({ t: i.title, v: i.variantId })));
    console.log("[CreateOrder] Upsells:", resolvedUpsells.map((i: any) => ({ t: i.title, v: i.variantId, p: i.upsellPrice })));

    // Distribute bundle price across MAIN items only
    const mainQty = mainItems.reduce((sum: number, i: any) => sum + i.quantity, 0);
    const itemPrices = distributePrice(resolvedMain, mainQty);

    // Build line items for main products (bundle pricing)
    const mainLineItems = resolvedMain.map((item: any, idx: number) => {
      const vid = String(item.variantId);
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

    // Build line items for upsells (discounted price)
    const upsellLineItems = resolvedUpsells.map((item: any) => {
      const vid = String(item.variantId);
      const price = item.upsellPrice || 49900;

      return {
        variantId: vid.startsWith("gid://") ? vid : `gid://shopify/ProductVariant/${vid}`,
        quantity: item.quantity || 1,
        priceSet: {
          shopMoney: {
            amount: String(price),
            currencyCode: "COP",
          },
        },
      };
    });

    const lineItems = [...mainLineItems, ...upsellLineItems];

    // Step 1: Create or find customer first
    let customerId: string | null = null;
    try {
      const customerResult = await findOrCreateCustomer(admin, {
        firstName, lastName, phone: formattedPhone, email,
      });
      customerId = customerResult;
      console.log("[CreateOrder] Customer ID:", customerId);
    } catch (e: any) {
      console.error("[CreateOrder] Customer creation failed (non-fatal):", e.message);
    }

    // Build detailed order note
    const orderNote = [
      `Pedido COD - ReleasitNuevo`,
      ``,
      `Cliente: ${firstName} ${lastName}`,
      `Telefono: ${formattedPhone}`,
      `Tel. confirmacion: ${formattedPhoneConfirm || 'N/A'}`,
      `Email: ${email || 'N/A'}`,
      ``,
      `Direccion: ${address}`,
      `Barrio: ${neighborhood || 'N/A'}`,
      `Ciudad: ${city}`,
      `Departamento: ${department}`,
      ``,
      `Productos: ${itemsList}`,
      `Bundle: ${mainQtyTotal} unidad(es) - $${bundlePrice.toLocaleString('es-CO')} COP`,
      upsellTotal > 0 ? `Upsells: $${upsellTotal.toLocaleString('es-CO')} COP` : '',
      `Total: $${grandTotal.toLocaleString('es-CO')} COP`,
      ``,
      `Metodo de pago: Contra entrega (COD)`,
      `IP: ${clientIp}`,
      `Fecha: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`,
    ].join("\n");

    // Build customer field for order
    const customerField = customerId
      ? { toAssociate: { id: customerId } }
      : email
        ? { toUpsert: { email, firstName, lastName, phone: formattedPhone } }
        : undefined;

    const orderResponse = await admin.graphql(`
      mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order { id, name, statusPageUrl }
          userErrors { field, message }
        }
      }
    `, {
      variables: {
        order: {
          lineItems,
          ...(customerField ? { customer: customerField } : {}),
          shippingAddress: {
            firstName, lastName,
            phone: formattedPhone,
            address1: address,
            address2: neighborhood ? `Barrio: ${neighborhood}` : undefined,
            city,
            province: department,
            country: "Colombia",
            countryCode: "CO",
            zip: "000000",
          },
          billingAddress: {
            firstName, lastName,
            phone: formattedPhone,
            address1: address,
            address2: neighborhood ? `Barrio: ${neighborhood}` : undefined,
            city,
            province: department,
            country: "Colombia",
            countryCode: "CO",
            zip: "000000",
          },
          email: email || undefined,
          phone: formattedPhone,
          note: orderNote,
          tags: ["releasitnuevo", "cod", `bundle-${totalQty}`],
          financialStatus: "PENDING",
          customAttributes: [
            { key: "Fuente", value: "ReleasitNuevo COD Form" },
            { key: "Metodo de pago", value: "Contra entrega (COD)" },
            { key: "Telefono", value: formattedPhone },
            { key: "Telefono confirmacion", value: formattedPhoneConfirm },
            { key: "Barrio", value: neighborhood || "" },
            { key: "Direccion completa", value: `${address}, ${neighborhood ? 'Barrio: ' + neighborhood + ', ' : ''}${city}, ${department}` },
            { key: "Bundle", value: `${totalQty} unidad(es)` },
            { key: "Total bundle", value: `$${bundlePrice.toLocaleString('es-CO')} COP` },
            { key: "Upsells", value: upsellTotal > 0 ? `$${upsellTotal.toLocaleString('es-CO')} COP` : "Ninguno" },
            { key: "Total orden", value: `$${grandTotal.toLocaleString('es-CO')} COP` },
            { key: "IP", value: clientIp },
          ],
        },
        options: {
          inventoryBehaviour: "BYPASS",
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
    const statusPageUrl = orderResult?.order?.statusPageUrl || "";

    // Save to DB (non-fatal)
    try {
      await db.codOrder.create({
        data: {
          shop, shopifyOrderId: orderId, shopifyOrderName: orderName,
          firstName, lastName, phone, phoneConfirm, email,
          address: fullAddress, neighborhood, department, city,
          items: JSON.stringify(items),
          subtotal: bundlePrice, total: grandTotal,
          bundleSize: mainQtyTotal, status: "pending",
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

    return json({ success: true, orderId, orderName, statusPageUrl });
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

    const formattedPhone = formatPhoneCO(phone);
    const resolvedItems = items?.length > 0 ? resolveVariantIds(admin, items) : [];
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
          note: `Abandono parcial - ReleasitNuevo\nNombre: ${firstName} ${lastName || ''}\nTel: ${formattedPhone}`,
          tags: ["releasitnuevo", "abandono"],
          shippingAddress: {
            firstName, lastName: lastName || ".",
            phone: formattedPhone, address1: "Pendiente",
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

// Format Colombian phone to E.164 (+57...)
function formatPhoneCO(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("57") && digits.length >= 12) return "+" + digits;
  if (digits.startsWith("+57")) return digits;
  if (digits.length === 10 && digits.startsWith("3")) return "+57" + digits;
  if (digits.length === 7) return "+57" + digits; // landline
  return "+57" + digits; // fallback
}

// Find or create a customer by phone, returns customer GID or null
async function findOrCreateCustomer(
  admin: any,
  data: { firstName: string; lastName: string; phone: string; email?: string }
): Promise<string | null> {
  // First try to find by phone
  try {
    const searchResp = await admin.graphql(`
      query findCustomer($query: String!) {
        customers(first: 1, query: $query) {
          edges { node { id } }
        }
      }
    `, {
      variables: { query: `phone:${data.phone}` },
    });

    const searchData = await searchResp.json();
    const existing = searchData.data?.customers?.edges?.[0]?.node?.id;
    if (existing) {
      console.log("[Customer] Found existing:", existing);
      return existing;
    }
  } catch (e: any) {
    console.error("[Customer] Search failed:", e.message);
  }

  // If email provided, also search by email
  if (data.email) {
    try {
      const emailResp = await admin.graphql(`
        query findCustomer($query: String!) {
          customers(first: 1, query: $query) {
            edges { node { id } }
          }
        }
      `, {
        variables: { query: `email:${data.email}` },
      });

      const emailData = await emailResp.json();
      const existing = emailData.data?.customers?.edges?.[0]?.node?.id;
      if (existing) {
        console.log("[Customer] Found by email:", existing);
        return existing;
      }
    } catch (e: any) {
      console.error("[Customer] Email search failed:", e.message);
    }
  }

  // Create new customer
  try {
    const createResp = await admin.graphql(`
      mutation customerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id }
          userErrors { field, message }
        }
      }
    `, {
      variables: {
        input: {
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          email: data.email || undefined,
          tags: ["releasitnuevo", "cod"],
        },
      },
    });

    const createData = await createResp.json();
    const newCustomer = createData.data?.customerCreate?.customer?.id;
    if (newCustomer) {
      console.log("[Customer] Created:", newCustomer);
      return newCustomer;
    }

    const errors = createData.data?.customerCreate?.userErrors;
    if (errors?.length) {
      console.error("[Customer] Create errors:", errors);
      // If "phone has already been taken", try to find again
      if (errors.some((e: any) => e.message?.includes("taken"))) {
        // Phone might exist under different format, try broader search
        const retryResp = await admin.graphql(`
          query findCustomer($query: String!) {
            customers(first: 1, query: $query) {
              edges { node { id } }
            }
          }
        `, {
          variables: { query: data.phone.replace("+", "") },
        });
        const retryData = await retryResp.json();
        return retryData.data?.customers?.edges?.[0]?.node?.id || null;
      }
    }
  } catch (e: any) {
    console.error("[Customer] Create failed:", e.message);
  }

  return null;
}

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
