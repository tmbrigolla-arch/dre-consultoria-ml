// ml-ocelot-preco v1 (12/10/2026) - preco sugerido das vendas pagas pelo piso (aba Repasse a fornecedores).
//
// POST { acao:"consultar", rp, itens:[{order_id,item_id,quantidade,valor_venda,taxa_ml,frete_vendedor}] }
//   Para cada item pago pelo piso de R$ 40/un devolve:
//   * venda: preco pago (unit_price) x preco cheio (full_unit_price) do pedido -> se foi vendido em promocao;
//   * anuncio hoje: preco de tabela, preco que o comprador paga (/items/{id}/sale_price) e a promocao ativa;
//   * sugerido: menor preco (final ,90) em que liquido - rp% x preco >= R$ 40/un, ou seja, o repasse pela
//     formula ja cobre o piso e a Ocelot fica com a margem padrao (rp%). Tarifa pela tabela do ML
//     (/sites/MLB/listing_prices, com a taxa fixa abaixo de R$ 79); frete = o frete por unidade desta venda.
// POST { acao:"efetivar", item_id, preco, order_id? }  (permissao editar_cadastro)
//   Muda o preco de tabela do anuncio no ML (PUT /items/{id}), confere relendo o anuncio e grava em
//   ocelot_precos_log (quem, quando, de quanto para quanto, resposta do ML).
// Token do ML so no servidor. Leitura com permissao "ocelot".
import { adminClient, CORS, erroML, exigirUsuario, json, ml } from "../_shared/ocelot.ts";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const PISO_UN = 40, FRETE_GRATIS_MIN = 79, MAX_ITENS = 40;
const r2 = (v: number) => Math.round(v * 100) / 100;
const final90 = (p: number) => Math.max(0.9, Math.ceil(p - 0.9 + 1e-9) + 0.9);

async function emLotes<T>(lista: T[], n: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < lista.length; i += n) await Promise.all(lista.slice(i, i + n).map(fn));
}

async function contaOk(admin: any, uid: string) {
  const { data } = await admin.rpc("app_contas", { p_uid: uid });
  return data === null || (data || []).includes(OCELOT_CONTA);
}

