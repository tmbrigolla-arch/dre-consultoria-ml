-- Calculadora de custo de producao do fornecedor (25/10/2026, pedido do Tiago): tela "Custo de producao" na
-- Gestao Ocelot + Edge Function ml-ocelot-fabricacao. Feita para o Miguel (cubas de concreto), usada por ele e
-- pela Elisangela.
--
-- 1. ocelot_fab_insumos: o que o fornecedor compra (resina, cimento, caixa...), com o preco pago pela embalagem e o
--    tamanho dela (ex.: saco de 50 kg por R$ 40 -> R$ 0,80/kg).
-- 2. ocelot_fab_receitas: modelos de peca (ex.: "Cuba oval 40x23"); ocelot_fab_receita_itens: quanto de cada
--    insumo uma peca usa, na unidade do insumo. Custo da peca = soma(quantidade x preco / embalagem).
-- 3. ocelot_fab_vinculos: SKU do anuncio (ou o MLB, quando a venda nao tem SKU) -> modelo. Varias cores do mesmo
--    modelo apontam para a mesma receita. Com as vendas do mes (ocelot_vendas_calc), da o custo mensal.
-- Tudo por fornecedor_id. Sem policy: so a function (service_role) le/grava.
-- 4. app_pode: o menu "ocelot_fabricacao" NAO libera a chave generica 'ocelot' (DRE, cadastro, anuncios, precos),
--    igual a Vendas a entregar / Etiquetas / Repasse / Promocoes.

create table if not exists public.ocelot_fab_insumos (
  id             uuid primary key default gen_random_uuid(),
  fornecedor_id  uuid not null,
  nome           text not null,
  unidade        text not null,
  qtd_embalagem  numeric not null default 1 check (qtd_embalagem > 0),
  preco          numeric not null default 0 check (preco >= 0),
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create index if not exists ocelot_fab_insumos_forn_idx on public.ocelot_fab_insumos (fornecedor_id);

create table if not exists public.ocelot_fab_receitas (
  id             uuid primary key default gen_random_uuid(),
  fornecedor_id  uuid not null,
  nome           text not null,
  obs            text,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create index if not exists ocelot_fab_receitas_forn_idx on public.ocelot_fab_receitas (fornecedor_id);

create table if not exists public.ocelot_fab_receita_itens (
  receita_id  uuid not null references public.ocelot_fab_receitas (id) on delete cascade,
  insumo_id   uuid not null references public.ocelot_fab_insumos (id) on delete cascade,
  quantidade  numeric not null check (quantidade >= 0),
  primary key (receita_id, insumo_id)
);

create table if not exists public.ocelot_fab_vinculos (
  fornecedor_id  uuid not null,
  chave          text not null,
  receita_id     uuid not null references public.ocelot_fab_receitas (id) on delete cascade,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid,
  primary key (fornecedor_id, chave)
);

alter table public.ocelot_fab_insumos enable row level security;
alter table public.ocelot_fab_receitas enable row level security;
alter table public.ocelot_fab_receita_itens enable row level security;
alter table public.ocelot_fab_vinculos enable row level security;
revoke all on public.ocelot_fab_insumos, public.ocelot_fab_receitas, public.ocelot_fab_receita_itens,
  public.ocelot_fab_vinculos from anon, authenticated;

-- insumos que o Miguel usa (preco 0 ate ele preencher; unidade e embalagem ele ajusta na tela)
insert into public.ocelot_fab_insumos (fornecedor_id, nome, unidade, qtd_embalagem, preco)
select '9e88add9-8405-46db-8bd4-e128ee9ce65a'::uuid, n, u, 1, 0
from (values ('Resina','kg'), ('Vaselina','kg'), ('Pedras','kg'), ('Areia','kg'), ('Cimento','kg'),
             ('Óleo lubrificante','L'), ('Ferro','kg'), ('Pigmento de cor','kg'), ('Caixa de embalagem','un'),
             ('Plástico bolha','m')) as t(n, u)
where not exists (select 1 from public.ocelot_fab_insumos where fornecedor_id = '9e88add9-8405-46db-8bd4-e128ee9ce65a');

create or replace function public.app_pode(p_uid uuid, p_chave text)
returns boolean language sql stable security definer set search_path to 'public' as $function$
  select coalesce((
    select u.admin
        or (p_chave='ocelot' and exists(select 1 from jsonb_array_elements_text(u.perms->'menus') m
                                         where m like 'ocelot\_%' and m not in ('ocelot_entregas','ocelot_etiquetas','ocelot_repasse','ocelot_promocoes','ocelot_fabricacao')))
        or (p_chave='consultoria' and ((u.perms->'menus') ? 'semanal' or (u.perms->'menus') ? 'mensal'))
        or (p_chave not in ('__admin','ocelot') and ((u.perms->'menus') ? p_chave or (u.perms->'acoes') ? p_chave))
    from app_usuarios u where u.user_id=p_uid and u.ativo), false);
$function$;
