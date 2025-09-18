// src/index.ts
import { ANALYZERS } from "./analyzers";
import { skogsSchema } from "./lib/schema";
import { JSON_HDR, json as j, base64FromBytes, extractInnerJsonString } from "./lib/utils";

export interface Env {
  skogaiR2bucket: R2Bucket;
  OPENAI_API_KEY: string;
  ACCESS_TOKEN?: string;
  ASSETS: Fetcher;              // <- från wrangler [assets] binding = "ASSETS"
}

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

    // Health
    if (url.pathname === "/health") return new Response("ok", { status: 200 });

    // Token (om satt)
    if (env.ACCESS_TOKEN) {
      const t = req.headers.get("x-access-token");
      if (t !== env.ACCESS_TOKEN) return new Response("Forbidden", { status: 403 });
    }

    // -------- Static: allt under / (fallback till public/index.html)
    if (req.method === "GET" && (url.pathname === "/" || !url.pathname.startsWith("/upload") && !url.pathname.startsWith("/process") && !url.pathname.startsWith("/get/"))) {
      return env.ASSETS.fetch(req);
    }

    // -------- Upload (body = application/pdf)
    if (url.pathname === "/upload" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (!ct.startsWith("application/pdf")) return j({ ok: false, error: "Skicka application/pdf" }, 400);
      const ab = await req.arrayBuffer();
      const key = `uploads/${crypto.randomUUID()}.pdf`;
      await env.skogaiR2bucket.put(key, ab, { httpMetadata: { contentType: "application/pdf" } });
      return j({ ok: true, key });
    }

    // -------- Process
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

        // Bygg payload
        let userPayload: string;
        let sliceInfo: { input_size_bytes: number; slice_bytes_used: number; partial: boolean } | null = null;

        if (textFromClient) {
          userPayload = `Detta är text extraherad ur ett svenskt skogsprospekt (PDF).\n\n${textFromClient}`;
        } else {
          const u8 = new Uint8Array(ab).slice(0, Math.min(ab.byteLength, SLICE_BYTES));
          sliceInfo = { input_size_bytes: ab.byteLength, slice_bytes_used: u8.byteLength, partial: ab.byteLength > u8.byteLength };
          const b64 = base64FromBytes(u8);
          userPayload = `Detta är en base64-slice av ett skogsprospekt (PDF). Extrahera enligt schema.\n\nPDF_base64:\n${b64}`;
        }

        const schemaStr = JSON.stringify(skogsSchema());
        const prompt = `SYSTEM:
Du är en extraktor. Returnera ENBART giltig JSON som matchar följande JSON Schema.
Sätt null där uppgift saknas. Inga förklaringar, inga markdown-block, inga extra fält.

JSON_SCHEMA:
${schemaStr}

USER:
${userPayload}`;

        const r = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input: prompt, temperature: 0, max_output_tokens: 1200 }),
        });

        const openai = await r.json();

        // Plocka ut JSON
        let extractedText: string | null =
          openai?.output?.[0]?.content?.find((c: any) => c.type === "output_text")?.text ??
          openai?.output_text ??
          null;

        let baseData: any = null;
        if (typeof extractedText === "string") {
          try { baseData = JSON.parse(extractedText); } catch {}
        }
        if (!baseData) {
          const raw = JSON.stringify(openai);
          const inner = extractInnerJsonString(raw);
          if (inner) {
            try { baseData = JSON.parse(inner); } catch {}
          }
        }

        // Kör analyser
        const results: Record<string, unknown> = {};
        const ctx = { baseData, options };
        for (const name of analyses) {
          try {
            results[name] = ANALYZERS[name] ? (ANALYZERS as any)[name](ctx) : { ok: false, error: "unknown_analyzer" };
          } catch (e: any) {
            results[name] = { ok: false, error: e?.message ?? "analyzer_error" };
          }
        }

        return j({
          ok: true,
          key,
          model,
          ...(sliceInfo ?? { input_size_bytes: ab.byteLength, slice_bytes_used: ab.byteLength, partial: false }),
          data: baseData,
          analyses: results,
          raw: extractedText || JSON.stringify(openai),
        });
      } catch (e: any) {
        return j({ ok: false, error: e?.message ?? "internal_error" }, 500);
      }
    }

    // -------- Hämta PDF från R2
    if (url.pathname.startsWith("/get/")) {
      const k = decodeURIComponent(url.pathname.replace("/get/", ""));
      const o = await env.skogaiR2bucket.get(k);
      if (!o) return j({ ok: false, error: "Not found" }, 404);
      return new Response(o.body, {
        headers: { "content-type": o.httpMetadata?.contentType || "application/pdf" },
      });
    }

    // Default
    return new Response(JSON.stringify({ ok: true, msg: "UI + API running" }), {
      headers: { ...JSON_HDR, "access-control-allow-origin": "*" },
    });
  },
};
