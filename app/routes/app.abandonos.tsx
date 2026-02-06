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

  const [drafts, total] = await Promise.all([
    db.draftOrder.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.draftOrder.count({ where: { shop } }),
  ]);

  return json({
    drafts: drafts.map(d => {
      let items: any[] = [];
      try {
        items = d.items ? JSON.parse(d.items) : [];
      } catch (_) { /* ignore */ }

      return {
        id: d.id,
        shopifyId: d.shopifyDraftOrderId || "-",
        customer: `${d.firstName} ${d.lastName || ""}`.trim(),
        phone: d.phone,
        items: items.map((i: any) => `${i.title} x${i.quantity}`).join(", ") || "Sin productos",
        status: d.status,
        createdAt: d.createdAt.toISOString(),
      };
    }),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
};

export default function Abandonos() {
  const { drafts, total, page, totalPages } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const statusBadge = (status: string) => {
    const tones: Record<string, any> = {
      open: "attention",
      invoice_sent: "info",
      completed: "success",
    };
    return <Badge tone={tones[status] || "new"}>{status}</Badge>;
  };

  const rows = drafts.map((draft: any) => [
    draft.customer,
    draft.phone,
    draft.items,
    draft.status,
    new Date(draft.createdAt).toLocaleString("es-CO", { timeZone: "America/Bogota" }),
    <Button
      key={draft.id}
      size="slim"
      url={`https://wa.me/${draft.phone.replace(/\D/g, "")}?text=${encodeURIComponent(
        `Hola ${draft.customer}! Vimos que estabas interesado en nuestros productos. ¿Te gustaria completar tu pedido?`
      )}`}
      external
    >
      Contactar
    </Button>,
  ]);

  return (
    <Page
      title="Abandonos"
      subtitle={`${total} abandonos registrados`}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="p" tone="subdued">
                Clientes que ingresaron nombre y telefono pero no completaron el pedido.
                Puedes contactarlos por WhatsApp para recuperar la venta.
              </Text>

              {rows.length > 0 ? (
                <>
                  <DataTable
                    columnContentTypes={[
                      "text", "text", "text", "text", "text", "text"
                    ]}
                    headings={[
                      "Cliente", "Telefono", "Productos", "Estado", "Fecha", "Accion"
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
                <Text as="p" tone="subdued">No hay abandonos registrados</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
