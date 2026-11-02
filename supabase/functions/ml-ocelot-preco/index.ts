// v5.3 (02/11/2026, pedido do Tiago): PRECO SUGERIDO por anuncio. POST { acao:"sugerir", item_ids[] } (ocelot, ate 20):
//   menor preco (final ,90) em que, mesmo com 5% de desconto de promocao, o repasse pela formula cobre o repasse
//   minimo do produto (ou o custo cadastrado do mes) e a Ocelot fica com a gestao (5,5%). Ver sugerirPreco.
// v5.2 (02/11/2026, pedido do Tiago): REPASSE MINIMO por SKU (ou anuncio sem SKU), padrao R$ 40, em
//   ocelot_repasse_minimo. POST { acao:"minimos" } (ocelot) lista; { acao:"minimo_set", sku|item_id, valor|null }
//   (editar_cadastro) grava/apaga. "analisar" devolve margem.repasse_minimo e a tela avisa quando o preco novo ou a
//   promocao deixam o repasse (o que o preco gera, antes do piso) abaixo do minimo. So aviso: nao muda o pagamento.
// v5.1 (02/11/2026): analisar devolve tambem o fornecedor do repasse (margem.fornecedor) -- a tela mostra o repasse.
// v5 (02/11/2026, pedido do Tiago): anuncio em PROMOCAO. A tela chama "analisar" (promocoes ativas, preco que o
//   comprador paga e a margem da Ocelot no preco novo e na promocao) e pergunta: sair da promocao e gravar agora
//   (efetivar com promocao:"remover" -> DELETE em /seller-promotions, confere, depois PUT do preco) ou manter
//   a promocao (promocao:"manter" -> o preco fica em ocelot_precos_agendados e o cron 'ocelot-precos-agendados'
//   grava quando nenhuma promocao estiver ativa). Sem a escolha, efetivar recusa (409) anuncio em promocao.
//   POST { acao:"agendados" } lista; { acao:"cancelar_agendado", id }; { acao:"aplicar_agendados" } so o cron.
// v4 (12/10/2026): efetivar passa a ser chamado pela aba Cadastro (preco por anuncio, saiu da aba Repasse) e
//   exige a permissao alterar_ml, a mesma da troca de SKU, situacao e estoque (tudo que escreve no anuncio do ML).
// v3 (12/10/2026): o sugerido e sempre o preco de TABELA, sem descontar promocao (a promocao so e indicada).
// v2 (12/10/2026): venda abaixo da tabela de hoje = promocao (campanha do ML); com promocao ativa sugere o
//   preco de TABELA que, com o desconto atual, faz o comprador pagar o sugerido (o botao grava esse).
// ml-ocelot-preco v1 (12/10/2026) - preco sugerido das vendas pagas pelo piso (aba Repasse a fornecedores).
//
// POST { acao:"consultar", rp, itens:[{order_id,item_id,quantidade,valor_venda,taxa_ml,frete_vendedor}] }
//   Para cada item pago pelo piso de R$ 40/un devolve:
//   * venda: preco pago (unit_price) x preco cheio (full_unit_price) do pedido -> se foi vendido em promocao;
//   * anuncio hoje: preco de tabela, preco que o comprador paga (/items/{id}/sale_price) e a promocao ativa;
//   * sugerido: menor preco (final ,90) em que liquido - rp% x preco >= R$ 40/un, ou seja, o repasse pela
//     formula ja cobre o piso e a Ocelot fica com a margem padrao (rp%). Tarifa pela tabela do ML
//     (/sites/MLB/listing_prices, com a taxa fixa abaixo de R$ 79); frete = o frete por unidade desta venda.
// POST { acao:"efetivar", item_id, preco, order_id? }  (permissao alterar_ml -- v4: era editar_cadastro)
//   Muda o preco de tabela do anuncio no ML (PUT /items/{id}), confere relendo o anuncio e grava em
//   ocelot_precos_log (quem, quando, de quanto para quanto, resposta do ML).
// Token do ML so no servidor. Leitura com permissao "ocelot".
import { adminClient, CORS, erroML, exigirUsuario, json, ml, segredoConfere } from "../_shared/ocelot.ts";
import { contextoMargem, margemOcelot, sugerirPreco } from "../_shared/ocelot-margem.ts";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const REPASSE_MIN_PADRAO = 40;
const DESCONTO_PROMO_SUGERIDO = 5; // % de folga para promocao no preco sugerido
const PISO_UN = 40, FRETE_GRATIS_MIN = 79, MAX_ITENS = 40;
const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
// tipos de promocao em que a saida vai com offer_id (mesma lista do ml-ocelot-promocoes)
const POR_OFERTA = ["SMART", "SMART_LIGHTNING", "PRICE_MATCHING", "PRICE_MATCHING_MELI_ALL", "MARKETPLACE_CAMPAIGN", "UNHEALTHY_STOCK"];
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
    await emLotes(Array.from(new Set<string>(itens.map((x: any) => String(x.item_id)))), 6, async (id: string) => {
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
      // v2: campanha do ML (marketplace_campaign) nao vem no full_unit_price do pedido. Se o preco pago ficou
      // abaixo do preco de tabela de hoje, a venda e tratada como promocao (desconto contra a tabela).
      const V = res.venda;
      if (V && !V.erro && !V.em_promocao && an.tabela && Number(an.tabela) - V.pago >= 0.01) {
        V.em_promocao = true; V.cheio = Number(an.tabela); V.desconto_pct = r2((1 - V.pago / V.cheio) * 100); V.pela_tabela = true;
      }
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
      // v3: sempre preco de TABELA (regra do Tiago): a promocao so e indicada, nao entra na conta.
      res.sugerido = { preco: r2(sug), tarifa: r2(l.t), frete: r2(freteUn), repasse_formula: r2(l.r), rp, tarifa_tabela_ml: tarifaReal, avisos };
      out.push(res);
    });
    return json({ ok: true, itens: out });
  }

  // ---------------------------------------------------------------- v5: promocao ativa
  // analisar: antes de gravar, a tela pergunta o que fazer quando o anuncio esta em promocao e mostra a margem
  if (body.acao === "analisar") {
    const u = await exigirUsuario(admin, req, "alterar_ml");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const itemId = String(body.item_id || "");
    const preco = r2(Number(body.preco));
    if (!/^MLB\d+$/.test(itemId)) return json({ ok: false, erro: "item_id invalido" }, 400);
    if (!(preco >= 5 && preco <= 100000)) return json({ ok: false, erro: "preco invalido" }, 400);
    const [antes, promos] = await Promise.all([precoAtual(admin, itemId), promocoesAtivas(admin, itemId)]);
    if ((antes as any).erro) return json({ ok: false, erro: (antes as any).erro }, 502);
    const a: any = antes;
    const lista = promos.lista || [];
    // preco que o comprador paga hoje e quanto o ML banca dele (co-participacao), para a margem na promocao
    const p0 = lista[0] || null;
    const precoPromo = a.em_promocao ? a.comprador : (p0?.preco ?? null);
    const parteMl = p0?.meli_pct && (p0.original ?? a.tabela) ? r2((p0.original ?? a.tabela) * p0.meli_pct / 100) : 0;
    const pedidos: { P: number; parteMl?: number }[] = [{ P: preco }];
    if (precoPromo && (lista.length || a.em_promocao)) pedidos.push({ P: precoPromo, parteMl });
    if (a.tabela > 0) pedidos.push({ P: a.tabela });
    let margem: any = null;
    try {
      const m = await margemOcelot(admin, OCELOT_CONTA, itemId, pedidos);
      const minimo = await repasseMinimo(admin, m.sku, itemId);
      margem = { repasse_minimo: minimo, novo: m.itens[0], promocao: pedidos.length === 3 ? m.itens[1] : null, tabela: a.tabela > 0 ? m.itens[m.itens.length - 1] : null, pct: m.pct, fornecedor: m.fornecedor, fornecedor_sugerido: m.fornecedor_sugerido };
    } catch (e) { margem = { erro: String((e as Error).message || e) }; }
    const fora = a.tabela > 0 && (preco > a.tabela * 2 || preco < a.tabela / 2);
    return json({
      ok: true, antes: a, em_promocao: lista.length > 0 || !!a.em_promocao, promocoes: lista,
      promocoes_erro: promos.erro || null, preco_promocao: precoPromo, margem,
      fora_faixa: fora ? `preço fora da faixa segura (preço de tabela atual R$ ${a.tabela.toFixed(2)})` : null,
      agendado: await agendadoPendente(admin, itemId),
    });
  }

  if (body.acao === "efetivar") {
    const u = await exigirUsuario(admin, req, "alterar_ml");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const itemId = String(body.item_id || "");
    const preco = r2(Number(body.preco));
    const escolha = String(body.promocao || "");
    if (!/^MLB\d+$/.test(itemId)) return json({ ok: false, erro: "item_id invalido" }, 400);
    if (!(preco >= 5 && preco <= 100000)) return json({ ok: false, erro: "preco invalido" }, 400);
    const [antes, promos] = await Promise.all([precoAtual(admin, itemId), promocoesAtivas(admin, itemId)]);
    if ((antes as any).erro) return json({ ok: false, erro: (antes as any).erro }, 502);
    const a: any = antes;
    // trava contra erro de digitacao / calculo: no maximo 2x ou metade do preco de tabela atual
    if (a.tabela > 0 && (preco > a.tabela * 2 || preco < a.tabela / 2))
      return json({ ok: false, erro: `preço fora da faixa segura (preço de tabela atual R$ ${a.tabela.toFixed(2)})` }, 400);
    if (promos.erro) return json({ ok: false, erro: `não consegui ler as promoções do anúncio (${promos.erro})` }, 502);
    const lista = promos.lista || [];
    // v5: em promocao o preco so muda com a escolha explicita da pessoa (a tela pergunta)
    if (lista.length && escolha !== "remover" && escolha !== "manter")
      return json({ ok: false, em_promocao: true, promocoes: lista, erro: "anúncio em promoção: escolha sair da promoção ou manter" }, 409);

    if (lista.length && escolha === "manter") {
      await cancelarPendentes(admin, itemId, "substituído por novo agendamento");
      const fins = lista.map((p: any) => p.fim).filter(Boolean).sort();
      const { data: ag, error } = await admin.from("ocelot_precos_agendados").insert({
        conta_id: OCELOT_CONTA, item_id: itemId, preco, usuario_id: u.id,
        promocoes: lista.map((p: any) => ({ id: p.id, tipo: p.tipo, nome: p.nome, preco: p.preco, fim: p.fim })),
        fim_previsto: fins.length ? fins[fins.length - 1] : null,
      }).select("id, item_id, preco, fim_previsto, criado_em, status").single();
      if (error) return json({ ok: false, erro: `não agendou: ${error.message}` }, 500);
      return json({ ok: true, agendado: ag, antes: a });
    }

    let removidas: any[] = [];
    if (lista.length) {
      const sai = await sairPromocoes(admin, itemId, lista);
      removidas = sai.resultados;
      if (!sai.ok) {
        await admin.from("ocelot_precos_log").insert({
          conta_id: OCELOT_CONTA, item_id: itemId, preco_anterior: a.tabela, preco_novo: preco, em_promocao: true,
          usuario_id: u.id, ok: false, origem: "remover_promocao", resposta: `nao saiu da promocao: ${sai.erro}`,
        });
        return json({ ok: false, erro: `não consegui tirar o anúncio da promoção (${sai.erro}); o preço não foi alterado`, promocoes: removidas }, 502);
      }
    }
    await cancelarPendentes(admin, itemId, "substituído por alteração direta de preço");
    const g = await gravarPreco(admin, itemId, preco, a, u.id, lista.length ? "remover_promocao" : "direto", body.order_id);
    return json({ ...g.corpo, promocoes_removidas: removidas }, g.http);
  }

  if (body.acao === "sugerir") {
    const u = await exigirUsuario(admin, req, "ocelot");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const ids = Array.from(new Set<string>((Array.isArray(body.item_ids) ? body.item_ids : []).map((x: any) => String(x).trim().toUpperCase())))
      .filter((x) => /^MLB\d+$/.test(x)).slice(0, 20);
    const itens: Record<string, any> = {};
    await emLotes(ids, 4, async (id: string) => {
      try {
        const ctx = await contextoMargem(admin, OCELOT_CONTA, id);
        const min = await repasseMinimo(admin, ctx.sku, id);
        const alvo = ctx.custoManual ?? min.valor;
        const s: any = await sugerirPreco(ctx, alvo, DESCONTO_PROMO_SUGERIDO);
        itens[id] = { ...s, alvo_origem: ctx.custoManual != null ? "custo_cadastrado" : (min.origem === "padrao" ? "minimo_padrao" : "minimo"),
          desconto_pct: DESCONTO_PROMO_SUGERIDO, gestao_pct: ctx.pct.gestao, repasse_pct: ctx.pct.repasse, preco_atual: ctx.preco_atual, tipo: ctx.tipo };
      } catch (e) { itens[id] = { erro: String((e as Error).message || e) }; }
    });
    return json({ ok: true, itens });
  }

  if (body.acao === "minimos") {
    const u = await exigirUsuario(admin, req, "ocelot");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const { data } = await admin.from("ocelot_repasse_minimo").select("tipo, chave, valor").eq("conta_id", OCELOT_CONTA).limit(5000);
    const itens: Record<string, number> = {};
    for (const r of data || []) itens[`${r.tipo}:${r.chave}`] = Number(r.valor);
    return json({ ok: true, padrao: REPASSE_MIN_PADRAO, itens });
  }

  if (body.acao === "minimo_set") {
    const u = await exigirUsuario(admin, req, "editar_cadastro");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const sku = String(body.sku || "").trim(), item = String(body.item_id || "").trim().toUpperCase();
    const tipo = sku ? "sku" : "mlb", chave = sku || item;
    if (!chave || (tipo === "mlb" && !/^MLB\d+$/.test(chave)) || chave.length > 80) return json({ ok: false, erro: "informe sku ou item_id" }, 400);
    if (body.valor === null || body.valor === "") {
      await admin.from("ocelot_repasse_minimo").delete().eq("conta_id", OCELOT_CONTA).eq("tipo", tipo).eq("chave", chave);
      return json({ ok: true, valor: null, padrao: REPASSE_MIN_PADRAO });
    }
    const valor = r2(Number(body.valor));
    if (!(valor > 0 && valor < 100000)) return json({ ok: false, erro: "valor invalido" }, 400);
    const { error } = await admin.from("ocelot_repasse_minimo").upsert({ conta_id: OCELOT_CONTA, tipo, chave, valor, usuario_id: u.id, atualizado_em: new Date().toISOString() });
    if (error) return json({ ok: false, erro: error.message }, 500);
    return json({ ok: true, valor });
  }

  if (body.acao === "agendados") {
    const u = await exigirUsuario(admin, req, "ocelot");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const desde = new Date(Date.now() - 3 * 86400_000).toISOString();
    const { data } = await admin.from("ocelot_precos_agendados")
      .select("id, item_id, preco, promocoes, fim_previsto, status, criado_em, verificado_em, aplicado_em, obs")
      .eq("conta_id", OCELOT_CONTA).or(`status.eq.pendente,and(status.in.(aplicado,erro),aplicado_em.gte.${desde})`)
      .order("criado_em", { ascending: false }).limit(500);
    return json({ ok: true, agendados: data || [] });
  }

  if (body.acao === "cancelar_agendado") {
    const u = await exigirUsuario(admin, req, "alterar_ml");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json({ ok: false, erro: "id invalido" }, 400);
    const { data } = await admin.from("ocelot_precos_agendados").update({ status: "cancelado", obs: "cancelado na tela" })
      .eq("id", id).eq("conta_id", OCELOT_CONTA).eq("status", "pendente").select("id");
    return json({ ok: !!(data && data.length) });
  }

  // cron 'ocelot-precos-agendados' (a cada 15 min, so quando ha pendente): grava o preco agendado de cada
  // anuncio cuja promocao ja terminou. Se o anuncio entrou em outra promocao, continua esperando.
  if (body.acao === "aplicar_agendados") {
    if (!(await segredoConfere(admin, "cron_precos", req.headers.get("x-cron-secret"))))
      return json({ ok: false, erro: "nao autorizado" }, 401);
    const { data: pend } = await admin.from("ocelot_precos_agendados").select("*")
      .eq("conta_id", OCELOT_CONTA).eq("status", "pendente").order("criado_em").limit(30);
    const out: any[] = [];
    for (const ag of pend || []) {
      const agora = new Date().toISOString();
      const promos = await promocoesAtivas(admin, ag.item_id);
      if (promos.erro) {
        await admin.from("ocelot_precos_agendados").update({ verificado_em: agora, obs: `leitura das promoções falhou: ${promos.erro}` }).eq("id", ag.id);
        out.push({ id: ag.id, espera: "erro_leitura" }); continue;
      }
      if ((promos.lista || []).length) {
        const p = promos.lista![0];
        await admin.from("ocelot_precos_agendados").update({
          verificado_em: agora, obs: `aguardando fim da promoção ${p.nome || p.tipo}${p.fim ? " (até " + String(p.fim).slice(0, 10) + ")" : ""}`,
        }).eq("id", ag.id);
        out.push({ id: ag.id, espera: "em_promocao" }); continue;
      }
      const antes: any = await precoAtual(admin, ag.item_id);
      let st = "erro", obs = "";
      if (antes.erro) obs = antes.erro;
      else if (antes.tabela > 0 && (Number(ag.preco) > antes.tabela * 2 || Number(ag.preco) < antes.tabela / 2))
        obs = `preço fora da faixa segura (preço de tabela atual R$ ${antes.tabela.toFixed(2)}); não aplicado`;
      else {
        const g = await gravarPreco(admin, ag.item_id, Number(ag.preco), antes, ag.usuario_id, "agendado", null);
        st = g.corpo.ok || g.corpo.depois ? "aplicado" : "erro";
        obs = g.corpo.ok ? "gravado no ML após o fim da promoção" : (g.corpo.aviso || g.corpo.erro || "");
      }
      await admin.from("ocelot_precos_agendados").update({ status: st, verificado_em: agora, aplicado_em: agora, obs }).eq("id", ag.id);
      out.push({ id: ag.id, status: st, obs });
    }
    return json({ ok: true, processados: out });
  }

  return json({ ok: false, erro: "acao invalida (use consultar|analisar|efetivar|agendados|cancelar_agendado)" }, 400);
});

