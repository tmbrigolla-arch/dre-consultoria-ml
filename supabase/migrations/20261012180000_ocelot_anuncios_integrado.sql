-- Cadastro integrado com o ML (12/10/2026): situacao, estoque e preco ao vivo por anuncio (ml-ocelot-anuncios).
--
-- (1) Anuncio EXCLUIDO no Mercado Livre sai do cadastro. NAO apaga a linha de ocelot_itens_sku: o mapa
--     item_id -> SKU continua valendo para as vendas antigas daquele anuncio (CMV por SKU e unidades
--     vendidas do produto). So marca excluido_em; o ml-ocelot-anuncios devolve a lista e a tela tira do cadastro.
--     O cron ml-ocelot-skus faz upsert so de sku/sku_bruto/titulo/atualizado_em, nao mexe nesta coluna.
alter table public.ocelot_itens_sku add column if not exists excluido_em timestamptz;
alter table public.ocelot_itens_sku add column if not exists excluido_motivo text;

-- (2) Toda alteracao de situacao (ativar/pausar) e de estoque feita pelo painel no ML fica registrada.
--     (preco continua em ocelot_precos_log, pelo ml-ocelot-preco.)
-- RLS sem policy: o navegador nao le direto, so a edge function com service_role.
create table if not exists public.ocelot_anuncios_log (
  id bigserial primary key,
  conta_id uuid not null,
  item_id text not null,
  tipo text not null check (tipo in ('status', 'estoque', 'excluido')),
  variacao_id bigint,
  antes text,
  depois text,
  usuario_id uuid,
  ok boolean not null default false,
  resposta text,
  criado_em timestamptz not null default now()
);
create index if not exists ocelot_anuncios_log_item on public.ocelot_anuncios_log (conta_id, item_id, criado_em desc);
alter table public.ocelot_anuncios_log enable row level security;
revoke all on public.ocelot_anuncios_log from public, anon, authenticated;

-- (3) Senha do cron diario que detecta anuncios excluidos mesmo sem ninguem abrir a tela.
insert into public.app_segredos (k, v)
values ('cron_anuncios', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (k) do nothing;

-- 08:40 de Brasilia, depois do ocelot-skus-diario (11:25 UTC).
select cron.unschedule('ocelot-anuncios-diario') where exists (select 1 from cron.job where jobname = 'ocelot-anuncios-diario');
select cron.schedule('ocelot-anuncios-diario', '40 11 * * *', $c$
  select net.http_post(
    url := 'https://qrvdqqdigzabltqgxggm.supabase.co/functions/v1/ml-ocelot-anuncios',
    body := '{"acao":"sincronizar"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select v from public.app_segredos where k = 'cron_anuncios')),
    timeout_milliseconds := 60000)
$c$);
