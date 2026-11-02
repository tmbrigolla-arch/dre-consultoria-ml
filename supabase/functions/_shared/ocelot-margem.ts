// Margem da Ocelot por unidade num preco P de UM anuncio (02/11/2026). Mesma conta da tela Promocoes
// (ml-ocelot-promocoes, funcao calcular/contaEm) -- se mudar a regra la, mude aqui tambem:
//   comissao = tarifa do ML em P (/sites/MLB/listing_prices) - parte que o ML banca na promocao (parteMl);
//   frete    = frete gratis do vendedor (/users/{id}/shipping_options/free) se P >= R$ 79; abaixo, R$ 11,05;
//   liquido  = P - comissao - frete;
//   CMV      = custo cadastrado do SKU/anuncio no mes corrente; senao liquido - repasse% x P (regra do mes),
//              com piso de R$ 40/un em cuba do Miguel e balanco do Alan;
//   resultado = liquido - CMV - (imposto + Ads + custo fixo)% x P;  margem = resultado / P.
// repasse% = imposto + gestao + Ads + custo fixo (ocelot_repasse_pct): pela formula a Ocelot fica com a gestao.
import { ml } from "./ocelot.ts";

const MIGUEL_ID = "9e88add9-8405-46db-8bd4-e128ee9ce65a";
const ALAN_ID = "e7e5a84c-9294-4d80-a251-d3f36dc83d46";
const FORN_NOME: Record<string, string> = {
  [MIGUEL_ID]: "Miguel", [ALAN_ID]: "Alan", "91c31303-ab54-43c0-9b36-88b7bd8d5c54": "Tiago",
};
const CMV_PISO = 40, FRETE_GRATIS_MIN = 79, FRETE_REF_PADRAO = 11.05;
const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const final90 = (p: number) => Math.max(0.9, Math.ceil(p - 0.9 + 1e-9) + 0.9);
const semAcento = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export type Margem = {
  preco: number; comissao: number | null; frete: number | null; liquido: number | null;
  cmv: number | null; cmv_origem: string; repasse_preco: number | null; repasse_formula?: number | null; retencoes: number | null; resultado: number | null; resultado_pct: number | null;
};

// Le uma vez o que a conta precisa de um anuncio (regra do mes, SKU, fornecedor, custo, frete, tipo/categoria)
// e devolve conta(P) para qualquer preco (tarifa do ML com cache por preco).
export async function contextoMargem(admin: any, conta: string, itemId: string) {
  const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7) + "-01";
  const [{ data: pctRows }, { data: rpData }, { data: c }, it, { data: skuRow }, { data: fornRow }] = await Promise.all([
    admin.rpc("ocelot_pct_mes", { p_conta: conta, p_mes: mes }),
    admin.rpc("ocelot_repasse_pct", { p_conta: conta, p_mes: mes }),
    admin.from("contas_ml").select("ml_user_id").eq("id", conta).maybeSingle(),
    ml(admin, conta, `/items/${itemId}?attributes=id,title,category_id,listing_type_id,price`),
    admin.from("ocelot_itens_sku").select("sku").eq("conta_id", conta).eq("item_id", itemId).maybeSingle(),
    admin.from("ocelot_item_fornecedor").select("fornecedor_id").eq("conta_id", conta).eq("item_id", itemId).maybeSingle(),
  ]);
  const pm: any = (pctRows || [])[0] || {};
  const pct = {
    mes, repasse: num(rpData), imposto: num(pm.imposto_pct) ?? 0, gestao: num(pm.gestao_pct) ?? 0,
    ads: num(pm.ads_pct) ?? 0, fixo: num(pm.fixo_pct) ?? 0,
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
  const cacheTarifa: Record<string, number | null> = {};
  async function tarifa(P: number) {
    if (!v.listing_type_id || !v.category_id) return null;
    const k = r2(P).toFixed(2);
    if (k in cacheTarifa) return cacheTarifa[k];
    const r = await ml(admin, conta, `/sites/MLB/listing_prices?price=${k}&listing_type_id=${v.listing_type_id}&category_id=${v.category_id}`);
    const o = Array.isArray(r.json) ? r.json.find((x: any) => x.listing_type_id === v.listing_type_id) || r.json[0] : r.json;
    return (cacheTarifa[k] = r.ok ? num(o?.sale_fee_amount) : null);
  }
  async function contaEm(P: number, parteMl = 0): Promise<Margem> {
    const tar = await tarifa(P);
    const comissao = tar == null ? null : r2(Math.max(0, tar - (parteMl || 0)));
    const frete = P < FRETE_GRATIS_MIN ? FRETE_REF_PADRAO : freteGratis;
    const vazio: Margem = { preco: P, comissao, frete, liquido: null, cmv: null, cmv_origem: "sem_dados", repasse_preco: null, retencoes: null, resultado: null, resultado_pct: null };
    if (comissao == null || frete == null) return vazio;
    const liquido = r2(P - comissao - frete);
    // repasse_formula: liquido - repasse% x P, mesmo com custo cadastrado (o preco sugerido compara isso com o alvo)
    const repasseFormula = pct.repasse == null ? null : r2(liquido - P * pct.repasse / 100);
    // repasse_preco: o que ESTE preco gera de repasse antes do piso de R$ 40 (pelo piso a Ocelot completa a diferenca)
    let cmv: number | null, origem: string, repassePreco: number | null = null;
    if (custoManual != null) { cmv = custoManual; origem = "custo_cadastrado"; repassePreco = custoManual; }
    else if (pct.repasse == null) { cmv = null; origem = "sem_regra"; }
    else {
      const formula = liquido - P * pct.repasse / 100;
      repassePreco = r2(formula);
      if (temPiso && formula < CMV_PISO) { cmv = CMV_PISO; origem = "piso"; } else { cmv = formula; origem = "formula"; }
    }
    if (cmv == null) return { ...vazio, liquido, cmv_origem: origem, repasse_formula: repasseFormula };
    const retencoes = r2(P * (pct.imposto + pct.ads + pct.fixo) / 100);
    const resultado = r2(liquido - cmv - retencoes);
    return { preco: P, comissao, frete, liquido, cmv: r2(cmv), cmv_origem: origem, repasse_preco: repassePreco, repasse_formula: repasseFormula, retencoes, resultado, resultado_pct: P ? r2(resultado / P * 100) : null };
  }
  return {
    pct, sku, custoManual, contaEm, tipo: v.listing_type_id || null, preco_atual: num(v.price),
    fornecedor: fornId ? (FORN_NOME[fornId] || "outro") : null, fornecedor_sugerido: !fornRow?.fornecedor_id && !!fornId,
  };
}

