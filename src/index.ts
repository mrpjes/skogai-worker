// src/index.ts
import type { R2Bucket } from "@cloudflare/workers-types";
import { json as j, base64FromBytes, extractOpenAIJson } from "./lib/utils";
import { ANALYZERS /*, runAllAnalyses*/ } from "./analyses/all";

export interface Env {
  skogaiR2bucket: R2Bucket;
  OPENAI_API_KEY: string;
  ACCESS_TOKEN?: string;
}

const JSON_HDR = { "content-type": "application/json" } as const;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-access-token",
        },
      });
    }

    if (url.pathname === "/health") return new Response("ok");

    // Valfritt access-token
    if (env.ACCESS_TOKEN) {
      const t = req.headers.get("x-access-token");
      if (t !== env.ACCESS_TOKEN) return new Response("Forbidden", { status: 403 });
    }

    // Enkel UI
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(HTML_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" },
      });
    }

    // 1) Ladda upp PDF -> R2
    if (url.pathname === "/upload" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (!ct.startsWith("application/pdf")) return j({ ok: false, error: "Skicka application/pdf" }, 400);
      const ab = await req.arrayBuffer();
      const key = `uploads/${crypto.randomUUID()}.pdf`;
      await env.skogaiR2bucket.put(key, ab, { httpMetadata: { contentType: "application/pdf" } });
      return j({ ok: true, key });
    }

    // 2) Extrahera + analysera
    if (url.pathname === "/process" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        const key = body?.key as string | undefined;
        const analyses = Array.isArray(body?.analyses) ? (body.analyses as string[]) : [];
        const options = (body?.options ?? {}) as Record<string, unknown>;
        const model = (body?.model as string) || "gpt-4.1-mini";
        const SLICE_BYTES = Math.min(800_000, Math.max(120_000, Number(body?.slice_bytes) || 300_000));
        if (!key) return j({ ok: false, error: "Saknar 'key'" }, 400);

        const textFromClient =
          typeof body?.text === "string" && body.text.trim().length > 0 ? (body.text as string).trim() : null;

        const obj = await env.skogaiR2bucket.get(key);
        if (!obj) return j({ ok: false, error: "File not found in R2", key }, 404);
        const ab = await obj.arrayBuffer();

        // Gör prompt-data: antingen klientens text eller binär slice (base64)
        let userPayload: string;
        let sliceInfo: { input_size_bytes: number; slice_bytes_used: number; partial: boolean } | null = null;
        if (textFromClient) {
          userPayload = `Detta är text extraherad ur ett svenskt skogsprospekt (PDF).\n\n${textFromClient}`;
        } else {
          const u8 = new Uint8Array(ab).slice(0, Math.min(ab.byteLength, SLICE_BYTES));
          sliceInfo = {
            input_size_bytes: ab.byteLength,
            slice_bytes_used: u8.byteLength,
            partial: ab.byteLength > u8.byteLength,
          };
          const b64 = base64FromBytes(u8);
          userPayload = `Detta är en base64-slice av ett skogsprospekt (PDF). Extrahera enligt schema.\n\nPDF_base64:\n${b64}`;
        }

        const schemaStr = JSON.stringify(skogsSchema());
        const prompt = `SYSTEM:
Du är en extraktor. Returnera ENBART giltig JSON som matchar följande JSON Schema.
Sätt null där uppgift saknas. Inga förklaringar, inga markdown