// PUT do preco de tabela + releitura + log (efetivar direto, saindo da promocao, ou pelo agendamento)
async function gravarPreco(admin: any, itemId: string, preco: number, a: any, uid: string | null, origem: string, orderId: unknown) {
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
    conta_id: OCELOT_CONTA, item_id: itemId, order_id: /^\d+$/.test(String(orderId || "")) ? Number(orderId) : null,
    preco_anterior: a.tabela, preco_novo: preco, em_promocao: a.em_promocao, usuario_id: uid, ok, origem,
    resposta: r.ok ? null : erroML(r),
  });
  if (!r.ok) return { http: 502, corpo: { ok: false, erro: erroML(r) } as any };
  return { http: 200, corpo: { ok, antes: a, depois, aviso: ok ? null : "o ML aceitou, mas o preço relido ainda não é o novo (pode levar alguns minutos)" } as any };
}

// Promocoes ATIVAS (status started) do anuncio, pela API de promocoes do vendedor (v2).
async function promocoesAtivas(admin: any, itemId: string): Promise<{ lista?: any[]; erro?: string }> {
  const r = await ml(admin, OCELOT_CONTA, `/seller-promotions/items/${itemId}?app_version=v2`, { headers: { version: "v2" } });
  if (r.status === 404) return { lista: [] };
  if (!r.ok) return { erro: erroML(r) };
  const lista = (Array.isArray(r.json) ? r.json : []).filter((p: any) => p?.status === "started").map((p: any) => ({
    id: p.id ?? null, tipo: p.type ?? null, nome: p.name ?? null,
    preco: num(p.price), original: num(p.original_price), inicio: p.start_date ?? null, fim: p.finish_date ?? p.end_date ?? null,
    offer_id: p.offer_id ?? p.ref_id ?? null, meli_pct: num(p.meli_percentage), seller_pct: num(p.seller_percentage),
  }));
  return { lista };
}

