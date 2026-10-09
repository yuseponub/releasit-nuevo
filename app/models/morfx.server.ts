import crypto from "crypto";

// Avisa a MorfX de un carrito abandonado (la persona dejó el teléfono y no
// terminó). MorfX crea el pedido en CARRITO ABANDONADO y manda el template.
// Va directo, sin depender de que Shopify acepte el borrador.
// Firma HMAC: X-Morfx-Signature = hex(HMAC-SHA256(secret, `${ts}.POST.${path}.${body}`)).
// Nunca lanza: un fallo de MorfX no puede romper el formulario.

const MORFX_URL = process.env.MORFX_ABANDONED_CART_URL || "";
const MORFX_SECRET = process.env.MORFX_ABANDONED_CART_SECRET || "";

export async function notifyMorfxAbandonedCart(shop: string, form: any, items: any[], sessionId?: string) {
  if (!MORFX_URL || !MORFX_SECRET) return;
  const phone = typeof form?.phone === "string" ? form.phone.trim() : "";
  if (phone.replace(/\D/g, "").length < 7) return;
  try {
    const bundleQty = (items || []).reduce((s: number, i: any) => s + (Number(i?.quantity) || 0), 0) || 1;
    const body = JSON.stringify({
      event: "abandoned_cart",
      shop,
      lead: {
        phone,
        firstName: form.firstName || null,
        lastName: form.lastName || null,
        email: form.email || null,
        address: form.address || null,
        neighborhood: form.neighborhood || null,
        city: form.city || null,
        department: form.department || null,
        bundleQty,
        sessionId: sessionId || null,
      },
    });
    const url = new URL(MORFX_URL);
    const ts = String(Date.now());
    const signature = crypto.createHmac("sha256", MORFX_SECRET)
      .update(`${ts}.POST.${url.pathname}.${body}`, "utf8").digest("hex");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Morfx-Timestamp": ts, "X-Morfx-Signature": signature },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    console.log(`[MorfX] carrito abandonado ${res.status} session=${sessionId || "-"} ${text.slice(0, 120)}`);
  } catch (e: any) {
    console.error(`[MorfX] carrito abandonado falló session=${sessionId || "-"} err=${e?.message}`);
  }
}
