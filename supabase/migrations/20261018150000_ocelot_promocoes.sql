-- Promocoes do ML na Gestao Ocelot (18/10/2026, pedido do Tiago): tela "Promocoes" + Edge Function
-- ml-ocelot-promocoes. Mesma ideia da tela do antoninho-comissoes, com o CMV = repasse do mes corrente.
--
-- 1. ocelot_promocoes_log: toda tentativa de participar/sair de campanha, inclusive as barradas pela trava e as
--    recusadas pelo ML, com o resultado calculado na hora e o % de repasse usado. Sem policy: so a function le/grava.
-- 2. app_pode: o menu "ocelot_promocoes" NAO libera a chave generica 'ocelot' (DRE, cadastro, anuncios, precos),
--    igual a Vendas a entregar / Etiquetas / Repasse.

create table if not exists public.ocelot_promocoes_log (
  id              bigint generated always as identity primary key,
  criado_em       timestamptz not null default now(),
  conta_id        uuid not null,
  item_id         text not null,
  promotion_id    text not null,
  promotion_type  text not null,
  acao            text not null check (acao in ('participar', 'sair')),
  preco           numeric,
  resultado       numeric,
  resultado_pct   numeric,
  cmv             numeric,
  repasse_pct     numeric,
  forcado         boolean not null default false,
  usuario_id      uuid,
  ok              boolean not null,
  erro            text
);
create index if not exists ocelot_promocoes_log_criado_idx on public.ocelot_promocoes_log (criado_em desc);
create index if not exists ocelot_promocoes_log_item_idx on public.ocelot_promocoes_log (item_id, criado_em desc);
alter table public.ocelot_promocoes_log enable row level security;   -- sem policy: so as functions (service_role)
revoke all on public.ocelot_promocoes_log from anon, authenticated;

create or replace function public.app_pode(p_uid uuid, p_chave text)
returns boolean language sql stable security definer set search_path to 'public' as $function$
  select coalesce((
    select u.admin
        or (p_chave='ocelot' and exists(select 1 from jsonb_array_elements_text(u.perms->'menus') m
                                         where m like 'ocelot\_%' and m not in ('ocelot_entregas','ocelot_etiquetas','ocelot_repasse','ocelot_promocoes')))
        or (p_chave='consultoria' and ((u.perms->'menus') ? 'semanal' or (u.perms->'menus') ? 'mensal'))
        or (p_chave not in ('__admin','ocelot') and ((u.perms->'menus') ? p_chave or (u.perms->'acoes') ? p_chave))
    from app_usuarios u where u.user_id=p_uid and u.ativo), false);
$function$;
