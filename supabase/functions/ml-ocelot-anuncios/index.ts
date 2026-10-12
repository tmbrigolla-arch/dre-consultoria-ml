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
// POST { acao:"estoque", item_id, quantidade, variacao_id? }    (permissao alterar_ml)
//   Grava o estoque disponivel. Anuncio com variacoes: estoque e por variacao, e o PUT leva TODAS as
//   variacoes (o ML apaga a variacao que nao vier no corpo) -- so a escolhida muda. Full: estoque e do ML.
// Preco: a tela usa o ml-ocelot-preco (acao efetivar), que ja tem a trava de faixa segura e o log.
// Toda escrita confere relendo o anuncio e fica em ocelot_anuncios_log. Token do ML so no servidor.
// v2 (12/10/2026) TRAVAS contra exclusao por engano: (a) o painel NUNCA exclui/encerra anuncio no ML -- a
//   status so aceita active/paused e o ml() compartilhado recusa DELETE e status closed/deleted em /items;
//   (b) "excluido" so tira do cadastro apos 2a leitura individual confirmar; (c) mais de 10 (ou 5%) de uma vez
//   ficam pendentes ate alguem confirmar na tela (POST sincronizar com confirmar_exclusoes:[ids]);
//   (d) anuncio marcado que volta a existir no ML e restaurado sozinho.
import { adminClient, CORS, erroML, exigirUsuario, json, ml, segredoConfere } from "../_shared/ocelot.ts";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const CAMPOS = "id,title,price,status,sub_status,available_quantity,variations,shipping,permalink,user_product_id,family_id";
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
    const q = Number(body.quantidade);
    if (!Number.isInteger(q) || q < 0 || q > 99999) return json({ ok: false, erro: "quantidade invalida (inteiro de 0 a 99999)" }, 400);
    if (antes.full) return json({ ok: false, erro: "anúncio no Full: o estoque é o que está no armazém do ML, não dá para alterar aqui", antes }, 409);
    let corpo: any, vid: number | null = null, qAntes: number;
    if (antes.variacoes.length) {
      vid = Number(body.variacao_id);
      const alvo = antes.variacoes.find((v: any) => v.id === vid);
      if (!alvo) return json({ ok: false, erro: "anúncio com variações: escolha a variação", antes }, 400);
      qAntes = alvo.estoque;
      corpo = { variations: antes.variacoes.map((v: any) => ({ id: v.id, available_quantity: v.id === vid ? q : v.estoque })) };
    } else {
      qAntes = antes.estoque;
      corpo = { available_quantity: q };
    }
    if (qAntes === q) return json({ ok: true, antes, depois: antes });
    const r = await ml(admin, OCELOT_CONTA, `/items/${itemId}`, { method: "PUT", body: JSON.stringify(corpo) });
    const depois: any = r.ok ? await lerItem(admin, itemId) : null;
    const qDepois = depois && !depois.erro ? (vid != null ? (depois.variacoes.find((v: any) => v.id === vid)?.estoque ?? null) : depois.estoque) : null;
    const ok = r.ok && qDepois === q;
    await log(admin, { item_id: itemId, tipo: "estoque", variacao_id: vid, antes: String(qAntes), depois: String(q), usuario_id: u.id, ok, resposta: r.ok ? null : erroML(r) });
    if (!r.ok) return json({ ok: false, erro: erroML(r), antes }, 502);
    return json({ ok, antes, depois, aviso: ok ? null : "o ML aceitou, mas o estoque relido ainda não é o novo (pode levar alguns minutos)" });
  }

  return json({ ok: false, erro: "acao invalida (use sincronizar|status|estoque)" }, 400);
});
