import { json } from "@remix-run/node";
import { useLoaderData, useRevalidator, useSearchParams } from "@remix-run/react";
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
  Pagination,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useEffect } from "react";

const HISTORY_PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const historyPage = Math.max(1, Number(url.searchParams.get("hp")) || 1);

  const now = new Date();
  const activeThreshold = new Date(now.getTime() - 60 * 1000);
  const idleThreshold = new Date(now.getTime() - 120 * 1000);

  // Active sessions (last 60 seconds)
  const activeSessions = await db.activeSession.findMany({
    where: { shop, lastSeenAt: { gte: activeThreshold }, status: { not: "closed" } },
    orderBy: { lastSeenAt: "desc" },
  });

  // Recently closed (last 10 min)
  const recentClosed = await db.activeSession.findMany({
    where: { shop, status: "closed", lastSeenAt: { gte: new Date(now.getTime() - 10 * 60 * 1000) } },
    orderBy: { lastSeenAt: "desc" },
    take: 10,
  });

  // History: all sessions (paginated)
  const [historySessions, historyTotal] = await Promise.all([
    db.activeSession.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      skip: (historyPage - 1) * HISTORY_PAGE_SIZE,
      take: HISTORY_PAGE_SIZE,
    }),
    db.activeSession.count({ where: { shop } }),
  ]);

  // Stats
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [todayTotal, todayWithForm, todayCompleted] = await Promise.all([
    db.activeSession.count({ where: { shop, createdAt: { gte: today } } }),
    db.activeSession.count({
      where: { shop, createdAt: { gte: today }, formData: { not: null } },
    }),
    db.activeSession.count({
      where: { shop, createdAt: { gte: today }, status: "completed" },
    }),
  ]);

  const formatSession = (s: any, isHistory = false) => {
    let form: any = {};
    let cart: any[] = [];
    let extras: any[] = [];
    try { form = s.formData ? JSON.parse(s.formData) : {}; } catch (_) {}
    try { cart = s.cartData ? JSON.parse(s.cartData) : []; } catch (_) {}
    try { extras = s.extrasData ? JSON.parse(s.extrasData) : []; } catch (_) {}

    const isActive = new Date(s.lastSeenAt) >= activeThreshold && s.status !== "closed" && s.status !== "completed";
    const isIdle = !isActive && new Date(s.lastSeenAt) >= idleThreshold && s.status !== "closed" && s.status !== "completed";

    const secondsAgo = Math.round((now.getTime() - new Date(s.lastSeenAt).getTime()) / 1000);
    const sessionDuration = Math.round((new Date(s.lastSeenAt).getTime() - new Date(s.createdAt).getTime()) / 1000);

    let statusVal = s.status === "completed" ? "completed" : s.status === "closed" ? "closed" : isActive ? "active" : isIdle ? "idle" : "gone";

    return {
      id: s.id,
      shortId: s.id.slice(-6).toUpperCase(),
      ip: s.ip || '-',
      customer: form.firstName ? `${form.firstName} ${form.lastName || ''}`.trim() : 'Anonimo',
      phone: form.phone || '-',
      email: form.email || '-',
      city: form.city || '-',
      products: cart.map((i: any) => `${i.title} x${i.quantity}`).join(', ') || 'Sin productos',
      extras: extras.map((e: any) => e.title).join(', ') || '-',
      status: statusVal,
      lastSeen: secondsAgo < 60 ? `${secondsAgo}s` : secondsAgo < 3600 ? `${Math.round(secondsAgo / 60)}m` : `${Math.round(secondsAgo / 3600)}h`,
      duration: sessionDuration < 60 ? `${sessionDuration}s` : sessionDuration < 3600 ? `${Math.round(sessionDuration / 60)}m` : `${Math.round(sessionDuration / 3600)}h`,
      createdAt: new Date(s.createdAt).toLocaleString("es-CO", { timeZone: "America/Bogota" }),
    };
  };

  return json({
    active: activeSessions.map(s => formatSession(s)),
    recentClosed: recentClosed.map(s => formatSession(s)),
    history: historySessions.map(s => formatSession(s, true)),
    historyTotal,
    historyPage,
    historyTotalPages: Math.ceil(historyTotal / HISTORY_PAGE_SIZE),
    activeCount: activeSessions.length,
    stats: { todayTotal, todayWithForm, todayCompleted },
  });
};