// Tira o anuncio de cada promocao ativa (mesmo DELETE da tela Promocoes, acao sair) e confere relendo.
async function sairPromocoes(admin: any, itemId: string, lista: any[]) {
  const resultados: any[] = [];
  for (const p of lista) {
    const q = new URLSearchParams({ promotion_type: String(p.tipo || ""), app_version: "v2" });
    if (p.id) q.set("promotion_id", String(p.id));
    if (p.offer_id && POR_OFERTA.includes(p.tipo)) q.set("offer_id", String(p.offer_id));
    const r = await ml(admin, OCELOT_CONTA, `/seller-promotions/items/${itemId}?${q}`, { method: "DELETE", headers: { version: "v2" } });
    resultados.push({ id: p.id, tipo: p.tipo, ok: r.ok, erro: r.ok ? null : erroML(r) });
  }
  const falhas = resultados.filter((x) => !x.ok);
  if (falhas.length) return { ok: false, erro: falhas.map((x) => `${x.tipo}: ${x.erro}`).join("; "), resultados };
  // o ML pode levar alguns segundos para refletir a saida
  for (let i = 0; i < 3; i++) {
    await new Promise((ok) => setTimeout(ok, 1500));
    const d = await promocoesAtivas(admin, itemId);
    if (!d.erro && !(d.lista || []).length) return { ok: true, resultados };
  }
  return { ok: false, erro: "o ML aceitou a saída, mas a promoção ainda aparece ativa; tente de novo em alguns minutos", resultados };
}

