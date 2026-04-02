import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  BlockStack,
  Badge,
  Pagination,
  Button,
  InlineStack,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { LoaderFunctionArgs } from "@remix-run/node";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const filter = url.searchParams.get("filter") || "open";

  const where: any = { shop };
  if (filter !== "all") {
    where.status = filter;
  }

  const [drafts, total, stats] = await Promise.all([
    db.draftOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.draftOrder.count({ where }),
    Promise.all([
      db.draftOrder.count({ where: { shop, status: "open" } }),
      db.draftOrder.count({ where: { shop, status: "completed" } }),
      db.draftOrder.count({ where: { shop } }),
      // Tracking events last 24h
      db.formSubmission.count({
        where: {
          shop,
          type: { startsWith: "TRACKING_" },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      // Form opens (ViewContent) last 24h
      db.formSubmission.count({
        where: {
          shop,
          type: "TRACKING_VIEWCONTENT",
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      // AddToCart last 24h
      db.formSubmission.count({
        where: {
          shop,
          type: "TRACKING_ADDTOCART",
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      // InitiateCheckout last 24h
      db.formSubmission.count({
        where: {
          shop,
          type: "TRACKING_INITIATECHECKOUT",
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      // Purchase last 24h
      db.formSubmission.count({
        where: {
          shop,
          type: "TRACKING_PURCHASE",
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]),
  ]);

  const [openCount, completedCount, totalCount, trackingTotal, viewCount, addToCartCount, checkoutCount, purchaseCount] = stats;

  return json({
    drafts: drafts.map(d => {
      let parsedItems: any = {};
      try {
        parsedItems = d.items ? JSON.parse(d.items) : {};
      } catch (_) {}

      const itemsList = Array.isArray(parsedItems)
        ? parsedItems.map((i: any) => `${i.title} x${i.quantity}`).join(", ")
        : Array.isArray(parsedItems.items)
          ? parsedItems.items.map((i: any) => `${i.title} x${i.quantity}`).join(", ")
          : "Sin productos";

      const extraInfo = parsedItems.city ? `${parsedItems.city}, ${parsedItems.department || ''}` : "";

      return {
        id: d.id,
        shopifyId: d.shopifyDraftOrderId || "-",
        customer: `${d.firstName} ${d.lastName || ""}`.trim(),
        phone: d.phone,
        items: itemsList,
        location: extraInfo,
        status: d.status,
        convertedToOrderId: d.convertedToOrderId || null,
        createdAt: d.createdAt.toISOString(),
      };
    }),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
    filter,
    stats: {
      open: openCount,
      completed: completedCount,
      total: totalCount,
      funnel: {
        views: viewCount,
        addToCart: addToCartCount,
        checkout: checkoutCount,
        purchase: purchaseCount,
      },
    },
  });
};

export default function Abandonos() {
  const { drafts, total, page, totalPages, filter, stats } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const setFilter = (f: string) => {
    searchParams.set("filter", f);
    searchParams.set("page", "1");
    setSearchParams(searchParams);
  };

  const statusBadge = (status: string) => {
    const config: Record<string, { tone: any; label: string }> = {
      open: { tone: "warning", label: "Abandonado" },
      completed: { tone: "success", label: "Convertido" },
      invoice_sent: { tone: "info", label: "Contactado" },
    };
    const c = config[status] || { tone: "new", label: status };
    return <Badge tone={c.tone}>{c.label}</Badge>;
  };

  const rows = drafts.map((draft: any) => [
    draft.customer,
    draft.phone,
    draft.items,
    draft.location,
    statusBadge(draft.status),
    new Date(draft.createdAt).toLocaleString("es-CO", { timeZone: "America/Bogota" }),
    <Button
      key={draft.id}
      size="slim"
      url={`https://wa.me/${draft.phone.replace(/\D/g, "")}?text=${encodeURIComponent(
        `Hola ${draft.customer}! Vimos que estabas interesado en nuestros productos. Te gustaria completar tu pedido?`
      )}`}
      external
      disabled={draft.status === "completed"}
    >
      WhatsApp
    </Button>,
  ]);

  const conversionRate = stats.funnel.views > 0
    ? ((stats.funnel.purchase / stats.funnel.views) * 100).toFixed(1)
    : "0";

  return (
    <Page
      title="Monitoreo del Formulario"
      subtitle={`${stats.open} carritos abandonados | ${stats.completed} convertidos`}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Funnel ultimas 24 horas</Text>
              <InlineStack gap="400" align="space-around">
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{stats.funnel.views}</Text>
                    <Text as="p" tone="subdued">Abrieron formulario</Text>
                  </BlockStack>
                </Box>
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{stats.funnel.addToCart}</Text>
                    <Text as="p" tone="subdued">Agregaron al carrito</Text>
                  </BlockStack>
                </Box>
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{stats.funnel.checkout}</Text>
                    <Text as="p" tone="subdued">Iniciaron checkout</Text>
                  </BlockStack>
                </Box>
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{stats.funnel.purchase}</Text>
                    <Text as="p" tone="subdued">Compraron</Text>
                  </BlockStack>
                </Box>
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{conversionRate}%</Text>
                    <Text as="p" tone="subdued">Conversion</Text>
                  </BlockStack>
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200">
                <Text as="h2" variant="headingMd">Carritos abandonados</Text>
                <Button size="slim" pressed={filter === "open"} onClick={() => setFilter("open")}>
                  Abiertos ({stats.open})
                </Button>
                <Button size="slim" pressed={filter === "completed"} onClick={() => setFilter("completed")}>
                  Convertidos ({stats.completed})
                </Button>
                <Button size="slim" pressed={filter === "all"} onClick={() => setFilter("all")}>
                  Todos ({stats.total})
                </Button>
              </InlineStack>

              {rows.length > 0 ? (
                <>
                  <DataTable
                    columnContentTypes={[
                      "text", "text", "text", "text", "text", "text", "text"
                    ]}
                    headings={[
                      "Cliente", "Telefono", "Productos", "Ubicacion", "Estado", "Fecha", "Accion"
                    ]}
                    rows={rows}
                  />
                  {totalPages > 1 && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "16px" }}>
                      <Pagination
                        hasPrevious={page > 1}
                        onPrevious={() => {
                          searchParams.set("page", String(page - 1));
                          setSearchParams(searchParams);
                        }}
                        hasNext={page < totalPages}
                        onNext={() => {
                          searchParams.set("page", String(page + 1));
                          setSearchParams(searchParams);
                        }}
                      />
                    </div>
                  )}
                </>
              ) : (
                <Text as="p" tone="subdued">No hay registros para este filtro</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
