import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  BlockStack,
  Filters,
  ChoiceList,
  Badge,
  Pagination,
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
  const status = url.searchParams.get("status") || undefined;
  const dateFrom = url.searchParams.get("dateFrom") || undefined;

  const where: any = { shop };
  if (status) where.status = status;
  if (dateFrom) where.createdAt = { gte: new Date(dateFrom) };

  const [orders, total] = await Promise.all([
    db.codOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.codOrder.count({ where }),
  ]);

  return json({
    orders: orders.map(o => ({
      id: o.id,
      name: o.shopifyOrderName || `Local-${o.id}`,
      customer: `${o.firstName} ${o.lastName}`,
      phone: o.phone,
      email: o.email || "-",
      address: `${o.city}, ${o.department}`,
      bundleSize: o.bundleSize,
      total: o.total,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    })),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
};

export default function Orders() {
  const { orders, total, page, totalPages } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const formatCOP = (amount: number) =>
    "$" + amount.toLocaleString("es-CO");

  const statusBadge = (status: string) => {
    const tones: Record<string, any> = {
      pending: "attention",
      confirmed: "info",
      fulfilled: "success",
      cancelled: "critical",
    };
    return <Badge tone={tones[status] || "new"}>{status}</Badge>;
  };

  const rows = orders.map((order: any) => [
    order.name,
    order.customer,
    order.phone,
    order.address,
    `${order.bundleSize} prod.`,
    formatCOP(order.total),
    order.status,
    new Date(order.createdAt).toLocaleString("es-CO", { timeZone: "America/Bogota" }),
  ]);

  return (
    <Page
      title="Ordenes COD"
      subtitle={`${total} ordenes en total`}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {rows.length > 0 ? (
                <>
                  <DataTable
                    columnContentTypes={[
                      "text", "text", "text", "text",
                      "text", "numeric", "text", "text"
                    ]}
                    headings={[
                      "Orden", "Cliente", "Telefono", "Ciudad",
                      "Bundle", "Total", "Estado", "Fecha"
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
                <Text as="p" tone="subdued">No hay ordenes</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
