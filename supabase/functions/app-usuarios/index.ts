import { createClient } from "jsr:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Content-Type": "application/json" };
// v3 (09/10/2026): menu "ocelot_entregas" (A entregar).
// v2 (06/10/2026): menus "ocelot_dashboard" (Dashboard de Vendas) e "atendimento_ml" (Perguntas e Mensagens).
// Tambem "ocelot_repasse": a tela ja oferecia esse menu, mas o servidor descartava ao salvar.
// atendimento_ml nao comeca com "ocelot_" de proposito: app_pode(uid,'ocelot') libera todos os dados
// financeiros da Ocelot para qualquer menu "ocelot_*", e quem so atende cliente nao precisa disso.
const MENUS = ["semanal", "mensal", "ocelot_dre", "ocelot_vendas", "ocelot_detalhada", "ocelot_repasse", "ocelot_cadastro", "ocelot_dashboard", "atendimento_ml", "ocelot_entregas"];
const ACOES = ["atualizar", "fechar_mes", "exportar_pdf", "editar_cadastro", "alterar_ml"];
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

function limpaPerms(p: any, contasValidas: Set<string>) {
  p = p || {};
  const menus = [...new Set((p.menus || []).filter((m: string) => MENUS.includes(m)))];
  const acoes = [...new Set((p.acoes || []).filter((a: string) => ACOES.includes(a)))];
  const contas = p.contas === "*" ? "*" : [...new Set((p.contas || []).filter((c: string) => contasValidas.has(c)))];
  return { menus, acoes, contas };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: uerr } = await admin.auth.getUser(token);
  if (uerr || !user) return J({ error: "nao autorizado" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const acao = body.acao || "me";

  const { data: eu } = await admin.from("app_usuarios").select("*").eq("user_id", user.id).maybeSingle();

  if (acao === "me") {
    if (!eu || !eu.ativo) return J({ email: user.email, ativo: false, admin: false, perms: { menus: [], acoes: [], contas: [] } });
    return J({ email: eu.email, nome: eu.nome, ativo: true, admin: eu.admin, perms: eu.perms });
  }

  if (acao === "minha_senha") {
    if (!eu || !eu.ativo) return J({ error: "usuario inativo" }, 403);
    if (!body.senha || String(body.senha).length < 8) return J({ error: "A senha precisa ter ao menos 8 caracteres." }, 400);
    const { error } = await admin.auth.admin.updateUserById(user.id, { password: String(body.senha) });
    if (error) return J({ error: error.message }, 400);
    await admin.from("app_usuarios_log").insert({ por: user.id, por_email: user.email, alvo: user.id, alvo_email: user.email, acao: "trocou_propria_senha" });
    return J({ ok: true });
  }

  // daqui pra baixo: so admin
  if (!eu || !eu.ativo || !eu.admin) return J({ error: "apenas administradores" }, 403);

  const { data: contasRows } = await admin.from("contas_ml").select("id, apelido, status, cliente_id, clientes(nome)").order("apelido");
  const contas = (contasRows || []).map((c: any) => ({ id: c.id, apelido: c.apelido, status: c.status, cliente_id: c.cliente_id, cliente: c.clientes?.nome }));
  const contasValidas = new Set(contas.map((c: any) => c.id));
  const log = (alvo: any, a: string, antes: any, depois: any) =>
    admin.from("app_usuarios_log").insert({ por: user.id, por_email: user.email, alvo: alvo?.user_id ?? null, alvo_email: alvo?.email ?? null, acao: a, antes, depois });

  if (acao === "lista") {
    const [{ data: us }, { data: au }, { data: lg }] = await Promise.all([
      admin.from("app_usuarios").select("*").order("criado_em"),
      admin.auth.admin.listUsers({ perPage: 1000 }),
      admin.from("app_usuarios_log").select("em,por_email,alvo_email,acao").order("em", { ascending: false }).limit(30),
    ]);
    const ult: Record<string, string | null> = {};
    for (const a of (au?.users || [])) ult[a.id] = a.last_sign_in_at ?? null;
    return J({ usuarios: (us || []).map((u: any) => ({ ...u, ultimo_acesso: ult[u.user_id] ?? null })), contas, menus: MENUS, acoes: ACOES, log: lg || [] });
  }

  if (acao === "criar") {
    const email = String(body.email || "").trim().toLowerCase();
    const senha = String(body.senha || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J({ error: "E-mail inválido." }, 400);
    if (senha.length < 8) return J({ error: "A senha precisa ter ao menos 8 caracteres." }, 400);
    const { data: cr, error } = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
    if (error || !cr?.user) return J({ error: error?.message?.includes("already") ? "Já existe um usuário com esse e-mail." : (error?.message || "falha ao criar") }, 400);
    const row = { user_id: cr.user.id, email, nome: String(body.nome || "").trim() || null, admin: !!body.admin, ativo: true,
      perms: limpaPerms(body.perms, contasValidas), atualizado_por: user.id };
    const { error: e2 } = await admin.from("app_usuarios").insert(row);
    if (e2) { await admin.auth.admin.deleteUser(cr.user.id); return J({ error: e2.message }, 400); }
    await log(row, "criou", null, { nome: row.nome, admin: row.admin, perms: row.perms });
    return J({ ok: true, user_id: cr.user.id });
  }

  if (acao === "salvar") {
    const { data: alvo } = await admin.from("app_usuarios").select("*").eq("user_id", body.user_id).maybeSingle();
    if (!alvo) return J({ error: "usuário não encontrado" }, 404);
    const novo: any = { atualizado_em: new Date().toISOString(), atualizado_por: user.id };
    if ("nome" in body) novo.nome = String(body.nome || "").trim() || null;
    if ("admin" in body) novo.admin = !!body.admin;
    if ("ativo" in body) novo.ativo = !!body.ativo;
    if ("perms" in body) novo.perms = limpaPerms(body.perms, contasValidas);
    if (alvo.user_id === user.id && (novo.admin === false || novo.ativo === false))
      return J({ error: "Você não pode tirar o seu próprio acesso de administrador nem se desativar." }, 400);
    if (novo.admin === false || novo.ativo === false) {
      const { count } = await admin.from("app_usuarios").select("user_id", { count: "exact", head: true }).eq("admin", true).eq("ativo", true).neq("user_id", alvo.user_id);
      if (alvo.admin && !count) return J({ error: "Precisa sobrar pelo menos um administrador ativo." }, 400);
    }
    const { error } = await admin.from("app_usuarios").update(novo).eq("user_id", alvo.user_id);
    if (error) return J({ error: error.message }, 400);
    if ("ativo" in novo && novo.ativo !== alvo.ativo)
      await admin.auth.admin.updateUserById(alvo.user_id, { ban_duration: novo.ativo ? "none" : "876000h" } as any);
    await log(alvo, "alterou", { nome: alvo.nome, admin: alvo.admin, ativo: alvo.ativo, perms: alvo.perms },
      { nome: novo.nome ?? alvo.nome, admin: novo.admin ?? alvo.admin, ativo: novo.ativo ?? alvo.ativo, perms: novo.perms ?? alvo.perms });
    return J({ ok: true });
  }

  if (acao === "senha") {
    const { data: alvo } = await admin.from("app_usuarios").select("*").eq("user_id", body.user_id).maybeSingle();
    if (!alvo) return J({ error: "usuário não encontrado" }, 404);
    if (!body.senha || String(body.senha).length < 8) return J({ error: "A senha precisa ter ao menos 8 caracteres." }, 400);
    const { error } = await admin.auth.admin.updateUserById(alvo.user_id, { password: String(body.senha) });
    if (error) return J({ error: error.message }, 400);
    await log(alvo, "redefiniu_senha", null, null);
    return J({ ok: true });
  }

  return J({ error: "acao desconhecida" }, 400);
});
