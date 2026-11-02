// Margem da Ocelot por unidade num preco P de UM anuncio (02/11/2026). Mesma conta da tela Promocoes
// (ml-ocelot-promocoes, funcao calcular/contaEm) -- se mudar a regra la, mude aqui tambem:
//   comissao = tarifa do ML em P (/sites/MLB/listing_prices) - parte que o ML banca na promocao (parteMl);
//   frete    = frete gratis do vendedor (/users/{id}/shipping_options/free) se P >= R$ 79; abaixo, R$ 11,05;
//   liquido  = P - comissao - frete;
//   CMV      = custo cadastrado do SKU/anuncio no mes corrente; senao liquido - repasse% x P (regra do mes),
//              com piso de R$ 40/un em cuba do Miguel e balanco do Alan;
//   resultado = liquido - CMV - (imposto + Ads + custo fixo)% x P;  margem = resultado / P.
import { ml } from "./ocelot.ts";

const MIGUEL_ID = "9e88add9-8405-46db-8bd4-e128ee9ce65a";
const ALAN_ID = "e7e5a84c-9294-4d80-a251-d3f36dc83d46";
const FORN_NOME: Record<string, string> = {
  [MIGUEL_ID]: "Miguel", [ALAN_ID]: "Alan", "91c31303-ab54-43c0-9b36-88b7bd8d5c54": "Tiago",
};
const CMV_PISO = 40, FRETE_GRATIS_MIN = 79, FRETE_REF_PADRAO = 11.05;
const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const semAcento = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export type Margem = {
  preco: number; comissao: number | null; frete: number | null; liquido: number | null;
  cmv: number | null; cmv_origem: string; repasse_preco: number | null; retencoes: number | null; resultado: number | null; resultado_pct: number | null;
};

// precos: [{ P, parteMl? }] -> uma Margem por preco, na mesma ordem
export async function margemOcelot(admin: any, conta: string, itemId: string, precos: { P: number; parteMl?: number }[]) {
  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7) + "-01";
  const [{ data: pctRows }, { data: rpData }, { data: c }, it, { data: skuRow }, { data: fornRow }] = await Promise.all([
    admin.rpc("ocelot_pct_mes", { p_conta: conta, p_mes: mes }),
    admin.rpc("ocelot_repasse_pct", { p_conta: conta, p_mes: mes }),
    admin.from("contas_ml").select("ml_user_id").eq("id", conta).maybeSingle(),
    ml(admin, conta, `/items/${itemId}?attributes=id,title,category_id,listing_type_id`),
    admin.from("ocelot_itens_sku").select("sku").eq("conta_id", conta).eq("item_id", itemId).maybeSingle(),
    admin.from("ocelot_item_fornecedor").select("fornecedor_id").eq("conta_id", conta).eq("item_id", itemId).maybeSingle(),
  ]);
  const pm: any = (pctRows || [])[0] || {};
  const pct = {
    mes, repasse: num(rpData), imposto: num(pm.imposto_pct) ?? 0, ads: num(pm.ads_pct) ?? 0, fixo: num(pm.fixo_pct) ?? 0,
  };
  const v: any = it.ok ? it.json || {} : {};
  const sku: string | null = skuRow?.sku || null;
  let fornId: string | null = fornRow?.fornecedor_id || null;
  if (!fornId && v.title) {
    const { data: sug } = await admin.rpc("ocelot_fornecedor_sugerido", { p_titulo: v.title });
    if (sug) fornId = String(sug);
  }
  const t = semAcento(v.title || "");
  const temPiso = (fornId === MIGUEL_ID && t.includes("cuba")) || (fornId === ALAN_ID && t.includes("balan"));
  let custoManual: number | null = null;
  {
    const base = () => admin.from("ocelot_custos_sku").select("sku, item_id, custo_unitario").eq("conta_id", conta).eq("mes_competencia", mes);
    const [a, b] = await Promise.all([sku ? base().eq("sku", sku) : { data: [] }, base().eq("item_id", itemId).is("sku", null)]);
    const porSku = (a.data || [])[0], porMlb = (b.data || [])[0];
    custoManual = num((porSku || porMlb)?.custo_unitario);
  }
  let freteGratis: number | null = null;
  if (c?.ml_user_id) {
    const r = await ml(admin, conta, `/users/${c.ml_user_id}/shipping_options/free?item_id=${itemId}`);
    freteGratis = r.ok ? num(r.json?.coverage?.all_country?.list_cost) : null;
  }
  async function tarifa(P: number) {
    if (!v.listing_type_id || !v.category_id) return null;
    const r = await ml(admin, conta, `/sites/MLB/listing_prices?price=${P}&listing_type_id=${v.listing_type_id}&category_id=${v.category_id}`);
    const o = Array.isArray(r.json) ? r.json.find((x: any) => x.listing_type_id === v.listing_type_id) || r.json[0] : r.json;
    return r.ok ? num(o?.sale_fee_amount) : null;
  }
  const itens: Margem[] = await Promise.all(precos.map(async ({ P, parteMl }) => {
    const tar = await tarifa(r2(P));
    const comissao = tar == null ? null : r2(Math.max(0, tar - (parteMl || 0)));
    const frete = P < FRETE_GRATIS_MIN ? FRETE_REF_PADRAO : freteGratis;
    const vazio: Margem = { preco: P, comissao, frete, liquido: null, cmv: null, cmv_origem: "sem_dados", repasse_preco: null, retencoes: null, resultado: null, resultado_pct: null };
    if (comissao == null || frete == null) return vazio;
    const liquido = r2(P - comissao - frete);
    // repasse_preco: o que ESTE preco gera de repasse antes do piso de R$ 40 (pelo piso a Ocelot completa a diferenca)
    let cmv: number | null, origem: string, repassePreco: number | null = null;
    if (custoManual != null) { cmv = custoManual; origem = "custo_cadastrado"; repassePreco = custoManual; }
    else if (pct.repasse == null) { cmv = null; origem = "sem_regra"; }
    else {
      const formula = liquido - P * pct.repasse / 100;
      repassePreco = r2(formula);
      if (temPiso && formula < CMV_PISO) { cmv = CMV_PISO; origem = "piso"; } else { cmv = formula; origem = "formula"; }
    }
    if (cmv == null) return { ...vazio, liquido, cmv_origem: origem };
    const retencoes = r2(P * (pct.imposto + pct.ads + pct.fixo) / 100);
    const resultado = r2(liquido - cmv - retencoes);
    return { preco: P, comissao, frete, liquido, cmv: r2(cmv), cmv_origem: origem, repasse_preco: repassePreco, retencoes, resultado, resultado_pct: P ? r2(resultado / P * 100) : null };
  }));
  // repasse = CMV da Ocelot = o que vai para o fornecedor dono do anuncio (ocelot_item_fornecedor)
  return { pct, sku, itens, fornecedor: fornId ? (FORN_NOME[fornId] || "outro") : null, fornecedor_sugerido: !fornRow?.fornecedor_id && !!fornId };
}
