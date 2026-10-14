// ml-ocelot-anuncios v2 (12/10/2026) - Cadastro integrado com o Mercado Livre (aba Cadastro, anuncios de cada SKU).
//
// POST { acao:"sincronizar" }  (permissao "ocelot", ou cron com x-cron-secret)
//   Le AO VIVO no ML (GET /items?ids=..., 20 por chamada) todos os anuncios de ocelot_itens_sku ainda nao
//   excluidos e devolve situacao, preco, estoque e variacoes de cada um. Anuncio EXCLUIDO no ML (multiget
//   devolve 404, ou status closed com sub_status "deleted") e marcado em ocelot_itens_sku.excluido_em e
//   some do cadastro -- a linha NAO e apagada: o mapa item -> SKU continua valendo para o CMV e as unidades
//   das vendas antigas daquele anuncio. O ml-ocelot-dados segue listando; a tela filtra por excluidos_ids.
//   Antes a tela mostrava preco/situacao da coleta semanal (item_metrics), entao anuncio apagado ficava no cadastro com "—" e o SKU dava "ML respondeu 400".
// POST { acao:"status", item_id, ativo:true|false }            (permissao alterar_ml)
//   Ativa ou pausa o anuncio no ML. Encerrado (closed) nao volta por aqui: so republicando no ML.
// POST { acao:"estoque", item_id, quantidade|somar, variacao_id?, esperado? }  (permissao alterar_ml)
//   Grava o estoque disponivel. Anuncio com variacoes: estoque e por variacao, e o PUT leva TODAS as
//   variacoes (o ML apaga a variacao que nao vier no corpo) -- so a escolhida muda. Full: estoque e do ML.
// Preco: a tela usa o ml-ocelot-preco (acao efetivar), que ja tem a trava de faixa segura e o log.
// Toda escrita confere relendo o anuncio e fica em ocelot_anuncios_log. Token do ML so no servidor.
// v2 (12/10/2026) TRAVAS contra exclusao por engano: (a) o painel NUNCA exclui/encerra anuncio no ML -- a
//   status so aceita active/paused e o ml() compartilhado recusa DELETE e status closed/deleted em /items;
//   (b) "excluido" so tira do cadastro apos 2a leitura individual confirmar; (c) mais de 10 (ou 5%) de uma vez
//   ficam pendentes ate alguem confirmar na tela (POST sincronizar com confirmar_exclusoes:[ids]);
//   (d) anuncio marcado que volta a existir no ML e restaurado sozinho.
// v3 (12/10/2026): o estoque no ML e o LIMITE que o Tiago define (quem tem o produto e o fornecedor; quando
//   ele nao tem, o Tiago limita). Anuncios do mesmo produto do vendedor (user_product_id, uma cor) dividem o
//   estoque no ML. POST { acao:"estoque_lote", item_ids, quantidade } grava o mesmo limite em todas as cores
//   de um SKU (uma gravacao por produto).
// v4 (13/10/2026): edicao de estoque DESLIGADA a pedido do Tiago -- o painel nao grava estoque no ML
//   (acoes estoque e estoque_lote recusadas). Ler estoque e ativar/pausar continuam. Religar: ESTOQUE_LIGADO.
// v5 (14/10/2026): edicao de estoque RELIGADA a pedido do Tiago. O ML continua sendo a fonte da verdade: se o
//   estoque mudar no ML (venda, ajuste feito direto la), a tela rele sozinha e mostra o saldo novo. Trava contra
//   sobrescrever: a tela manda "esperado" (o saldo que ela mostrava) e, se o ML ja estiver diferente, a gravacao
//   e recusada (409) com o saldo atual -- a pessoa revisa e confirma de novo. "+N"/"-N" vai como somar:N e e
//   aplicado sobre o saldo LIDO NA HORA no ML (nao sobre o da tela).
import { adminClient, CORS, erroML, exigirUsuario, json, ml, segredoConfere } from "../_shared/ocelot.ts";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const CAMPOS = "id,title,price,status,sub_status,available_quantity,variations,shipping,permalink,user_product_id,family_id";
const ESTOQUE_LIGADO = true; // v5: religado (v4 tinha desligado)
const LIMITE_EXCLUSOES = 10; // por leitura; acima disso (ou de 5% dos anuncios) precisa confirmar na tela

async function contaOk(admin: any, uid: string) {
  const { data } = await admin.rpc("app_contas", { p_uid: uid });
  return data === null || (data || []).includes(OCELOT_CONTA);
}

function nomeVariacao(v: any): string {
  return (v.attribute_combinations || []).map((a: any) => a.value_name).filter(Boolean).join(" / ") || String(v.id);
}

