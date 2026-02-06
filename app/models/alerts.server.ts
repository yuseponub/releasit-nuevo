import nodemailer from "nodemailer";
import db from "../db.server";

// ----- Email Alert Service -----
function createEmailTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendEmailAlert(
  shop: string,
  subject: string,
  message: string,
  to?: string
): Promise<boolean> {
  const recipient = to || process.env.ALERT_EMAIL_TO;
  if (!recipient || !process.env.SMTP_USER) {
    console.warn("Email alert skipped: no recipient or SMTP config");
    return false;
  }

  try {
    const transporter = createEmailTransporter();
    await transporter.sendMail({
      from: `"ReleasitNuevo Alertas" <${process.env.SMTP_USER}>`,
      to: recipient,
      subject: `[ReleasitNuevo] ${subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #2D9B83; padding: 20px; border-radius: 8px 8px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 20px;">ReleasitNuevo - Alerta</h1>
          </div>
          <div style="padding: 20px; border: 1px solid #E5E7EB; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 14px; color: #1A1A2E;">${message}</p>
            <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 16px 0;">
            <p style="font-size: 12px; color: #6B7280;">Tienda: ${shop}</p>
            <p style="font-size: 12px; color: #6B7280;">Hora: ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}</p>
          </div>
        </div>
      `,
    });

    await db.alertLog.create({
      data: { shop, type: "email", message: subject, status: "sent" },
    });

    return true;
  } catch (e: any) {
    console.error("Email alert failed:", e);
    await db.alertLog.create({
      data: { shop, type: "email", message: subject, status: "failed", error: e.message },
    });
    return false;
  }
}

// ----- WhatsApp Alert Service (Twilio) -----
export async function sendWhatsAppAlert(
  shop: string,
  message: string,
  to?: string
): Promise<boolean> {
  const recipient = to || process.env.ALERT_WHATSAPP_TO;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;

  if (!recipient || !sid || !token || !from) {
    console.warn("WhatsApp alert skipped: missing Twilio config");
    return false;
  }

  try {
    // Use Twilio REST API directly to avoid requiring the full Twilio SDK at runtime
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: from,
        To: recipient,
        Body: `[ReleasitNuevo] ${message}\n\nTienda: ${shop}\nHora: ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Twilio error: ${response.status} ${await response.text()}`);
    }

    await db.alertLog.create({
      data: { shop, type: "whatsapp", message, status: "sent" },
    });

    return true;
  } catch (e: any) {
    console.error("WhatsApp alert failed:", e);
    await db.alertLog.create({
      data: { shop, type: "whatsapp", message, status: "failed", error: e.message },
    });
    return false;
  }
}

// ----- Health Monitor -----
export async function checkOrderHealth(shop: string): Promise<{
  healthy: boolean;
  lastOrderAt: Date | null;
  ordersToday: number;
  minutesSinceLastOrder: number | null;
}> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [lastOrder, ordersToday] = await Promise.all([
    db.codOrder.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
    db.codOrder.count({
      where: {
        shop,
        createdAt: { gte: todayStart },
      },
    }),
  ]);

  const lastOrderAt = lastOrder?.createdAt || null;
  const minutesSinceLastOrder = lastOrderAt
    ? Math.round((now.getTime() - lastOrderAt.getTime()) / 60000)
    : null;

  // Get alert config for this shop
  const config = await db.alertConfig.findUnique({
    where: { shop },
  });

  const threshold = config?.noOrderThresholdMin || 60;

  // Check if within active hours
  const isActiveHour = isWithinActiveHours(
    now,
    config?.activeHoursStart || "08:00",
    config?.activeHoursEnd || "22:00",
    config?.activeDays || "1,2,3,4,5,6,7"
  );

  const healthy =
    !isActiveHour ||
    minutesSinceLastOrder === null ||
    minutesSinceLastOrder < threshold;

  return {
    healthy,
    lastOrderAt,
    ordersToday,
    minutesSinceLastOrder,
  };
}

function isWithinActiveHours(
  now: Date,
  start: string,
  end: string,
  days: string
): boolean {
  // Convert to Colombia time
  const colombiaTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Bogota" }));
  const currentDay = colombiaTime.getDay() || 7; // Sunday = 7
  const activeDays = days.split(",").map(Number);

  if (!activeDays.includes(currentDay)) return false;

  const [startHour, startMin] = start.split(":").map(Number);
  const [endHour, endMin] = end.split(":").map(Number);
  const currentMinutes = colombiaTime.getHours() * 60 + colombiaTime.getMinutes();
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

// Run health check and send alerts if needed
export async function runHealthCheck(shop: string): Promise<void> {
  const health = await checkOrderHealth(shop);

  if (!health.healthy) {
    const config = await db.alertConfig.findUnique({ where: { shop } });

    // Check if we already sent an alert recently (within last 30 minutes)
    const recentAlert = await db.alertLog.findFirst({
      where: {
        shop,
        status: "sent",
        createdAt: {
          gte: new Date(Date.now() - 30 * 60 * 1000),
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (recentAlert) return; // Don't spam alerts

    const message = `Sin ordenes en los ultimos ${health.minutesSinceLastOrder} minutos.\n` +
      `Ultima orden: ${health.lastOrderAt?.toLocaleString("es-CO", { timeZone: "America/Bogota" }) || "Nunca"}\n` +
      `Ordenes hoy: ${health.ordersToday}`;

    if (config?.emailEnabled) {
      await sendEmailAlert(shop, "Sin ordenes recientes", message, config.emailTo || undefined);
    }

    if (config?.whatsappEnabled) {
      await sendWhatsAppAlert(shop, message, config.whatsappTo || undefined);
    }
  }
}
