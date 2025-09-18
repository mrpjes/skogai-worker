// src/analyses/all.ts
import { n } from "../lib/utils"; // justera ev. sökväg om din utils ligger annorlunda

/** --------- Pris-metrik --------- */
function price_metrics({ baseData }: { baseData: any }) {
  const A = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
  const V = n(baseData?.volym_total_m3sk);
  const P = n(baseData?.pris_forvantning_sek);
  const vPerHa = (V && A) ? V / A : null;

  return {
    ok: true,
    areal_anv: A,
    volym_total_m3sk: V,
    volym_per_ha_m3sk: vPerHa,
    pris_forvantning_sek: P,
    pris_per_ha: (P && A) ? P / A : null,
    pris_per_m3sk: (P && V) ? P / V : null,
  };
}

/** --------- Risk-indikator --------- */
function risk({ baseData, options }: { baseData: any; options?: any }) {
  const vPerHa =
    n(baseData?.volym_per_ha_m3sk) ??
    ((n(baseData?.volym_total_m3sk) && n(baseData?.skogsmark_ha))
      ? n(baseData?.volym_total_m3sk) / n(baseData?.skogsmark_ha)
      : null);

  const löv = n(baseData?.tradslag_andelar?.["löv_procent"]);

  let score = 0;
  if (vPerHa !== null && vPerHa < (options?.low_v_per_ha ?? 70)) score++;
  if (löv !== null && löv > (options?.high_löv_pct ?? 30)) score++;

  const level = ["låg", "medel", "hög"][Math.min(score, 2)];
  return { ok: true, score, level, vPerHa, "löv_procent": löv };
}

/** --------- Värde-indikator (exempel) --------- */
function value_indicator({ baseData }: { baseData: any }) {
  const pris = n(baseData?.pris_forvantning_sek);
  const v = n(baseData?.volym_total_m3sk);
  const pPerM3 = (pris && v) ? pris / v : null;

  // En mycket enkel “indikator” bara som exempel
  let klass: "lågt" | "normalt" | "högt" | null = null;
  if (pPerM3 != null) {
    if (pPerM3 < 250) klass = "lågt";
    else if (pPerM3 <= 400) klass = "normalt";
    else klass = "högt";
  }

  return { ok: true, pris_per_m3sk: pPerM3, indikator: klass };
}

// --- Hjälpare (importera n från din utils om du inte redan gör det) ---
const to = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------
// 1) ÅRLIG TILLVÄXT (m³sk/år) och VÄRDE/år
// ---------------------------------------------------------------
// Antaganden (kan styras via options):
// - growth_rate_pct: årlig volymtillväxt på skogsmark (% av befintlig volym/ha)
// - price_per_m3sk: pris (stumpage) per m³sk
// - vPerHa och area hämtas från baseData om möjligt
export function growth_analysis({ baseData, options }: any) {
  const areaHa =
    n(baseData?.skogsmark_ha) ??
    n(baseData?.areal_total_ha);

  // volym/ha: använd explicit fält, annars total/area
  const vPerHa =
    n(baseData?.volym_per_ha_m3sk) ??
    (n(baseData?.volym_total_m3sk) && areaHa ? n(baseData?.volym_total_m3sk)! / areaHa : null);

  const growthRate = to(n(options?.growth_rate_pct)) ?? 3.0; // %/år – enkel default
  const pricePerM3 = to(n(options?.price_per_m3sk)) ?? 350;  // SEK/m³sk default

  if (areaHa == null || vPerHa == null) {
    return { ok: false, error: "saknar_areal_eller_volym_per_ha" };
  }

  const totalVol = vPerHa * areaHa;
  const growth_m3sk_per_year = (growthRate / 100) * totalVol;
  const growth_value_per_year = growth_m3sk_per_year * pricePerM3;

  return {
    ok: true,
    area_ha: areaHa,
    total_vol_m3sk: totalVol,
    growth_rate_pct: growthRate,
    growth_m3sk_per_year,
    price_per_m3sk: pricePerM3,
    growth_value_per_year_sek: growth_value_per_year
  };
}

// ---------------------------------------------------------------
// 2) MÖJLIGA AVVERKNINGAR (enkel heuristik) + VÄRDE
// ---------------------------------------------------------------
// Antaganden (styr via options):
// - harvest_fraction_now_pct: andel av total volym som kan avverkas nu (%)
// - price_per_m3sk: stumpagepris
// - replant_cost_per_ha: ev. kostnad/ha (dras av)
// OBS: Detta är en förenklad placeholder tills du har åldersfördelning m.m.
export function harvest_plan({ baseData, options }: any) {
  const areaHa =
    n(baseData?.skogsmark_ha) ??
    n(baseData?.areal_total_ha);

  const totalVol =
    n(baseData?.volym_total_m3sk) ??
    (areaHa && n(baseData?.volym_per_ha_m3sk) ? areaHa * n(baseData?.volym_per_ha_m3sk)! : null);

  if (areaHa == null || totalVol == null) {
    return { ok: false, error: "saknar_areal_eller_totalvolym" };
  }

  const fractionNow = to(n(options?.harvest_fraction_now_pct)) ?? 20; // % av total vol
  const pricePerM3 = to(n(options?.price_per_m3sk)) ?? 350;          // SEK/m³sk
  const replantCostPerHa = to(n(options?.replant_cost_per_ha)) ?? 0; // enkel avdragspost

  const cutNow_m3sk = (fractionNow / 100) * totalVol;
  const grossValue = cutNow_m3sk * pricePerM3;
  const replantCost = replantCostPerHa * areaHa;
  const netValue = grossValue - replantCost;

  return {
    ok: true,
    harvest_fraction_now_pct: fractionNow,
    cut_now_m3sk: cutNow_m3sk,
    price_per_m3sk: pricePerM3,
    gross_value_sek: grossValue,
    replant_cost_total_sek: replantCost,
    net_value_sek: netValue
  };
}