// Promocao ativa no anuncio: /items/{id}/sale_price (regular_amount preenchido = em promocao).
async function precoAtual(admin: any, itemId: string) {
  const [it, sp] = await Promise.all([
    ml(admin, OCELOT_CONTA, `/items/${itemId}?attributes=id,price,original_price,status,listing_type_id,category_id,variations`),
    ml(admin, OCELOT_CONTA, `/items/${itemId}/sale_price?context=channel_marketplace`),
  ]);
  if (!it.ok) return { erro: erroML(it) };
  const tabela = Number(it.json?.price ?? 0);
  let comprador = tabela, regular: number | null = null, promo: any = null;
  if (sp.ok && sp.json && sp.json.amount != null) {
    comprador = Number(sp.json.amount);
    regular = sp.json.regular_amount != null ? Number(sp.json.regular_amount) : null;
    const md = sp.json.metadata || {};
    if (regular != null && regular > comprador)
      promo = { tipo: md.promotion_type || null, id: md.promotion_id || md.campaign_id || null };
  } else if (it.json?.original_price && Number(it.json.original_price) > tabela) {
    regular = Number(it.json.original_price); promo = { tipo: null, id: null };
  }
  return {
    tabela: regular ?? tabela, comprador, em_promocao: !!promo, promocao: promo,
    status: it.json?.status || null, listing_type_id: it.json?.listing_type_id || null,
    category_id: it.json?.category_id || null, n_variacoes: (it.json?.variations || []).length,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* vazio */ }

  if (body.acao === "consultar") {
    const u = await exigirUsuario(admin, req, "ocelot");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const rp = Number(body.rp);
    if (!(rp >= 0 && rp < 80)) return json({ ok: false, erro: "rp invalido" }, 400);
    const itens = (Array.isArray(body.itens) ? body.itens : []).slice(0, MAX_ITENS)
      .filter((x: any) => /^MLB\d+$/.test(String(x?.item_id || "")) && /^\d+$/.test(String(x?.order_id || "")));

    const anuncios: Record<string, any> = {};
    await emLotes(Array.from(new Set(itens.map((x: any) => String(x.item_id)))), 6, async (id) => {
      try { anuncios[id] = await precoAtual(admin, id); } catch (e) { anuncios[id] = { erro: String((e as Error).message || e) }; }
    });

    // tarifa do ML num preco (com cache por preco/tipo/categoria)
    const cacheTarifa: Record<string, number | null> = {};
    async function tarifa(preco: number, lt: string | null, cat: string | null): Promise<number | null> {
      if (!lt || !cat) return null;
      const k = `${preco}|${lt}|${cat}`;
      if (k in cacheTarifa) return cacheTarifa[k];
      const r = await ml(admin, OCELOT_CONTA, `/sites/MLB/listing_prices?price=${preco}&listing_type_id=${lt}&category_id=${cat}`);
      const o = Array.isArray(r.json) ? r.json.find((x: any) => x.listing_type_id === lt) || r.json[0] : r.json;
      return (cacheTarifa[k] = r.ok && o && o.sale_fee_amount != null ? Number(o.sale_fee_amount) : null);
    }

    const out: any[] = [];
    await emLotes(itens, 4, async (x: any) => {
      const q = Math.max(1, Number(x.quantidade) || 1);
      const precoUn = Number(x.valor_venda || 0) / q, taxaUn = Number(x.taxa_ml || 0) / q, freteUn = Number(x.frete_vendedor || 0) / q;
      const res: any = { order_id: String(x.order_id), item_id: String(x.item_id) };
      // venda: preco cheio x preco pago
      try {
        const o = await ml(admin, OCELOT_CONTA, `/orders/${x.order_id}`);
        const oi = (o.json?.order_items || []).find((z: any) => z.item?.id === x.item_id);
        if (o.ok && oi) {
          const pago = Number(oi.unit_price || 0), cheio = Number(oi.full_unit_price ?? oi.unit_price ?? 0);
          res.venda = { pago, cheio, em_promocao: cheio - pago >= 0.01, desconto_pct: cheio > 0 ? r2((1 - pago / cheio) * 100) : 0 };
        } else res.venda = { erro: o.ok ? "item nao achado no pedido" : erroML(o) };
      } catch (e) { res.venda = { erro: String((e as Error).message || e) }; }
      const an = anuncios[x.item_id] || {};
      res.anuncio = an;
      // preco sugerido: liquido(P) - rp% P = 40 -> P - tarifa(P) - frete - rp% P = 40
      const pctProp = precoUn > 0 ? taxaUn / precoUn : 0.14; // fallback: tarifa proporcional a desta venda
      const liq = async (p: number) => {
        const t = await tarifa(r2(p), an.listing_type_id, an.category_id);
        return { t: t ?? pctProp * p, real: t != null, r: p - (t ?? pctProp * p) - freteUn - rp / 100 * p };
      };
      const den = Math.max(0.2, 1 - pctProp - rp / 100);
      let p = (PISO_UN + freteUn + taxaUn - pctProp * precoUn) / den; // chute: tarifa fixa desta venda
      if (!(p > 0)) p = precoUn;
      let tarifaReal = true;
      for (let i = 0; i < 6; i++) {
        const l = await liq(p); tarifaReal = l.real;
        const falta = PISO_UN - l.r;
        if (Math.abs(falta) < 0.02) break;
        p = Math.max(1, p + falta / den);
      }
      let sug = final90(p);
      let l = await liq(sug);
      for (let i = 0; i < 3 && l.r < PISO_UN - 0.005; i++) { sug += 1; l = await liq(sug); }
      const avisos: string[] = [];
      if (!tarifaReal) avisos.push("tarifa estimada pela proporção desta venda (tabela do ML indisponível)");
      if ((precoUn < FRETE_GRATIS_MIN) !== (sug < FRETE_GRATIS_MIN))
        avisos.push(sug >= FRETE_GRATIS_MIN ? "acima de R$ 79 o ML passa a cobrar o frete grátis do vendedor: o frete usado (desta venda) deve subir" : "abaixo de R$ 79 o frete do vendedor muda: o frete usado (desta venda) é só referência");
      if (freteUn > 0 && precoUn > 0 && freteUn / precoUn > 0.3)
        avisos.push(`frete de ${r2(freteUn).toFixed(2).replace(".", ",")} = ${Math.round(freteUn / precoUn * 100)}% da venda: confira peso/medidas do anúncio`);
      if (an.em_promocao) avisos.push("anúncio em promoção agora: o botão muda o preço de tabela; o comprador paga o preço da promoção e o ML pode tirar o anúncio dela");
      res.sugerido = { preco: r2(sug), tarifa: r2(l.t), frete: r2(freteUn), repasse_formula: r2(l.r), rp, tarifa_tabela_ml: tarifaReal, avisos };
      out.push(res);
    });
    return json({ ok: true, itens: out });
  }

  if (body.acao === "efetivar") {
    const u = await exigirUsuario(admin, req, "editar_cadastro");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const itemId = String(body.item_id || "");
    const preco = r2(Number(body.preco));
    if (!/^MLB\d+$/.test(itemId)) return json({ ok: false, erro: "item_id invalido" }, 400);
    if (!(preco >= 5 && preco <= 100000)) return json({ ok: false, erro: "preco invalido" }, 400);
    const antes = await precoAtual(admin, itemId);
    if ((antes as any).erro) return json({ ok: false, erro: (antes as any).erro }, 502);
    const a: any = antes;
    // trava contra erro de digitacao / calculo: no maximo 2x ou metade do preco de tabela atual
    if (a.tabela > 0 && (preco > a.tabela * 2 || preco < a.tabela / 2))
      return json({ ok: false, erro: `preço fora da faixa segura (preço de tabela atual R$ ${a.tabela.toFixed(2)})` }, 400);
    // anuncio com variacoes: o preco vai em cada variacao (o ML exige o mesmo preco em todas)
    let corpo: any = { price: preco };
    if (a.n_variacoes > 0) {
      const v = await ml(admin, OCELOT_CONTA, `/items/${itemId}?attributes=variations`);
      corpo = { variations: (v.json?.variations || []).map((z: any) => ({ id: z.id, price: preco })) };
    }
    const r = await ml(admin, OCELOT_CONTA, `/items/${itemId}`, { method: "PUT", body: JSON.stringify(corpo) });
    const depois: any = r.ok ? await precoAtual(admin, itemId) : null;
    const ok = r.ok && depois && !depois.erro && Math.abs(Number(depois.tabela) - preco) < 0.01;
    await admin.from("ocelot_precos_log").insert({
      conta_id: OCELOT_CONTA, item_id: itemId, order_id: /^\d+$/.test(String(body.order_id || "")) ? Number(body.order_id) : null,
      preco_anterior: a.tabela, preco_novo: preco, em_promocao: a.em_promocao, usuario_id: u.id, ok,
      resposta: r.ok ? null : erroML(r),
    });
    if (!r.ok) return json({ ok: false, erro: erroML(r) }, 502);
    return json({ ok, antes: a, depois, aviso: ok ? null : "o ML aceitou, mas o preço relido ainda não é o novo (pode levar alguns minutos)" });
  }

  return json({ ok: false, erro: "acao invalida (use consultar|efetivar)" }, 400);
});