// precos: [{ P, parteMl? }] -> uma Margem por preco, na mesma ordem
export async function margemOcelot(admin: any, conta: string, itemId: string, precos: { P: number; parteMl?: number }[]) {
  const ctx = await contextoMargem(admin, conta, itemId);
  const itens = await Promise.all(precos.map(({ P, parteMl }) => ctx.contaEm(P, parteMl || 0)));
  // repasse = CMV da Ocelot = o que vai para o fornecedor dono do anuncio (ocelot_item_fornecedor)
  return { pct: ctx.pct, sku: ctx.sku, itens, fornecedor: ctx.fornecedor, fornecedor_sugerido: ctx.fornecedor_sugerido };
}

// PRECO SUGERIDO (02/11/2026, pedido do Tiago): menor preco (final ,90) em que, MESMO com um desconto de
// promocao (descontoPct, ex. 5%), o repasse gerado pela formula (liquido - repasse% x preco) ainda cobre o alvo
// (repasse minimo do produto; custo cadastrado do mes quando houver). Como repasse% ja inclui a gestao, a Ocelot
// fica com os 5,5% da gestao. Tarifa e frete do proprio anuncio (Classico/Premium, frete gratis acima de R$ 79).
export async function sugerirPreco(ctx: Awaited<ReturnType<typeof contextoMargem>>, alvo: number, descontoPct: number) {
  if (ctx.pct.repasse == null) return { erro: "sem regra de repasse no mes" };
  const fator = 1 - descontoPct / 100;
  // repasse pela formula (com custo cadastrado o alvo e o custo: o preco tem de gerar ao menos isso)
  const rep = async (X: number) => (await ctx.contaEm(r2(X))).repasse_formula ?? null;
  // cobre nos DOIS precos: o cheio e o da promocao. Nao basta olhar a promocao: acima de R$ 79 o vendedor paga o
  // frete gratis, entao o preco cheio pode gerar MENOS repasse que o promocional logo abaixo de 79.
  const sobra = async (P: number) => {
    const [a, b] = await Promise.all([rep(P), rep(P * fator)]);
    return a == null || b == null ? null : Math.min(a, b) - alvo;
  };
  // menor X com repasse(X) >= alvo (iteracao: a tarifa e o frete mudam com o preco)
  const den = Math.max(0.3, 1 - 0.14 - ctx.pct.repasse / 100);
  const resolve = async (inicio: number) => {
    let X = inicio;
    for (let i = 0; i < 8; i++) {
      const r = await rep(X);
      if (r == null) return null;
      const falta = alvo - r;
      if (Math.abs(falta) < 0.05) break;
      X = Math.max(5, X + falta / den);
    }
    return X;
  };
  const xPromo = await resolve(Math.max(10, (alvo + FRETE_REF_PADRAO) / den));
  if (xPromo == null) return { erro: "tarifa ou frete do ML indisponivel" };
  const xCheio = await resolve(xPromo / fator);
  if (xCheio == null) return { erro: "tarifa ou frete do ML indisponivel" };
  let P = final90(Math.max(xPromo / fator, xCheio));
  let s = await sobra(P);
  if (s == null) return { erro: "tarifa ou frete do ML indisponivel" };
  // sobe de R$ 1 em R$ 1 ate cobrir (degrau do frete em R$ 79); depois desce enquanto ainda cobrir
  for (let i = 0; i < 40 && s < -0.005; i++) { P += 1; s = (await sobra(P)) ?? -1; }
  if (s < -0.005) return { erro: "nao achei preco que cubra o repasse (confira frete/tarifa do anuncio)" };
  for (let i = 0; i < 8 && P - 1 > 1; i++) { const s2 = await sobra(P - 1); if (s2 == null || s2 < -0.005) break; P -= 1; s = s2; }
  return { preco: r2(P), preco_promo: r2(P * fator), repasse_promo: await rep(P * fator), repasse_cheio: await rep(P), alvo };
}