// ---------------------------------------------------------------
// 3) KASSAFLÖDE & LÅNEKAPACITET (enkel DCF + DSCR)
// ---------------------------------------------------------------
// Antaganden (styr via options):
// - years: kalkylår (t.ex. 10)
// - discount_rate_pct: kalkylränta för DCF
// - price_per_m3sk: intäkt per m³sk
// - growth_rate_pct: årlig volymtillväxt
// - mgmt_cost_per_ha: årlig förvaltningskostnad per ha
// - property_price_sek: köp­pris (använd baseData.pris_forvantning_sek som fallback)
// - interest_rate_pct: låneränta
// - amort_years: rak amortering över X år (0 = bara ränta)
// - target_DSCR: min kassaflödes­täckningsgrad (ex. 1.25)
// NOTE: Väldigt förenklad modell (ingen skatteteknik, inga prisbanor, inga huggningscykler)
export function cashflow_loan({ baseData, options }: any) {
  const areaHa =
    n(baseData?.skogsmark_ha) ??
    n(baseData?.areal_total_ha);

  const totalVol =
    n(baseData?.volym_total_m3sk) ??
    (areaHa && n(baseData?.volym_per_ha_m3sk) ? areaHa * n(baseData?.volym_per_ha_m3sk)! : null);

  const askPrice = n(baseData?.pris_forvantning_sek) ?? to(n(options?.property_price_sek)) ?? null;

  if (areaHa == null || totalVol == null) {
    return { ok: false, error: "saknar_areal_eller_totalvolym" };
  }

  // Parametrar
  const years = Math.max(1, to(n(options?.years)) ?? 10);
  const rDisc = (to(n(options?.discount_rate_pct)) ?? 6) / 100; // diskonteringsränta
  const pricePerM3 = to(n(options?.price_per_m3sk)) ?? 350;
  const growth = (to(n(options?.growth_rate_pct)) ?? 3) / 100;
  const mgmtPerHa = to(n(options?.mgmt_cost_per_ha)) ?? 200;    // SEK/ha/år

  const loanRate = (to(n(options?.interest_rate_pct)) ?? 5) / 100;
  const amortYears = Math.max(0, to(n(options?.amort_years)) ?? 25);
  const targetDSCR = to(n(options?.target_DSCR)) ?? 1.25;

  // Generera enkel kassaflödesbana: vi antar att årlig "skörd" = tillväxten
  // (dvs. beståndet hålls ungefär konstant i volym).
  let vol = totalVol;
  let pv = 0;
  const series: Array<{
    year: number;
    growth_m3sk: number;
    revenue_sek: number;
    mgmt_cost_sek: number;
    NOI_sek: number;
    PV_sek: number;
  }> = [];

  for (let y = 1; y <= years; y++) {
    const growthVol = vol * growth;          // m³sk/år
    const revenue = growthVol * pricePerM3;  // SEK/år
    const mgmt = mgmtPerHa * areaHa;
    const NOI = revenue - mgmt;              // enkelt driftöverskott

    const pvYear = NOI / Math.pow(1 + rDisc, y);
    pv += pvYear;

    series.push({
      year: y,
      growth_m3sk: growthVol,
      revenue_sek: revenue,
      mgmt_cost_sek: mgmt,
      NOI_sek: NOI,
      PV_sek: pvYear
    });

    // håll volymen någorlunda konstant (skörd = tillväxt)
    // vill du “bygga volym”, kommentera bort nästa rad
    // vol = vol; // implicit
  }

  // DCF-värde ~ PV av NOIs (utan terminalvärde i denna simpla version)
  const dcf_value_sek = pv;

  // Lånekapacitet via DSCR: NOI ska täcka räntekostnad + amortering
  // Vi antar rak amortering över amortYears om > 0
  // Approximation: använd år 1 NOI som “typår”
  const NOI1 = series[0]?.NOI_sek ?? 0;
  const A = amortYears > 0 ? (askPrice ? askPrice / amortYears : 0) : 0; // kr/år
  // Vill vi i stället lösa för max loan L: DSCR = NOI / debt_service >= target
  // debt_service = L*loanRate + (amortYears>0? L/amortYears : 0)
  // => L <= NOI / (loanRate + (amortYears>0?1/amortYears:0)) / targetDSCR
  const denom = loanRate + (amortYears > 0 ? 1 / amortYears : 0);
  const maxLoanFromDSCR = denom > 0 ? (NOI1 / denom) / targetDSCR : 0;

  // Jämför mot önskat pris
  const ltvIfAsk = askPrice ? (maxLoanFromDSCR / askPrice) : null;

  return {
    ok: true,
    assumptions: {
      years,
      discount_rate_pct: rDisc * 100,
      price_per_m3sk: pricePerM3,
      growth_rate_pct: growth * 100,
      mgmt_cost_per_ha: mgmtPerHa,
      interest_rate_pct: loanRate * 100,
      amort_years: amortYears,
      target_DSCR: targetDSCR
    },
    dcf_value_sek,
    series,
    loan_capacity_sek: maxLoanFromDSCR,
    ask_price_sek: askPrice,
    implied_LTV_vs_ask: ltvIfAsk
  };
}
/** --------- Lägg allt i en export --------- */
export const ANALYZERS = {
  price_metrics,
  risk,
  value_indicator,
  growth_analysis,
  harvest_plan,
  cashflow_loan,
};

// Tips: lägg till nya analyser här i samma fil:
// function din_nya({ baseData, options }: { baseData:any; options?:any }) { ... }
// export const ANALYZERS = { ...ANALYZERS, din_nya };
