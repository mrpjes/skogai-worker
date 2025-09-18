// src/analyzers.ts
import { n } from "./lib/utils";

export type AnalyzerCtx = { baseData: any; options?: Record<string, any> };
export type Analyzer = (ctx: AnalyzerCtx) => any;

export const ANALYZERS: Record<string, Analyzer> = {
  price_metrics: ({ baseData }: AnalyzerCtx) => {
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

  risk: ({ baseData, options }: AnalyzerCtx) => {
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
