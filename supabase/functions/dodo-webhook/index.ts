// Dodo Payments → Earpiece Pro. Verifies the Standard Webhooks signature, then keeps
// public.subscriptions in step with the subscription's life: active/renewed → Pro until the next
// billing date (plus a short grace for late renewals), cancelled/past due → Pro until the paid
// period ends, on hold/expired/failed → Free. Older events delivered late are ignored.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Webhook } from "npm:standardwebhooks@1.0.0";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GRACE_MS = 2 * 24 * 3600_000; // a renewal webhook that arrives a little late doesn't cut access
// Earpiece Pro products, live and test (ids aren't secret; DODO_PRODUCT_MONTH / _YEAR add to them).
const env = (name: string) => (Deno.env.get(name) || "").trim().replace(/^["']|["']$/g, "");
const PRO_PRODUCTS = [
  "pdt_0Nox7nghhsoBXPYpVE3cy", "pdt_0Nox7nhuXf5QMA425MfjH", // live
  "pdt_0NowseZLebYL9xfZ7e6RC", "pdt_0NowsebJJIuoHy8MRWTIt", // test
  env("DODO_PRODUCT_MONTH"), env("DODO_PRODUCT_YEAR"),
].filter(Boolean);

const ok = () => new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
const plus = (iso: string | null | undefined, ms: number) => (iso ? new Date(Date.parse(iso) + ms).toISOString() : null);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = await req.text();
  let event: { type: string; timestamp: string; data: Record<string, any> };
  try {
    event = new Webhook(env("DODO_WEBHOOK_SECRET")).verify(raw, {
      "webhook-id": req.headers.get("webhook-id") || "",
      "webhook-signature": req.headers.get("webhook-signature") || "",
      "webhook-timestamp": req.headers.get("webhook-timestamp") || "",
    }) as typeof event;
  } catch {
    return new Response("bad signature", { status: 401 });
  }
  if (!event.type?.startsWith("subscription.")) return ok();
  const s = event.data;
  // The Dodo business also sells other brands' products and their events arrive here too:
  // only the Earpiece Pro products may change an Earpiece account.
  if (!PRO_PRODUCTS.includes(s.product_id)) return ok();

  // Who: the user id put in the checkout metadata, else the customer's email.
  let uid: string | null = s.metadata?.user_id || null;
  if (!uid && s.customer?.email) {
    const { data } = await admin.rpc("user_id_by_email", { p_email: s.customer.email });
    uid = data || null;
  }
  if (!uid) {
    console.error("dodo-webhook: no user for", s.subscription_id);
    return ok(); // nothing to retry: Dodo would keep redelivering an event we can't place
  }

  const { data: cur } = await admin.from("subscriptions").select("event_at").eq("user_id", uid).maybeSingle();
  if (cur?.event_at && Date.parse(cur.event_at) > Date.parse(event.timestamp)) return ok();

  const t = event.type;
  let row: Record<string, unknown>;
  if (["subscription.active", "subscription.renewed", "subscription.plan_changed", "subscription.unpaused", "subscription.updated"].includes(t) && s.status === "active") {
    row = { plan: "pro", status: "active", current_period_end: plus(s.next_billing_date, GRACE_MS) };
  } else if (t === "subscription.past_due") {
    row = { plan: "pro", status: "past_due", current_period_end: s.past_due_ends_at || plus(s.next_billing_date, GRACE_MS) };
  } else if (t === "subscription.cancelled") {
    row = { plan: "pro", status: "canceled", current_period_end: s.next_billing_date || s.cancelled_at || event.timestamp };
  } else if (["subscription.on_hold", "subscription.paused", "subscription.expired", "subscription.failed"].includes(t)) {
    row = { plan: "free", status: "canceled", current_period_end: event.timestamp };
  } else {
    return ok(); // e.g. update_payment_method, or an update that isn't an activation
  }

  const { error } = await admin.from("subscriptions").upsert({
    user_id: uid,
    ...row,
    provider: "dodo",
    provider_customer_id: s.customer?.customer_id || null,
    provider_subscription_id: s.subscription_id || null,
    event_at: event.timestamp,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("dodo-webhook upsert", error.message);
    return new Response("db error", { status: 500 }); // Dodo retries
  }
  return ok();
});
