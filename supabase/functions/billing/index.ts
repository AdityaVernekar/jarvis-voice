// Earpiece Pro billing for the signed-in user: { action: "checkout", interval: "month" | "year" }
// returns a Dodo Payments checkout URL; { action: "portal" } returns the customer portal URL
// (change card, cancel). The Supabase user id rides along in the checkout metadata so the
// webhook (dodo-webhook) can tie the subscription back to the account.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// Secrets are trimmed: a pasted trailing space or quotes shouldn't silently switch modes or break the key.
const env = (name: string) => (Deno.env.get(name) || "").trim().replace(/^["']|["']$/g, "");
const DODO = env("DODO_ENV").toLowerCase() === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
const API_KEY = env("DODO_API_KEY").replace(/^Bearer\s+/i, "");
// Earpiece Pro products (Earpiece brand in Dodo), per mode. Not secret; DODO_PRODUCT_MONTH / _YEAR override.
const LIVE = DODO.includes("live.");
const PRODUCTS: Record<string, string> = {
  month: env("DODO_PRODUCT_MONTH") || (LIVE ? "pdt_0Nox7nghhsoBXPYpVE3cy" : "pdt_0NowseZLebYL9xfZ7e6RC"),
  year: env("DODO_PRODUCT_YEAR") || (LIVE ? "pdt_0Nox7nhuXf5QMA425MfjH" : "pdt_0NowsebJJIuoHy8MRWTIt"),
};
const RETURN_URL = "https://earpiece.dev/?pro=thanks";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function dodo(path: string, body: unknown) {
  const res = await fetch(`${DODO}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`dodo ${DODO} ${path} HTTP ${res.status} (key ${API_KEY.length} chars): ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const { data, error } = await admin.auth.getUser((req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
  const user = data?.user;
  if (error || !user?.email) return json(401, { error: "sign in first" });
  const p = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  try {
    if (p.action === "portal") {
      const { data: sub } = await admin.from("subscriptions").select("provider_customer_id").eq("user_id", user.id).maybeSingle();
      if (!sub?.provider_customer_id) return json(404, { error: "no Earpiece Pro subscription yet" });
      const portal = await dodo(`/customers/${sub.provider_customer_id}/customer-portal/session`, {});
      return json(200, { url: portal.link });
    }
    const product_id = PRODUCTS[String(p.interval || "month")];
    if (!product_id) return json(400, { error: "interval must be month or year" });
    const m = user.user_metadata || {};
    const session = await dodo("/checkouts", {
      product_cart: [{ product_id, quantity: 1 }],
      customer: { email: user.email, name: m.full_name || m.name || undefined },
      metadata: { user_id: user.id, app: "earpiece" },
      return_url: RETURN_URL,
      feature_flags: { allow_discount_code: true },
    });
    return json(200, { url: session.checkout_url });
  } catch (e) {
    console.error(String(e));
    return json(502, { error: "billing provider unavailable" });
  }
});
