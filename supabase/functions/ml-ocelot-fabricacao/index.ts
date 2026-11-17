// ml-ocelot-fabricacao v3 (17/11/2026) - calculadora de custo de producao do fornecedor (tela "Custo de producao"
// da Gestao Ocelot). Feita para o Miguel (cubas de concreto); usada por ele e pela Elisangela.
// v2: a receita e da PECA do cadastro (SKU, ou o MLB do anuncio sem SKU), sem o passo de "modelo" da v1.
// v3: a tela e do fabricante: nao cruza mais com vendas/repasse; o historico e das alteracoes de preco dos insumos
// (ocelot_fab_precos_hist), gravado no salvar_insumo.
//
// POST { acao:"dados" }  -> { ok, fornecedor, unidades, insumos[], receitas[], produtos[], precos_hist[] }
//   insumos com custo por unidade (preco / embalagem); receitas com itens e custo da peca;
//   produtos = pecas do fornecedor no cadastro (ocelot_itens_sku + ocelot_item_fornecedor) e as que tem receita,
//   com anuncios, receita_id e custo_peca; precos_hist = ultimas 300 alteracoes de preco, mais recentes primeiro.
// POST { acao:"salvar_insumo", id?, nome, unidade, qtd_embalagem, preco }  | { acao:"excluir_insumo", id }
// POST { acao:"salvar_peca", chave, titulo?, itens:[{insumo_id, quantidade}] }  | { acao:"excluir_peca", chave }
//
// Permissao: menu "ocelot_fabricacao" (ler e editar). Fornecedor: o do usuario em ocelot_usuario_fornecedor
// (Miguel); quem nao e usuario de fornecedor (Elisangela, admin) ve o do Miguel. Nada de DRE, custo fixo ou outros
// fornecedores sai daqui.
import { adminClient, CORS, exigirUsuario, json } from "../_shared/ocelot.ts";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const MIGUEL_ID = "9e88add9-8405-46db-8bd4-e128ee9ce65a";
const ALAN_ID = "e7e5a84c-9294-4d80-a251-d3f36dc83d46";
const TIAGO_ID = "91c31303-ab54-43c0-9b36-88b7bd8d5c54";
const NOME_FORN: Record<string, string> = { [MIGUEL_ID]: "Miguel", [ALAN_ID]: "Alan", [TIAGO_ID]: "Tiago" };
const UNIDADES = ["kg", "g", "L", "ml", "un", "m", "m²", "cm"];

