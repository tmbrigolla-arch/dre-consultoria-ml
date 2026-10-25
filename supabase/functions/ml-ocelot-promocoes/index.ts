// ml-ocelot-promocoes v3 (25/10/2026: oferta relampago pelo painel, com estoque reservado; v2: relampago co-participada manda stock, erro do ML com cause; v1 18/10/2026) - campanhas de promocao do ML da conta Ocelot, o resultado de cada item
// nelas e os botoes de participar / sair (sempre pelo usuario, nunca automatico). Mesma ideia da tela
// Promocoes do antoninho-comissoes, com o CMV da Ocelot = REPASSE ao fornecedor pela regra do mes corrente.
//
// POST { acao:"campanhas" }                                                   -> { ok, campanhas[], pct }
//   cada campanha traz participando (started + pending) e elegiveis (+ candidate), pelo paging.total do ML
// POST { acao:"itens", promotion_id, promotion_type, status?, cursor? }      -> { ok, itens[], total, cursor, pct }
// POST { acao:"participar"|"sair", promotion_id, promotion_type, item_ids[], forcar?, estoque_max? } -> { ok, resultados[] }
//   relampago (LIGHTNING, SMART_LIGHTNING): reserva o estoque do anuncio, limitado ao max do ML e a estoque_max
//
// Conta por unidade, no preco da campanha P (e o mesmo no preco cheio, para comparar):
//   comissao = tarifa do ML em P (/sites/MLB/listing_prices) - parte que o ML banca (meli_percentage do
//              preco cheio: o ML desconta da tarifa, conferido em vendas reais no antoninho em 17/10/2026);
//   frete    = custo do frete gratis (/users/{id}/shipping_options/free) se P >= R$ 79; abaixo de R$ 79,
//              R$ 11,05 (frete de referencia da Ocelot para item avulso abaixo de 79, regra v28 da DRE);
//   liquido  = P - comissao - frete;
//   CMV      = repasse ao fornecedor, regra do MES CORRENTE (ocelot_repasse_pct, provisorio ate o fechamento):
//              custo cadastrado do SKU/anuncio no mes, se houver; senao liquido - repasse% x P, com piso de
//              R$ 40/un em cuba do Miguel e balanco do Alan (mesma regra de ml-ocelot-dados);
//   resultado da Ocelot = liquido - CMV - imposto - Ads - custo fixo (% do mes, ocelot_pct_mes).
// Pela formula o resultado e sempre a gestao (5,5%) e o desconto sai do repasse do fornecedor; a Ocelot so
// perde margem quando o CMV vem do piso ou de custo cadastrado. Por isso a trava daqui e prejuizo (resultado
// abaixo de MARGEM_MINIMA = 0%) ou CMV desconhecido, salvo forcar:true.
//
// Permissoes: ler = menu "ocelot_promocoes"; participar/sair = tambem a acao "alterar_ml" (a mesma que troca
// preco/estoque no Cadastro). Usuario ligado a fornecedor (ocelot_usuario_fornecedor) nao usa esta tela.
// Toda tentativa de participar/sair vai para ocelot_promocoes_log. Token do ML so no servidor.
import { adminClient, CORS, erroML, exigirUsuario, json, ml } from "../_shared/ocelot.ts";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const MIGUEL_ID = "9e88add9-8405-46db-8bd4-e128ee9ce65a";
const ALAN_ID = "e7e5a84c-9294-4d80-a251-d3f36dc83d46";
const FORN_NOME: Record<string, string> = {
  [MIGUEL_ID]: "Miguel", [ALAN_ID]: "Alan", "91c31303-ab54-43c0-9b36-88b7bd8d5c54": "Tiago",
};
const CMV_PISO = 40, FRETE_GRATIS_MIN = 79, FRETE_REF_PADRAO = 11.05;
const POR_PAGINA = 100, MARGEM_MINIMA = 0, MAX_LOTE = 50;
// tipos que o ML aceita por offer_id (a oferta ja vem montada por ele)
const POR_OFERTA = ["SMART", "SMART_LIGHTNING", "PRICE_MATCHING", "PRICE_MATCHING_MELI_ALL", "MARKETPLACE_CAMPAIGN", "UNHEALTHY_STOCK"];
// tipos em que o vendedor informa o preco (deal_price)
const POR_PRECO = ["DEAL", "SELLER_CAMPAIGN"];
// oferta relampago do vendedor: preco (deal_price) + estoque, sem promotion_id (formato da doc do ML)
const POR_PRECO_ESTOQUE = ["LIGHTNING"];
// relampago: o ML exige o estoque reservado para a oferta (stock, dentro do min/max que ele informa)
const COM_ESTOQUE = ["SMART_LIGHTNING", "LIGHTNING"];
const SO_NO_ML = ["PRICE_DISCOUNT", "DOD", "VOLUME", "PRE_NEGOTIATED", "BANK"];

