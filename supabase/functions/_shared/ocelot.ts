// Funcoes compartilhadas das telas Ocelot do Mercado Livre (dashboard, atendimento, horario de corte).
//
// Seguranca (padrao do projeto + licoes do antoninho-comissoes):
//   * o navegador nunca le tabela direto (RLS sem policy): tudo passa por aqui com service_role,
//     depois de validar o JWT do usuario, a permissao da tela (app_pode) e as contas dele (app_contas);
//   * empresa: so contas_ml do cliente Ocelot, nunca de outro cliente;
//   * token do ML so no servidor: nunca vai para resposta, log ou navegador;
//   * cron autentica com segredo proprio (app_segredos), comparado em tempo constante.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const OCELOT_CLIENTE = "640477d2-2724-41cb-ae5f-0287961992bd";
export const ML_API = "https://api.mercadolibre.com";
const ML_CLIENT_ID = "6065152162276049";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export type Conta = { id: string; nome: string; ml_user_id: number | null; status: string };
export type Usuario = { id: string; email: string | null };

// Contas ML da Ocelot que o usuario pode ver. uid null = chamada do cron (todas as contas da Ocelot).
export async function contasOcelot(admin: SupabaseClient, uid: string | null): Promise<Conta[]> {
  const { data } = await admin.from("contas_ml").select("id, apelido, ml_user_id, status")
    .eq("cliente_id", OCELOT_CLIENTE).order("apelido");
  let contas: Conta[] = (data || []).map((c: any) => ({ id: c.id, nome: c.apelido || c.id, ml_user_id: c.ml_user_id, status: c.status }));
  if (uid) {
    const { data: perm } = await admin.rpc("app_contas", { p_uid: uid });
    if (perm !== null) { // null = admin ou "todas as contas"
      const ok = new Set((perm || []) as string[]);
      contas = contas.filter((c) => ok.has(c.id));
    }
  }
  return contas;
}

// Valida o JWT e a permissao da tela. Devolve o usuario ou a Response de erro pronta.
export async function exigirUsuario(admin: SupabaseClient, req: Request, chave: string): Promise<Usuario | Response> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, erro: "nao autenticado" }, 401);
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ ok: false, erro: "nao autenticado" }, 401);
  const { data: pode } = await admin.rpc("app_pode", { p_uid: user.id, p_chave: chave });
  if (pode !== true) return json({ ok: false, erro: "sem permissao" }, 403);
  return { id: user.id, email: user.email ?? null };
}

// Comparacao de tempo constante (via SHA-256 dos dois lados, entao o tamanho tambem nao vaza).
export async function iguaisTempoConstante(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0 && a.length > 0 && b.length > 0;
}

export async function segredoConfere(admin: SupabaseClient, chave: string, recebido: string | null): Promise<boolean> {
  if (!recebido) return false;
  const { data } = await admin.from("app_segredos").select("v").eq("k", chave).maybeSingle();
  if (!data?.v) return false;
  return await iguaisTempoConstante(recebido, data.v);
}

// Token de acesso do ML da conta (renova se faltar menos de 10 min). So uso no servidor.
const cacheToken: Record<string, string> = {};
export async function tokenML(admin: SupabaseClient, contaId: string): Promise<string> {
  if (cacheToken[contaId]) return cacheToken[contaId];
  const { data: cr } = await admin.from("credenciais_ml").select("access_token, refresh_token, expires_at")
    .eq("conta_id", contaId).maybeSingle();
  if (!cr) throw new Error("conta sem credencial do ML");
  if (new Date(cr.expires_at).getTime() - Date.now() > 600_000) return (cacheToken[contaId] = cr.access_token);
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: ML_CLIENT_ID,
      client_secret: Deno.env.get("ML_CLIENT_SECRET")!, refresh_token: cr.refresh_token,
    }),
  });
  const t = await r.json().catch(() => null);
  if (!r.ok || !t?.access_token) throw new Error(`renovacao do token falhou (ML ${r.status})`);
  await admin.from("credenciais_ml").update({
    access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
  }).eq("conta_id", contaId);
  return (cacheToken[contaId] = t.access_token);
}

export async function ml(admin: SupabaseClient, contaId: string, caminho: string, init: RequestInit = {}) {
  const t = await tokenML(admin, contaId);
  const r = await fetch(`${ML_API}${caminho}`, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const txt = await r.text();
  let j: any = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { j = { raw: txt.slice(0, 300) }; }
  return { status: r.status, ok: r.ok, json: j };
}

// Mensagem de erro do ML sem eco de cabecalho/token.
export function erroML(r: { status: number; json: any }): string {
  const m = r.json?.message || r.json?.error || "";
  return `ML ${r.status}${m ? ": " + String(m).slice(0, 200) : ""}`;
}
