-- Preco com promocao ativa (02/11/2026, pedido do Tiago). Ao mudar o preco de um anuncio em promocao, a tela
-- pergunta: alterar agora (o painel tira o anuncio da promocao e grava o preco) ou manter a promocao (o preco
-- fica AGENDADO e o cron grava quando a promocao terminar). Tudo pelo ml-ocelot-preco.
-- RLS sem policy: o navegador nao le direto, so a edge function com service_role.
create table if not exists public.ocelot_precos_agendados (
  id bigserial primary key,
  conta_id uuid not null,
  item_id text not null,
  preco numeric(12,2) not null,
  promocoes jsonb,                 -- promocoes ativas na hora do agendamento (id, tipo, fim)
  fim_previsto timestamptz,        -- maior data de fim entre elas (so informativo: o cron confere ao vivo)
  status text not null default 'pendente' check (status in ('pendente', 'aplicado', 'cancelado', 'erro')),
  usuario_id uuid,
  criado_em timestamptz not null default now(),
  verificado_em timestamptz,
  aplicado_em timestamptz,
  obs text
);
create index if not exists ocelot_precos_agendados_pend on public.ocelot_precos_agendados (conta_id, item_id) where status = 'pendente';
alter table public.ocelot_precos_agendados enable row level security;
revoke all on public.ocelot_precos_agendados from public, anon, authenticated;

-- como o preco foi gravado: direto, saindo da promocao, ou pelo agendamento
alter table public.ocelot_precos_log add column if not exists origem text;

insert into public.app_segredos (k, v)
values ('cron_precos', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (k) do nothing;

-- a cada 15 min: o ml-ocelot-preco so chama o ML se houver agendamento pendente
select cron.unschedule('ocelot-precos-agendados') where exists (select 1 from cron.job where jobname = 'ocelot-precos-agendados');
select cron.schedule('ocelot-precos-agendados', '*/15 * * * *', $c$
  select net.http_post(
    url := 'https://qrvdqqdigzabltqgxggm.supabase.co/functions/v1/ml-ocelot-preco',
    body := '{"acao":"aplicar_agendados"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      -- ml-ocelot-preco tem verify_jwt=true: o gateway exige um JWT valido; vai a chave anon (publica, legada),
      -- guardada em app_segredos.anon_jwt (inserida a parte, fora do repositorio). Quem autoriza e o x-cron-secret.
      'Authorization', 'Bearer ' || (select v from public.app_segredos where k = 'anon_jwt'),
      'x-cron-secret', (select v from public.app_segredos where k = 'cron_precos')),
    timeout_milliseconds := 60000)
  where exists (select 1 from public.ocelot_precos_agendados where status = 'pendente')
$c$);
