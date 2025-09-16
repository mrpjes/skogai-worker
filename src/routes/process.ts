import { json, base64FromBytes, extractOpenAIJson, n } from "../lib/utils";
import { skogsSchema } from "../config/schema";
import { callResponses } from "../lib/openai";
import * as ANALYZERS from "../analyses";
import type { Env } from "../index";

export async function handleProcess(req: Request, env: Env) {
  const body = await req.json().catch(() => ({}));
  const key: string | undefined = body?.key;
  const analyses: string[] = Array.isArray(body?.analyses) ? body.analyses : [];
  const options = body?.options || {};
  const model: string = body?.model || "gpt-4.1-mini";
  const SLICE_BYTES = Math.min(800_000, Math.max(120_000, body?.slice_bytes || 300_000));
  if (!key) return json({ ok:false, error:"Saknar 'key'" }, 400);

  const textFromClient: string | null =
    (typeof body?.text === "string" && body.text.trim().length > 0) ? body.text.trim() : null;

  const obj = await env.skogaiR2bucket.get(key);
  if (!obj) return json({ ok:false, error:"File not found in R2", key }, 404);
  const ab = await obj.arrayBuffer();

  let userPayload: string;
  let sliceInfo: Record<string, unknown> | null = null;

  if (textFromClient) {
    userPayload = `Detta är text extraherad ur ett svenskt skogsprospekt (PDF).\n\n${textFromClient}`;
  } else {
    const u8 = new Uint8Array(ab).slice(0, Math.min(ab.byteLength, SLICE_BYTES));
    sliceInfo = { input_size_bytes: ab.byteLength, slice_bytes_used: u8.byteLength, partial: ab.byteLength > u8.byteLength };
    const b64 = base64FromBytes(u8);
    userPayload = `Detta är en base64-slice av ett skogsprospekt (PDF). Extrahera enligt schema.\n\nPDF_base64:\n${b64}`;
  }

  const schemaStr = JSON.stringify(skogsSchema());
  const prompt =
`SYSTEM:
Du är en extraktor. Returnera ENBART giltig JSON som matchar följande JSON Schema.
Sätt null där uppgift saknas. Inga förklaringar, inga markdown-block, inga extra fält.

JSON_SCHEMA:
${schemaStr}

USER:
${userPayload}`;

  const openai = await callResponses(env.OPENAI_API_KEY, { model, input: prompt, temperature: 0, max_output_tokens: 1200 });

  const baseData = extractOpenAIJson(openai);

  // kör analyser
  const results: Record<string, unknown> = {};
  const ctx = { baseData, options, n };
  for (const name of analyses) {
    try {
      const f = (ANALYZERS as any)[name];
      results[name] = typeof f === "function" ? f({ baseData, options }) : { ok:false, error:"unknown_analyzer" };
    } catch (e: any) {
      results[name] = { ok:false, error: e?.message || String(e) };
    }
  }

  return json({
    ok: true,
    key,
    model,
    ...(sliceInfo ?? { input_size_bytes: ab.byteLength, slice_bytes_used: ab.byteLength, partial: false }),
    data: baseData,
    analyses: results,
  });
}
