import { json } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
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
  Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useEffect } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const now = new Date();
  const activeThreshold = new Date(now.getTime() - 60 * 1000); // 60 seconds
  const idleThreshold = new Date(now.getTime() - 120 * 1000); // 2 minutes

  // Get active sessions (seen in last 60 seconds)
  const activeSessions = await db.activeSession.findMany({
    where: {
      shop,
      lastSeenAt: { gte: activeThreshold },
      status: { not: "closed" },
    },
    orderBy: { lastSeenAt: "desc" },
  });

  // Get recently closed sessions (last 10 minutes)
  const recentClosed = await db.activeSession.findMany({
    where: {
      shop,
      status: "closed",
      lastSeenAt: { gte: new Date(now.getTime() - 10 * 60 * 1000) },
    },
    orderBy: { lastSeenAt: "desc" },
    take: 10,
  });

  const formatSession = (s: any) => {
    let form: any = {};
    let cart: any[] = [];
    let extras: any[] = [];
    try { form = s.formData ? JSON.parse(s.formData) : {}; } catch (_) {}
    try { cart = s.cartData ? JSON.parse(s.cartData) : []; } catch (_) {}
    try { extras = s.extrasData ? JSON.parse(s.extrasData) : []; } catch (_) {}

    const isActive = s.lastSeenAt >= activeThreshold && s.status !== "closed";
    const isIdle = !isActive && s.lastSeenAt >= idleThreshold && s.status !== "closed";

    const secondsAgo = Math.round((now.getTime() - new Date(s.lastSeenAt).getTime()) / 1000);
    const sessionDuration = Math.round((new Date(s.lastSeenAt).getTime() - new Date(s.createdAt).getTime()) / 1000);

    return {
      id: s.id,
      customer: form.firstName ? `${form.firstName} ${form.lastName || ''}`.trim() : 'Anonimo',
      phone: form.phone || '-',
      email: form.email || '-',
      city: form.city || '-',
      products: cart.map((i: any) => `${i.title} x${i.quantity}`).join(', ') || 'Sin productos',
      extras: extras.map((e: any) => e.title).join(', ') || '-',
      status: s.status === "closed" ? "closed" : isActive ? "active" : isIdle ? "idle" : "gone",
      lastSeen: secondsAgo < 60 ? `${secondsAgo}s` : `${Math.round(secondsAgo / 60)}m`,
      duration: sessionDuration < 60 ? `${sessionDuration}s` : `${Math.round(sessionDuration / 60)}m`,
      page: s.page || '-',
    };
  };

  return json({
    active: activeSessions.map(formatSession),
    recentClosed: recentClosed.map(formatSession),
    activeCount: activeSessions.filter((s: any) => s.lastSeenAt >= activeThreshold).length,
    timestamp: now.toISOString(),
  });
};

export default function CarritosActivos() {
  const { active, recentClosed, activeCount, timestamp } = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      revalidate();
    }, 10000);
    return () => clearInterval(interval);
  }, [revalidate]);

  const statusBadge = (status: string) => {
    const config: Record<string, { tone: any; label: string }> = {
      active: { tone: "success", label: "Activo ahora" },
      idle: { tone: "attention", label: "Inactivo" },
      closed: { tone: "new", label: "Cerrado" },
      gone: { tone: "new", label: "Desconectado" },
    };
    const c = config[status] || { tone: "new", label: status };
    return <Badge tone={c.tone}>{c.label}</Badge>;
  };

  const activeRows = active.map((s: any) => [
    s.customer,
    s.phone,
    s.products,
    s.extras,
    s.city,
    statusBadge(s.status),
    s.duration,
    s.lastSeen,
  ]);

  const closedRows = recentClosed.map((s: any) => [
    s.customer,
    s.phone,
    s.products,
    s.city,
    s.duration,
    s.lastSeen + ' atras',
  ]);

  return (
    <Page
      title="Carritos Activos"
      subtitle={`${activeCount} persona(s) con el formulario abierto ahora`}
      primaryAction={
        <Button onClick={() => revalidate()}>Actualizar</Button>
      }
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  En vivo — {activeCount} activo(s)
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Se actualiza cada 10 segundos
                </Text>
              </InlineStack>

              {activeRows.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text"]}
                  headings={["Cliente", "Telefono", "Productos", "Extras", "Ciudad", "Estado", "Tiempo", "Ultimo ping"]}
                  rows={activeRows}
                />
              ) : (
                <Box padding="400">
                  <Text as="p" tone="subdued" alignment="center">
                    No hay nadie con el formulario abierto en este momento
                  </Text>
                </Box>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {closedRows.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Cerrados recientemente (ultimos 10 min)</Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["Cliente", "Telefono", "Productos", "Ciudad", "Duracion", "Hace"]}
                  rows={closedRows}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
