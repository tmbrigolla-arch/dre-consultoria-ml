-- Perguntas e Mensagens + Horario de corte do Mercado Envios (06/10/2026).
--
-- Padrao do projeto: RLS ligado e nenhuma policy para anon/authenticated. Tudo passa pelas
-- Edge Functions (ml-ocelot-atendimento, ml-ocelot-horario-corte, ml-ocelot-dashboard), que
-- validam o JWT, a permissao (app_pode) e as contas do usuario (app_contas) e gravam com service_role.

-- ---------------------------------------------------------------------------------------------
-- Segredos de servidor (ex.: senha do cron). Ninguem alem de service_role/postgres le.
-- O valor e gerado aqui dentro do banco: nao fica no codigo nem no repositorio.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.app_segredos (
  k          text primary key,
  v          text not null,
  criado_em  timestamptz not null default now()
);
alter table public.app_segredos enable row level security;
revoke all on public.app_segredos from public, anon, authenticated;

insert into public.app_segredos (k, v)
values ('cron_horario_corte', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (k) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Log do atendimento: toda resposta, toda tentativa recusada pelo ML e todo "marcar como lida".
-- ---------------------------------------------------------------------------------------------
create table if not exists public.ml_atendimento_log (
  id             bigint generated always as identity primary key,
  criado_em      timestamptz not null default now(),
  conta_id       uuid not null references public.contas_ml(id),
  tipo           text not null check (tipo in ('pergunta', 'mensagem', 'marcar_lida')),
  referencia     text not null,          -- question_id ou pack_id
  texto          text,
  usuario_id     uuid not null,
  usuario_email  text,
  ok             boolean not null,
  erro           text
);
create index if not exists ml_atendimento_log_criado_idx on public.ml_atendimento_log (criado_em desc);
alter table public.ml_atendimento_log enable row level security;
revoke all on public.ml_atendimento_log from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Horario de corte (xd_drop_off): agenda atual por conta, alteracoes detectadas e o "ciente" por usuario.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.ml_horario_corte (
  conta_id       uuid primary key references public.contas_ml(id),
  logistic_type  text not null default 'xd_drop_off',
  agenda         jsonb,            -- { monday: {trabalha, data, cortes:[{corte, coleta, facility}]}, ... }
  consultado_em  timestamptz,
  alterado_em    timestamptz,
  erro           text
);

create table if not exists public.ml_horario_corte_alteracao (
  id            bigint generated always as identity primary key,
  conta_id      uuid not null references public.contas_ml(id),
  detectado_em  timestamptz not null default now(),
  dia           text not null,     -- monday..sunday
  data          date,              -- data real do dia afetado (proxima ocorrencia)
  antes         jsonb,
  depois        jsonb,
  resumo        text not null
);
create index if not exists ml_horario_corte_alteracao_det_idx on public.ml_horario_corte_alteracao (detectado_em desc);

create table if not exists public.ml_horario_corte_ciente (
  alteracao_id  bigint not null references public.ml_horario_corte_alteracao(id) on delete cascade,
  usuario_id    uuid not null,
  ciente_em     timestamptz not null default now(),
  primary key (alteracao_id, usuario_id)
);

alter table public.ml_horario_corte enable row level security;
alter table public.ml_horario_corte_alteracao enable row level security;
alter table public.ml_horario_corte_ciente enable row level security;
revoke all on public.ml_horario_corte, public.ml_horario_corte_alteracao, public.ml_horario_corte_ciente
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Cron: todo dia as 07:00 de Brasilia (10:00 UTC; o Brasil nao tem horario de verao).
-- Autentica com x-cron-secret lido de app_segredos na hora (nao usa a anon key como senha).
-- ---------------------------------------------------------------------------------------------
select cron.unschedule('ocelot-horario-corte-diario')
 where exists (select 1 from cron.job where jobname = 'ocelot-horario-corte-diario');

select cron.schedule('ocelot-horario-corte-diario', '0 10 * * *', $cron$
  select net.http_post(
    url := 'https://qrvdqqdigzabltqgxggm.supabase.co/functions/v1/ml-ocelot-horario-corte',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select v from public.app_segredos where k = 'cron_horario_corte')),
    timeout_milliseconds := 60000
  )
$cron$);
