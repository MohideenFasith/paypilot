import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("./public/", import.meta.url);
const port = Number(process.env.PORT || 3000);

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const readJson = async (req) => {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Payload too large");
  }
  return raw ? JSON.parse(raw) : {};
};

export function scoreInvoice({ amount, daysOverdue, relationship, history }) {
  const dayScore = Math.min(Number(daysOverdue) / 90, 1) * 45;
  const amountScore = Math.min(Number(amount) / 10000, 1) * 25;
  const historyScore = history === "late" ? 22 : history === "new" ? 12 : 3;
  const relationshipRelief = relationship === "long-term" ? 8 : 0;
  const risk = Math.max(5, Math.min(98, Math.round(dayScore + amountScore + historyScore - relationshipRelief)));
  const tone = risk >= 70 ? "firm" : risk >= 40 ? "direct" : "warm";
  const plan = risk >= 70 ? [50, 50] : risk >= 40 ? [40, 30, 30] : [100];
  return { risk, tone, plan };
}

function fallbackAnalysis(input) {
  const { risk, tone, plan } = scoreInvoice(input);
  const first = String(input.clientName || "there").trim().split(/\s+/)[0];
  const currency = input.currency || "USD";
  const formatted = new Intl.NumberFormat("en", { style: "currency", currency }).format(Number(input.amount));
  const plans = plan.map((percentage, index) => ({
    label: plan.length === 1 ? "Pay in full" : `Payment ${index + 1}`,
    percentage,
    amount: Number((Number(input.amount) * percentage / 100).toFixed(2))
  }));
  return {
    risk,
    tone,
    confidence: 87,
    reason: risk >= 70
      ? "The invoice is significantly overdue and prior payment behavior raises collection risk."
      : risk >= 40
        ? "The delay is material, but a structured payment option may preserve the relationship."
        : "The account appears healthy; a friendly reminder is likely enough.",
    subject: `Quick note about invoice ${input.invoiceNumber}`,
    message: `Hi ${first},\n\nI hope you're well. ${input.invoiceNumber} for ${formatted} is now ${input.daysOverdue} days past due. I know timing can get complicated, so I've included a secure PayPal option to make settlement simple.\n\n${plan.length > 1 ? "If paying in full today is difficult, the proposed payment schedule below is available." : "You can settle the balance in full using the link below."}\n\nPlease let me know if there is anything we should clarify.\n\nThanks,\nAvery`,
    plans,
    nextAction: risk >= 70 ? "Send now and review in 48 hours" : "Send now and review in 5 days"
  };
}

async function analyzeWithAI(input) {
  if (!process.env.OPENAI_API_KEY) return { ...fallbackAnalysis(input), source: "local-model" };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: `You are a considerate accounts-receivable copilot. Analyze this invoice and return ONLY valid JSON with keys risk (0-100), tone, confidence, reason, subject, message, plans (array of label, percentage, amount), nextAction. Never threaten or make legal claims. Invoice: ${JSON.stringify(input)}`
    })
  });
  if (!response.ok) throw new Error(`AI provider returned ${response.status}`);
  const data = await response.json();
  const text = data.output?.flatMap(x => x.content || []).find(x => x.type === "output_text")?.text;
  return { ...JSON.parse(text), source: "openai" };
}

async function paypalToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) return null;
  const response = await fetch(`${process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com"}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) throw new Error(`PayPal authentication returned ${response.status}`);
  return (await response.json()).access_token;
}

async function createOrder(input) {
  const token = await paypalToken();
  if (!token) {
    return { demo: true, id: `DEMO-${Date.now()}`, status: "CREATED", approveUrl: null };
  }
  const base = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
  const response = await fetch(`${base}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "paypal-request-id": crypto.randomUUID() },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: input.invoiceNumber,
        description: `Invoice ${input.invoiceNumber}`,
        amount: { currency_code: input.currency || "USD", value: Number(input.amount).toFixed(2) }
      }],
      payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", return_url: `${input.origin}/?paid=1`, cancel_url: `${input.origin}/?cancelled=1` } } }
    })
  });
  if (!response.ok) throw new Error(`PayPal order creation returned ${response.status}`);
  const order = await response.json();
  return { ...order, approveUrl: order.links?.find(link => link.rel === "payer-action")?.href };
}

async function captureOrder(orderId) {
  const token = await paypalToken();
  if (!token) return { demo: true, id: orderId, status: "COMPLETED" };
  const base = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
  const response = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "paypal-request-id": crypto.randomUUID() }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.details?.[0]?.description || `PayPal capture returned ${response.status}`);
  return result;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { ok: true, ai: Boolean(process.env.OPENAI_API_KEY), paypal: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) });
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      const input = await readJson(req);
      if (!input.amount || !input.daysOverdue || !input.invoiceNumber) return json(res, 400, { error: "Missing invoice details" });
      return json(res, 200, await analyzeWithAI(input));
    }
    if (req.method === "POST" && req.url === "/api/paypal/orders") {
      const input = await readJson(req);
      return json(res, 200, await createOrder(input));
    }
    if (req.method === "POST" && req.url === "/api/paypal/capture") {
      const input = await readJson(req);
      if (!input.orderId) return json(res, 400, { error: "Missing order ID" });
      return json(res, 200, await captureOrder(input.orderId));
    }
    if (req.method !== "GET") return json(res, 404, { error: "Not found" });
    const pathname = new URL(req.url, "http://localhost").pathname;
    const safePath = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    if (safePath.startsWith("..")) return json(res, 403, { error: "Forbidden" });
    const file = await readFile(new URL(safePath, root));
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    res.writeHead(200, { "content-type": `${types[extname(safePath)] || "application/octet-stream"}; charset=utf-8` });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "Not found" });
    console.error(error);
    json(res, 500, { error: error.message || "Unexpected error" });
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) server.listen(port, () => console.log(`PayPilot running at http://localhost:${port}`));
