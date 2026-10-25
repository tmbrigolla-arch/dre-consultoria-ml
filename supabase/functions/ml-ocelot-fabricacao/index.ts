// ml-ocelot-fabricacao v1 (25/10/2026) - calculadora de custo de producao do fornecedor (tela "Custo de producao"
// da Gestao Ocelot). Feita para o Miguel (cubas de concreto); usada por ele e pela Elisangela.
//
// POST { acao:"dados", mes? }                       -> { ok, fornecedor, insumos[], receitas[], produtos[], mes }
//   insumos com custo por unidade (preco / embalagem); receitas (modelos) com itens e custo por peca;
//   produtos = SKUs do fornecedor vendidos nos ultimos 3 meses ou ja ligados a um modelo, com as unidades e o
//   repasse do mes pedido (ocelot_vendas_calc, so as vendas cujo CMV e do fornecedor; cancelada sem cobertura do ML
//   nao conta) e o custo do mes = unidades x custo da peca do modelo ligado.
// POST { acao:"salvar_insumo", id?, nome, unidade, qtd_embalagem, preco }  | { acao:"excluir_insumo", id }
// POST { acao:"salvar_receita", id?, nome, obs?, itens:[{insumo_id, quantidade}] } | { acao:"excluir_receita", id }
// POST { acao:"vincular", chave, receita_id|null }  (chave = SKU, ou o MLB quando a venda nao tem SKU)
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
  const quem = { atualizado_em: new Date().toISOString(), atualizado_por: u.id };

  try {
    // ---------------------------------------------------------------- dados
    if (acao === "dados") {
      const mes = /^\d{4}-\d{2}-01$/.test(String(body?.mes || "")) ? String(body.mes) : mesCorrente();
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
        const semPreco = itens.filter((x: any) => x.custo == null && x.quantidade > 0).length;
        return { id: r.id, nome: r.nome, obs: r.obs, atualizado_em: r.atualizado_em, itens,
          custo_peca: r2(itens.reduce((s: number, x: any) => s + (x.custo || 0), 0)), insumos_sem_preco: semPreco };
      });
      const custoRec: Record<string, number> = {};
      for (const r of receitas) custoRec[r.id] = r.custo_peca;
      const vinc: Record<string, string> = {};
      for (const v of vincs || []) vinc[v.chave] = v.receita_id;

      // vendas: 3 meses ate o fim do mes pedido (catalogo de SKUs) e o mes pedido (unidades e repasse)
      const { data: vendas, error } = await admin.rpc("ocelot_vendas_calc", { p_conta: OCELOT_CONTA, p_de: somaMeses(mes, -2), p_ate: fimDoMes(mes) });
      if (error) return json({ ok: false, erro: "vendas: " + error.message }, 500);
      const prod: Record<string, any> = {};
      for (const v of vendas || []) {
        if (v.responsavel_cmv !== cod) continue;
        const chave = v.sku || v.item_id;
        const p = prod[chave] ||= { chave, sem_sku: !v.sku, titulo: v.titulo, unidades: 0, repasse: 0 };
        if (!p.titulo && v.titulo) p.titulo = v.titulo;
        if (String(v.data_venda) < mes) continue;
        // cancelada so conta quando o ML cobriu (o cliente ficou com a peca); devolvida volta para o fornecedor
        if (v.status === "cancelled" && !v.ml_cobriu) continue;
        p.unidades += Number(v.quantidade) || 0;
        p.repasse += Number(v.cmv) || 0;
      }
      for (const chave of Object.keys(vinc)) prod[chave] ||= { chave, sem_sku: /^MLB\d+$/.test(chave), titulo: null, unidades: 0, repasse: 0 };
      const produtos = Object.values(prod).map((p: any) => {
        const rid = vinc[p.chave] || null, cp = rid ? custoRec[rid] ?? null : null;
        return { ...p, repasse: r2(p.repasse), receita_id: rid, custo_peca: cp,
          custo_mes: cp != null ? r2(cp * p.unidades) : null };
      }).sort((a: any, b: any) => b.unidades - a.unidades || String(a.chave).localeCompare(String(b.chave)));

      return json({ ok: true, fornecedor: { id: forn, nome: NOME_FORN[forn] || "" }, mes, unidades: UNIDADES, insumos, receitas, produtos });
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

    // -------------------------------------------------------------- receitas
    if (acao === "salvar_receita") {
      const nome = String(body?.nome || "").trim().slice(0, 80);
      if (!nome) return json({ ok: false, erro: "informe o nome do modelo" }, 400);
      const { data: meus } = await admin.from("ocelot_fab_insumos").select("id").eq("fornecedor_id", forn);
      const ok = new Set((meus || []).map((x: any) => x.id));
      const itens: { insumo_id: string; quantidade: number }[] = [];
      for (const x of Array.isArray(body?.itens) ? body.itens : []) {
        const q = num(x?.quantidade);
        if (!ok.has(String(x?.insumo_id)) || q == null || q < 0) return json({ ok: false, erro: "item da receita invalido" }, 400);
        if (q > 0) itens.push({ insumo_id: String(x.insumo_id), quantidade: q });
      }
      const linha = { nome, obs: String(body?.obs || "").trim().slice(0, 300) || null, ...quem };
      const r = body?.id
        ? await admin.from("ocelot_fab_receitas").update(linha).eq("id", String(body.id)).eq("fornecedor_id", forn).select("id").maybeSingle()
        : await admin.from("ocelot_fab_receitas").insert({ ...linha, fornecedor_id: forn }).select("id").maybeSingle();
      if (r.error) return json({ ok: false, erro: r.error.message }, 500);
      if (!r.data) return json({ ok: false, erro: "modelo nao encontrado" }, 404);
      const id = r.data.id;
      const d = await admin.from("ocelot_fab_receita_itens").delete().eq("receita_id", id);
      if (d.error) return json({ ok: false, erro: d.error.message }, 500);
      if (itens.length) {
        const i = await admin.from("ocelot_fab_receita_itens").insert(itens.map((x) => ({ ...x, receita_id: id })));
        if (i.error) return json({ ok: false, erro: i.error.message }, 500);
      }
      return json({ ok: true, id });
    }
    if (acao === "excluir_receita") {
      const r = await admin.from("ocelot_fab_receitas").delete().eq("id", String(body?.id || "")).eq("fornecedor_id", forn);
      if (r.error) return json({ ok: false, erro: r.error.message }, 500);
      return json({ ok: true });
    }

    // --------------------------------------------------------------- vinculo
    if (acao === "vincular") {
      const chave = String(body?.chave || "").trim().slice(0, 60);
      if (!chave) return json({ ok: false, erro: "informe o SKU" }, 400);
      if (!body?.receita_id) {
        const r = await admin.from("ocelot_fab_vinculos").delete().eq("fornecedor_id", forn).eq("chave", chave);
        if (r.error) return json({ ok: false, erro: r.error.message }, 500);
        return json({ ok: true });
      }
      const { data: rec } = await admin.from("ocelot_fab_receitas").select("id").eq("id", String(body.receita_id)).eq("fornecedor_id", forn).maybeSingle();
      if (!rec) return json({ ok: false, erro: "modelo nao encontrado" }, 404);
      const r = await admin.from("ocelot_fab_vinculos").upsert({ fornecedor_id: forn, chave, receita_id: rec.id, ...quem });
      if (r.error) return json({ ok: false, erro: r.error.message }, 500);
      return json({ ok: true });
    }

    return json({ ok: false, erro: "acao invalida (use dados|salvar_insumo|excluir_insumo|salvar_receita|excluir_receita|vincular)" }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
