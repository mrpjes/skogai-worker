// src/analyzers.ts
import { n } from "./lib/utils";

type Opts = Record<string, any>;
const def = <T>(v: T | null | undefined, d: T): T => (v ?? d);

// Effektivt pris per m³sk: sortimentsmix → price_per_m3sk → fallback (pris/volym)
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

/* ------------------------- NYCKELTAL ------------------------- */
function key_metrics({ baseData, options }: { baseData:any; options?: Opts }) {
  const area = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
  const totV = n(baseData?.volym_total_m3sk);
  const vPerHa = n(baseData?.volym_per_ha_m3sk) ?? ((totV && area) ? totV/area : null);
  const bonitet = n(baseData?.bonitet);
  const pris = n(baseData?.pris_forvantning_sek);
  const taxv = n(baseData?.taxeringsvarde_sek);

  const pricePerHa = (pris && area) ? pris/area : null;
  const pricePerM3 = (pris && totV) ? pris/totV : null;

  const growth_m3 = (bonitet && n(baseData?.skogsmark_ha)) ? bonitet * n(baseData?.skogsmark_ha)! : null;

  const pEff = effPricePerM3(baseData, options || {});
  const growth_value = (growth_m3 && pEff) ? growth_m3*pEff : null;

  const cap_rate_pct = (growth_value && pris && pris>0) ? (100*growth_value/pris) : null;

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

/* ------------- LÖNSAMHET: INITIAL AVVERKNING (skatt) ------------- */
/** Beräknar skogsavdrag, skogskonto, aktuell skatt och utskjuten skatt. */
function initial_harvest_taxed({ baseData, options }: { baseData:any; options?: Opts }) {
  const totV = n(baseData?.volym_total_m3sk);
  if (totV === null) return { ok:false, error:"saknar totalvolym" };

  const S1 = n(baseData?.huggningsklasser?.S1_m3sk) ?? 0;
  const S2 = n(baseData?.huggningsklasser?.S2_m3sk) ?? 0;
  const cut_m3 = (S1 ?? 0) + (S2 ?? 0);

  const pEff = effPricePerM3(baseData, options || {});
  if (pEff == null) return { ok:false, error:"saknar virkespris (price_per_m3sk)" };

  const gross = cut_m3 * pEff; // bruttointäkt (exkl moms)

  const ask = n(baseData?.pris_forvantning_sek);
  // Skogsavdragsutrymme: antas 50% av köpeskillingen (skog+mark). (Förenkling.)
  const skogsavdrag_utrymme = ask ? 0.5 * ask : 0;

  const taxRate = def(n(options?.tax_rate_pct), 0.30); // decimal, t.ex. 0.30
  const skogskontoShare = Math.max(0, Math.min(1, def(n(options?.skogskonto_share_pct), 0.60))); // 0..1

  const skogsavdrag_nu = Math.min(gross, skogsavdrag_utrymme);
  const taxable_before_account = Math.max(0, gross - skogsavdrag_nu);
  const deposit = taxable_before_account * skogskontoShare;
  const taxable_now = taxable_before_account - deposit;
  const current_tax = taxable_now * taxRate;

  // Utskjuten skatt på insatt belopp (när det tas ut)
  const deferred_tax = deposit * taxRate;

  const net_cash_now = gross - current_tax - deposit;
  const skogskonto_net_after_future_tax = deposit - deferred_tax;

  const remaining_deduction_room = skogsavdrag_utrymme - skogsavdrag_nu;

  return {
    ok:true,
    antaganden: {
      price_per_m3sk_used: pEff,
      tax_rate_pct: taxRate*100,
      skogskonto_share_pct: skogskontoShare*100,
      skogsavdragsutrymme_sek: skogsavdrag_utrymme
    },
    volym_avverkning_m3sk: cut_m3,
    bruttointakt_sek: gross,
    skogsavdrag_anstalld_sek: skogsavdrag_nu,
    beskattningsbar_fore_skogskonto_sek: taxable_before_account,
    skogskonto_insattning_sek: deposit,
    skatt_nu_sek: current_tax,
    netto_idag_sek: net_cash_now,
    utskjuten_skatt_skogskonto_sek: deferred_tax,
    skogskonto_netto_efter_fr_skatt_sek: skogskonto_net_after_future_tax,
    kvarvarande_skogsavdragsutrymme_sek: remaining_deduction_room,
    // hur mycket av priset kan betalas ned (före/efter skatt)
    skuldnedbetalning_andel_av_pris_brutto_pct: (ask && ask>0) ? (100*gross/ask) : null,
    skuldnedbetalning_andel_av_pris_netto_pct: (ask && ask>0) ? (100*net_cash_now/ask) : null
  };
}

/* ------------- LÖNSAMHET: RÄNTOR & LÅNEBÄRIGHET (100% default) ------------- */
/** Antar låneandel (default 100%). Amorterar med netto_idag, räknar ränta och hur länge skogskontot räcker. */
function loan_sustainability({ baseData, options, fromInitial }: { baseData:any; options?: Opts; fromInitial?: any }) {
  const ask = n(baseData?.pris_forvantning_sek);
  if (!ask) return { ok:false, error:"saknar pris_forvantning_sek" };

  const loanShare = def(n(options?.loan_share_pct), 1.0); // decimal (1.0 = 100%)
  const loan0 = ask * loanShare;

  const netNow = n(fromInitial?.netto_idag_sek) ?? 0;
  const debt = Math.max(0, loan0 - netNow);

  const r = def(n(options?.interest_rate_pct), 0.05); // decimal
  if (!r || r<=0) return { ok:false, error:"felaktig ränta" };

  const annualInterest = debt * r;

  const skogskontoNet = n(fromInitial?.skogskonto_netto_efter_fr_skatt_sek) ?? 0;
  const yearsCovered = annualInterest>0 ? (skogskontoNet / annualInterest) : null;

  return {
    ok:true,
    antaganden: { loan_share_pct: loanShare*100, interest_rate_pct: r*100 },
    initial_lan_sek: loan0,
    amortering_med_netto_sek: Math.min(loan0, netNow),
    restskuld_sek: debt,
    arlig_ranta_sek: annualInterest,
    skogskonto_netto_efter_fr_skatt_sek: skogskontoNet,
    ar_rante_tackt_av_skogskonto: yearsCovered
  };
}

/* -------------------- RÄNTEFÖRDELNING (positiv) -------------------- */
function interest_distribution({ baseData, options, fromLoan }: { baseData:any; options?: Opts; fromLoan?: any }) {
  const ask = n(baseData?.pris_forvantning_sek);
  const debt = n(fromLoan?.restskuld_sek);
  if (ask == null || debt == null) return { ok:false, error:"saknar pris/restskuld" };

  const capitalBase = Math.max(0, ask - debt);
  const rate = def(n(options?.interest_distribution_rate_pct), 0.0862); // t.ex. 8.62% (2024) – decimal
  const amount = capitalBase * rate;

  // Besparingsindikator: skillnad mellan näringsskatt (effektiv) och kapitalskatt 30%
  const effBiz = def(n(options?.business_tax_effective_pct), 0.45); // grovt antagande
  const taxSaving = amount * Math.max(0, (effBiz - 0.30));

  return {
    ok:true,
    kapitalunderlag_sek: capitalBase,
    rantefordelningsranta_pct: rate*100,
    rantefordelningsbelopp_sek: amount,
    antagen_skattebesparing_vs_naring_sek: taxSaving
  };
}

/* ------------- LÖNSAMHET (LEAN): KASSA/DSCR utan amort ------------- */
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

/* ----------------------- SUMMARY (sektioner) ----------------------- */
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

  // Steg: initial skattelogik
  const initTax = initial_harvest_taxed({ baseData, options });
  // Steg: lån/skogskonto-hållbarhet (beror på initTax)
  const loan = loan_sustainability({ baseData, options, fromInitial: initTax });
  // Steg: räntefördelning (beror på restskuld)
  const idist = interest_distribution({ baseData, options, fromLoan: loan });

  // Lean DSCR (utjämnat kassaflöde)
  const fwd  = forward_cashflow_and_debt({ baseData, options });

  return {
    ok:true,
    grunddata,
    nyckeltal,
    lonsamhet: {
      initial_avverkning: initTax,
      lan_och_skogskonto: loan,
      rantefordelning: idist,
      framot_kassaflode_och_skuldbarande: fwd
    }
  };
}

/* -------------------- (valfria legacy-analyser) -------------------- */
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

/* --------------------------- Export --------------------------- */
export const ANALYZERS = {
  key_metrics,
  initial_harvest_taxed,
  loan_sustainability,
  interest_distribution,
  forward_cashflow_and_debt,
  summary_pack,
  price_metrics,
  risk
};