// minimo do SKU; senao do anuncio; senao o padrao (R$ 40)
async function repasseMinimo(admin: any, sku: string | null, itemId: string) {
  const q = (tipo: string, chave: string) => admin.from("ocelot_repasse_minimo").select("valor")
    .eq("conta_id", OCELOT_CONTA).eq("tipo", tipo).eq("chave", chave).maybeSingle();
  if (sku) { const { data } = await q("sku", sku); if (data) return { valor: Number(data.valor), origem: "sku" }; }
  const { data } = await q("mlb", itemId);
  if (data) return { valor: Number(data.valor), origem: "anuncio" };
  return { valor: REPASSE_MIN_PADRAO, origem: "padrao" };
}

async function cancelarPendentes(admin: any, itemId: string, obs: string) {
  await admin.from("ocelot_precos_agendados").update({ status: "cancelado", obs })
    .eq("conta_id", OCELOT_CONTA).eq("item_id", itemId).eq("status", "pendente");
}

async function agendadoPendente(admin: any, itemId: string) {
  const { data } = await admin.from("ocelot_precos_agendados").select("id, preco, fim_previsto, criado_em")
    .eq("conta_id", OCELOT_CONTA).eq("item_id", itemId).eq("status", "pendente").order("criado_em", { ascending: false }).limit(1);
  return (data || [])[0] || null;
}
