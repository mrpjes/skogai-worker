// src/analyzers.ts
import { n } from "./lib/utils";

type Num = number | null;
type Opts = Record<string, any>;

function def<T>(v: T | null | undefined, d: T): T { return v ?? d; }

function effPricePerM3(baseData: any, opt: Opts): Num {
  // 1) sortimentsmix om angiven
  const saw = n(opt?.price_sawlog);
  const pulp = n(opt?.price_pulp);
  const wSaw = n(opt?.share_sawlog_pct) ?? 0;
  const wPulp = n(opt?.share_pulp_pct) ?? 0;
  if (saw !== null && pulp !== null && (wSaw + wPulp) > 0) {
    return (wSaw/100)*saw + (wPulp/100)*pulp;
  }
  // 2) generellt virkespris
  const p = n(opt?.price_per_m3sk);
  if (p !== null) return p;
  // 3) fallback: prisförväntan / totalvolym
  const P = n(baseData?.pris_forvantning_sek);
  const V = n(baseData?.volym_total_m3sk);
  return (P !== null && V !== null && V>0) ? (P / V) : null;
}

// ====== Nyckeltal ======
function key_metrics({ baseData, options }: { baseData: any; options?: Opts; }) {
  const opt = options || {};
  const area = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
  const totV = n(baseData?.volym_total_m3sk);
  const vPerHa = n(baseData?.volym_per_ha_m3sk) ?? ((totV && area) ? totV/area : null);
  const bonitet = n(baseData?.bonitet);
  const pris = n(baseData?.pris_forvantning_sek);
  const taxv = n(baseData?.taxeringsvarde_sek);

  const pricePerHa = (pris && area) ? pris/area : null;
  const pricePerM3 = (pris && totV) ? pris/totV : null;

  // tillväxt (m³/år): bonitet * skogsmark
  const growth_m3 = (bonitet && n(baseData?.skogsmark_ha)) ? bonitet * n(baseData?.skogsmark_ha)! : null;
  // värde/år: tillväxt * virkespris
  const pEff = effPricePerM3(baseData, opt);
  const growth_value = (growth_m3 && pEff) ? growth_m3*pEff : null;

  const cap_rate_pct = (growth_value && pris && pris>0) ? (100*growth_value/pris) : null;

  return {
    ok: true,
    nyckeltal: {
      pris_forvantning_sek: pris,
      taxeringsvarde_sek: taxv,
      pris_per_hektar: pricePerHa,
      pris_per_m3sk: pricePerM3,
      tillvaxt_m3sk_per_ar: growth_m3,
      tillvaxtvarde_sek_per_ar: growth_value,
      kapitaliseringsranta_pct: cap_rate_pct
    }
  };
}

// ====== Risk / Avverkning nu ======
function initial_harvest({ baseData, options }: { baseData: any; options?: Opts; }) {
  const opt = options || {};
  const totV = n(baseData?.volym_total_m3sk);
  if (totV === null) return { ok:false, error:"saknar totalvolym" };

  const harvestNowPct = def(n(opt.harvest_now_pct), 20); // % av totalvolym nu (S1/S2 proxy)
  const cut_m3 = (harvestNowPct/100) * totV;

  const pEff = effPricePerM3(baseData, opt) ?? 0;
  const revenue = cut_m3 * pEff;

  const costHarvest = def(n(opt.harvest_cost_per_m3), 120);     // skördare + skotare
  const costTransport = def(n(opt.transport_cost_per_m3), 60);  // lastbil
  const variableCost = (costHarvest + costTransport) * cut_m3;

  // skogsvård knyts till slutavverkad areal (grov proxy via v/ha):
  const area = n(baseData?.skogsmark_ha);
  const vPerHa = n(baseData?.volym_per_ha_m3sk) ?? ((totV && area) ? totV/area! : null);
  const impliedHaClearcut = (vPerHa && vPerHa>0) ? (cut_m3 / vPerHa) : 0;
  const replant = def(n(opt.replant_cost_per_ha), 3000) * impliedHaClearcut;
  const sitePrep = def(n(opt.site_prep_cost_per_ha), 2000) * impliedHaClearcut;
  const röjning = def(n(opt.precommercial_thin_per_ha), 1000) * impliedHaClearcut;

  const gross = revenue;
  const opex = variableCost + replant + sitePrep + röjning;

  // enkel skattmodell m. skogsavdrag (procent av intäkten)
  const taxRate = def(n(opt.tax_rate_pct), 0.22);      // effektiv genomsnittlig
  const skogsAvdrag = def(n(opt.skogsavdrag_pct), 0.0); // 0–50% av intäkten (väldigt förenklat)
  const taxable = Math.max(0, gross - opex) * (1 - skogsAvdrag);
  const tax = taxable * taxRate;

  const net = gross - opex - tax;
  const ask = n(baseData?.pris_forvantning_sek);
  const debtPaydownPct = (ask && ask>0) ? (100*net/ask) : null;

  return {
    ok:true,
    antaganden: {
      harvest_now_pct: harvestNowPct,
      price_per_m3sk_used: pEff,
      cost_harvest_per_m3: costHarvest,
      cost_transport_per_m3: costTransport,
      replant_cost_per_ha: def(n(opt.replant_cost_per_ha), 3000),
      site_prep_cost_per_ha: def(n(opt.site_prep_cost_per_ha), 2000),
      precommercial_thin_per_ha: def(n(opt.precommercial_thin_per_ha), 1000),
      tax_rate_pct: taxRate,
      skogsavdrag_pct: skogsAvdrag
    },
    volym_avverkning_m3sk: cut_m3,
    bruttointakt_sek: gross,
    kostnader_sek: opex,
    skatt_sek: tax,
    nettopengar_sek: net,
    skuldnedbetalning_andel_av_pris_pct: debtPaydownPct
  };
}