const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* vazio */ }
  const acao = String(body?.acao || "");

  const u = await exigirUsuario(admin, req, "ocelot_fabricacao");
  if (u instanceof Response) return u;
  const { data: uf } = await admin.from("ocelot_usuario_fornecedor").select("fornecedor_id").eq("user_id", u.id).maybeSingle();
  const forn: string = uf?.fornecedor_id || MIGUEL_ID;
  const uid = u.id;
  const quem = { atualizado_em: new Date().toISOString(), atualizado_por: uid };

  // insumos, receitas (custo da peca pelos precos atuais) e o mapa peca -> receita
  async function base() {
    const [{ data: ins }, { data: recs }, { data: vincs }] = await Promise.all([
      admin.from("ocelot_fab_insumos").select("id, nome, unidade, qtd_embalagem, preco, atualizado_em").eq("fornecedor_id", forn).order("nome"),
      admin.from("ocelot_fab_receitas").select("id, nome, obs, atualizado_em, ocelot_fab_receita_itens(insumo_id, quantidade)").eq("fornecedor_id", forn).order("nome"),
      admin.from("ocelot_fab_vinculos").select("chave, receita_id").eq("fornecedor_id", forn),
    ]);
    const insumos = (ins || []).map((i: any) => ({
      ...i, qtd_embalagem: Number(i.qtd_embalagem), preco: Number(i.preco),
      custo_unidade: Number(i.qtd_embalagem) > 0 ? r4(Number(i.preco) / Number(i.qtd_embalagem)) : null,
    }));
    const custoIns: Record<string, number | null> = {};
    for (const i of insumos) custoIns[i.id] = i.preco > 0 ? i.custo_unidade : null;
    const receitas = (recs || []).map((r: any) => {
      const itens = (r.ocelot_fab_receita_itens || []).map((x: any) => {
        const c = custoIns[x.insumo_id];
        return { insumo_id: x.insumo_id, quantidade: Number(x.quantidade), custo: c == null ? null : r4(Number(x.quantidade) * c) };
      });
      return { id: r.id, nome: r.nome, atualizado_em: r.atualizado_em, itens,
        custo_peca: r2(itens.reduce((s: number, x: any) => s + (x.custo || 0), 0)) };
    });
    const custoRec: Record<string, number> = {}, nomeRec: Record<string, string> = {};
    for (const r of receitas) { custoRec[r.id] = r.custo_peca; nomeRec[r.id] = r.nome; }
    const vinc: Record<string, string> = {};
    for (const v of vincs || []) vinc[v.chave] = v.receita_id;
    return { insumos, receitas, custoRec, nomeRec, vinc };
  }

  // pecas do cadastro (anuncios do fornecedor) + as que tem receita, com o custo da peca pelos precos atuais
  async function pecas(b: Awaited<ReturnType<typeof base>>) {
    const prod: Record<string, any> = {};
    // anuncios do fornecedor (dono gravado em ocelot_item_fornecedor; sem FK entre as tabelas, entao em 2 consultas)
    const { data: donos } = await admin.from("ocelot_item_fornecedor").select("item_id").eq("conta_id", OCELOT_CONTA).eq("fornecedor_id", forn).range(0, 4999);
    const meusItens = (donos || []).map((x: any) => x.item_id);
    const cad: any[] = [];
    for (let i = 0; i < meusItens.length; i += 200) {
      const { data } = await admin.from("ocelot_itens_sku").select("item_id, sku, titulo").eq("conta_id", OCELOT_CONTA)
        .is("excluido_em", null).in("item_id", meusItens.slice(i, i + 200));
      cad.push(...(data || []));
    }
    for (const c of cad) {
      const chave = c.sku || c.item_id;
      const p = prod[chave] ||= { chave, sem_sku: !c.sku, titulo: c.titulo, anuncios: 0 };
      p.anuncios++;
      // titulo mais curto entre os anuncios do SKU (as cores costumam so acrescentar palavras)
      if (c.titulo && (!p.titulo || c.titulo.length < p.titulo.length)) p.titulo = c.titulo;
    }
    const semTitulo = Object.keys(b.vinc).filter((k) => !prod[k]);
    if (semTitulo.length) {
      // peca com receita que saiu do cadastro: usa o nome gravado na receita
      for (const k of semTitulo) prod[k] = { chave: k, sem_sku: /^MLB\d+$/.test(k), titulo: b.nomeRec[b.vinc[k]] || null, anuncios: 0 };
    }
    return Object.values(prod).map((p: any) => {
      const rid = b.vinc[p.chave] || null;
      return { ...p, receita_id: rid, custo_peca: rid ? b.custoRec[rid] ?? null : null };
    }).sort((a: any, z: any) => String(a.chave).localeCompare(String(z.chave), "pt-BR", { numeric: true }));
  }

  async function precosHist() {
    const { data } = await admin.from("ocelot_fab_precos_hist")
      .select("id, insumo_id, insumo_nome, unidade, qtd_embalagem, preco, custo_unidade, preco_anterior, qtd_embalagem_anterior, unidade_anterior, custo_unidade_anterior, alterado_em, alterado_por")
      .eq("fornecedor_id", forn).order("alterado_em", { ascending: false }).limit(300);
    const ids = [...new Set((data || []).map((h: any) => h.alterado_por).filter(Boolean))];
    const nomes: Record<string, string> = {};
    if (ids.length) {
      const { data: us } = await admin.from("app_usuarios").select("user_id, nome, email").in("user_id", ids);
      for (const x of us || []) nomes[x.user_id] = x.nome || String(x.email || "").split("@")[0];
    }
    return (data || []).map((h: any) => {
      const n = (v: any) => (v == null ? null : Number(v));
      return { ...h, qtd_embalagem: n(h.qtd_embalagem), preco: n(h.preco), custo_unidade: n(h.custo_unidade), preco_anterior: n(h.preco_anterior),
        qtd_embalagem_anterior: n(h.qtd_embalagem_anterior), custo_unidade_anterior: n(h.custo_unidade_anterior),
        alterado_por_nome: h.alterado_por ? nomes[h.alterado_por] || null : null };
    });
  }

  try {
    // ---------------------------------------------------------------- dados
    if (acao === "dados") {
      const b = await base();
      const [produtos, precos_hist] = await Promise.all([pecas(b), precosHist()]);
      return json({ ok: true, fornecedor: { id: forn, nome: NOME_FORN[forn] || "" }, unidades: UNIDADES,
        insumos: b.insumos, receitas: b.receitas, produtos, precos_hist });
    }

    // --------------------------------------------------------------- insumos
    if (acao === "salvar_insumo") {
      const nome = String(body?.nome || "").trim().slice(0, 80);
      const unidade = String(body?.unidade || "").trim();
      const qtd = num(body?.qtd_embalagem), preco = num(body?.preco);
      if (!nome) return json({ ok: false, erro: "informe o nome do insumo" }, 400);
      if (!UNIDADES.includes(unidade)) return json({ ok: false, erro: "unidade invalida" }, 400);
      if (qtd == null || qtd <= 0) return json({ ok: false, erro: "quantidade da embalagem deve ser maior que zero" }, 400);
      if (preco == null || preco < 0) return json({ ok: false, erro: "preco invalido" }, 400);
      const linha = { nome, unidade, qtd_embalagem: qtd, preco, ...quem };
      let antes: any = null;
      if (body?.id) {
        const a = await admin.from("ocelot_fab_insumos").select("unidade, qtd_embalagem, preco").eq("id", String(body.id)).eq("fornecedor_id", forn).maybeSingle();
        antes = a.data;
      }
      const r = body?.id
        ? await admin.from("ocelot_fab_insumos").update(linha).eq("id", String(body.id)).eq("fornecedor_id", forn).select("id").maybeSingle()
        : await admin.from("ocelot_fab_insumos").insert({ ...linha, fornecedor_id: forn }).select("id").maybeSingle();
      if (r.error) return json({ ok: false, erro: r.error.message }, 500);
      if (!r.data) return json({ ok: false, erro: "insumo nao encontrado" }, 404);
      // historico: so quando muda o que mexe no custo (preco, embalagem ou unidade); renomear nao grava
      const mudou = !antes || Number(antes.preco) !== preco || Number(antes.qtd_embalagem) !== qtd || antes.unidade !== unidade;
      if (mudou) {
        const h = await admin.from("ocelot_fab_precos_hist").insert({
          fornecedor_id: forn, insumo_id: r.data.id, insumo_nome: nome, unidade, qtd_embalagem: qtd, preco, custo_unidade: r4(preco / qtd),
          preco_anterior: antes ? Number(antes.preco) : null, qtd_embalagem_anterior: antes ? Number(antes.qtd_embalagem) : null,
          unidade_anterior: antes ? antes.unidade : null,
          custo_unidade_anterior: antes && Number(antes.qtd_embalagem) > 0 ? r4(Number(antes.preco) / Number(antes.qtd_embalagem)) : null,
          alterado_por: uid,
        });
        if (h.error) return json({ ok: false, erro: "salvou o insumo, mas nao gravou o historico: " + h.error.message }, 500);
      }
      return json({ ok: true, id: r.data.id });
    }
    if (acao === "excluir_insumo") {
      const r = await admin.from("ocelot_fab_insumos").delete().eq("id", String(body?.id || "")).eq("fornecedor_id", forn);
      if (r.error) return json({ ok: false, erro: r.error.message }, 500);
      return json({ ok: true });
    }

    // ---------------------------------------------------------- receita da peca
    if (acao === "salvar_peca") {
      const chave = String(body?.chave || "").trim().slice(0, 60);
      if (!chave) return json({ ok: false, erro: "escolha a peca" }, 400);
      const { data: meus } = await admin.from("ocelot_fab_insumos").select("id").eq("fornecedor_id", forn);
      const ok = new Set((meus || []).map((x: any) => x.id));
      const itens: { insumo_id: string; quantidade: number }[] = [];
      for (const x of Array.isArray(body?.itens) ? body.itens : []) {
        const q = num(x?.quantidade);
        if (!ok.has(String(x?.insumo_id)) || q == null || q < 0) return json({ ok: false, erro: "quantidade invalida na receita" }, 400);
        if (q > 0) itens.push({ insumo_id: String(x.insumo_id), quantidade: q });
      }
      const nome = (String(body?.titulo || "").trim() || chave).slice(0, 80);
      // receita so desta peca: reaproveita se ninguem mais usa (receitas de "modelo" da v1 sao separadas por peca)
      const { data: v } = await admin.from("ocelot_fab_vinculos").select("receita_id").eq("fornecedor_id", forn).eq("chave", chave).maybeSingle();
      let id: string | null = null;
      if (v?.receita_id) {
        const { count } = await admin.from("ocelot_fab_vinculos").select("chave", { count: "exact", head: true }).eq("receita_id", v.receita_id);
        if ((count || 0) <= 1) id = v.receita_id;
      }
      if (id) {
        const r = await admin.from("ocelot_fab_receitas").update({ nome, ...quem }).eq("id", id).eq("fornecedor_id", forn);
        if (r.error) return json({ ok: false, erro: r.error.message }, 500);
      } else {
        const r = await admin.from("ocelot_fab_receitas").insert({ nome, fornecedor_id: forn, ...quem }).select("id").single();
        if (r.error) return json({ ok: false, erro: r.error.message }, 500);
        id = r.data.id;
        const l = await admin.from("ocelot_fab_vinculos").upsert({ fornecedor_id: forn, chave, receita_id: id, ...quem });
        if (l.error) return json({ ok: false, erro: l.error.message }, 500);
      }
      const d = await admin.from("ocelot_fab_receita_itens").delete().eq("receita_id", id);
      if (d.error) return json({ ok: false, erro: d.error.message }, 500);
      if (itens.length) {
        const i = await admin.from("ocelot_fab_receita_itens").insert(itens.map((x) => ({ ...x, receita_id: id })));
        if (i.error) return json({ ok: false, erro: i.error.message }, 500);
      }
      return json({ ok: true, receita_id: id });
    }
    if (acao === "excluir_peca") {
      const chave = String(body?.chave || "").trim();
      const { data: v } = await admin.from("ocelot_fab_vinculos").select("receita_id").eq("fornecedor_id", forn).eq("chave", chave).maybeSingle();
      if (!v) return json({ ok: true });
      const d = await admin.from("ocelot_fab_vinculos").delete().eq("fornecedor_id", forn).eq("chave", chave);
      if (d.error) return json({ ok: false, erro: d.error.message }, 500);
      const { count } = await admin.from("ocelot_fab_vinculos").select("chave", { count: "exact", head: true }).eq("receita_id", v.receita_id);
      if (!count) await admin.from("ocelot_fab_receitas").delete().eq("id", v.receita_id).eq("fornecedor_id", forn);
      return json({ ok: true });
    }

    return json({ ok: false, erro: "acao invalida (use dados|salvar_insumo|excluir_insumo|salvar_peca|excluir_peca)" }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
