-- Repasse a fornecedores (12/10/2026): botao "Efetivar preço" nas vendas pagas pelo piso.
-- Toda mudanca de preco feita pelo painel no ML fica registrada aqui (ml-ocelot-preco, acao efetivar).
-- RLS sem policy: o navegador nao le direto, so a edge function com service_role.
create table if not exists public.ocelot_precos_log (
  id bigserial primary key,
  conta_id uuid not null,
  item_id text not null,
  order_id bigint,
  preco_anterior numeric(12,2),
  preco_novo numeric(12,2) not null,
  em_promocao boolean,
  usuario_id uuid,
  ok boolean not null default false,
  resposta text,
  criado_em timestamptz not null default now()
);
create index if not exists ocelot_precos_log_item on public.ocelot_precos_log (conta_id, item_id, criado_em desc);
alter table public.ocelot_precos_log enable row level security;