export default function CarritosActivos() {
  const { active, recentClosed, history, historyTotal, historyPage, historyTotalPages, activeCount, stats } = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const interval = setInterval(() => revalidate(), 10000);
    return () => clearInterval(interval);
  }, [revalidate]);

  const statusBadge = (status: string) => {
    const config: Record<string, { tone: any; label: string }> = {
      active: { tone: "success", label: "Activo" },
      idle: { tone: "attention", label: "Inactivo" },
      closed: { tone: "new", label: "Cerrado" },
      completed: { tone: "info", label: "Compro" },
      gone: { tone: "new", label: "Salio" },
    };
    const c = config[status] || { tone: "new", label: status };
    return <Badge tone={c.tone}>{c.label}</Badge>;
  };

  const activeRows = active.map((s: any) => [
    s.shortId,
    s.customer,
    s.phone,
    s.products,
    s.city,
    s.ip,
    statusBadge(s.status),
    s.duration,
  ]);

  const closedRows = recentClosed.map((s: any) => [
    s.shortId,
    s.customer,
    s.phone,
    s.products,
    s.city,
    s.ip,
    s.duration,
    s.lastSeen + ' atras',
  ]);

  const historyRows = history.map((s: any) => [
    s.shortId,
    s.customer,
    s.phone,
    s.products,
    s.city,
    s.ip,
    statusBadge(s.status),
    s.duration,
    s.createdAt,
  ]);

  const formRate = stats.todayTotal > 0 ? ((stats.todayWithForm / stats.todayTotal) * 100).toFixed(0) : "0";
  const convRate = stats.todayTotal > 0 ? ((stats.todayCompleted / stats.todayTotal) * 100).toFixed(0) : "0";

  return (
    <Page
      title="Carritos Activos"
      subtitle={`${activeCount} persona(s) con el formulario abierto ahora`}
      primaryAction={<Button onClick={() => revalidate()}>Actualizar</Button>}
    >
      <Layout>
        {/* Stats de hoy */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Hoy</Text>
              <InlineStack gap="400" align="space-around">
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{stats.todayTotal}</Text>
                    <Text as="p" tone="subdued">Abrieron formulario</Text>
                  </BlockStack>
                </Box>
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{stats.todayWithForm}</Text>
                    <Text as="p" tone="subdued">Llenaron datos</Text>
                  </BlockStack>
                </Box>
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{formRate}%</Text>
                    <Text as="p" tone="subdued">Tasa formulario</Text>
                  </BlockStack>
                </Box>
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{stats.todayCompleted}</Text>
                    <Text as="p" tone="subdued">Compraron</Text>
                  </BlockStack>
                </Box>
                <Box>
                  <BlockStack gap="100" inlineAlign="center">
                    <Text as="p" variant="headingLg">{convRate}%</Text>
                    <Text as="p" tone="subdued">Conversion</Text>
                  </BlockStack>
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* En vivo */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">En vivo — {activeCount} activo(s)</Text>
                <Text as="p" tone="subdued" variant="bodySm">Se actualiza cada 10s</Text>
              </InlineStack>
              {activeRows.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text"]}
                  headings={["ID", "Cliente", "Telefono", "Productos", "Ciudad", "IP", "Estado", "Tiempo"]}
                  rows={activeRows}
                />
              ) : (
                <Box padding="400">
                  <Text as="p" tone="subdued" alignment="center">Nadie tiene el formulario abierto ahora</Text>
                </Box>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Cerrados recientemente */}
        {closedRows.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Cerrados recientemente (10 min)</Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text"]}
                  headings={["ID", "Cliente", "Telefono", "Productos", "Ciudad", "IP", "Duracion", "Hace"]}
                  rows={closedRows}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Historial */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Historial ({historyTotal} sesiones totales)</Text>
              {historyRows.length > 0 ? (
                <>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text", "text"]}
                    headings={["ID", "Cliente", "Telefono", "Productos", "Ciudad", "IP", "Estado", "Duracion", "Fecha"]}
                    rows={historyRows}
                  />
                  {historyTotalPages > 1 && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "16px" }}>
                      <Pagination
                        hasPrevious={historyPage > 1}
                        onPrevious={() => {
                          searchParams.set("hp", String(historyPage - 1));
                          setSearchParams(searchParams);
                        }}
                        hasNext={historyPage < historyTotalPages}
                        onNext={() => {
                          searchParams.set("hp", String(historyPage + 1));
                          setSearchParams(searchParams);
                        }}
                      />
                    </div>
                  )}
                </>
              ) : (
                <Text as="p" tone="subdued">No hay historial aun</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
