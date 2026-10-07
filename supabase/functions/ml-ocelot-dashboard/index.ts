// ml-ocelot-dashboard v1 (06/10/2026) - Dashboard de Vendas do Mercado Livre da Ocelot.
//
// POST { acao: "dados", de, ate, contas? }   -> agregado do periodo (dashboard_vendas_ocelot, no banco)
// POST { acao: "doze_meses", contas? }       -> receita e margem por mes (dashboard_vendas_ocelot_12m)
// POST { acao: "sincronizar", forcar? }      -> busca vendas novas no ML (ml-ocelot-vendas)
// POST { acao: "horario" }                   -> agenda de corte por conta + alteracoes sem "ciente" deste usuario
// POST { acao: "ciente", alteracao_id }      -> registra o ciente do usuario
//
// Permissao: menu "ocelot_dashboard" (ou admin). Contas: so as da Ocelot que o usuario pode ver.
// Nenhuma soma e feita no navegador: o banco devolve o JSON pronto.
import { adminClient, contasOcelot, CORS, exigirUsuario, json, OCELOT_CLIENTE } from "../_shared/ocelot.ts";

const OCELOT_CONTA_SYNC = "30fa53d4-60c0-40f6-9832-63b4cb313797"; // unica conta que ml-ocelot-vendas sincroniza hoje
const SYNC_PULA_MIN = 2;      // abrir de novo em menos de 2 min nao sincroniza (F5 seguido nao martela o ML)
const JANELA_MIN_H = 2, JANELA_MAX_H = 48;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();
  const u = await exigirUsuario(admin, req, "ocelot_dashboard");
  if (u instanceof Response) return u;

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const acao = String(body?.acao || "");

  const permitidas = await contasOcelot(admin, u.id);
  if (!permitidas.length) return json({ ok: false, erro: "nenhuma conta da Ocelot liberada para o seu usuario" }, 403);
  // Filtro de contas pedido pela tela, sempre dentro das permitidas.
  const pedidas: string[] | null = Array.isArray(body?.contas) && body.contas.length ? body.contas.map(String) : null;
  const contasSel = pedidas ? permitidas.filter((c) => pedidas.includes(c.id)) : permitidas;
  if (!contasSel.length) return json({ ok: false, erro: "conta fora do seu acesso" }, 403);
  const idsSel = contasSel.map((c) => c.id);
  const contasInfo = permitidas.map((c) => ({ id: c.id, nome: c.nome }));

  try {
    if (acao === "dados") {
      const de = String(body.de || ""), ate = String(body.ate || "");
      if (!DATA_RE.test(de) || !DATA_RE.test(ate)) return json({ ok: false, erro: "datas invalidas" }, 400);
      const { data, error } = await admin.rpc("dashboard_vendas_ocelot", {
        p_cliente: OCELOT_CLIENTE, p_de: de, p_ate: ate, p_contas: idsSel,
      });
      if (error) return json({ ok: false, erro: error.message }, 400);
      return json({ ok: true, contas: contasInfo, ...data });
    }

    if (acao === "doze_meses") {
      const { data, error } = await admin.rpc("dashboard_vendas_ocelot_12m", {
        p_cliente: OCELOT_CLIENTE, p_contas: idsSel,
      });
      if (error) return json({ ok: false, erro: error.message }, 400);
      return json({ ok: true, ...data });
    }

    if (acao === "sincronizar") {
      const forcar = body.forcar === true;
      const { data: cfg } = await admin.from("app_config").select("v").eq("k", "collector_secret").single();
      const resultados = await Promise.all(permitidas.map(async (c) => {
        if (c.id !== OCELOT_CONTA_SYNC) return { conta_id: c.id, nome: c.nome, ok: false, erro: "sincronizacao desta conta ainda nao configurada" };
        const { data: ult } = await admin.from("ml_sync_vendas_log").select("criado_em")
          .eq("conta_id", c.id).eq("ok", true).order("criado_em", { ascending: false }).limit(1).maybeSingle();
        const ultimoOk = ult?.criado_em ? new Date(ult.criado_em).getTime() : null;
        if (!forcar && ultimoOk && Date.now() - ultimoOk < SYNC_PULA_MIN * 60_000) {
          return { conta_id: c.id, nome: c.nome, ok: true, pulada: true };
        }
        // Janela: desde o ultimo sucesso da conta, no minimo 2 h e no maximo 48 h.
        const desdeH = ultimoOk ? (Date.now() - ultimoOk) / 3_600_000 : JANELA_MAX_H;
        const horas = Math.min(JANELA_MAX_H, Math.max(JANELA_MIN_H, Math.ceil(desdeH) + 1));
        const to = new Date().toISOString();
        const from = new Date(Date.now() - horas * 3_600_000).toISOString();
        const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ml-ocelot-vendas?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&folga=0&por=atualizacao&origem=painel&usuario=${u.id}`;
        try {
          const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-collector-secret": cfg?.v || "" }, body: "{}" });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) {
            return { conta_id: c.id, nome: c.nome, ok: false, erro: j.erro || (j.falhas || []).join("; ") || `falha ${r.status}` };
          }
          return { conta_id: c.id, nome: c.nome, ok: true, horas, pedidos: j.pedidos_encontrados, aviso: j.aviso || null };
        } catch (e) {
          return { conta_id: c.id, nome: c.nome, ok: false, erro: (e as Error).message };
        }
      }));
      return json({ ok: resultados.every((r) => r.ok), resultados });
    }

    if (acao === "horario") {
      const ids = permitidas.map((c) => c.id);
      const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [{ data: agendas }, { data: alts }, { data: cientes }] = await Promise.all([
        admin.from("ml_horario_corte").select("conta_id, logistic_type, agenda, consultado_em, alterado_em, erro").in("conta_id", ids),
        admin.from("ml_horario_corte_alteracao").select("id, conta_id, detectado_em, dia, data, resumo")
          .in("conta_id", ids).gte("detectado_em", desde).order("detectado_em", { ascending: false }).limit(200),
        admin.from("ml_horario_corte_ciente").select("alteracao_id").eq("usuario_id", u.id),
      ]);
      const vistos = new Set((cientes || []).map((x: any) => x.alteracao_id));
      return json({
        ok: true, contas: contasInfo,
        agendas: agendas || [],
        alertas: (alts || []).filter((a: any) => !vistos.has(a.id)),
      });
    }

    if (acao === "ciente") {
      const id = Number(body.alteracao_id);
      if (!Number.isInteger(id) || id <= 0) return json({ ok: false, erro: "alteracao_id invalido" }, 400);
      const { data: alt } = await admin.from("ml_horario_corte_alteracao").select("id, conta_id").eq("id", id).maybeSingle();
      if (!alt || !permitidas.some((c) => c.id === alt.conta_id)) return json({ ok: false, erro: "alteracao nao encontrada" }, 404);
      const { error } = await admin.from("ml_horario_corte_ciente").upsert({ alteracao_id: id, usuario_id: u.id }, { onConflict: "alteracao_id,usuario_id" });
      if (error) return json({ ok: false, erro: error.message }, 400);
      return json({ ok: true });
    }

    return json({ ok: false, erro: "acao desconhecida" }, 400);
  } catch (e) {
    return json({ ok: false, erro: (e as Error).message }, 500);
  }
});

