-- Custo de producao v3 (17/11/2026, pedido do Tiago): a tela e do fabricante e nao cruza mais com vendas.
-- O historico passa a ser das ALTERACOES DE PRECO dos insumos: uma linha cada vez que o preco pago, a embalagem
-- ou a unidade de um insumo muda (e quando o insumo e cadastrado). Guarda nome/unidade da epoca, entao continua
-- legivel mesmo se o insumo for excluido. Sem policy: so a function (service_role) le/grava.
-- (ocelot_fab_historico, o historico mensal por vendas da v2, fica parado com os dados que tem; nada mais grava nele.)

create table if not exists public.ocelot_fab_precos_hist (
  id                     uuid primary key default gen_random_uuid(),
  fornecedor_id          uuid not null,
  insumo_id              uuid,
  insumo_nome            text not null,
  unidade                text not null,
  qtd_embalagem          numeric not null,
  preco                  numeric not null,
  custo_unidade          numeric,
  preco_anterior         numeric,
  qtd_embalagem_anterior numeric,
  unidade_anterior       text,
  custo_unidade_anterior numeric,
  alterado_em            timestamptz not null default now(),
  alterado_por           uuid
);
create index if not exists ocelot_fab_precos_hist_forn_idx on public.ocelot_fab_precos_hist (fornecedor_id, alterado_em desc);
alter table public.ocelot_fab_precos_hist enable row level security;
revoke all on public.ocelot_fab_precos_hist from anon, authenticated;

-- ponto de partida: o preco atual de cada insumo ja cadastrado
insert into public.ocelot_fab_precos_hist (fornecedor_id, insumo_id, insumo_nome, unidade, qtd_embalagem, preco, custo_unidade, alterado_em, alterado_por)
select i.fornecedor_id, i.id, i.nome, i.unidade, i.qtd_embalagem, i.preco,
       case when i.qtd_embalagem > 0 then round(i.preco / i.qtd_embalagem, 4) end, i.atualizado_em, i.atualizado_por
from public.ocelot_fab_insumos i
where not exists (select 1 from public.ocelot_fab_precos_hist h where h.insumo_id = i.id);