function resumo(b: any) {
  const vars = (b.variations || []).map((v: any) => ({ id: v.id, nome: nomeVariacao(v), estoque: Number(v.available_quantity ?? 0) }));
  const sub: string[] = Array.isArray(b.sub_status) ? b.sub_status : [];
  return {
    item_id: b.id, titulo: b.title || null, status: b.status || null, sub_status: sub,
    preco: b.price == null ? null : Number(b.price),
    estoque: vars.length ? vars.reduce((s: number, v: any) => s + v.estoque, 0) : Number(b.available_quantity ?? 0),
    variacoes: vars, full: b.shipping?.logistic_type === "fulfillment", permalink: b.permalink || null,
    user_product_id: b.user_product_id || null, family_id: b.family_id ?? null,
  };
}

async function lerItem(admin: any, itemId: string) {
  const r = await ml(admin, OCELOT_CONTA, `/items/${itemId}?attributes=${CAMPOS}`);
  if (!r.ok) return { erro: erroML(r) };
  return resumo(r.json);
}

async function log(admin: any, linha: Record<string, unknown>) {
  await admin.from("ocelot_anuncios_log").insert({ conta_id: OCELOT_CONTA, ...linha });
}

// Grava o estoque de UM anuncio (ja lido em "antes"), confere relendo e registra no log.
// v5: somar (inteiro, pode ser negativo) e aplicado sobre o saldo lido agora; esperado (saldo que a tela mostrava)
// recusa a gravacao se o ML ja mudou nesse meio tempo (venda, ajuste direto no ML).
async function gravarEstoque(admin: any, itemId: string, antes: any, quantidade: any, variacaoId: any, uid: string, somar: any = null, esperado: any = null) {
  if (antes.full) return { http: 409, corpo: { ok: false, erro: "anúncio no Full: o estoque é o que está no armazém do ML, não dá para alterar aqui", antes } };
  let vid: number | null = null, qAntes: number;
  if (antes.variacoes.length) {
    vid = Number(variacaoId);
    const alvo = antes.variacoes.find((v: any) => v.id === vid);
    if (!alvo) return { http: 400, corpo: { ok: false, erro: "anúncio com variações: escolha a variação", antes } };
    qAntes = alvo.estoque;
  } else {
    qAntes = antes.estoque;
  }
  const temSomar = somar !== null && somar !== undefined && somar !== "";
  if (!temSomar && esperado !== null && esperado !== undefined && esperado !== "" && Number(esperado) !== qAntes)
    return { http: 409, corpo: { ok: false, mudou_no_ml: true, atual: qAntes, erro: `o estoque mudou no ML (agora ${qAntes}, a tela mostrava ${esperado}): confira e grave de novo`, antes } };
  const q = temSomar ? qAntes + Number(somar) : Number(quantidade);
  if (temSomar && !Number.isInteger(Number(somar))) return { http: 400, corpo: { ok: false, erro: "somar invalido (inteiro)" } };
  if (!Number.isInteger(q) || q < 0 || q > 99999) return { http: 400, corpo: { ok: false, erro: temSomar ? `resultado invalido: ${qAntes} ${Number(somar) >= 0 ? "+" : ""}${somar} = ${q}` : "quantidade invalida (inteiro de 0 a 99999)" } };
  const corpo: any = vid != null
    ? { variations: antes.variacoes.map((v: any) => ({ id: v.id, available_quantity: v.id === vid ? q : v.estoque })) }
    : { available_quantity: q };
  if (qAntes === q) return { http: 200, corpo: { ok: true, antes, depois: antes } };
  const r = await ml(admin, OCELOT_CONTA, `/items/${itemId}`, { method: "PUT", body: JSON.stringify(corpo) });
  const depois: any = r.ok ? await lerItem(admin, itemId) : null;
  const qDepois = depois && !depois.erro ? (vid != null ? (depois.variacoes.find((v: any) => v.id === vid)?.estoque ?? null) : depois.estoque) : null;
  const ok = r.ok && qDepois === q;
  await log(admin, { item_id: itemId, tipo: "estoque", variacao_id: vid, antes: String(qAntes), depois: String(q), usuario_id: uid, ok, resposta: r.ok ? null : erroML(r) });
  if (!r.ok) return { http: 502, corpo: { ok: false, erro: erroML(r), antes } };
  return { http: 200, corpo: { ok, antes, depois, aviso: ok ? null : "o ML aceitou, mas o estoque relido ainda não é o novo (pode levar alguns minutos)" } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* vazio */ }

  if (body.acao === "sincronizar") {
    let uid: string | null = null;
    if (!(await segredoConfere(admin, "cron_anuncios", req.headers.get("x-cron-secret")))) {
      const u = await exigirUsuario(admin, req, "ocelot");
      if (u instanceof Response) return u;
      if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
      uid = u.id;
    }
    // le tambem os ja marcados como excluidos: se voltarem a existir no ML, saem da marcacao (restaura)
    const { data: linhas } = await admin.from("ocelot_itens_sku").select("item_id,excluido_em")
      .eq("conta_id", OCELOT_CONTA).range(0, 4999);
    const jaExcluido = new Set((linhas || []).filter((r: any) => r.excluido_em).map((r: any) => String(r.item_id)));
    const ids = Array.from(new Set((linhas || []).map((r: any) => String(r.item_id)).filter((x: string) => /^MLB\d+$/.test(x))));
    const itens: Record<string, any> = {};
    const candidatos: { item_id: string; motivo: string }[] = [];
    const restaurar: string[] = [];
    let lotesErro = 0;
    const lotes: string[][] = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const ehExcluido = (code: number, b: any) => code === 404 || (b?.status === "closed" && Array.isArray(b?.sub_status) && b.sub_status.includes("deleted"));
    for (let i = 0; i < lotes.length; i += 4) {
      await Promise.all(lotes.slice(i, i + 4).map(async (lote) => {
        let r = await ml(admin, OCELOT_CONTA, `/items?ids=${lote.join(",")}&attributes=${CAMPOS}`);
        if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); r = await ml(admin, OCELOT_CONTA, `/items?ids=${lote.join(",")}&attributes=${CAMPOS}`); }
        if (!r.ok || !Array.isArray(r.json)) { lotesErro++; return; }
        r.json.forEach((e: any, k: number) => {
          const id = e?.body?.id || lote[k];
          if (e?.code !== 404 && (e?.code !== 200 || !e.body?.id)) return; // outro erro: nao conclui nada
          if (ehExcluido(e.code, e.body)) {
            if (!jaExcluido.has(id)) candidatos.push({ item_id: id, motivo: e.code === 404 ? "ML: anúncio não existe mais (404)" : "ML: excluído (closed/deleted)" });
            return;
          }
          if (jaExcluido.has(id)) restaurar.push(id);
          itens[id] = resumo(e.body);
        });
      }));
    }
    // TRAVA 1: so marca como excluido depois de uma 2a leitura, individual, confirmar a exclusao
    const confirmados: { item_id: string; motivo: string }[] = [];
    for (const c of candidatos) {
      const r = await ml(admin, OCELOT_CONTA, `/items/${c.item_id}?attributes=${CAMPOS}`);
      if (ehExcluido(r.status, r.json)) confirmados.push(c);
    }
    // TRAVA 2: muitas exclusoes de uma vez (erro do ML/token, conta trocada...) nao tira nada do cadastro
    // sozinho: devolve a lista pendente e so marca quando alguem confirmar na tela. O cron nunca confirma.
    const limite = Math.max(LIMITE_EXCLUSOES, Math.ceil(ids.length * 0.05));
    const conf = new Set((Array.isArray(body.confirmar_exclusoes) ? body.confirmar_exclusoes : []).map(String));
    const pendentes = confirmados.length > limite ? confirmados.filter((x) => !conf.has(x.item_id)) : [];
    const pend = new Set(pendentes.map((x) => x.item_id));
    const excluidos = confirmados.filter((x) => !pend.has(x.item_id));
    const agora = new Date().toISOString();
    for (const x of excluidos) {
      const { error } = await admin.from("ocelot_itens_sku").update({ excluido_em: agora, excluido_motivo: x.motivo })
        .eq("conta_id", OCELOT_CONTA).eq("item_id", x.item_id).is("excluido_em", null);
      if (!error) await log(admin, { item_id: x.item_id, tipo: "excluido", depois: x.motivo, usuario_id: uid, ok: true });
    }
    // TRAVA 3: anuncio marcado como excluido que voltou a existir no ML volta para o cadastro sozinho
    for (const id of restaurar) {
      const { error } = await admin.from("ocelot_itens_sku").update({ excluido_em: null, excluido_motivo: null })
        .eq("conta_id", OCELOT_CONTA).eq("item_id", id);
      if (!error) await log(admin, { item_id: id, tipo: "restaurado", depois: "existe de novo no ML", usuario_id: uid, ok: true });
    }
    // todos os excluidos (inclusive de leituras anteriores): a tela tira esses anuncios do cadastro
    const { data: exRows } = await admin.from("ocelot_itens_sku").select("item_id")
      .eq("conta_id", OCELOT_CONTA).not("excluido_em", "is", null).range(0, 4999);
    const excluidosIds = (exRows || []).map((r: any) => String(r.item_id));
    return json({ ok: true, consultados: ids.length, lotes_com_erro: lotesErro, itens, excluidos, excluidos_ids: excluidosIds,
      exclusoes_pendentes: pendentes, restaurados: restaurar, nao_confirmados: candidatos.length - confirmados.length, lido_em: agora });
  }

  if ((body.acao === "estoque" || body.acao === "estoque_lote") && !ESTOQUE_LIGADO)
    return json({ ok: false, erro: "edição de estoque desligada no painel: altere o estoque direto no Mercado Livre" }, 403);

  if (body.acao === "status" || body.acao === "estoque") {
    const u = await exigirUsuario(admin, req, "alterar_ml");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const itemId = String(body.item_id || "").trim().toUpperCase();
    if (!/^MLB\d+$/.test(itemId)) return json({ ok: false, erro: "item_id invalido" }, 400);
    const antes: any = await lerItem(admin, itemId);
    if (antes.erro) return json({ ok: false, erro: antes.erro }, 502);
    if (antes.status === "closed") return json({ ok: false, erro: "anúncio encerrado no ML: só volta republicando pelo Mercado Livre", antes }, 409);

    if (body.acao === "status") {
      // so ativar ou pausar: nunca encerrar/excluir (ver tambem a trava em _shared/ocelot.ts)
      if (body.ativo !== true && body.ativo !== false) return json({ ok: false, erro: "informe ativo: true ou false" }, 400);
      const novo = body.ativo ? "active" : "paused";
      if (antes.status === novo) return json({ ok: true, antes, depois: antes });
      if (novo === "active" && antes.estoque <= 0) return json({ ok: false, erro: "sem estoque: coloque estoque antes de ativar", antes }, 409);
      const r = await ml(admin, OCELOT_CONTA, `/items/${itemId}`, { method: "PUT", body: JSON.stringify({ status: novo }) });
      const depois: any = r.ok ? await lerItem(admin, itemId) : null;
      const ok = r.ok && depois && !depois.erro && depois.status === novo;
      await log(admin, { item_id: itemId, tipo: "status", antes: antes.status, depois: novo, usuario_id: u.id, ok, resposta: r.ok ? null : erroML(r) });
      if (!r.ok) return json({ ok: false, erro: erroML(r), antes }, 502);
      return json({ ok, antes, depois, aviso: ok ? null : "o ML aceitou, mas a situação relida ainda não mudou" });
    }

    // estoque
    const x = await gravarEstoque(admin, itemId, antes, body.quantidade, body.variacao_id, u.id, body.somar, body.esperado);
    return json(x.corpo, x.http);
  }

  if (body.acao === "estoque_lote") {
    // v3: o mesmo limite em varios anuncios (todas as cores de um SKU). Anuncios do mesmo produto do
    // vendedor (user_product_id) dividem o estoque no ML: grava em UM deles por produto e o ML replica.
    const u = await exigirUsuario(admin, req, "alterar_ml");
    if (u instanceof Response) return u;
    if (!(await contaOk(admin, u.id))) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
    const ids = Array.from(new Set((Array.isArray(body.item_ids) ? body.item_ids : []).map((x: any) => String(x).trim().toUpperCase())))
      .filter((x) => /^MLB\d+$/.test(x)).slice(0, 60);
    if (!ids.length) return json({ ok: false, erro: "informe item_ids" }, 400);
    const lidos: any[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const r = await ml(admin, OCELOT_CONTA, `/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=${CAMPOS}`);
      if (!r.ok || !Array.isArray(r.json)) return json({ ok: false, erro: erroML(r) }, 502);
      for (const e of r.json) if (e?.code === 200 && e.body?.id) lidos.push(resumo(e.body));
    }
    const resultados: any[] = [], feitos = new Set<string>();
    for (const it of lidos) {
      const grupo = it.user_product_id || it.item_id;
      if (feitos.has(grupo)) { resultados.push({ item_id: it.item_id, ok: true, pulado: "mesmo produto de outro anúncio já gravado (estoque compartilhado)" }); continue; }
      if (it.status === "closed") { resultados.push({ item_id: it.item_id, ok: false, erro: "encerrado" }); continue; }
      if (it.full) { resultados.push({ item_id: it.item_id, ok: false, erro: "Full: estoque do ML" }); continue; }
      if (it.variacoes.length) { resultados.push({ item_id: it.item_id, ok: false, erro: "tem variações: ajuste por variação" }); continue; }
      const x = await gravarEstoque(admin, it.item_id, it, body.quantidade, null, u.id);
      if (x.corpo.ok || x.corpo.depois) feitos.add(grupo);
      resultados.push({ item_id: it.item_id, ok: !!x.corpo.ok, erro: x.corpo.erro || x.corpo.aviso || null, depois: x.corpo.depois || null });
    }
    return json({ ok: resultados.every((r) => r.ok), resultados });
  }

  return json({ ok: false, erro: "acao invalida (use sincronizar|status|estoque|estoque_lote)" }, 400);
});