// ====== Kassaflöde framåt och skuldbärande ======
function forward_cashflow_and_debt({ baseData, options }: { baseData:any; options?: Opts; }) {
  const opt = options || {};
  const area = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
  const bonitet = n(baseData?.bonitet);
  const years = def(n(opt.years), 5);

  if (area === null || bonitet === null) return { ok:false, error:"saknar area/bonitet" };

  const pEff = effPricePerM3(baseData, opt) ?? 0;
  const mgmtPerHa = def(n(opt.mgmt_cost_per_ha), 200);
  const r = def(n(opt.interest_rate_pct), 0.05);
  const amortYears = def(n(opt.amort_years), 25);
  const targetDSCR = def(n(opt.target_DSCR), 1.25);
  const disc = def(n(opt.discount_rate_pct), 0.06);

  const annualGrowthM3 = bonitet * area;
  const annualRev = annualGrowthM3 * pEff;
  const annualMgmt = mgmtPerHa * area;
  const NOI = Math.max(0, annualRev - annualMgmt);

  // DSCR-approximativ lånekapacitet
  const denom = r + (amortYears > 0 ? (1 / amortYears) : 0);
  const loanCapacity = denom > 0 ? (NOI / denom) / targetDSCR : 0;

  // enkel DCF av NOI över 'years'
  let pv = 0;
  for (let y=1; y<=years; y++) pv += NOI / Math.pow(1+disc, y);

  const ask = n(baseData?.pris_forvantning_sek);
  const LTV_vs_ask = (ask && ask>0) ? (loanCapacity / ask) : null;

  return {
    ok:true,
    antaganden:{
      years, price_per_m3sk_used: pEff, mgmt_cost_per_ha: mgmtPerHa,
      interest_rate_pct: r, amort_years: amortYears, target_DSCR: targetDSCR, discount_rate_pct: disc
    },
    arlig_tillvaxt_m3sk: annualGrowthM3,
    arlig_intakt_sek: annualRev,
    arliga_kostnader_sek: annualMgmt,
    NOI_sek: NOI,
    DCF_NOI_sek: pv,
    lanekapacitet_sek: loanCapacity,
    implied_LTV_vs_pris: LTV_vs_ask
  };
}

// ====== Sammanfattning i sektioner (en enda “nyckel” i svaret) ======
function summary_pack({ baseData, options }: { baseData:any; options?: Opts; }) {
  // Grunddata visar rena fält i en sektion
  const grunddata = {
    fastighetsbeteckning: baseData?.fastighetsbeteckning ?? baseData?.fastighet ?? null,
    areal_total_ha: n(baseData?.areal_total_ha),
    skogsmark_ha: n(baseData?.skogsmark_ha),
    volym_total_m3sk: n(baseData?.volym_total_m3sk),
    volym_per_ha_m3sk: n(baseData?.volym_per_ha_m3sk)
      ?? ((n(baseData?.volym_total_m3sk) && n(baseData?.skogsmark_ha))
          ? n(baseData?.volym_total_m3sk)! / n(baseData?.skogsmark_ha)! : null),
    bonitet: n(baseData?.bonitet),
    huggningsklass: baseData?.huggningsklass ?? null,
    tradslag_andelar: baseData?.tradslag_andelar ?? null,
    byggnader: baseData?.byggnader ?? null
  };

  // Nyckeltal (återanvänder key_metrics)
  const km = key_metrics({ baseData, options });
  const nyckeltal = km?.nyckeltal ?? {};

  // Lönsamhet: initial avverkning + framåtblick och skuld
  const init = initial_harvest({ baseData, options });
  const fwd = forward_cashflow_and_debt({ baseData, options });

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

// ===== Export =====
export const ANALYZERS = {
  // tidigare
  price_metrics: ({ baseData }: any) => {
    const A = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
    const V = n(baseData?.volym_total_m3sk);
    const P = n(baseData?.pris_forvantning_sek);
    const vPerHa = (V && A) ? V/A : null;
    return {
      ok:true,
      areal_anv: A,
      volym_total_m3sk: V,
      volym_per_ha_m3sk: vPerHa,
      pris_forvantning_sek: P,
      pris_per_ha: (P&&A)? P/A : null,
      pris_per_m3sk: (P&&V)? P/V : null
    };
  },
  risk: ({ baseData, options }: any) => {
    const vPerHa =
      n(baseData?.volym_per_ha_m3sk) ??
      ((n(baseData?.volym_total_m3sk) && n(baseData?.skogsmark_ha))
        ? n(baseData?.volym_total_m3sk)!/n(baseData?.skogsmark_ha)! : null);
    let score=0;
    if (vPerHa!==null && vPerHa < (options?.low_v_per_ha ?? 70)) score++;
    const level=["låg","medel","hög"][Math.min(score,2)];
    return { ok:true, score, level, vPerHa };
  },

  // nya
  key_metrics,
  initial_harvest,
  forward_cashflow_and_debt,

  // samlad
  summary_pack
};