const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const semAcento = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

async function emLotes<T, R>(lista: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(lista.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => {
    while (i < lista.length) { const k = i++; out[k] = await fn(lista[k]); }
  }));
  return out;
}

function mesCorrente() {
  // competencia pelo horario de Brasilia (UTC-3)
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7) + "-01";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* vazio */ }
  const acao = String(body?.acao || "");

  const u = await exigirUsuario(admin, req, "ocelot_promocoes");
  if (u instanceof Response) return u;
  const uid = u.id;
  const { data: contasPerm } = await admin.rpc("app_contas", { p_uid: u.id });
  if (contasPerm !== null && !(contasPerm || []).includes(OCELOT_CONTA))
    return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
  const { data: uf } = await admin.from("ocelot_usuario_fornecedor").select("fornecedor_id").eq("user_id", u.id).maybeSingle();
  if (uf) return json({ ok: false, erro: "usuario de fornecedor nao usa a tela de promocoes" }, 403);

  const { data: conta } = await admin.from("contas_ml").select("ml_user_id").eq("id", OCELOT_CONTA).maybeSingle();
  const uidML = conta?.ml_user_id;
  if (!uidML) return json({ ok: false, erro: "conta Ocelot sem usuario do ML" }, 500);

  // % do mes corrente (provisorios ate o fechamento: Ads e custo fixo do ultimo mes fechado)
  const mes = mesCorrente();
  const [{ data: pctRows }, { data: rpData }] = await Promise.all([
    admin.rpc("ocelot_pct_mes", { p_conta: OCELOT_CONTA, p_mes: mes }),
    admin.rpc("ocelot_repasse_pct", { p_conta: OCELOT_CONTA, p_mes: mes }),
  ]);
  const pm: any = (pctRows || [])[0] || {};
  const pct = {
    mes, repasse: num(rpData), imposto: num(pm.imposto_pct) ?? 0, gestao: num(pm.gestao_pct) ?? 0,
    ads: num(pm.ads_pct) ?? 0, fixo: num(pm.fixo_pct) ?? 0, fechado: !!pm.fechado, ads_origem: pm.ads_origem ?? null,
  };

  const mlc = (caminho: string, init: RequestInit = {}) =>
    ml(admin, OCELOT_CONTA, caminho, { ...init, headers: { version: "v2", ...(init.headers || {}) } });

  // resultado de cada item cru da API de promocoes (lista de /promotions/{id}/items ou montada de /items/{id})
  async function calcular(lista: any[]) {
    const ids = [...new Set(lista.map((x) => String(x.id)))];

    // anuncio ao vivo (titulo, preco, categoria, tipo)
    const vivo: Record<string, any> = {};
    const blocos: string[][] = [];
    for (let i = 0; i < ids.length; i += 20) blocos.push(ids.slice(i, i + 20));
    await emLotes(blocos, 4, async (b) => {
      const r = await mlc(`/items?ids=${b.join(",")}&attributes=id,title,price,category_id,listing_type_id,permalink,thumbnail,available_quantity`);
      for (const x of Array.isArray(r.json) ? r.json : []) if (x?.code === 200 && x.body?.id) vivo[x.body.id] = x.body;
    });

    // SKU, dono do anuncio e custo cadastrado do mes
    const [{ data: skuRows }, { data: fornRows }] = await Promise.all([
      ids.length ? admin.from("ocelot_itens_sku").select("item_id, sku").eq("conta_id", OCELOT_CONTA).in("item_id", ids) : { data: [] },
      ids.length ? admin.from("ocelot_item_fornecedor").select("item_id, fornecedor_id").eq("conta_id", OCELOT_CONTA).in("item_id", ids) : { data: [] },
    ]);
    const skuPorItem: Record<string, string> = {};
    for (const r of skuRows || []) if (r.sku) skuPorItem[r.item_id] = r.sku;
    const fornPorItem: Record<string, string> = {};
    for (const r of fornRows || []) if (r.fornecedor_id) fornPorItem[r.item_id] = r.fornecedor_id;
    for (const id of ids) {
      if (fornPorItem[id] || !vivo[id]?.title) continue;
      const { data: sug } = await admin.rpc("ocelot_fornecedor_sugerido", { p_titulo: vivo[id].title });
      if (sug) fornPorItem[id] = String(sug);
    }
    const { data: custos } = await admin.from("ocelot_custos_sku").select("sku, item_id, custo_unitario")
      .eq("conta_id", OCELOT_CONTA).eq("mes_competencia", mes);
    const custoSku: Record<string, number> = {}, custoMlb: Record<string, number> = {};
    for (const c of custos || []) {
      if (c.sku) custoSku[c.sku] = Number(c.custo_unitario);
      else if (c.item_id) custoMlb[c.item_id] = Number(c.custo_unitario);
    }

    // tarifa (cache por preco/tipo/categoria) e frete gratis do vendedor no preco atual
    const tarifas: Record<string, number | null> = {};
    async function tarifa(preco: number | null, tipo: string | null, cat: string | null) {
      if (!preco || !tipo || !cat) return null;
      const k = `${preco}|${tipo}|${cat}`;
      if (k in tarifas) return tarifas[k];
      const r = await mlc(`/sites/MLB/listing_prices?price=${preco}&listing_type_id=${tipo}&category_id=${cat}`);
      const o = Array.isArray(r.json) ? r.json.find((x: any) => x.listing_type_id === tipo) || r.json[0] : r.json;
      return (tarifas[k] = r.ok ? num(o?.sale_fee_amount) : null);
    }
    const fretes: Record<string, number | null> = {};
    await emLotes(ids, 6, async (id) => {
      const r = await mlc(`/users/${uidML}/shipping_options/free?item_id=${id}`);
      fretes[id] = r.ok ? num(r.json?.coverage?.all_country?.list_cost) : null;
    });

    // conta da Ocelot num preco P (por unidade)
    function contaEm(P: number | null, comissao: number | null, frete: number | null, ctx: any) {
      if (P == null || comissao == null || frete == null) return null;
      const liquido = r2(P - comissao - frete);
      let cmv: number | null, origem: string;
      if (ctx.custoManual != null) { cmv = ctx.custoManual; origem = "custo_cadastrado"; }
      else if (pct.repasse == null) { cmv = null; origem = "sem_regra"; }
      else {
        const formula = liquido - P * pct.repasse / 100;
        if (ctx.temPiso && formula < CMV_PISO) { cmv = CMV_PISO; origem = "piso"; }
        else { cmv = formula; origem = "formula"; }
      }
      if (cmv == null) return { liquido, cmv: null, origem, resultado: null, resultado_pct: null, retencoes: null };
      const retencoes = r2(P * (pct.imposto + pct.ads + pct.fixo) / 100);
      const resultado = r2(liquido - cmv - retencoes);
      return { liquido, cmv: r2(cmv), origem, retencoes, resultado, resultado_pct: P ? r2(resultado / P * 100) : null };
    }

    return await emLotes(lista, 6, async (x) => {
      const id = String(x.id);
      const v = vivo[id] || {};
      const titulo = v.title || null;
      const sku = skuPorItem[id] || null;
      const fornId = fornPorItem[id] || null;
      const t = semAcento(titulo || "");
      const temPiso = (fornId === MIGUEL_ID && t.includes("cuba")) || (fornId === ALAN_ID && t.includes("balan"));
      const custoManual = sku && custoSku[sku] != null ? custoSku[sku] : (custoMlb[id] ?? null);

      const cheio = num(x.original_price) ?? num(v.price);
      const cupomPct = num(x.fixed_percentage);
      const precoCampanha = (num(x.price) || null) ?? num(x.max_discounted_price) ?? num(x.suggested_discounted_price)
        ?? (cheio && cupomPct ? r2(cheio * (1 - cupomPct / 100)) : null);
      const meliPct = num(x.meli_percentage) || 0;
      const parteMl = cheio && meliPct ? r2(cheio * meliPct / 100) : 0;
      const tipo = v.listing_type_id || null, cat = v.category_id || null;

      const freteGratis = fretes[id] ?? null;
      const freteEm = (P: number | null) => P == null ? null : (P < FRETE_GRATIS_MIN ? FRETE_REF_PADRAO : freteGratis);
      const tarCamp = await tarifa(precoCampanha, tipo, cat);
      const tarCheio = await tarifa(cheio, tipo, cat);
      const comissao = tarCamp == null ? null : r2(Math.max(0, tarCamp - parteMl));
      const ctx = { custoManual, temPiso };
      const camp = contaEm(precoCampanha, comissao, freteEm(precoCampanha), ctx);
      const atual = contaEm(cheio, tarCheio, freteEm(cheio), ctx);

      const avisos: string[] = [];
      if (camp?.origem === "piso") avisos.push("piso_ocelot_paga");
      if (camp?.origem === "custo_cadastrado") avisos.push("custo_cadastrado_ocelot_paga");
      if (!fornId) avisos.push("sem_fornecedor");
      if (precoCampanha != null && precoCampanha < FRETE_GRATIS_MIN) avisos.push("abaixo_79_frete_referencia");
      if (cupomPct) avisos.push("cupom_so_acima_do_minimo");
      if (tarCamp == null) avisos.push("comissao_indisponivel");
      if (freteGratis == null && !(precoCampanha != null && precoCampanha < FRETE_GRATIS_MIN)) avisos.push("frete_indisponivel");
      if (!num(x.price) && precoCampanha != null) avisos.push("preco_sugerido");

      return {
        item_id: id, status: x.status ?? null, offer_id: x.offer_id ?? x.ref_id ?? null,
        titulo, permalink: v.permalink || null, sku, estoque: num(v.available_quantity),
        fornecedor: fornId ? (FORN_NOME[fornId] || "outro") : null,
        preco_cheio: cheio, preco_campanha: precoCampanha,
        desconto_pct: cheio && precoCampanha ? r2((1 - precoCampanha / cheio) * 100) : null,
        meli_pct: meliPct || null, seller_pct: num(x.seller_percentage), parte_ml: parteMl || null,
        tarifa: tarCamp, comissao, frete: freteEm(precoCampanha),
        liquido: camp?.liquido ?? null, cmv: camp?.cmv ?? null, cmv_origem: camp?.origem ?? null,
        retencoes: camp?.retencoes ?? null, resultado: camp?.resultado ?? null, resultado_pct: camp?.resultado_pct ?? null,
        cmv_atual: atual?.cmv ?? null, resultado_atual: atual?.resultado ?? null, resultado_atual_pct: atual?.resultado_pct ?? null,
        repasse_perde: camp?.cmv != null && atual?.cmv != null ? r2(atual.cmv - camp.cmv) : null,
        inicio: x.start_date ?? null, fim: x.end_date ?? null,
        estoque_min: num(x.stock?.min), estoque_max: num(x.stock?.max),
        avisos,
      };
    });
  }

  try {
    // -------------------------------------------------------------- campanhas
    if (acao === "campanhas") {
      const r = await mlc(`/seller-promotions/users/${uidML}?app_version=v2`);
      if (!r.ok) return json({ ok: false, erro: erroML(r) }, 502);
      const campanhas = (r.json?.results || []).map((p: any) => ({
        id: p.id ?? null, tipo: p.type ?? null, status: p.status ?? null, nome: p.name ?? null,
        inicio: p.start_date ?? null, fim: p.finish_date ?? null, prazo_adesao: p.deadline_date ?? null,
        cupom_pct: num(p.fixed_percentage), cupom_minimo: num(p.min_purchase_amount),
        participando: null as number | null, elegiveis: null as number | null,
      }));
      // participacao: total de itens por status (limit=1, so o paging.total interessa); falhou um, fica null
      await emLotes(campanhas.filter((c: any) => c.id && c.tipo), 4, async (c: any) => {
        const tot = await Promise.all(["started", "pending", "candidate"].map(async (st) => {
          const q = new URLSearchParams({ promotion_type: c.tipo, app_version: "v2", limit: "1", status: st });
          const r = await mlc(`/seller-promotions/promotions/${encodeURIComponent(c.id)}/items?${q}`);
          return r.ok ? (num(r.json?.paging?.total) ?? 0) : null;
        }));
        if (tot.some((t) => t == null)) return;
        c.participando = tot[0]! + tot[1]!;
        c.elegiveis = c.participando + tot[2]!;
      });
      return json({ ok: true, campanhas, pct, margem_minima: MARGEM_MINIMA });
    }

    // ------------------------------------------------------------------ itens
    if (acao === "itens") {
      const promotion_id = String(body?.promotion_id || "");
      const promotion_type = String(body?.promotion_type || "");
      if (!promotion_id || !promotion_type) return json({ ok: false, erro: "promotion_id e promotion_type obrigatorios" }, 400);
      const status = ["candidate", "pending", "started"].includes(String(body?.status)) ? String(body.status) : "";
      const lista: any[] = [];
      let cursor: string | null = body?.cursor ? String(body.cursor) : null;
      let total: number | null = null;
      for (let pag = 0; pag < POR_PAGINA / 50; pag++) {
        const q = new URLSearchParams({ promotion_type, app_version: "v2", limit: "50" });
        if (status) q.set("status", status);
        if (cursor) q.set("search_after", cursor);
        const r = await mlc(`/seller-promotions/promotions/${encodeURIComponent(promotion_id)}/items?${q}`);
        if (!r.ok) {
          if (pag === 0) return json({ ok: false, erro: erroML(r) }, 502);
          break;
        }
        const res = Array.isArray(r.json?.results) ? r.json.results : [];
        lista.push(...res);
        total = num(r.json?.paging?.total);
        cursor = r.json?.paging?.searchAfter ?? r.json?.paging?.search_after ?? null;
        if (!cursor || !res.length) { cursor = null; break; }
      }
      const itens = await calcular(lista);
      return json({ ok: true, itens, total, cursor, pct, margem_minima: MARGEM_MINIMA });
    }

    // -------------------------------------------------------- participar / sair
    if (acao === "participar" || acao === "sair") {
      const { data: podeAlterar } = await admin.rpc("app_pode", { p_uid: uid, p_chave: "alterar_ml" });
      if (podeAlterar !== true) return json({ ok: false, erro: "sem permissao para alterar anuncios no ML" }, 403);
      const promotion_id = String(body?.promotion_id || "");
      const promotion_type = String(body?.promotion_type || "");
      const forcar = body?.forcar === true;
      const estoqueMax = num(body?.estoque_max) != null && num(body.estoque_max)! > 0 ? Math.floor(num(body.estoque_max)!) : null;
      const ids = [...new Set<string>((Array.isArray(body?.item_ids) ? body.item_ids : []).map(String))].filter((x) => /^MLB\d+$/.test(x));
      if (!promotion_id || !promotion_type) return json({ ok: false, erro: "promotion_id e promotion_type obrigatorios" }, 400);
      if (!ids.length) return json({ ok: false, erro: "nenhum item" }, 400);
      if (ids.length > MAX_LOTE) return json({ ok: false, erro: `maximo ${MAX_LOTE} itens por vez` }, 400);
      if (SO_NO_ML.includes(promotion_type)) return json({ ok: false, erro: "esse tipo de campanha e feito pelo proprio ML" }, 400);

      async function logar(r: any) {
        await admin.from("ocelot_promocoes_log").insert({
          conta_id: OCELOT_CONTA, item_id: r.item_id, promotion_id, promotion_type, acao,
          preco: r.preco ?? null, resultado: r.resultado ?? null, resultado_pct: r.resultado_pct ?? null,
          cmv: r.cmv ?? null, repasse_pct: pct.repasse, forcado: forcar, usuario_id: uid, ok: r.ok, erro: r.erro ?? null,
        });
      }

      // estado ao vivo de cada item nesta campanha (a conta e refeita aqui, nao vale a que a tela mandou)
      const vivos = await emLotes(ids, 4, async (id) => {
        const r = await mlc(`/seller-promotions/items/${id}?app_version=v2`);
        const lista = Array.isArray(r.json) ? r.json : [];
        const p = lista.find((x: any) => String(x.id) === promotion_id && x.type === promotion_type);
        return { id, p: p ? { ...p, id } : null, erro: r.ok ? null : erroML(r) };
      });
      const calc = acao === "participar" ? await calcular(vivos.filter((v) => v.p).map((v) => v.p)) : [];
      const porId: Record<string, any> = {};
      for (const c of calc) porId[c.item_id] = c;

      const resultados = await emLotes(vivos, 3, async (v) => {
        const res: any = { item_id: v.id, ok: false };
        if (!v.p) { res.erro = v.erro || "item_fora_da_campanha"; await logar(res); return res; }
        const oferta = v.p.offer_id ?? v.p.ref_id ?? null;
        if (acao === "participar") {
          const c = porId[v.id];
          res.preco = c?.preco_campanha ?? null;
          res.resultado = c?.resultado ?? null;
          res.resultado_pct = c?.resultado_pct ?? null;
          res.cmv = c?.cmv ?? null;
          if (v.p.status !== "candidate") { res.erro = `ja_${v.p.status}`; await logar(res); return res; }
          if (!forcar && (c?.resultado_pct == null || c.resultado_pct < MARGEM_MINIMA)) {
            res.erro = c?.resultado_pct == null ? "sem_resultado_calculado" : "abaixo_margem_minima";
            await logar(res); return res;
          }
          const corpo: any = POR_PRECO_ESTOQUE.includes(promotion_type) ? { promotion_type } : { promotion_id, promotion_type };
          if (COM_ESTOQUE.includes(promotion_type)) {
            // estoque do anuncio, limitado ao max do ML e ao limite escolhido na tela; abaixo do min do ML nao vai
            const min = num(v.p.stock?.min) ?? 1;
            const tetos = [c?.estoque ?? null, num(v.p.stock?.max), estoqueMax].filter((t): t is number => t != null);
            const qtd = tetos.length ? Math.min(...tetos) : null;
            if (qtd == null || qtd < min) { res.erro = `estoque_insuficiente (min ${min})`; await logar(res); return res; }
            corpo.stock = qtd;
            res.estoque = qtd;
          }
          if (POR_OFERTA.includes(promotion_type)) {
            if (!oferta) { res.erro = "sem_offer_id"; await logar(res); return res; }
            corpo.offer_id = oferta;
          } else if (POR_PRECO.includes(promotion_type) || POR_PRECO_ESTOQUE.includes(promotion_type)) {
            if (!res.preco) { res.erro = "sem_preco"; await logar(res); return res; }
            corpo.deal_price = res.preco;
          }
          const r = await mlc(`/seller-promotions/items/${v.id}?app_version=v2`, { method: "POST", body: JSON.stringify(corpo) });
          res.ok = r.ok;
          if (!r.ok) res.erro = erroML(r);
        } else {
          if (v.p.status === "candidate") { res.erro = "nao_participa"; await logar(res); return res; }
          const q = new URLSearchParams({ promotion_type, promotion_id, app_version: "v2" });
          if (oferta && POR_OFERTA.includes(promotion_type)) q.set("offer_id", oferta);
          const r = await mlc(`/seller-promotions/items/${v.id}?${q}`, { method: "DELETE" });
          res.ok = r.ok;
          if (!r.ok) res.erro = erroML(r);
        }
        await logar(res);
        return res;
      });
      return json({ ok: true, resultados, margem_minima: MARGEM_MINIMA });
    }

    return json({ ok: false, erro: "acao invalida (use campanhas|itens|participar|sair)" }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
