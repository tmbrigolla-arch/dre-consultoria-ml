// ml-ocelot-fabricacao v2 (25/10/2026) - calculadora de custo de producao do fornecedor (tela "Custo de producao"
// da Gestao Ocelot). Feita para o Miguel (cubas de concreto); usada por ele e pela Elisangela.
// v2: a receita e da PECA do cadastro (SKU, ou o MLB do anuncio sem SKU), sem o passo de "modelo" da v1; e o
// resultado do mes fica em ocelot_fab_historico.
//
// POST { acao:"dados", mes? }  -> { ok, fornecedor, mes, mes_aberto, congelado, gravado_em, insumos[], receitas[],
//                                   produtos[], historico[] }
//   insumos com custo por unidade (preco / embalagem); receitas com itens e custo da peca;
//   produtos = pecas do fornecedor no cadastro (ocelot_itens_sku + ocelot_item_fornecedor) e as vendidas nos ultimos
//   3 meses, com receita_id, unidades e repasse do mes (ocelot_vendas_calc, so vendas cujo CMV e do fornecedor;
//   cancelada so conta se o ML cobriu) e custo do mes = unidades x custo da peca.
//   Historico: mes corrente e regravado a cada chamada; mes passado ja gravado volta congelado (custo da epoca);
//   mes passado sem gravacao volta calculado com os precos atuais (congelado=false) ate alguem gravar.
// POST { acao:"salvar_insumo", id?, nome, unidade, qtd_embalagem, preco }  | { acao:"excluir_insumo", id }
// POST { acao:"salvar_peca", chave, titulo?, itens:[{insumo_id, quantidade}] }  | { acao:"excluir_peca", chave }
// POST { acao:"gravar_historico", mes }   (regrava o mes com os precos atuais)
//
// Permissao: menu "ocelot_fabricacao" (ler e editar). Fornecedor: o do usuario em ocelot_usuario_fornecedor
// (Miguel); quem nao e usuario de fornecedor (Elisangela, admin) ve o do Miguel. Nada de DRE, custo fixo ou outros
// fornecedores sai daqui.
import { adminClient, CORS, exigirUsuario, json } from "../_shared/ocelot.ts";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const MIGUEL_ID = "9e88add9-8405-46db-8bd4-e128ee9ce65a";
const ALAN_ID = "e7e5a84c-9294-4d80-a251-d3f36dc83d46";
const TIAGO_ID = "91c31303-ab54-43c0-9b36-88b7bd8d5c54";
// responsavel_cmv de ocelot_vendas_calc por fornecedor (mesmo mapa de ml-ocelot-dados)
const COD_FORN: Record<string, string> = { [MIGUEL_ID]: "miguel", [ALAN_ID]: "alan", [TIAGO_ID]: "ocelot" };
const NOME_FORN: Record<string, string> = { [MIGUEL_ID]: "Miguel", [ALAN_ID]: "Alan", [TIAGO_ID]: "Tiago" };
const UNIDADES = ["kg", "g", "L", "ml", "un", "m", "m²", "cm"];

