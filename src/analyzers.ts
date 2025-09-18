// src/analyzers.ts
import { n } from "./lib/utils";

type Opts = Record<string, any>;
const def = <T>(v: T | null | undefined, d: T): T => (v ?? d);

// Effektivt pris per m³sk: sortimentsmix → generellt pris → fallback (pris/volym)
function effPricePerM3(baseData: any, opt: Opts): number | null {
  const saw = n(opt?.price_sawlog);
  const pulp = n(opt?.price_pulp);
  const wSaw = n(opt?.share_sawlog_pct) ?? 0;
  const wPulp = n(opt?.share_pulp_pct) ?? 0;
  if (saw !== null && pulp !== null && (wSaw + wPulp) > 0) {
    return (wSaw/100)*saw + (wPulp/100)*pulp;
  }
  const p = n(opt?.price_per_m3sk);
  if (p !== null) return p;

  const P = n(baseData?.pris_forvantning_sek);
  const V = n(baseData?.volym_total_m3sk);
  return (P && V && V>0) ? P/V : null;
}

// ===== Nyckeltal =====
function key_metrics({ baseData, options }: { baseData:any; options?: Opts }) {
  const area = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
  const totV = n(baseData?.volym_total_m3sk);
  const vPerHa = n(baseData?.volym_per_ha_m3sk) ?? ((totV && area) ? totV/area : null);
  const bonitet = n(baseData?.bonitet);
  const pris = n(baseData?.pris_forvantning_sek);
  const taxv = n(baseData?.taxeringsvarde_sek);

  const pricePerHa = (pris && area) ? pris/area : null;
  const pricePerM3 = (pris && totV) ? pris/totV : null;

  // tillväxt (m³/år) = bonitet × skogsmark
  const growth_m3 = (bonitet && n(baseData?.skogsmark_ha)) ? bonitet * n(baseData?.skogsmark_ha)! : null;

  // tillväxtvärde (SEK/år) = tillväxt × virkespris (effektivt)
  const pEff = effPricePerM3(baseData, options || {});
  const growth_value = (growth_m3 && pEff) ? growth_m3*pEff : null;

  const cap_rate_pct = (growth_value && pris && pris>0) ? (100*growth_value/pris) : null;

  // andel slutavverkningsbar skog
  const S1 = n(baseData?.huggningsklasser?.S1_m3sk) ?? 0;
  const S2 = n(baseData?.huggningsklasser?.S2_m3sk) ?? 0;
  const harvestNowPct = (totV && totV>0) ? (100 * ((S1??0)+(S2??0)) / totV) : null;

  return {
    ok: true,
    nyckeltal: {
      pris_forvantning_sek: pris,
      taxeringsvarde_sek: taxv,
      pris_per_hektar: pricePerHa,
      pris_per_m3sk: pricePerM3,
      tillvaxt_m3sk_per_ar: growth_m3,
      tillvaxtvarde_sek_per_ar: growth_value,
      kapitaliseringsranta_pct: cap_rate_pct,
      andel_slutavverkningsbar_pct: harvestNowPct
    }
  };
}

// ===== Lönsamhet – 1) Initial avverkning (år 0–2) =====
function initial_harvest({ baseData, options }: { baseData:any; options?: Opts }) {
  const totV = n(baseData?.volym_total_m3sk);
  if (totV === null) return { ok:false, error:"saknar totalvolym" };

  const S1 = n(baseData?.huggningsklasser?.S1_m3sk) ?? 0;
  const S2 = n(baseData?.huggningsklasser?.S2_m3sk) ?? 0;
  const cut_m3 = (S1 ?? 0) + (S2 ?? 0);

  const pEff = effPricePerM3(baseData, options || {}) ?? 0;
  const gross = cut_m3 * pEff;

  const ask = n(baseData?.pris_forvantning_sek);
  const debtPayPct = (ask && ask>0) ? (100*gross/ask) : null;

  return {
    ok:true,
    antaganden: { price_per_m3sk_used: pEff },
    volym_avverkning_m3sk: cut_m3,
    bruttointakt_sek: gross,
    skuldnedbetalning_andel_av_pris_pct: debtPayPct
  };
}

