// src/index.ts
export interface Env {
  skogaiR2bucket: R2Bucket;   // R2-binding (wrangler.toml)
  OPENAI_API_KEY: string;     // Secret i Cloudflare
  ACCESS_TOKEN?: string;      // Valfri enkel auth header
}

const JSON_HDR = { "content-type": "application/json" } as const;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ---- CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-access-token",
        },
      });
    }

    // ---- Health
    if (url.pathname === "/health") return new Response("ok", { status: 200 });

    // ---- Enkel auth (valfri)
    if (env.ACCESS_TOKEN) {
      const t = req.headers.get("x-access-token");
      if (t !== env.ACCESS_TOKEN) return new Response("Forbidden", { status: 403 });
    }

    // ---- Rot (UI i public/ om du använder assets; annars bara info)
    if (url.pathname === "/" && req.method === "GET") {
      return new Response('Vedrik Skog och lite AI – API. Använd /upload, /process, /get/{key}.', {
        headers: { "content-type": "text/plain" },
      });
    }

    // ---- Upload PDF -> R2
    if (url.pathname === "/upload" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (!ct.startsWith("application/pdf")) return j({ ok: false, error: "Skicka application/pdf" }, 400);
      const ab = await req.arrayBuffer();
      const key = `uploads/${crypto.randomUUID()}.pdf`;
      await env.skogaiR2bucket.put(key, ab, { httpMetadata: { contentType: "application/pdf" } });
      return j({ ok: true, key });
    }

    // ---- Process (extrahera + analysera)
    if (url.pathname === "/process" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        const key = body?.key as string | undefined;
        const analyses = Array.isArray(body?.analyses) ? (body.analyses as string[]) : [];
        const options = (body?.options ?? {}) as Record<string, unknown>;
        const model = (body?.model as string) || "gpt-4.1-mini";
        const SLICE_BYTES = Math.min(800_000, Math.max(120_000, Number(body?.slice_bytes) || 300_000));
        if (!key) return j({ ok: false, error: "Saknar 'key'" }, 400);

        // Text från frontend (PDF.js) – använd i första hand
        const textFromClient =
          typeof body?.text === "string" && body.text.trim().length > 0 ? (body.text as string).trim() : null;

        // Hämta fil från R2 (för ev. slice-fallback)
        const o = await env.skogaiR2bucket.get(key);
        if (!o) return j({ ok: false, error: "File not found in R2", key }, 404);
        const ab = await o.arrayBuffer();

        // Bygg payload till modellen
        let userPayload: string;
        let sliceInfo: { input_size_bytes: number; slice_bytes_used: number; partial: boolean } | null = null;

        if (textFromClient) {
          userPayload = `Detta är text extraherad ur ett svenskt skogsprospekt (PDF).\n\n${textFromClient}`;
        } else {
          // Fallback: ta SLUTET av PDF (sammanställningar ligger ofta sist)
          const size = Math.min(ab.byteLength, SLICE_BYTES);
          const start = Math.max(0, ab.byteLength - size);
          const u8 = new Uint8Array(ab).slice(start, start + size);
          sliceInfo = {
            input_size_bytes: ab.byteLength,
            slice_bytes_used: u8.byteLength,
            partial: ab.byteLength > u8.byteLength,
          };
          const b64 = base64FromBytes(u8);
          userPayload =
            `Detta är en base64-slice av ett svenskt skogsprospekt (PDF). ` +
            `Fokusera på tabeller och sammanställningar enligt schema.\n\nPDF_base64:\n${b64}`;
        }

        // Fokus-hint (prioritera ”Sammanställning över fastigheten” m.m.)
        const pageNote = Array.isArray((body as any)?.pages)
          ? `Använd i första hand siffror från sidorna: ${(body as any).pages.join(", ")}.`
          : "";

        const FOCUS_HINT = `
FOKUSERA PÅ AVSNITT OCH TABELLER MED:
- "Sammanställning över fastigheten" (och 1–2 sidor efter),
- virkesförråd (m³sk), m³sk/ha, bonitet (m³sk/ha/år), tillväxt,
- huggningsklasser (S1, S2, G1, G2, K1, K2) i m³sk,
- arealfördelning (skogsmark, inägomark, impediment),
- prisidé/prisförväntan (SEK), taxeringsvärde (SEK),
- byggnader (om de finns).
IGNORERA brödtext, bilder, kartor, visningsinfo.
${pageNote}`.trim();

        const schemaStr = JSON.stringify(skogsSchema());
        const prompt = `SYSTEM:
Du är en extraktor. Returnera ENBART giltig JSON som matchar följande JSON Schema.
Sätt null där uppgift saknas. Inga förklaringar, inga markdown-block, inga extra fält.

JSON_SCHEMA:
${schemaStr}

ORDLISTA FÖR FÄLTMAPPNING:
- "Prisidé", "Utgångspris", "Pris": mappa till "pris_forvantning_sek" (SEK som heltal).
- "Taxeringsvärde": mappa till "taxeringsvarde_sek".
- S1, S2, G1, G2, K1, K2 i m³sk: mappa till "huggningsklasser".

INSTRUKTIONER:
${FOCUS_HINT}

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

        // Robust parsning
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

        // ---- Prisidé fallback från klient-textextrakt ----
        if (baseData && (baseData.pris_forvantning_sek == null || !(baseData.pris_forvantning_sek > 0))) {
          const clientText = typeof (body as any)?.text === "string" ? (body as any).text : "";
          const guessed = extractAskPriceFromText(clientText);
          if (guessed && guessed > 0) {
            baseData.pris_forvantning_sek = guessed;
          }
        }

        // Kör analyser (med säkra default-antaganden)
        (ANALYZERS as any).__last_initial = null;
        (ANALYZERS as any).__last_loan = null;

        const results: Record<string, unknown> = {};
        const ctx: AnalyzerCtx = { baseData, options };
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

    // ---- Hämta PDF från R2
    if (url.pathname.startsWith("/get/")) {
      const k = decodeURIComponent(url.pathname.replace("/get/", ""));
      const o = await env.skogaiR2bucket.get(k);
      if (!o) return j({ ok: false, error: "Not found" }, 404);
      return new Response(o.body, {
        headers: { "content-type": o.httpMetadata?.contentType || "application/pdf" },
      });
    }

    // ---- default
    return new Response(JSON.stringify({ ok: true, msg: "UI + API running" }), {
      headers: { ...JSON_HDR, "access-control-allow-origin": "*" },
    });
  },
};

// ================= Helpers =================
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

// Försök hitta JSON som ligger som sträng i Responses-svaret
function extractInnerJsonString(s: string): string | null {
  const m =
    s.match(/{\\\"fastighet\\\"[\s\S]*?}/) ||
    s.match(/{\\\"fastighetsbeteckning\\\"[\s\S]*?}/);
  return m ? m[0].replace(/\\"/g, '"') : null;
}

function n(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.replace(/\s/g, "").replace(",", ".");
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function nz(v: any): number {
  const x = n(v);
  return x ?? 0;
}
function pctToDecMaybe(v: any, fallback: number | null = null): number | null {
  const x = n(v);
  if (x === null) return fallback;
  return x > 1 ? x / 100 : x;
}

// Prisidé/Utgångspris-fallback ur rå text
function extractAskPriceFromText(txt: string): number | null {
  if (!txt) return null;
  const patterns = [
    /prisid[eé]\s*[:\-]?\s*([\d\s.,]+)\s*(sek|kr)?/i,
    /utg[aå]ngspris\s*[:\-]?\s*([\d\s.,]+)\s*(sek|kr)?/i,
    /pris\s*[:\-]?\s*([\d\s.,]+)\s*(sek|kr)?/i
  ];
  for (const re of patterns) {
    const m = txt.match(re);
    if (m && m[1]) {
      const num = Number(m[1].replace(/\s/g, "").replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(num) && num > 0) return Math.round(num);
    }
  }
  return null;
}

// ================= JSON-schema =================
function skogsSchema() {
  return {
    type: "object",
    properties: {
      fastighetsbeteckning: { type: ["string", "null"] },
      fastighet: { type: ["string", "null"] }, // alias
      kommun: { type: ["string", "null"] },
      lage_beskrivning: { type: ["string", "null"] },

      areal_total_ha: { type: ["number", "null"] },
      skogsmark_ha: { type: ["number", "null"] },
      impediment_ha: { type: ["number", "null"] },
      inagomark_ha: { type: ["number", "null"] },

      volym_total_m3sk: { type: ["number", "null"] },
      volym_per_ha_m3sk: { type: ["number", "null"] },
      bonitet: { type: ["number", "null"] },
      tillvaxt_m3sk_per_ar: { type: ["number", "null"] },

      huggningsklasser: {
        type: ["object", "null"],
        properties: {
          S1_m3sk: { type: ["number", "null"] },
          S2_m3sk: { type: ["number", "null"] },
          G1_m3sk: { type: ["number", "null"] },
          G2_m3sk: { type: ["number", "null"] },
          K1_m3sk: { type: ["number", "null"] },
          K2_m3sk: { type: ["number", "null"] },
        },
        additionalProperties: true,
      },

      tradslag_andelar: {
        type: ["object", "null"],
        properties: {
          gran_procent: { type: ["number", "null"] },
          tall_procent: { type: ["number", "null"] },
          lov_procent: { type: ["number", "null"] },
          "löv_procent": { type: ["number", "null"] }, // tolerera båda
        },
        additionalProperties: true,
      },

      pris_forvantning_sek: { type: ["number", "null"] },
      taxeringsvarde_sek: { type: ["number", "null"] },

      byggnader: {
        type: ["object", "null"],
        properties: {
          finns: { type: ["boolean", "null"] },
          typer: { type: ["array", "null"], items: { type: "string" } },
          kommentar: { type: ["string", "null"] },
        },
        additionalProperties: true,
      },
    },
    required: ["skogsmark_ha", "volym_total_m3sk"],
    additionalProperties: true,
  };
}

// ================= Analyser (med defaults) =================
type AnalyzerCtx = { baseData: any; options: Record<string, unknown> };

const ANALYZERS = {
  // 1) Nyckeltal
  key_metrics: ({ baseData, options }: AnalyzerCtx) => {
    let pris = n(baseData?.pris_forvantning_sek);
    const taxv = n(baseData?.taxeringsvarde_sek);
    const ha = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
    const vTot = n(baseData?.volym_total_m3sk);

    // Estimera pris om saknas
    if ((pris == null || !(pris > 0)) && vTot != null && vTot > 0) {
      const price_per_m3sk = n(options?.price_per_m3sk) ?? 350;
      pris = vTot * price_per_m3sk;
    }

    const bonitet = n(baseData?.bonitet);
    const till_pdf = n(baseData?.tillvaxt_m3sk_per_ar);
    const tillv = till_pdf ?? (bonitet && (n(baseData?.skogsmark_ha) ?? 0) ? bonitet * (n(baseData?.skogsmark_ha) ?? 0) : null);

    const prisPerHa = pris && ha ? pris / ha : null;
    const prisPerM3 = pris && vTot ? pris / vTot : null;

    const price_per_m3sk = n(options?.price_per_m3sk) ?? 350;
    const tillvVarde = tillv ? tillv * price_per_m3sk : null;

    const s1 = n(baseData?.huggningsklasser?.S1_m3sk);
    const s2 = n(baseData?.huggningsklasser?.S2_m3sk);
    const andelSlut = vTot && (s1 || s2) ? (((nz(s1) + nz(s2)) / vTot) * 100) : null;

    return {
      ok: true,
      nyckeltal: {
        pris_forvantning_sek: pris ?? null,
        taxeringsvarde_sek: taxv ?? null,
        pris_per_hektar: prisPerHa,
        pris_per_m3sk: prisPerM3,
        tillvaxt_m3sk_per_ar: tillv,
        tillvaxtvarde_sek_per_ar: tillvVarde,
        kapitaliseringsranta_pct: null,
        andel_slutavverkningsbar_pct: andelSlut,
      },
    };
  },

  // 2) Initial avverkning (skatt – förenklad, med skogsavdrag + skogskonto)
  initial_harvest_taxed: ({ baseData, options }: AnalyzerCtx) => {
    const price_per_m3sk = n(options?.price_per_m3sk) ?? 350;
    const taxRate = pctToDecMaybe(options?.tax_rate_pct, 0.30) ?? 0.30;
    const skogskontoShare = pctToDecMaybe(options?.skogskonto_share_pct, 0.60) ?? 0.60;

    const pris = n(baseData?.pris_forvantning_sek) ?? 0;
    const s1 = n(baseData?.huggningsklasser?.S1_m3sk) ?? 0;
    const s2 = n(baseData?.huggningsklasser?.S2_m3sk) ?? 0;
    const vol = nz(s1) + nz(s2);

    const brutto = vol * price_per_m3sk;

    // Skogsavdrag (tak ~50% av priset), men inte mer än brutto
    const skogsavdragMax = 0.50 * pris;
    const skogsavdrag = Math.min(skogsavdragMax, brutto);

    const beskattningsbarEfterAvdrag = Math.max(0, brutto - skogsavdrag);
    const skogskontoIns = beskattningsbarEfterAvdrag * skogskontoShare;
    const skattNu = (beskattningsbarEfterAvdrag - skogskontoIns) * taxRate;
    const nettoIdag = brutto - skattNu;

    const utskjSkatt = skogskontoIns * taxRate;      // latent skatt
    const skogskontoNetto = skogskontoIns * (1 - taxRate);
    const skuldNedPct = pris > 0 ? (nettoIdag / pris) * 100 : null;

    const res = {
      ok: true,
      initial_avverkning: {
        volym_avverkning_m3sk: vol || null,
        bruttointakt_sek: brutto || null,
        skogsavdrag_anstalld_sek: skogsavdrag || 0,
        skogskonto_insattning_sek: skogskontoIns || 0,
        skatt_nu_sek: skattNu || 0,
        netto_idag_sek: nettoIdag || 0,
        utskjuten_skatt_skogskonto_sek: utskjSkatt || 0,
        skogskonto_netto_efter_fr_skatt_sek: skogskontoNetto || 0,
        skuldnedbetalning_andel_av_pris_netto_pct: skuldNedPct,
      },
    };
    (ANALYZERS as any).__last_initial = res;
    return res;
  },

  // 3) Lån & skogskonto (default 100% belåning, 5% ränta)
  loan_sustainability: ({ baseData, options }: AnalyzerCtx) => {
    // --- 1) Hämta/estimera pris ---
    const price_per_m3sk = n(options?.price_per_m3sk) ?? 350;
    const vTot = n(baseData?.volym_total_m3sk);
    let pris = n(baseData?.pris_forvantning_sek);
    if (pris == null || !(pris > 0)) {
      if (vTot != null && vTot > 0) pris = vTot * price_per_m3sk;
      else pris = 0;
    }

    // --- 2) Defaults för lån/ränta ---
    const loanShare = pctToDecMaybe(options?.loan_share_pct, 1.0) ?? 1.0; // 100%
    const r = pctToDecMaybe(options?.interest_rate_pct, 0.05) ?? 0.05;     // 5%

    // --- 3) Initial avverkning (för netto/skogskonto) ---
    let init = (ANALYZERS as any).__last_initial;
    if (!init || !init.initial_avverkning) {
      init = (ANALYZERS as any).initial_harvest_taxed({ baseData, options });
    }
    const netto = n(init?.initial_avverkning?.netto_idag_sek) ?? 0;
    const skogskontoNetto = n(init?.initial_avverkning?.skogskonto_netto_efter_fr_skatt_sek) ?? 0;

    // --- 4) Lånebelopp: explicit > estimat (pris × låneandel) ---
    const givenLoan = n(options?.loan_amount_sek);
    const initialLoan = (givenLoan ?? (pris * loanShare)) || 0;

    // --- 5) Amortera med netto från initial avverkning ---
    const amort = Math.min(initialLoan, Math.max(0, netto));
    const rest = Math.max(0, initialLoan - amort);

    const yearlyInterest = rest * r;
    const yearsCovered = yearlyInterest > 0 ? (skogskontoNetto / yearlyInterest) : null;

    const res = {
      ok: true,
      lan_och_skogskonto: {
        initial_lan_sek: initialLoan,
        amortering_med_netto_sek: amort,
        restskuld_sek: rest,
        arlig_ranta_sek: yearlyInterest,
        skogskonto_netto_efter_fr_skatt_sek: skogskontoNetto,
        ar_rante_tackt_av_skogskonto: yearsCovered,
      },
    };
    (ANALYZERS as any).__last_loan = res;
    return res;
  },

  // 4) Räntefördelning (positiv)
  interest_distribution: ({ baseData, options }: AnalyzerCtx) => {
    // Pris (ev. estimerat via key_metrics)
    let pris = n(baseData?.pris_forvantning_sek);
    if (pris == null || !(pris > 0)) {
      const vTot = n(baseData?.volym_total_m3sk);
      const price_per_m3sk = n(options?.price_per_m3sk) ?? 350;
      if (vTot != null && vTot > 0) pris = vTot * price_per_m3sk;
      else pris = 0;
    }

    const rfdRate = pctToDecMaybe(options?.interest_distribution_rate_pct, 0.0862) ?? 0.0862; // ~8,62 %
    const busTax = pctToDecMaybe(options?.business_tax_effective_pct, 0.45) ?? 0.45;

    let loan = (ANALYZERS as any).__last_loan;
    if (!loan || !loan.lan_och_skogskonto) {
      loan = (ANALYZERS as any).loan_sustainability({ baseData, options });
    }
    const rest = n(loan?.lan_och_skogskonto?.restskuld_sek) ?? 0;

    const kapitalunderlag = Math.max(0, (pris ?? 0) - rest);
    const belopp = kapitalunderlag * rfdRate;
    const sparing = Math.max(0, belopp * (busTax - 0.30)); // indikativ jämfört med näring

    return {
      ok: true,
      rantefordelning: {
        kapitalunderlag_sek: kapitalunderlag,
        rantefordelningsranta_pct: rfdRate * 100,
        rantefordelningsbelopp_sek: belopp,
        antagen_skattebesparing_vs_naring_sek: sparing,
      },
    };
  },

  // 5) Kassaflöde & DSCR (lean)
  forward_cashflow_and_debt: ({ baseData, options }: AnalyzerCtx) => {
    const price_per_m3sk = n(options?.price_per_m3sk) ?? 350;
    const r = pctToDecMaybe(options?.interest_rate_pct, 0.05) ?? 0.05;

    // Pris (ev. estimerat)
    let pris = n(baseData?.pris_forvantning_sek);
    const vTot = n(baseData?.volym_total_m3sk);
    if (pris == null || !(pris > 0)) {
      if (vTot != null && vTot > 0) pris = vTot * price_per_m3sk;
      else pris = 0;
    }

    const bonitet = n(baseData?.bonitet);
    const ha = n(baseData?.skogsmark_ha);
    const till_pdf = n(baseData?.tillvaxt_m3sk_per_ar);
    const tillv = (till_pdf != null) ? till_pdf : ((bonitet && ha) ? bonitet * ha : 0);

    const yearlyIncome = tillv * price_per_m3sk;

    let loan = (ANALYZERS as any).__last_loan;
    if (!loan || !loan.lan_och_skogskonto) {
      loan = (ANALYZERS as any).loan_sustainability({ baseData, options });
    }
    const rest = n(loan?.lan_och_skogskonto?.restskuld_sek) ?? 0;

    const dscrVsGiven = rest > 0 ? (yearlyIncome / (rest * r)) : null;
    const dscrVsAsk = (pris ?? 0) > 0 ? (yearlyIncome / ((pris ?? 0) * r)) : null;
    const loanCapacity = r > 0 ? (yearlyIncome / r) : null;

    return {
      ok: true,
      framot_kassaflode_och_skuldbarande: {
        arlig_tillvaxt_m3sk: tillv,
        arlig_intakt_sek: yearlyIncome,
        lanekapacitet_sek: loanCapacity,
        dscr_vs_given_loan: dscrVsGiven,
        dscr_vs_ask_price: dscrVsAsk,
      },
    };
  },

  // 6) Sammanfattningspaket – kör ordning och cachea mellansteg
  summary_pack: ({ baseData, options }: AnalyzerCtx) => {
    const km   = (ANALYZERS as any).key_metrics({ baseData, options });
    const init = (ANALYZERS as any).initial_harvest_taxed({ baseData, options });
    (ANALYZERS as any).__last_initial = init;

    const loan = (ANALYZERS as any).loan_sustainability({ baseData, options });
    (ANALYZERS as any).__last_loan = loan;

    const idst = (ANALYZERS as any).interest_distribution({ baseData, options });
    const fwd  = (ANALYZERS as any).forward_cashflow_and_debt({ baseData, options });

    const gd = {
      fastighetsbeteckning: baseData?.fastighetsbeteckning ?? baseData?.fastighet ?? null,
      kommun: baseData?.kommun ?? null,
      areal_total_ha: n(baseData?.areal_total_ha),
      skogsmark_ha: n(baseData?.skogsmark_ha),
      volym_total_m3sk: n(baseData?.volym_total_m3sk),
      volym_per_ha_m3sk:
        n(baseData?.volym_per_ha_m3sk) ??
        (n(baseData?.volym_total_m3sk) && n(baseData?.skogsmark_ha)
          ? (n(baseData?.volym_total_m3sk)! / n(baseData?.skogsmark_ha)!)
          : null),
      bonitet: n(baseData?.bonitet),
      huggningsklasser: baseData?.huggningsklasser ?? null,
      tradslag_andelar: baseData?.tradslag_andelar ?? null,
      byggnader: baseData?.byggnader ?? null,
    };

    return {
      ok: true,
      grunddata: gd,
      nyckeltal: (km as any)?.nyckeltal ?? {},
      lonsamhet: {
        ...(init ?? {}),
        ...(loan ?? {}),
        ...(idst ?? {}),
        ...(fwd ?? {}),
      },
    };
  },
} as const;
