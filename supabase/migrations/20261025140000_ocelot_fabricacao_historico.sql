-- Custo de producao v2 (25/10/2026, pedido do Tiago): a receita passa a ser da PECA do cadastro (SKU, ou o MLB do
-- anuncio sem SKU), sem o passo de "modelo"; e o resultado do mes fica gravado em historico.
--
-- ocelot_fab_historico: uma linha por fornecedor x mes x peca, com unidades vendidas, custo da peca, custo do mes e
-- repasse. O mes corrente e regravado a cada abertura da tela (fica com o ultimo estado quando o mes vira); mes
-- passado gravado fica congelado com o custo da epoca (o preco atual dos insumos nao muda o passado) e so muda se
-- alguem clicar em "Regravar com os precos atuais". Sem policy: so a function (service_role) le/grava.
-- (ocelot_fab_receitas continua guardando a receita; cada peca tem a sua, ligada por ocelot_fab_vinculos.)

create table if not exists public.ocelot_fab_historico (
  fornecedor_id  uuid not null,
  mes            date not null,
  chave          text not null,
  titulo         text,
  unidades       integer not null default 0,
  custo_peca     numeric,
  custo_mes      numeric,
  repasse        numeric not null default 0,
  gravado_em     timestamptz not null default now(),
  gravado_por    uuid,
  primary key (fornecedor_id, mes, chave)
);
alter table public.ocelot_fab_historico enable row level security;
revoke all on public.ocelot_fab_historico from anon, authenticated;