// ===== Lönsamhet – 2) Kassaflöde/DSCR (periodiskt utjämnat) =====
// Förenklad: årlig intäkt ≈ (bonitet × ha × pris). DSCR utan amortering.
// Visar även lånekapacitet = kassaflöde / ränta och DSCR mot priset som lån.
function forward_cashflow_and_debt({ baseData, options }: { baseData:any; options?: Opts }) {
  const area = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
  const bonitet = n(baseData?.bonitet);
  if (area == null || bonitet == null) return { ok:false, error:"saknar area/bonitet" };

  const pEff = effPricePerM3(baseData, options || {});
  if (pEff == null) return { ok:false, error:"saknar virkespris (price_per_m3sk)" };

  const annualGrowthM3 = bonitet * area;
  const cashflow = annualGrowthM3 * pEff;

  const r = def(n(options?.interest_rate_pct), 0.05); // decimal
  if (!r || r <= 0) return { ok:false, error:"felaktig ränta" };

  const loanCapacity = cashflow / r;

  const loanAmount = n(options?.loan_amount_sek);
  const dscr_vs_loan = loanAmount ? (cashflow / (r * loanAmount)) : null;

  const ask = n(baseData?.pris_forvantning_sek);
  const dscr_vs_ask = (ask && ask>0) ? (cashflow / (r * ask)) : null;

  return {
    ok:true,
    antaganden: { interest_rate_pct: r*100, price_per_m3sk_used: pEff },
    arlig_tillvaxt_m3sk: annualGrowthM3,
    arlig_intakt_sek: cashflow,
    lanekapacitet_sek: loanCapacity,
    dscr_vs_given_loan: dscr_vs_loan,
    dscr_vs_ask_price: dscr_vs_ask
  };
}

// ===== Sammanfattning i sektioner (visas i UI) =====
function summary_pack({ baseData, options }: { baseData:any; options?: Opts }) {
  // Grunddata
  const grunddata = {
    fastighetsbeteckning: baseData?.fastighetsbeteckning ?? baseData?.fastighet ?? null,
    kommun: baseData?.kommun ?? null,
    areal_total_ha: n(baseData?.areal_total_ha),
    skogsmark_ha: n(baseData?.skogsmark_ha),
    volym_total_m3sk: n(baseData?.volym_total_m3sk),
    volym_per_ha_m3sk:
      n(baseData?.volym_per_ha_m3sk) ??
      ((n(baseData?.volym_total_m3sk) && n(baseData?.skogsmark_ha))
        ? n(baseData?.volym_total_m3sk)!/n(baseData?.skogsmark_ha)! : null),
    bonitet: n(baseData?.bonitet),
    huggningsklasser: baseData?.huggningsklasser ?? null,
    tradslag_andelar: baseData?.tradslag_andelar ?? null,
    byggnader: baseData?.byggnader ?? null
  };

  // Nyckeltal
  const km = key_metrics({ baseData, options });
  const nyckeltal = km?.nyckeltal ?? {};

  // Lönsamhet
  const init = initial_harvest({ baseData, options });
  const fwd  = forward_cashflow_and_debt({ baseData, options });

  return {
    ok:true,
    grunddata,
    nyckeltal,
    lonsamhet: {
      initial_avverkning: init,
      framot_kassaflode_och_skuldbarande: fwd
    }
  };
}

// (valfritt) Legacy-exempel kvar om du använder dem via UI
function price_metrics({ baseData }: any) {
  const A = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
  const V = n(baseData?.volym_total_m3sk);
  const P = n(baseData?.pris_forvantning_sek);
  const vPerHa = (V && A) ? V/A : null;
  return {
    ok:true,
    areal_anv: A, volym_total_m3sk: V, volym_per_ha_m3sk: vPerHa,
    pris_forvantning_sek: P,
    pris_per_ha: (P&&A)? P/A : null,
    pris_per_m3sk: (P&&V)? P/V : null
  };
}
function risk({ baseData, options }: any) {
  const vPerHa =
    n(baseData?.volym_per_ha_m3sk) ??
    ((n(baseData?.volym_total_m3sk) && n(baseData?.skogsmark_ha))
      ? n(baseData?.volym_total_m3sk)!/n(baseData?.skogsmark_ha)! : null);
  let score=0;
  if (vPerHa!==null && vPerHa < (options?.low_v_per_ha ?? 70)) score++;
  const level=["låg","medel","hög"][Math.min(score,2)];
  return { ok:true, score, level, vPerHa };
}

// ===== Export =====
export const ANALYZERS = {
  key_metrics,
  initial_harvest,
  forward_cashflow_and_debt,
  summary_pack,
  // legacy (valfritt i UI)
  price_metrics,
  risk
};
