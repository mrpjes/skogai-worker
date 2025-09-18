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

/** --------- Lägg allt i en export --------- */
export const ANALYZERS = {
  price_metrics,
  risk,
  value_indicator,
};

// Tips: lägg till nya analyser här i samma fil:
// function din_nya({ baseData, options }: { baseData:any; options?:any }) { ... }
// export const ANALYZERS = { ...ANALYZERS, din_nya };
