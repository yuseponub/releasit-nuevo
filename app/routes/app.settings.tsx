import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Checkbox,
  Button,
  Banner,
  Divider,
  InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [alertConfig, bundlePricing] = await Promise.all([
    db.alertConfig.findUnique({ where: { shop } }),
    db.bundlePricing.findMany({ where: { shop }, orderBy: { quantity: "asc" } }),
  ]);

  return json({
    alertConfig: alertConfig || {
      emailEnabled: true,
      emailTo: "",
      whatsappEnabled: false,
      whatsappTo: "",
      checkIntervalMin: 30,
      noOrderThresholdMin: 60,
      activeHoursStart: "08:00",
      activeHoursEnd: "22:00",
      activeDays: "1,2,3,4,5,6,7",
    },
    bundlePricing: bundlePricing.length > 0
      ? bundlePricing
      : [
          { quantity: 1, price: 89900 },
          { quantity: 2, price: 129900 },
          { quantity: 3, price: 159900 },
        ],
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save-alerts") {
    await db.alertConfig.upsert({
      where: { shop },
      create: {
        shop,
        emailEnabled: formData.get("emailEnabled") === "true",
        emailTo: String(formData.get("emailTo") || ""),
        whatsappEnabled: formData.get("whatsappEnabled") === "true",
        whatsappTo: String(formData.get("whatsappTo") || ""),
        checkIntervalMin: Number(formData.get("checkIntervalMin")) || 30,
        noOrderThresholdMin: Number(formData.get("noOrderThresholdMin")) || 60,
        activeHoursStart: String(formData.get("activeHoursStart") || "08:00"),
        activeHoursEnd: String(formData.get("activeHoursEnd") || "22:00"),
        activeDays: String(formData.get("activeDays") || "1,2,3,4,5,6,7"),
      },
      update: {
        emailEnabled: formData.get("emailEnabled") === "true",
        emailTo: String(formData.get("emailTo") || ""),
        whatsappEnabled: formData.get("whatsappEnabled") === "true",
        whatsappTo: String(formData.get("whatsappTo") || ""),
        checkIntervalMin: Number(formData.get("checkIntervalMin")) || 30,
        noOrderThresholdMin: Number(formData.get("noOrderThresholdMin")) || 60,
        activeHoursStart: String(formData.get("activeHoursStart") || "08:00"),
        activeHoursEnd: String(formData.get("activeHoursEnd") || "22:00"),
        activeDays: String(formData.get("activeDays") || "1,2,3,4,5,6,7"),
      },
    });

    return json({ success: true, message: "Configuracion de alertas guardada" });
  }

  if (intent === "save-pricing") {
    const prices = [
      { quantity: 1, price: Number(formData.get("price1")) || 89900 },
      { quantity: 2, price: Number(formData.get("price2")) || 129900 },
      { quantity: 3, price: Number(formData.get("price3")) || 159900 },
    ];

    for (const p of prices) {
      await db.bundlePricing.upsert({
        where: { shop_quantity: { shop, quantity: p.quantity } },
        create: { shop, quantity: p.quantity, price: p.price },
        update: { price: p.price },
      });
    }

    return json({ success: true, message: "Precios de bundle guardados" });
  }

  return json({ success: false, message: "Accion no reconocida" });
};

