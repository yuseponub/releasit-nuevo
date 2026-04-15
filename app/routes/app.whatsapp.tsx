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
  InlineStack,
  Box,
  Pagination,
  Link as PolarisLink,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { LoaderFunctionArgs } from "@remix-run/node";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("p")) || 1);

  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [clicks, total, todayCount, weekCount, identifiedCount, topProducts] = await Promise.all([
    db.whatsAppClick.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.whatsAppClick.count({ where: { shop } }),
    db.whatsAppClick.count({ where: { shop, createdAt: { gte: startOfDay } } }),
    db.whatsAppClick.count({ where: { shop, createdAt: { gte: weekAgo } } }),
    db.whatsAppClick.count({ where: { shop, phone: { not: null }, createdAt: { gte: weekAgo } } }),
    db.whatsAppClick.groupBy({
      by: ["productName"],
      where: { shop, createdAt: { gte: weekAgo }, productName: { not: null } },
      _count: { productName: true },
      orderBy: { _count: { productName: "desc" } },
      take: 5,
    }),
  ]);

  return json({
    clicks,
    total,
    page,
    todayCount,
    weekCount,
    identifiedCount,
    topProducts: topProducts.map((p) => ({ name: p.productName, count: p._count.productName })),
  });
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function detectDevice(ua: string | null): string {
  if (!ua) return "—";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Mobile/i.test(ua)) return "Mobile";
  return "Desktop";
}

export default function WhatsAppClicksPage() {
  const { clicks, total, page, todayCount, weekCount, identifiedCount, topProducts } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const rows = clicks.map((c: any) => [
    formatDate(c.createdAt),
    c.firstName || c.lastName
      ? `${c.firstName || ""} ${c.lastName || ""}`.trim()
      : "—",
    c.phone || "—",
    c.productName || c.collectionName || c.pageType || "—",
    detectDevice(c.userAgent),
    c.city || "—",
    c.ip || "—",
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const conversionRate = weekCount > 0 ? ((identifiedCount / weekCount) * 100).toFixed(1) : "0";

  return (
    <Page title="Clicks a WhatsApp" subtitle="Quién está tocando el botón y desde dónde">
      <Layout>
        <Layout.Section>
          <InlineStack gap="400" wrap>
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">Hoy</Text>
                <Text as="p" variant="heading2xl">{todayCount}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">Últimos 7 días</Text>
                <Text as="p" variant="heading2xl">{weekCount}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">Identificados (7d)</Text>
                <InlineStack gap="200" blockAlign="baseline">
                  <Text as="p" variant="heading2xl">{identifiedCount}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">({conversionRate}%)</Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Con nombre/teléfono del COD form
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">Total histórico</Text>
                <Text as="p" variant="heading2xl">{total}</Text>
              </BlockStack>
            </Card>
          </InlineStack>
        </Layout.Section>

        {topProducts.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Top productos con clicks (7d)</Text>
                <BlockStack gap="100">
                  {topProducts.map((p: any) => (
                    <InlineStack key={p.name} align="space-between">
                      <Text as="span">{p.name}</Text>
                      <Badge tone="info">{String(p.count)}</Badge>
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Clicks recientes</Text>
              {rows.length === 0 ? (
                <Box paddingBlock="400">
                  <Text as="p" tone="subdued">
                    Aún no hay clicks registrados. Los datos aparecerán aquí cuando los
                    visitantes empiecen a tocar el botón de WhatsApp.
                  </Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
                  headings={["Fecha", "Nombre", "Teléfono", "Página / Producto", "Dispositivo", "Ciudad", "IP"]}
                  rows={rows}
                />
              )}
              {totalPages > 1 && (
                <Box paddingBlockStart="300">
                  <InlineStack align="center">
                    <Pagination
                      hasPrevious={page > 1}
                      onPrevious={() => setSearchParams({ p: String(page - 1) })}
                      hasNext={page < totalPages}
                      onNext={() => setSearchParams({ p: String(page + 1) })}
                      label={`Página ${page} de ${totalPages}`}
                    />
                  </InlineStack>
                </Box>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