const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function mesCorrente() {
  // competencia pelo horario de Brasilia (UTC-3)
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7) + "-01";
}
function somaMeses(mes: string, n: number) {
  const d = new Date(mes + "T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return d.toISOString().slice(0, 10);
}
function fimDoMes(mes: string) {
  const d = new Date(somaMeses(mes, 1) + "T12:00:00Z");
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

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
  const cod = COD_FORN[forn];
  if (!cod) return json({ ok: false, erro: "fornecedor sem codigo de repasse" }, 400);
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
    const custoRec: Record<string, number> = {};
    for (const r of receitas) custoRec[r.id] = r.custo_peca;
    const vinc: Record<string, string> = {};
    for (const v of vincs || []) vinc[v.chave] = v.receita_id;
    return { insumos, receitas, custoRec, vinc };
  }

  // pecas do cadastro + vendidas nos 3 meses ate o mes, com unidades/repasse/custo do mes pelos precos atuais
  async function calcularMes(mes: string, b: Awaited<ReturnType<typeof base>>) {
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
      const p = prod[chave] ||= { chave, sem_sku: !c.sku, titulo: c.titulo, anuncios: 0, unidades: 0, repasse: 0 };
      p.anuncios++;
      // titulo mais curto entre os anuncios do SKU (as cores costumam so acrescentar palavras)
      if (c.titulo && (!p.titulo || c.titulo.length < p.titulo.length)) p.titulo = c.titulo;
    }
    const { data: vendas, error } = await admin.rpc("ocelot_vendas_calc", { p_conta: OCELOT_CONTA, p_de: somaMeses(mes, -2), p_ate: fimDoMes(mes) });
    if (error) throw new Error("vendas: " + error.message);
    for (const v of vendas || []) {
      if (v.responsavel_cmv !== cod) continue;
      const chave = v.sku || v.item_id;
      const p = prod[chave] ||= { chave, sem_sku: !v.sku, titulo: v.titulo, anuncios: 0, unidades: 0, repasse: 0 };
      if (!p.titulo && v.titulo) p.titulo = v.titulo;
      if (String(v.data_venda) < mes) continue;
      if (v.status === "cancelled" && !v.ml_cobriu) continue;
      p.unidades += Number(v.quantidade) || 0;
      p.repasse += Number(v.cmv) || 0;
    }
    for (const chave of Object.keys(b.vinc)) prod[chave] ||= { chave, sem_sku: /^MLB\d+$/.test(chave), titulo: null, anuncios: 0, unidades: 0, repasse: 0 };
    return Object.values(prod).map((p: any) => {
      const rid = b.vinc[p.chave] || null, cp = rid ? b.custoRec[rid] ?? null : null;
      return { ...p, repasse: r2(p.repasse), receita_id: rid, custo_peca: cp, custo_mes: cp != null ? r2(cp * p.unidades) : null };
    }).sort((a: any, z: any) => z.unidades - a.unidades || String(a.chave).localeCompare(String(z.chave)));
  }

  // grava o mes no historico (substitui o que havia): so pecas com venda no mes ou com receita
  async function gravar(mes: string, produtos: any[]) {
    const linhas = produtos.filter((p) => p.unidades > 0 || p.receita_id).map((p) => ({
      fornecedor_id: forn, mes, chave: p.chave, titulo: p.titulo, unidades: p.unidades, custo_peca: p.custo_peca,
      custo_mes: p.custo_mes, repasse: p.repasse, gravado_em: new Date().toISOString(), gravado_por: uid,
    }));
    const d = await admin.from("ocelot_fab_historico").delete().eq("fornecedor_id", forn).eq("mes", mes);
    if (d.error) throw new Error(d.error.message);
    if (linhas.length) {
      const i = await admin.from("ocelot_fab_historico").insert(linhas);
      if (i.error) throw new Error(i.error.message);
    }
  }

  async function historico() {
    const { data } = await admin.from("ocelot_fab_historico").select("mes, unidades, custo_mes, repasse, gravado_em").eq("fornecedor_id", forn).range(0, 9999);
    const m: Record<string, any> = {};
    for (const h of data || []) {
      const x = m[h.mes] ||= { mes: h.mes, unidades: 0, custo: 0, repasse: 0, repasse_com_custo: 0, unidades_sem_custo: 0, gravado_em: h.gravado_em };
      x.unidades += h.unidades; x.repasse += Number(h.repasse) || 0;
      if (h.custo_mes != null) { x.custo += Number(h.custo_mes); x.repasse_com_custo += Number(h.repasse) || 0; } else x.unidades_sem_custo += h.unidades;
      if (h.gravado_em > x.gravado_em) x.gravado_em = h.gravado_em;
    }
    return Object.values(m).map((x: any) => ({ ...x, custo: r2(x.custo), repasse: r2(x.repasse), sobra: r2(x.repasse_com_custo - x.custo) }))
      .sort((a: any, z: any) => String(z.mes).localeCompare(String(a.mes)));
  }

  try {
    // ---------------------------------------------------------------- dados
    if (acao === "dados" || acao === "gravar_historico") {
      const mes = /^\d{4}-\d{2}-01$/.test(String(body?.mes || "")) ? String(body.mes) : mesCorrente();
      const aberto = mes >= mesCorrente();
      const b = await base();
      let produtos = await calcularMes(mes, b);
      let congelado = false, gravado_em: string | null = null;
      if (aberto || acao === "gravar_historico") {
        await gravar(mes, produtos);
        gravado_em = new Date().toISOString();
      } else {
        // mes passado: o gravado vale (custo da epoca); a lista de pecas continua a do cadastro
        const { data: h } = await admin.from("ocelot_fab_historico").select("chave, titulo, unidades, custo_peca, custo_mes, repasse, gravado_em")
          .eq("fornecedor_id", forn).eq("mes", mes).range(0, 9999);
        if (h && h.length) {
          congelado = true;
          const porChave: Record<string, any> = {};
          for (const x of h) { porChave[x.chave] = x; if (!gravado_em || x.gravado_em > gravado_em) gravado_em = x.gravado_em; }
          produtos = produtos.map((p: any) => {
            const x = porChave[p.chave];
            return x ? { ...p, unidades: x.unidades, repasse: Number(x.repasse), custo_peca: x.custo_peca == null ? null : Number(x.custo_peca),
              custo_mes: x.custo_mes == null ? null : Number(x.custo_mes) } : { ...p, unidades: 0, repasse: 0, custo_mes: null };
          });
        }
      }
      return json({ ok: true, fornecedor: { id: forn, nome: NOME_FORN[forn] || "" }, mes, mes_aberto: aberto, congelado, gravado_em,
        unidades: UNIDADES, insumos: b.insumos, receitas: b.receitas, produtos, historico: await historico() });
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
      const r = body?.id
        ? await admin.from("ocelot_fab_insumos").update(linha).eq("id", String(body.id)).eq("fornecedor_id", forn).select("id").maybeSingle()
        : await admin.from("ocelot_fab_insumos").insert({ ...linha, fornecedor_id: forn }).select("id").maybeSingle();
      if (r.error) return json({ ok: false, erro: r.error.message }, 500);
      if (!r.data) return json({ ok: false, erro: "insumo nao encontrado" }, 404);
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

    return json({ ok: false, erro: "acao invalida (use dados|gravar_historico|salvar_insumo|excluir_insumo|salvar_peca|excluir_peca)" }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