export default function Settings() {
  const { alertConfig, bundlePricing } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Alert config state
  const [emailEnabled, setEmailEnabled] = useState(alertConfig.emailEnabled);
  const [emailTo, setEmailTo] = useState(alertConfig.emailTo || "");
  const [whatsappEnabled, setWhatsappEnabled] = useState(alertConfig.whatsappEnabled);
  const [whatsappTo, setWhatsappTo] = useState(alertConfig.whatsappTo || "");
  const [checkInterval, setCheckInterval] = useState(String(alertConfig.checkIntervalMin));
  const [threshold, setThreshold] = useState(String(alertConfig.noOrderThresholdMin));
  const [activeStart, setActiveStart] = useState(alertConfig.activeHoursStart);
  const [activeEnd, setActiveEnd] = useState(alertConfig.activeHoursEnd);

  // Bundle pricing state
  const pricingMap: Record<number, number> = {};
  bundlePricing.forEach((p: any) => { pricingMap[p.quantity] = p.price; });
  const [price1, setPrice1] = useState(String(pricingMap[1] || 89900));
  const [price2, setPrice2] = useState(String(pricingMap[2] || 129900));
  const [price3, setPrice3] = useState(String(pricingMap[3] || 159900));

  const handleSaveAlerts = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "save-alerts");
    formData.set("emailEnabled", String(emailEnabled));
    formData.set("emailTo", emailTo);
    formData.set("whatsappEnabled", String(whatsappEnabled));
    formData.set("whatsappTo", whatsappTo);
    formData.set("checkIntervalMin", checkInterval);
    formData.set("noOrderThresholdMin", threshold);
    formData.set("activeHoursStart", activeStart);
    formData.set("activeHoursEnd", activeEnd);
    submit(formData, { method: "post" });
  }, [emailEnabled, emailTo, whatsappEnabled, whatsappTo, checkInterval, threshold, activeStart, activeEnd, submit]);

  const handleSavePricing = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "save-pricing");
    formData.set("price1", price1);
    formData.set("price2", price2);
    formData.set("price3", price3);
    submit(formData, { method: "post" });
  }, [price1, price2, price3, submit]);

  return (
    <Page title="Configuracion">
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner tone="success" title={actionData.message} />
        )}

        {/* Bundle Pricing */}
        <Layout>
          <Layout.AnnotatedSection
            title="Precios de Bundle"
            description="Configura los precios por cantidad de productos. Los precios se aplican al total del carrito independientemente de la mezcla de productos."
          >
            <Card>
              <BlockStack gap="400">
                <TextField
                  label="1 unidad (COP)"
                  type="number"
                  value={price1}
                  onChange={setPrice1}
                  autoComplete="off"
                  helpText={`$${Number(price1).toLocaleString("es-CO")} COP`}
                />
                <TextField
                  label="2 unidades (COP)"
                  type="number"
                  value={price2}
                  onChange={setPrice2}
                  autoComplete="off"
                  helpText={`$${Number(price2).toLocaleString("es-CO")} COP — $${Math.round(Number(price2) / 2).toLocaleString("es-CO")}/u`}
                />
                <TextField
                  label="3 unidades (COP)"
                  type="number"
                  value={price3}
                  onChange={setPrice3}
                  autoComplete="off"
                  helpText={`$${Number(price3).toLocaleString("es-CO")} COP — $${Math.round(Number(price3) / 3).toLocaleString("es-CO")}/u`}
                />
                <Button
                  variant="primary"
                  onClick={handleSavePricing}
                  loading={isSubmitting}
                >
                  Guardar Precios
                </Button>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>

        <Divider />

        {/* Alert Configuration */}
        <Layout>
          <Layout.AnnotatedSection
            title="Alertas"
            description="Configura las notificaciones para cuando el formulario deje de generar ordenes."
          >
            <Card>
              <BlockStack gap="400">
                <Text variant="headingSm" as="h3">Email</Text>
                <Checkbox
                  label="Activar alertas por email"
                  checked={emailEnabled}
                  onChange={setEmailEnabled}
                />
                {emailEnabled && (
                  <TextField
                    label="Email destinatario"
                    type="email"
                    value={emailTo}
                    onChange={setEmailTo}
                    autoComplete="off"
                    placeholder="alertas@tutienda.com"
                  />
                )}

                <Divider />

                <Text variant="headingSm" as="h3">WhatsApp</Text>
                <Checkbox
                  label="Activar alertas por WhatsApp"
                  checked={whatsappEnabled}
                  onChange={setWhatsappEnabled}
                />
                {whatsappEnabled && (
                  <TextField
                    label="Numero WhatsApp (con codigo pais)"
                    value={whatsappTo}
                    onChange={setWhatsappTo}
                    autoComplete="off"
                    placeholder="whatsapp:+573001234567"
                    helpText="Formato Twilio: whatsapp:+57XXXXXXXXXX"
                  />
                )}

                <Divider />

                <Text variant="headingSm" as="h3">Horario de Monitoreo</Text>
                <InlineStack gap="400">
                  <TextField
                    label="Hora inicio"
                    value={activeStart}
                    onChange={setActiveStart}
                    autoComplete="off"
                    placeholder="08:00"
                  />
                  <TextField
                    label="Hora fin"
                    value={activeEnd}
                    onChange={setActiveEnd}
                    autoComplete="off"
                    placeholder="22:00"
                  />
                </InlineStack>

                <TextField
                  label="Alerta si no hay ordenes en (minutos)"
                  type="number"
                  value={threshold}
                  onChange={setThreshold}
                  autoComplete="off"
                  helpText="Se envia una alerta si no se reciben ordenes en este periodo durante horario activo"
                />

                <TextField
                  label="Intervalo de verificacion (minutos)"
                  type="number"
                  value={checkInterval}
                  onChange={setCheckInterval}
                  autoComplete="off"
                  helpText="Cada cuantos minutos se verifica el estado"
                />

                <Button
                  variant="primary"
                  onClick={handleSaveAlerts}
                  loading={isSubmitting}
                >
                  Guardar Alertas
                </Button>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </BlockStack>
    </Page>
  );
}
