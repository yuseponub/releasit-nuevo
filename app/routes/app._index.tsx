import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  DataTable,
  Icon,
  Box,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { checkOrderHealth } from "../models/alerts.server";
import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);

  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    ordersToday,
    ordersWeek,
    ordersMonth,
    revenueToday,
    revenueMonth,
    draftsOpen,
    recentOrders,
    health,
    recentAlerts,
  ] = await Promise.all([
    db.codOrder.count({ where: { shop, createdAt: { gte: todayStart } } }),
    db.codOrder.count({ where: { shop, createdAt: { gte: weekStart } } }),
    db.codOrder.count({ where: { shop, createdAt: { gte: monthStart } } }),
    db.codOrder.aggregate({
      where: { shop, createdAt: { gte: todayStart } },
      _sum: { total: true },
    }),
    db.codOrder.aggregate({
      where: { shop, createdAt: { gte: monthStart } },
      _sum: { total: true },
    }),
    db.draftOrder.count({ where: { shop, status: "open" } }),
    db.codOrder.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    checkOrderHealth(shop),
    db.alertLog.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  return json({
    stats: {
      ordersToday,
      ordersWeek,
      ordersMonth,
      revenueToday: revenueToday._sum.total || 0,
      revenueMonth: revenueMonth._sum.total || 0,
      draftsOpen,
    },
    health,
    recentOrders: recentOrders.map(o => ({
      id: o.id,
      name: o.shopifyOrderName || `#${o.id}`,
      customer: `${o.firstName} ${o.lastName}`,
      phone: o.phone,
      total: o.total,
      bundleSize: o.bundleSize,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    })),
    recentAlerts: recentAlerts.map(a => ({
      type: a.type,
      message: a.message,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    })),
  });
};

export default function Dashboard() {
  const { stats, health, recentOrders, recentAlerts } = useLoaderData<typeof loader>();

  const formatCOP = (amount: number) =>
    "$" + amount.toLocaleString("es-CO");

  const healthBadge = health.healthy
    ? <Badge tone="success">Saludable</Badge>
    : <Badge tone="critical">Alerta</Badge>;

  const orderRows = recentOrders.map((order: any) => [
    order.name,
    order.customer,
    order.phone,
    `${order.bundleSize} prod.`,
    formatCOP(order.total),
    order.status,
    new Date(order.createdAt).toLocaleString("es-CO", { timeZone: "America/Bogota" }),
  ]);

  return (
    <Page title="Dashboard">
      <BlockStack gap="500">
        {!health.healthy && (
          <Banner
            title="Sin ordenes recientes"
            tone="warning"
          >
            <p>
              No se han recibido ordenes en los ultimos{" "}
              {health.minutesSinceLastOrder} minutos.
              Ultima orden: {health.lastOrderAt
                ? new Date(health.lastOrderAt).toLocaleString("es-CO", { timeZone: "America/Bogota" })
                : "Nunca"}
            </p>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">Ordenes Hoy</Text>
                <Text variant="heading2xl" as="p">{stats.ordersToday}</Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  Revenue: {formatCOP(stats.revenueToday)}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">Ordenes Semana</Text>
                <Text variant="heading2xl" as="p">{stats.ordersWeek}</Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  Mes: {stats.ordersMonth} ordenes
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="200" align="start">
                  <Text variant="headingSm" as="h3">Estado del Formulario</Text>
                  {healthBadge}
                </InlineStack>
                <Text variant="heading2xl" as="p">{stats.draftsOpen}</Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  Abandonos pendientes
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Revenue del Mes</Text>
                <Text variant="heading2xl" as="p">
                  {formatCOP(stats.revenueMonth)}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Ordenes Recientes</Text>
                {orderRows.length > 0 ? (
                  <DataTable
                    columnContentTypes={[
                      "text", "text", "text", "text",
                      "numeric", "text", "text"
                    ]}
                    headings={[
                      "Orden", "Cliente", "Telefono", "Bundle",
                      "Total", "Estado", "Fecha"
                    ]}
                    rows={orderRows}
                  />
                ) : (
                  <Text as="p" tone="subdued">No hay ordenes aun</Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {recentAlerts.length > 0 && (
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text variant="headingMd" as="h2">Alertas Recientes</Text>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Tipo", "Mensaje", "Estado", "Fecha"]}
                    rows={recentAlerts.map((a: any) => [
                      a.type,
                      a.message,
                      a.status,
                      new Date(a.createdAt).toLocaleString("es-CO", { timeZone: "America/Bogota" }),
                    ])}
                  />
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}
      </BlockStack>
    </Page>
  );
}
