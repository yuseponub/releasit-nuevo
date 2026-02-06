import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";
import { runHealthCheck, checkOrderHealth } from "../models/alerts.server";

/**
 * Health check endpoint.
 * Can be called by an external cron service (e.g., cron-job.org, Railway cron, etc.)
 * GET /api/health-check?secret=YOUR_SECRET
 *
 * Also serves as a status endpoint for the admin dashboard.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  const shopParam = url.searchParams.get("shop");

  // Simple secret-based auth for cron calls
  const expectedSecret = process.env.HEALTH_CHECK_SECRET || "releasitnuevo-health";
  if (secret !== expectedSecret) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // If a specific shop is provided, check just that one
    if (shopParam) {
      await runHealthCheck(shopParam);
      const health = await checkOrderHealth(shopParam);
      return json({ shop: shopParam, ...health });
    }

    // Otherwise, check all shops with alert configs
    const configs = await db.alertConfig.findMany();
    const results = [];

    for (const config of configs) {
      await runHealthCheck(config.shop);
      const health = await checkOrderHealth(config.shop);
      results.push({ shop: config.shop, ...health });
    }

    return json({ results, checkedAt: new Date().toISOString() });
  } catch (e: any) {
    console.error("Health check error:", e);
    return json({ error: e.message }, { status: 500 });
  }
};
