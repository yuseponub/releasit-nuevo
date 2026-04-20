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

    if (path.includes("fb-event") || path.includes("track")) {
      return await handleTrackEvent(request, body);
    }

    if (path.includes("heartbeat")) {
      return await handleHeartbeat(request, body);
    }

    if (path.includes("wa-click")) {
      return await handleWaClick(request, body);
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

    if (!firstName || !lastName || !phone || !address || !city || !items?.length) {
      return json({ success: false, error: "Faltan campos requeridos" }, { status: 400 });
    }

    const missingDepartment = !department || !String(department).trim();

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
      `Departamento: ${department || 'SIN DEPARTAMENTO - completar'}`,
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
            ...(missingDepartment ? {} : { province: department }),
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
            ...(missingDepartment ? {} : { province: department }),
            country: "Colombia",
            countryCode: "CO",
            zip: "000000",
          },
          email: email || undefined,
          phone: formattedPhone,
          note: orderNote,
          tags: [
            "releasitnuevo",
            "cod",
            `bundle-${totalQty}`,
            ...(missingDepartment ? ["sin-departamento"] : []),
          ],
          financialStatus: "PENDING",
          customAttributes: [
            { key: "Fuente", value: "ReleasitNuevo COD Form" },
            { key: "Metodo de pago", value: "Contra entrega (COD)" },
            { key: "Telefono", value: formattedPhone },
            { key: "Telefono confirmacion", value: formattedPhoneConfirm },
            { key: "Barrio", value: neighborhood || "" },
            { key: "Direccion completa", value: `${address}, ${neighborhood ? 'Barrio: ' + neighborhood + ', ' : ''}${city}${department ? ', ' + department : ' (SIN DEPARTAMENTO)'}` },
            { key: "Bundle", value: `${totalQty} unidad(es)` },
            { key: "Total bundle", value: `$${bundlePrice.toLocaleString('es-CO')} COP` },
            { key: "Upsells", value: upsellTotal > 0 ? `$${upsellTotal.toLocaleString('es-CO')} COP` : "Ninguno" },
            { key: "Total orden", value: `$${grandTotal.toLocaleString('es-CO')} COP` },
            { key: "IP", value: clientIp },
          ],
        },
        options: {
          inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
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

    // Mark draft as completed if one exists
    const draftOrderId = body.draftOrderId;
    if (draftOrderId) {
      try {
        // Update local DB
        await db.draftOrder.updateMany({
          where: { shopifyDraftOrderId: draftOrderId },
          data: { status: "completed", convertedToOrderId: orderId },
        });
        // Delete draft in Shopify
        await admin.graphql(`
          mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
            draftOrderDelete(input: $input) {
              deletedId
              userErrors { field, message }
            }
          }
        `, {
          variables: { input: { id: draftOrderId } },
        });
        console.log("[CreateOrder] Draft marked as completed:", draftOrderId);
      } catch (draftErr: any) {
        console.error("[CreateOrder] Draft cleanup error (non-fatal):", draftErr.message);
      }
    }

    // Also mark any draft with same phone as completed
    try {
      await db.draftOrder.updateMany({
        where: { phone: formattedPhone, status: "open" },
        data: { status: "completed", convertedToOrderId: orderId },
      });
    } catch (_) {}

    // Save to DB (non-fatal)
    try {
      await db.codOrder.create({
        data: {
          shop, shopifyOrderId: orderId, shopifyOrderName: orderName,
          firstName, lastName, phone, phoneConfirm, email,
          address, neighborhood, department: department || "", city,
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
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("cf-connecting-ip")
      || request.headers.get("x-real-ip")
      || "N/A";

    const result = await createDraftFromFormData(admin, shop, body, clientIp);
    if (result.error) {
      return json({ success: false, error: result.error }, { status: result.status || 500 });
    }
    return json({ success: true, draftOrderId: result.draftOrderId });
  } catch (e: any) {
    console.error("[CreateDraft] FATAL:", e.message, e.stack);
    return json({ success: false, error: "Error: " + e.message }, { status: 500 });
  }
}

// Reusable draft creation — called by /create-draft and by heartbeat on close.
// Returns { draftOrderId, error?, status? }. Never throws.
async function createDraftFromFormData(
  admin: any,
  shop: string,
  body: any,
  clientIp: string,
): Promise<{ draftOrderId: string; error?: string; status?: number }> {
  try {
    const {
      firstName, lastName, phone, phoneConfirm, email,
      address, city, department, neighborhood,
      items, extras,
    } = body;

    // Identity trigger: phone OR email is enough to create the draft
    const rawPhone = typeof phone === "string" ? phone.trim() : "";
    const rawEmail = typeof email === "string" ? email.trim() : "";
    if (!rawPhone && !rawEmail) {
      return { draftOrderId: "", error: "Telefono o email requerido", status: 400 };
    }

    const formattedPhone = rawPhone ? formatPhoneCO(rawPhone) : "";
    const formattedPhoneConfirm = phoneConfirm ? formatPhoneCO(phoneConfirm) : "";
    const safeFirstName = (firstName && firstName.trim()) || "Sin nombre";
    const safeLastName = (lastName && lastName.trim()) || "";
    const missingDepartment = !department || !String(department).trim();
    const missingAddress = !address || !String(address).trim();

    // Resolve variant IDs (map config keys → real Shopify variant IDs)
    const resolvedMain = resolveVariantIds(admin, items || []);
    const resolvedExtras = resolveVariantIds(admin, extras || []);

    // Bundle pricing — same as order
    const mainQty = resolvedMain.reduce((s: number, i: any) => s + (i.quantity || 1), 0);
    const bundlePrice = mainQty > 0 ? calcBundlePrice(mainQty) : 0;
    const mainLineTotals = mainQty > 0 ? distributePrice(resolvedMain, mainQty) : [];
    const extrasTotal = resolvedExtras.reduce((s: number, e: any) => s + (Number(e.price) || 0), 0);
    const grandTotal = bundlePrice + extrasTotal;

    const itemsList = resolvedMain.map((i: any) => `${i.title} x${i.quantity}`).join(", ");
    const extrasList = resolvedExtras.map((e: any) => {
      const p = Number(e.price) || 0;
      return p > 0 ? `${e.title} ($${p.toLocaleString('es-CO')})` : e.title;
    }).join(", ");

    // Build line items with bundle pricing
    const lineItems: any[] = [];
    resolvedMain.forEach((item: any, idx: number) => {
      const vid = String(item.variantId || "");
      const qty = item.quantity || 1;
      const lineTotal = mainLineTotals[idx] || 0;
      const pricePerUnit = qty > 0 ? Math.round(lineTotal / qty) : 0;
      const hasRealId = vid && (vid.startsWith("gid://") || /^\d+$/.test(vid));
      if (hasRealId) {
        lineItems.push({
          variantId: vid.startsWith("gid://") ? vid : `gid://shopify/ProductVariant/${vid}`,
          quantity: qty,
          originalUnitPrice: String(pricePerUnit),
        });
      } else {
        lineItems.push({
          title: item.title || "Producto",
          quantity: qty,
          originalUnitPrice: String(pricePerUnit),
        });
      }
    });

    resolvedExtras.forEach((ex: any) => {
      const vid = String(ex.variantId || "");
      const price = Number(ex.price) || 0;
      const hasRealId = vid && (vid.startsWith("gid://") || /^\d+$/.test(vid));
      if (hasRealId) {
        lineItems.push({
          variantId: vid.startsWith("gid://") ? vid : `gid://shopify/ProductVariant/${vid}`,
          quantity: 1,
          originalUnitPrice: String(price),
        });
      } else {
        lineItems.push({
          title: ex.title || "Extra",
          quantity: 1,
          originalUnitPrice: String(price),
        });
      }
    });

    if (lineItems.length === 0) {
      lineItems.push({
        title: "Carrito abandonado (sin productos)",
        quantity: 1,
        originalUnitPrice: "0",
      });
    }

    // Find or create customer — tolerant: works with phone alone, email alone, or both
    let customerId: string | null = null;
    try {
      customerId = await findOrCreateCustomer(admin, {
        firstName: safeFirstName,
        lastName: safeLastName || "Sin apellido",
        phone: formattedPhone,
        email: rawEmail || undefined,
      });
      console.log("[CreateDraft] Customer ID:", customerId);
    } catch (e: any) {
      console.error("[CreateDraft] Customer lookup failed (non-fatal):", e.message);
    }

    // Detailed note — mirrors order note
    const noteLines = [
      `Carrito abandonado - ReleasitNuevo`,
      ``,
      `Cliente: ${safeFirstName} ${safeLastName}`.trim(),
      formattedPhone ? `Telefono: ${formattedPhone}` : '',
      formattedPhoneConfirm ? `Tel. confirmacion: ${formattedPhoneConfirm}` : '',
      rawEmail ? `Email: ${rawEmail}` : '',
      ``,
      address ? `Direccion: ${address}` : 'Direccion: (pendiente)',
      neighborhood ? `Barrio: ${neighborhood}` : '',
      city ? `Ciudad: ${city}` : '',
      `Departamento: ${department || 'SIN DEPARTAMENTO - completar'}`,
      ``,
      `Productos: ${itemsList || 'N/A'}`,
      extrasList ? `Extras: ${extrasList}` : '',
      mainQty > 0 ? `Bundle: ${mainQty} unidad(es) - $${bundlePrice.toLocaleString('es-CO')} COP` : '',
      extrasTotal > 0 ? `Extras total: $${extrasTotal.toLocaleString('es-CO')} COP` : '',
      grandTotal > 0 ? `Total estimado: $${grandTotal.toLocaleString('es-CO')} COP` : '',
      ``,
      `IP: ${clientIp}`,
      `Fecha: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`,
    ].filter(Boolean).join("\n");

    // Shipping address — include only if we have anything to put in it
    const hasShipping = !!(address || city || department || neighborhood);
    const shippingAddress = hasShipping ? {
      firstName: safeFirstName,
      lastName: safeLastName || ".",
      ...(formattedPhone ? { phone: formattedPhone } : {}),
      address1: address || "Pendiente",
      ...(neighborhood ? { address2: `Barrio: ${neighborhood}` } : {}),
      city: city || "Pendiente",
      ...(missingDepartment ? {} : { province: department }),
      country: "Colombia",
      countryCode: "CO",
      zip: "000000",
    } : undefined;

    const tags = [
      "releasitnuevo",
      "abandono",
      ...(mainQty > 0 ? [`bundle-${mainQty}`] : []),
      ...(missingDepartment ? ["sin-departamento"] : []),
      ...(missingAddress ? ["sin-direccion"] : []),
      ...(!firstName ? ["sin-nombre"] : []),
      ...(!rawEmail ? ["sin-email"] : []),
      ...(!rawPhone ? ["sin-telefono"] : []),
    ];

    const customAttributes = [
      { key: "Fuente", value: "ReleasitNuevo Abandono" },
      { key: "Telefono", value: formattedPhone || "N/A" },
      { key: "Telefono confirmacion", value: formattedPhoneConfirm || "" },
      { key: "Email", value: rawEmail || "" },
      { key: "Barrio", value: neighborhood || "" },
      { key: "Direccion completa", value: address
        ? `${address}${neighborhood ? ', Barrio: ' + neighborhood : ''}${city ? ', ' + city : ''}${department ? ', ' + department : ' (SIN DEPARTAMENTO)'}`
        : "SIN DIRECCION" },
      { key: "Bundle", value: mainQty > 0 ? `${mainQty} unidad(es)` : "0" },
      { key: "Total bundle", value: `$${bundlePrice.toLocaleString('es-CO')} COP` },
      { key: "Extras", value: extrasTotal > 0 ? `$${extrasTotal.toLocaleString('es-CO')} COP` : "Ninguno" },
      { key: "Total estimado", value: `$${grandTotal.toLocaleString('es-CO')} COP` },
      { key: "IP", value: clientIp },
      { key: "productos", value: itemsList || "N/A" },
      { key: "extras_list", value: extrasList || "Ninguno" },
    ];

    let draftOrderId = "";
    try {
      const input: any = {
        note: noteLines,
        tags,
        lineItems,
        customAttributes,
        ...(rawEmail ? { email: rawEmail } : {}),
        ...(formattedPhone ? { phone: formattedPhone } : {}),
        ...(shippingAddress ? { shippingAddress } : {}),
        ...(customerId ? { purchasingEntity: { customerId } } : {}),
      };

      const draftResponse = await admin.graphql(`
        mutation draftOrderCreate($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id, name }
            userErrors { field, message }
          }
        }
      `, { variables: { input } });

      const draftData = await draftResponse.json();
      const draftResult = draftData.data?.draftOrderCreate;

      if (draftResult?.userErrors?.length > 0) {
        console.error("[CreateDraft] Shopify userErrors:", JSON.stringify(draftResult.userErrors));
      }
      draftOrderId = draftResult?.draftOrder?.id || "";

      if (draftOrderId) {
        console.log("[CreateDraft] Shopify draft created:", draftOrderId);
      } else {
        console.error("[CreateDraft] Shopify draft NOT created. Response:", JSON.stringify(draftData));
      }
    } catch (shopifyErr: any) {
      console.error("[CreateDraft] Shopify draft creation failed:", shopifyErr.message);
    }

    // Always save to local DB even if Shopify draft fails
    try {
      await db.draftOrder.create({
        data: {
          shop,
          shopifyDraftOrderId: draftOrderId || null,
          firstName: safeFirstName,
          lastName: safeLastName,
          phone: formattedPhone,
          items: JSON.stringify({
            items: items || [], extras: extras || [],
            address, city, department, neighborhood, email: rawEmail,
          }),
          status: "open",
        },
      });
    } catch (dbErr: any) {
      console.error("[CreateDraft] DB error:", dbErr.message);
    }

    try {
      await db.formSubmission.create({
        data: { shop, type: "DRAFT_ORDER", data: JSON.stringify(body), shopifyOrderId: draftOrderId || null },
      });
    } catch (_) {}

    return { draftOrderId };
  } catch (e: any) {
    console.error("[CreateDraft] helper error:", e.message, e.stack);
    return { draftOrderId: "", error: "Error: " + e.message };
  }
}

// ===================== FACEBOOK CONVERSIONS API =====================

const FB_PIXEL_ID = process.env.FB_PIXEL_ID || "1639820782820483";
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN || "";

async function handleTrackEvent(request: Request, body: any) {
  try {
    const { eventName, eventId, data: eventData, userAgent, sourceUrl, timestamp, fbc, fbp } = body;

    const evName = eventName || "PageView";
    const evId = eventId;
    const value = eventData?.value;
    const email = eventData?.email;
    const phone = eventData?.phone;
    const firstName = eventData?.firstName;
    const lastName = eventData?.lastName;
    const city = eventData?.city;
    const department = eventData?.department;
    const orderId = eventData?.order_id;
    const externalId = eventData?.external_id;
    const numItems = eventData?.num_items;

    // Get IP from request
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("cf-connecting-ip")
      || request.headers.get("x-real-ip")
      || "";

    // 1. Save to database for monitoring
    try {
      await db.formSubmission.create({
        data: {
          shop: new URL(request.url).searchParams.get("shop") || "unknown",
          type: "TRACKING_" + evName.toUpperCase(),
          data: JSON.stringify({ ...body, ip: clientIp }),
          success: true,
        },
      });
    } catch (dbErr: any) {
      console.error("[Track] DB error:", dbErr.message);
    }

    // 2. Send to Meta Conversions API (only for key events)
    const metaEvents = ["Purchase", "AddToCart", "InitiateCheckout", "ViewContent"];
    if (FB_ACCESS_TOKEN && metaEvents.includes(evName)) {
      const hashSHA256 = (val: string) => {
        if (!val) return undefined;
        return crypto.createHash("sha256").update(val.trim().toLowerCase()).digest("hex");
      };

      const formattedPhone = phone ? formatPhoneCO(phone) : "";

      const fbPayload = {
        data: [{
          event_name: evName,
          event_time: Math.floor(Date.now() / 1000), // Use server time for accuracy
          event_id: evId,
          event_source_url: sourceUrl,
          action_source: "website",
          user_data: {
            em: email ? [hashSHA256(email)] : undefined,
            ph: formattedPhone ? [hashSHA256(formattedPhone.replace("+", ""))] : undefined,
            fn: firstName ? [hashSHA256(firstName)] : undefined,
            ln: lastName ? [hashSHA256(lastName)] : undefined,
            ct: city ? [hashSHA256(city)] : undefined,
            st: department ? [hashSHA256(department)] : undefined,
            country: [hashSHA256("co")],
            external_id: externalId ? [hashSHA256(externalId)] : undefined,
            client_ip_address: clientIp || undefined,
            client_user_agent: userAgent,
            fbc: fbc || undefined,
            fbp: fbp || undefined,
          },
          custom_data: {
            value: value,
            currency: "COP",
            order_id: orderId,
            content_type: "product",
            num_items: numItems,
            contents: eventData?.contents || eventData?.content_ids?.map((id: string) => ({ id, quantity: 1 })),
          },
        }],
      };

      try {
        const fbResp = await fetch(
          `https://graph.facebook.com/v24.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fbPayload),
          }
        );
        const fbResult = await fbResp.json();
        console.log(`[Track] ${evName} → Meta:`, JSON.stringify(fbResult));
      } catch (fbErr: any) {
        console.error("[Track] Meta API error:", fbErr.message);
      }
    }

    return json({ success: true, event: evName });
  } catch (e: any) {
    console.error("[Track] Error:", e.message);
    return json({ success: false, error: e.message });
  }
}

// ===================== HEARTBEAT (Active Carts) =====================

async function handleHeartbeat(request: Request, body: any) {
  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "unknown";
    const { sessionId, status, page, formData, cartData, extrasData } = body;

    if (!sessionId) {
      return json({ success: false, error: "Missing sessionId" }, { status: 400 });
    }

    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("cf-connecting-ip")
      || "";
    const userAgent = body.userAgent || request.headers.get("user-agent") || "";

    // Upsert session: create if new, update if exists
    await db.activeSession.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        shop,
        page: page || "",
        userAgent,
        ip: clientIp,
        formData: formData ? JSON.stringify(formData) : null,
        cartData: cartData ? JSON.stringify(cartData) : null,
        extrasData: extrasData ? JSON.stringify(extrasData) : null,
        status: status || "active",
        lastSeenAt: new Date(),
      },
      update: {
        page: page || undefined,
        formData: formData ? JSON.stringify(formData) : undefined,
        cartData: cartData ? JSON.stringify(cartData) : undefined,
        extrasData: extrasData ? JSON.stringify(extrasData) : undefined,
        status: status || "active",
        lastSeenAt: new Date(),
      },
    });

    // Mark old active sessions as closed (not delete — keep for history)
    db.activeSession.updateMany({
      where: { lastSeenAt: { lt: new Date(Date.now() - 5 * 60 * 1000) }, status: "active" },
      data: { status: "closed" },
    }).catch(() => {});

    // Auto-create draft when session closes (page unload / tab close).
    // Dedup: check DraftOrder table for a recent draft with same phone (last 2h).
    // Email-only sessions skip dedup (rare, acceptable risk of one duplicate).
    if (status === "closed" && formData) {
      const phoneOk = typeof formData.phone === "string" && formData.phone.trim().length >= 7;
      const emailOk = typeof formData.email === "string" && /^\S+@\S+\.\S+$/.test(formData.email.trim());
      if (phoneOk || emailOk) {
        try {
          let duplicate = false;
          if (phoneOk) {
            const formattedPhone = formatPhoneCO(formData.phone.trim());
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const existing = await db.draftOrder.findFirst({
              where: {
                shop,
                phone: formattedPhone,
                createdAt: { gte: twoHoursAgo },
                shopifyDraftOrderId: { not: null },
              },
              select: { shopifyDraftOrderId: true },
            });
            if (existing) {
              duplicate = true;
              console.log("[Heartbeat] Auto-draft skipped, dup found:", existing.shopifyDraftOrderId);
            }
          }

          if (!duplicate) {
            const { admin } = await authProxy(request);
            const draftBody = {
              ...formData,
              items: cartData || [],
              extras: extrasData || [],
            };
            const result = await createDraftFromFormData(admin, shop, draftBody, clientIp || "N/A");
            if (result.draftOrderId) {
              console.log("[Heartbeat] Auto-draft created for session", sessionId, "→", result.draftOrderId);
            } else if (result.error) {
              console.warn("[Heartbeat] Auto-draft skipped:", result.error);
            }
          }
        } catch (draftErr: any) {
          console.error("[Heartbeat] Auto-draft failed (non-fatal):", draftErr.message);
        }
      }
    }

    return json({ success: true });
  } catch (e: any) {
    console.error("[Heartbeat] Error:", e.message);
    return json({ success: false });
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

// ===================== WhatsApp click tracking =====================

async function handleWaClick(request: Request, body: any) {
  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "unknown";

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      "";

    // Try to enrich with identity from ActiveSession (same sessionId, or same IP+UA recently)
    let identity: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      email?: string;
      city?: string;
    } = {};

    try {
      const ua: string = body.userAgent || "";
      const cutoff = new Date(Date.now() - 30 * 60 * 1000); // last 30 min

      let active = null;
      if (body.sessionId) {
        active = await db.activeSession.findFirst({
          where: { shop, id: body.sessionId, formData: { not: null } },
          orderBy: { lastSeenAt: "desc" },
        });
      }
      if (!active && ip) {
        active = await db.activeSession.findFirst({
          where: {
            shop,
            ip,
            userAgent: ua || undefined,
            formData: { not: null },
            lastSeenAt: { gte: cutoff },
          },
          orderBy: { lastSeenAt: "desc" },
        });
      }
      if (active?.formData) {
        try {
          const form = JSON.parse(active.formData);
          identity = {
            firstName: form.firstName || undefined,
            lastName: form.lastName || undefined,
            phone: form.phone || undefined,
            email: form.email || undefined,
            city: form.city || undefined,
          };
        } catch (_) {}
      }
    } catch (err) {
      console.error("[wa-click] identity lookup error", err);
    }

    await db.whatsAppClick.create({
      data: {
        shop,
        eventId: body.eventId || null,
        sessionId: body.sessionId || null,
        pageType: body.pageType || null,
        pageUrl: body.pageUrl || null,
        productId: body.productId ? String(body.productId) : null,
        productName: body.productName || null,
        productPrice: body.productPrice || null,
        collectionName: body.collectionName || null,
        referrer: body.referrer || null,
        userAgent: body.userAgent || null,
        ip: ip || null,
        firstName: identity.firstName || null,
        lastName: identity.lastName || null,
        phone: identity.phone || null,
        email: identity.email || null,
        city: identity.city || null,
      },
    });

    return json({ ok: true });
  } catch (e: any) {
    console.error("[wa-click] error:", e.message);
    return json({ ok: false, error: e.message }, { status: 500 });
  }
}
