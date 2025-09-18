// src/index.ts
export interface Env {
  skogaiR2bucket: R2Bucket;         // måste matcha wrangler.toml binding
  OPENAI_API_KEY: string;           // sätts som Secret i Cloudflare
  ACCESS_TOKEN?: string;            // valfritt; om du vill låsa API med header
}

const JSON_HDR = { "content-type": "application/json" } as const;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // --- CORS (enkel) ---
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-access-token",
        },
      });
    }

    // --- Healthcheck ---
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // (valfritt) kräva hemlig header
    if (env.ACCESS_TOKEN) {
      const t = req.headers.get("x-access-token");
      if (t !== env.ACCESS_TOKEN) return new Response("Forbidden", { status: 403 });
    }

    // UI
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(HTML_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Ladda upp PDF till R2 (kropp = rå PDF, content-type: application/pdf)
    if (url.pathname === "/upload" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (!ct.startsWith("application/pdf")) return j({ ok: false, error: "Skicka application/pdf" }, 400);
      const ab = await req.arrayBuffer();
      const key = `uploads/${crypto.randomUUID()}.pdf`;
      await env.skogaiR2bucket.put(key, ab, { httpMetadata: { contentType: "application/pdf" } });
      return j({ ok: true, key });
    }

    // Process (extrahera + analysera)
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

        // userPayload = klientens text eller binär slice
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
Sätt null där uppgift saknas. Inga förklaringar, inga markdown-block, inga extra fält.

JSON_SCHEMA:
${schemaStr}

USER:
${userPayload}`;

        // OpenAI Responses API
        const r = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: prompt,
            temperature: 0,
            max_output_tokens: 1200,
          }),
        });

        const openai = await r.json();

        // Ta ut text från Responses API strukturen
        let extractedText: string | null =
          openai?.output?.[0]?.content?.find((c: any) => c.type === "output_text")?.text ??
          openai?.output_text ??
          null;

        let baseData: any = null;
        if (typeof extractedText === "string") {
          try {
            baseData = JSON.parse(extractedText);
          } catch {
            /* fallback nedan */
          }
        }
        if (!baseData) {
          const raw = JSON.stringify(openai);
          const inner = extractInnerJsonString(raw);
          if (inner) {
            try {
              baseData = JSON.parse(inner);
            } catch {}
          }
        }

        // Analyser
        const results: Record<string, unknown> = {};
        const ctx = { baseData, options };
        for (const name of analyses) {
          try {
            if (ANALYZERS[name as keyof typeof ANALYZERS]) {
              results[name] = (ANALYZERS as any)[name](ctx);
            } else results[name] = { ok: false, error: "unknown_analyzer" };
          } catch (e: any) {
            results[name] = { ok: false, error: e?.message ?? "analyzer_error" };
          }
        }

        return j({
          ok: true,
          key,
          model,
          ...(sliceInfo ?? {
            input_size_bytes: ab.byteLength,
            slice_bytes_used: ab.byteLength,
            partial: false,
          }),
          data: baseData,
          analyses: results,
          raw: extractedText || JSON.stringify(openai),
        });
      } catch (e: any) {
        return j({ ok: false, error: e?.message ?? "internal_error" }, 500);
      }
    }

    // Hämta PDF från R2 (valfritt)
    if (url.pathname.startsWith("/get/")) {
      const k = decodeURIComponent(url.pathname.replace("/get/", ""));
      const o = await env.skogaiR2bucket.get(k);
      if (!o) return j({ ok: false, error: "Not found" }, 404);
      return new Response(o.body, {
        headers: { "content-type": o.httpMetadata?.contentType || "application/pdf" },
      });
    }

    // default
    return new Response(JSON.stringify({ ok: true, msg: "UI + API running" }), {
      headers: { ...JSON_HDR, "access-control-allow-origin": "*" },
    });
  },
};

// ---------- Hjälpare ----------
function j(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HDR, "access-control-allow-origin": "*" },
  });
}

function base64FromBytes(u8: Uint8Array): string {
  // chunkad för att undvika call-stack-problem
  let s = "";
  const c = 0x8000;
  for (let i = 0; i < u8.length; i += c) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + c)) as any);
  }
  // @ts-ignore
  return btoa(s);
}

function extractInnerJsonString(s: string): string | null {
  // Försöker hitta ett JSON-objekt i en strängad payload:  {\"fastighet\"...}
  const m = s.match(/{\\\"fastighet\\\"[\s\S]*?}/);
  return m ? m[0].replace(/\\"/g, '"') : null;
}

function n(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.replace(/\s/g, "").replace(",", ".");
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function skogsSchema() {
  return {
    type: "object",
    properties: {
      fastighet: { type: ["string", "null"] },
      kommun: { type: ["string", "null"] },
      lage_beskrivning: { type: ["string", "null"] },
      areal_total_ha: { type: ["number", "null"] },
      skogsmark_ha: { type: ["number", "null"] },
      impediment_ha: { type: ["number", "null"] },
      volym_total_m3sk: { type: ["number", "null"] },
      volym_per_ha_m3sk: { type: ["number", "null"] },
      medelalder_ar: { type: ["number", "null"] },
      bonitet: { type: ["number", "null"] },
      huggningsklass: { type: ["string", "null"] },
      tradslag_andelar: {
        type: "object",
        properties: {
          gran_procent: { type: ["number", "null"] },
          tall_procent: { type: ["number", "null"] },
          "löv_procent": { type: ["number", "null"] },
        },
        required: ["gran_procent", "tall_procent", "löv_procent"],
      },
      pris_forvantning_sek: { type: ["number", "null"] },
      koordinater: { type: ["string", "null"] },
    },
    required: ["fastighet", "kommun", "skogsmark_ha", "volym_total_m3sk"],
    additionalProperties: true,
  };
}

const ANALYZERS = {
  price_metrics: ({ baseData }: any) => {
    const A = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
    const V = n(baseData?.volym_total_m3sk);
    const P = n(baseData?.pris_forvantning_sek);
    const vPerHa = V && A ? V / A : null;
    return {
      ok: true,
      areal_anv: A,
      volym_total_m3sk: V,
      volym_per_ha_m3sk: vPerHa,
      pris_forvantning_sek: P,
      pris_per_ha: P && A ? P / A : null,
      pris_per_m3sk: P && V ? P / V : null,
    };
  },
  risk: ({ baseData, options }: any) => {
    const vPerHa =
      n(baseData?.volym_per_ha_m3sk) ??
      (n(baseData?.volym_total_m3sk) && n(baseData?.skogsmark_ha)
        ? (n(baseData?.volym_total_m3sk)! / n(baseData?.skogsmark_ha)!)
        : null);
    const löv = n(baseData?.tradslag_andelar?.["löv_procent"]);
    let score = 0;
    if (vPerHa !== null && vPerHa < (options?.low_v_per_ha ?? 70)) score++;
    if (löv !== null && löv > (options?.high_löv_pct ?? 30)) score++;
    const level = ["låg", "medel", "hög"][Math.min(score, 2)];
    return { ok: true, score, level, vPerHa, "löv_procent": löv };
  },
};

// Enkel inbäddad frontend (du har redan denna)
const HTML_PAGE = /* html */ `<!doctype html>
<!-- … din HTML från tidigare (progress-bars, upload, process etc) … -->
`;
