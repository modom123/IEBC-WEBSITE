/*
 * ─────────────────────────────────────────────────────────────────────────
 *  IEBC — consultant-chat Edge Function
 *  Created : 2026-09-30 UTC
 *  Purpose : Server-side proxy for the website's "My Consultants" chat so
 *            the Anthropic API key never reaches the browser.
 *
 *  Deploy  : supabase functions deploy consultant-chat --no-verify-jwt --project-ref gecnvzjuppmqcfcpmugq
 *  Secrets : supabase secrets set ANTHROPIC_API_KEY=sk-ant-...            --project-ref gecnvzjuppmqcfcpmugq
 *            supabase secrets set CHAT_ACCESS_CODES="IEBC-AAAA-1111,IEBC-BBBB-2222" --project-ref gecnvzjuppmqcfcpmugq
 *            (optional) supabase secrets set ALLOWED_ORIGIN=https://your-domain.com
 *
 *  Only requests carrying one of CHAT_ACCESS_CODES (issued to paying
 *  clients) are answered, so the endpoint can't be used as free AI.
 * ─────────────────────────────────────────────────────────────────────────
 */

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1200;
const MAX_MESSAGES = 30;
const MAX_CHARS_PER_MESSAGE = 8000;
const MAX_SYSTEM_CHARS = 6000;

const CHAT_RULES =
  "\n\nYou are in a live chat with an IEBC client through the IEBC website. " +
  "You are an AI advisor modeled on this IEBC role; if asked, say plainly that you are an AI assistant " +
  "and that the client's human IEBC team can follow up. Do not claim personal credentials or degrees. " +
  "Be direct, specific and genuinely helpful. Ask follow-up questions when you need more context. " +
  "For legal or tax matters, give general information and recommend confirming with a licensed attorney or CPA.";

const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const cors = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-iebc-access",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(500, { error: "Chat is not configured" });

  const codes = (Deno.env.get("CHAT_ACCESS_CODES") ?? "")
    .split(",").map((c) => c.trim()).filter(Boolean);
  const access = (req.headers.get("x-iebc-access") ?? "").trim();
  if (!codes.length || !codes.includes(access)) {
    return json(401, { error: "Invalid access code" });
  }

  let body: { system?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const system = typeof body.system === "string" ? body.system.slice(0, MAX_SYSTEM_CHARS) : "";
  if (!system.startsWith("You are ")) return json(400, { error: "Invalid consultant" });

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS_PER_MESSAGE) }));
  // The API requires the conversation to start with a user turn
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) return json(400, { error: "No message" });

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      system: system + CHAT_RULES,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    console.error("Anthropic error", upstream.status, await upstream.text().catch(() => ""));
    return json(502, { error: "Upstream error" });
  }

  // Pass the SSE stream straight through; the website parses content_block_delta events
  return new Response(upstream.body, {
    headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});
