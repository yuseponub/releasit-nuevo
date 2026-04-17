import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Card, Text, BlockStack, Banner, Button } from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { calcBundlePrice } from "../models/bundle-pricing.server";

/**
 * One-off rescue route for the order lost on 2026-04-17 08:27
 * (customer clicked WhatsApp button with department empty; backend rejected;
 * session was wrongly marked "completed" in the Activos panel).
 *
 * Visit this URL once while logged into the Shopify app; it creates the real
 * order in Shopify with all automations firing, and saves it to CodOrder.
 * If already rescued, it returns idempotently.
 */

const JULITA = {
  firstName: "Julita",
  lastName: "Mendez de Fernanda",
  phoneRaw: "3150008096",
  phoneE164: "+573150008096",
  email: "juliafernanda63@hotmail.com",
  address: "Calle 13 4N 06 501 Apartamento 501 501",
  neighborhood: "Lirios norte",
  city: "Ipiales",
  department: "Nariño",
  variantIdNumeric: "47357476634860",
  productTitle: "ELIXIR DEL SUEÑO",
  quantity: 1,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const existing = await db.codOrder.findFirst({
    where: { shop, phone: JULITA.phoneRaw },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.shopifyOrderId) {
    return json({
      status: "already_rescued" as const,
      orderId: existing.shopifyOrderId,
      orderName: existing.shopifyOrderName,
    });
  }

  const bundlePrice = calcBundlePrice(JULITA.quantity);
  const variantGid = `gid://shopify/ProductVariant/${JULITA.variantIdNumeric}`;

  const orderNote = [
    `Pedido COD - RESCATE MANUAL`,
    ``,
    `Cliente: ${JULITA.firstName} ${JULITA.lastName}`,
    `Telefono: ${JULITA.phoneE164}`,
    `Email: ${JULITA.email}`,
    ``,
    `Direccion: ${JULITA.address}`,
    `Barrio: ${JULITA.neighborhood}`,
    `Ciudad: ${JULITA.city}`,
    `Departamento: ${JULITA.department}`,
    ``,
    `Producto: ${JULITA.productTitle} x${JULITA.quantity}`,
    `Total: $${bundlePrice.toLocaleString("es-CO")} COP`,
    ``,
    `Metodo de pago: Contra entrega (COD)`,
    `NOTA: Orden rescatada manualmente. Cliente dio click en WhatsApp sin departamento; el sistema la rechazo por bug. Departamento Ipiales = Narino.`,
    `Fecha original: 17/4/2026, 8:27:57 a.m.`,
  ].join("\n");

  const orderResponse = await admin.graphql(
    `mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name statusPageUrl }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        order: {
          lineItems: [
            {
              variantId: variantGid,
              quantity: JULITA.quantity,
              priceSet: {
                shopMoney: {
                  amount: String(bundlePrice),
                  currencyCode: "COP",
                },
              },
            },
          ],
          shippingAddress: {
            firstName: JULITA.firstName,
            lastName: JULITA.lastName,
            phone: JULITA.phoneE164,
            address1: JULITA.address,
            address2: `Barrio: ${JULITA.neighborhood}`,
            city: JULITA.city,
            province: JULITA.department,
            country: "Colombia",
            countryCode: "CO",
            zip: "000000",
          },
          billingAddress: {
            firstName: JULITA.firstName,
            lastName: JULITA.lastName,
            phone: JULITA.phoneE164,
            address1: JULITA.address,
            address2: `Barrio: ${JULITA.neighborhood}`,
            city: JULITA.city,
            province: JULITA.department,
            country: "Colombia",
            countryCode: "CO",
            zip: "000000",
          },
          email: JULITA.email,
          phone: JULITA.phoneE164,
          note: orderNote,
          tags: ["releasitnuevo", "cod", "bundle-1", "rescate-manual"],
          financialStatus: "PENDING",
          customAttributes: [
            { key: "Fuente", value: "Rescate manual - sesion perdida" },
            { key: "Metodo de pago", value: "Contra entrega (COD)" },
            { key: "Telefono", value: JULITA.phoneE164 },
            { key: "Barrio", value: JULITA.neighborhood },
          ],
        },
        options: {
          inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
        },
      },
    },
  );

  const orderData = await orderResponse.json();
  const result = orderData.data?.orderCreate;

  if (result?.userErrors?.length > 0) {
    return json({
      status: "error" as const,
      errors: result.userErrors,
    });
  }

  const orderId = result?.order?.id || "";
  const orderName = result?.order?.name || "";
  const statusPageUrl = result?.order?.statusPageUrl || "";

  try {
    await db.codOrder.create({
      data: {
        shop,
        shopifyOrderId: orderId,
        shopifyOrderName: orderName,
        firstName: JULITA.firstName,
        lastName: JULITA.lastName,
        phone: JULITA.phoneRaw,
        email: JULITA.email,
        address: JULITA.address,
        neighborhood: JULITA.neighborhood,
        department: JULITA.department,
        city: JULITA.city,
        items: JSON.stringify([
          {
            variantId: JULITA.variantIdNumeric,
            title: JULITA.productTitle,
            quantity: JULITA.quantity,
          },
        ]),
        subtotal: bundlePrice,
        total: bundlePrice,
        bundleSize: JULITA.quantity,
        status: "pending",
      },
    });
  } catch (e: any) {
    console.error("[RescueJulita] CodOrder save failed (non-fatal):", e.message);
  }

  return json({
    status: "created" as const,
    orderId,
    orderName,
    statusPageUrl,
  });
};

export default function RescueJulita() {
  const data = useLoaderData<typeof loader>();

  if (data.status === "already_rescued") {
    return (
      <Page title="Rescate de orden — Julita">
        <Card>
          <BlockStack gap="300">
            <Banner tone="info">Esta orden ya fue rescatada.</Banner>
            <Text as="p">Orden: {data.orderName}</Text>
            <Text as="p" tone="subdued">Shopify ID: {data.orderId}</Text>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  if (data.status === "error") {
    return (
      <Page title="Rescate de orden — Julita">
        <Card>
          <BlockStack gap="300">
            <Banner tone="critical">Shopify rechazo la orden.</Banner>
            <pre>{JSON.stringify(data.errors, null, 2)}</pre>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Rescate de orden — Julita">
      <Card>
        <BlockStack gap="300">
          <Banner tone="success">Orden creada en Shopify.</Banner>
          <Text as="p" variant="headingMd">Orden: {data.orderName}</Text>
          <Text as="p">Automatizaciones (email, webhooks, Pixel) disparadas.</Text>
          {data.statusPageUrl && (
            <Button url={data.statusPageUrl} target="_blank">Ver pagina de estado</Button>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
