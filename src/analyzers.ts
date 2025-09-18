// src/analyzers.ts

// ===== Hjälpfunktioner =====
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

// ===== Analyser =====

// 1) Pris-metrik
function price_metrics({ baseData }: any) {
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
}

// 2) Risk-analys
function risk({ baseData, options }: any) {
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
}

// 3) Årlig tillväxt (volym + värde)
function growth_analysis({ baseData }: any) {
  const bonitet = n(baseData?.bonitet); // m³sk/ha/år
  const area = n(baseData?.skogsmark_ha);
  const pris = n(baseData?.pris_forvantning_sek);
  if (!bonitet || !area) return { ok: false, error: "saknar bonitet/area" };

  const tillvaxt_m3sk = bonitet * area;
  const pris_per_m3sk =
    pris && n(baseData?.volym_total_m3sk) ? pris / n(baseData?.volym_total_m3sk)! : null;
  const tillvaxt_varde = pris_per_m3sk ? tillvaxt_m3sk * pris_per_m3sk : null;

  return {
    ok: true,
    tillvaxt_m3sk_per_ar: tillvaxt_m3sk,
    tillvaxt_varde_per_ar: tillvaxt_varde,
  };
}

// 4) Möjliga avverkningar (grov uppskattning)
function harvest_plan({ baseData }: any) {
  const volym = n(baseData?.volym_total_m3sk);
  const pris = n(baseData?.pris_forvantning_sek);
  if (!volym || !pris) return { ok: false, error: "saknar volym/pris" };

  const pris_per_m3sk = pris / volym;
  const gallring = volym * 0.2;
  const slutavverkning = volym * 0.8;

  return {
    ok: true,
    gallring_m3sk: gallring,
    gallring_varde: gallring * pris_per_m3sk,
    slutavverkning_m3sk: slutavverkning,
    slutavverkning_varde: slutavverkning * pris_per_m3sk,
  };
}

// 5) Kassaflöde & låneutrymme
function cashflow_loan({ baseData, options }: any) {
  const pris = n(baseData?.pris_forvantning_sek);
  const tillvaxt = growth_analysis({ baseData });
  if (!pris || !tillvaxt.ok) return { ok: false, error: "saknar pris/tillväxt" };

  const årlig_intäkt = tillvaxt.tillvaxt_varde_per_ar ?? 0;
  const ränta = options?.ränta ?? 0.05; // default 5%
  const amort_tid = options?.amort_tid ?? 30; // default 30 år

  // Enkel annuitetsberäkning (lånebelopp baserat på årlig intäkt)
  const annuitetsfaktor = (ränta * Math.pow(1 + ränta, amort_tid)) / (Math.pow(1 + ränta, amort_tid) - 1);
  const max_lan = årlig_intäkt / (ränta + annuitetsfaktor);

  return {
    ok: true,
    årlig_intäkt,
    max_lan,
    andel_av_pris: pris > 0 ? max_lan / pris : null,
  };
}

// ===== Export =====
export const ANALYZERS = {
  price_metrics,
  risk,
  growth_analysis,
  harvest_plan,
  cashflow_loan,
};
