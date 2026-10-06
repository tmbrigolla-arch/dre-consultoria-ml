-- Dashboard de Vendas do Mercado Livre - Ocelot (06/10/2026).
--
-- Replica o dashboard do antoninho-comissoes com as regras DESTE projeto:
--   * data da venda = data_venda (data de APROVACAO no fuso de Brasilia, como a DRE e o relatorio do ML);
--   * margem = "resultado" por item, a mesma de ml-ocelot-dados/calcItem:
--       liquido - CMV (repasse ao fornecedor) - imposto - Ads - custo fixo;
--   * indicadores principais so com vendas validas; cancelada e devolucao com custo ficam a parte;
--   * pedidos = order_id distintos;
--   * agregacao aqui no banco (o PostgREST corta select em 1.000 linhas).
--
-- Multiempresa: o filtro por empresa e feito AQUI, por parametro (p_cliente -> contas_ml.cliente_id).
-- As tabelas seguem o padrao do projeto: RLS ligado e nenhuma policy para anon/authenticated
-- (o navegador nao le nada direto). Quem chama estas funcoes e a Edge Function ml-ocelot-dashboard,
-- depois de validar o login (JWT), a permissao (app_pode) e as contas do usuario (app_contas).
-- Por isso o execute fica so com service_role: dar a authenticated nao serviria para nada
-- (security invoker + RLS sem policy = zero linhas) e so abriria superficie.

-- ---------------------------------------------------------------------------------------------
-- 1) Calculo por item: porte fiel de calcItem (supabase/functions/ml-ocelot-dados, v24).
--    Reaproveita ocelot_pct_mes (imposto, gestao, Ads/TACoS, % do fixo) e ocelot_repasse_pct.
--    Diferenca consciente: frete e rateio de pacote olham o pacote inteiro (nao so o periodo
--    pedido), para "Hoje" e "Mes" darem o mesmo numero para a mesma venda.
-- ---------------------------------------------------------------------------------------------
create or replace function public.ocelot_vendas_calc(p_conta uuid, p_de date, p_ate date)
returns table (
  conta_id uuid, order_id bigint, pack_id bigint, item_id text, sku text, titulo text,
  data_venda date, data_venda_ts timestamptz, status text, categoria text, quantidade integer,
  receita numeric, taxa_ml numeric, frete numeric, devolvido numeric, liquido numeric,
  cmv numeric, cmv_origem text, imposto numeric, ads numeric, custo_fixo numeric, resultado numeric,
  responsavel_cmv text, ml_cobriu boolean
)
language sql
stable
security invoker
set search_path = public
as $$
with
v0 as (
  select x.*,
         (x.status = 'cancelled' and x.pagamento_status_detail = 'bpp_covered') as cobriu,
         coalesce(x.pack_id, x.order_id) as k
    from ocelot_vendas_itens x
   where x.conta_id = p_conta
     and x.data_venda >= p_de and x.data_venda <= p_ate
),
-- todas as linhas dos pacotes/pedidos tocados (mesmo fora do periodo)
grp as (
  select y.order_id, y.valor_venda, y.frete_vendedor,
         coalesce(y.pack_id, y.order_id) as k,
         case when y.status = 'cancelled' and y.pagamento_status_detail = 'bpp_covered'
              then 'paid' else y.status end as st
    from ocelot_vendas_itens y
   where y.conta_id = p_conta
     and coalesce(y.pack_id, y.order_id) in (select k from v0)
),
pk as (
  select k,
         count(distinct order_id) as n_orders,
         bool_or(st <> 'cancelled') as ativo,
         sum(valor_venda) filter (where st <> 'cancelled') as venda_ativos,
         count(*) filter (where st <> 'cancelled') as n_ativos,
         sum(valor_venda) as venda_todos,
         count(*) as n_todos
    from grp group by k
),
-- frete total do pacote = frete do envio (cada pedido do pacote guarda o envio inteiro rateado nos seus itens)
pkf as (
  select k, max(f) as frete_total
    from (select k, order_id, sum(coalesce(frete_vendedor, 0)) as f from grp group by k, order_id) z
   group by k
),
ped as (
  select order_id, sum(valor_venda) as venda
    from ocelot_vendas_itens
   where conta_id = p_conta and order_id in (select order_id from v0)
   group by order_id
),
-- o que o ML cobrou e nao estornou num pedido cancelado (fatura: tarifa de venda + frete)
canc as (
  select d.order_id,
         coalesce(sum(d.valor) filter (where m.categoria = 'taxa_ml'), 0) as tx,
         coalesce(sum(d.valor) filter (where m.categoria = 'frete'), 0) as fr
    from ml_faturamento_detalhe d
    join ml_mapa_categoria m on m.codigo = d.detail_sub_type
   where d.conta_id = p_conta
     and m.categoria in ('taxa_ml', 'frete')
     and d.order_id in (select order_id from v0 where status = 'cancelled' and not cobriu)
   group by d.order_id
),
meses as (select distinct date_trunc('month', data_venda)::date as mes from v0),
par as (
  select m.mes, p.imposto_pct, p.gestao_pct, p.ads_pct, p.fixo_pct,
         ocelot_repasse_pct(p_conta, m.mes) as repasse_pct
    from meses m cross join lateral ocelot_pct_mes(p_conta, m.mes) p
),
b as (
  select v.*,
         case when v.cobriu then 'paid' else v.status end as st,
         case when v.cobriu then 0 else coalesce(v.valor_devolvido, 0) end as dev,
         date_trunc('month', v.data_venda)::date as mes,
         pk.n_orders, pk.ativo as pack_ativo,
         case when pk.ativo then pk.venda_ativos else pk.venda_todos end as base_venda,
         case when pk.ativo then pk.n_ativos else pk.n_todos end as base_n,
         pkf.frete_total
    from v0 v
    join pk on pk.k = v.k
    join pkf on pkf.k = v.k
),
b2 as (
  select b.*,
         -- rateio do frete do pacote (v21): so entre os itens ativos, se houver
         (b.n_orders > 1 and not (b.pack_ativo and b.st = 'cancelled')) as rerateia
    from b
),
b3 as (
  select b2.*,
         case when b2.rerateia then
                b2.frete_total * case when b2.base_venda > 0 then b2.valor_venda / b2.base_venda
                                      else 1.0 / b2.base_n end
              else coalesce(b2.frete_vendedor, 0) end as frete_aj
    from b2
),
b4 as (
  select b3.*,
         case when b3.rerateia or b3.cobriu
                then b3.valor_venda - coalesce(b3.taxa_ml, 0) - b3.frete_aj - b3.dev
              else b3.valor_liquido end as liq,
         nullif(s.sku, '') as sku_item,
         coalesce(cs.custo_unitario, cm.custo_unitario) as custo_manual,
         coalesce(nullif(b3.responsavel_cmv, ''),
           case
             when t.tn like '%pochete%' or t.tn like '%copo termico%' then 'ocelot'
             when t.tn like '%cuba%' or t.tn like '%porta copo%' or t.tn like '%porta-copo%' or t.tn like '%portacopo%'
               or t.tn like '%porta joia%' or t.tn like '%porta-joia%' or t.tn like '%portajoia%'
               or t.tn like '%saboneteira%' or t.tn like '%ralo%' or t.tn like '%valvula%'
               or (t.tn like '%peso%' and t.tn like '%porta%') then 'miguel'
             when t.tn like '%balan%' or t.tn like '%prateleira%' or t.tn like '%banco%' or t.tn like '%bau%' then 'alan'
           end) as resp,
         f.fornecedor_id,
         lower(coalesce(b3.titulo, '')) as tl,
         p.imposto_pct, p.gestao_pct, p.ads_pct, p.fixo_pct, p.repasse_pct,
         c.order_id is not null as tem_canc, c.tx as canc_tx, c.fr as canc_fr,
         ped.venda as venda_pedido
    from b3
    cross join lateral (select translate(lower(coalesce(b3.titulo, '')),
                          'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') as tn) t
    left join ocelot_itens_sku s on s.conta_id = p_conta and s.item_id = b3.item_id
    left join ocelot_custos_sku cs on cs.conta_id = p_conta and cs.sku = nullif(s.sku, '')
                                  and cs.mes_competencia = b3.mes
    left join ocelot_custos_sku cm on cm.conta_id = p_conta and cm.sku is null and cm.item_id = b3.item_id
                                  and cm.mes_competencia = b3.mes
    left join ocelot_item_fornecedor f on f.conta_id = p_conta and f.item_id = b3.item_id
    join par p on p.mes = b3.mes
    left join canc c on c.order_id = b3.order_id
    left join ped on ped.order_id = b3.order_id
),
-- vendas validas (inclui mediacao coberta pelo ML)
venda as (
  select b4.*,
         greatest(0, b4.valor_venda - b4.dev) as efetivo
    from b4 where b4.st <> 'cancelled'
),
venda2 as (
  select venda.*,
         venda.efetivo * venda.imposto_pct / 100.0 as imp_v,
         venda.efetivo * venda.ads_pct / 100.0 as ads_v,
         venda.efetivo * venda.fixo_pct / 100.0 as fixo_v
    from venda
),
venda3 as (
  select venda2.*,
         case
           when custo_manual is not null then null
           when efetivo <= 0 then null
           when repasse_pct is not null then liq - efetivo * repasse_pct / 100.0
           else liq - (imp_v + ads_v + fixo_v + efetivo * gestao_pct / 100.0)
         end as cmv_bruto
    from venda2
),
venda4 as (
  select venda3.*,
         case when quantidade > 0 then cmv_bruto / quantidade else cmv_bruto end as unit_bruto,
         -- piso/teto: regra nova (repasse) = piso R$40 so em cuba do Miguel, sem teto;
         --            regra antiga = piso R$40 / teto R$90 em cuba do Miguel e balanco do Alan (por fornecedor)
         case when repasse_pct is not null then (resp = 'miguel' and tl like '%cuba%')
              else ((fornecedor_id = '9e88add9-8405-46db-8bd4-e128ee9ce65a' and tl like '%cuba%')
                 or (fornecedor_id = 'e7e5a84c-9294-4d80-a251-d3f36dc83d46' and tl like '%balan%')) end as elegivel
    from venda3
),
venda5 as (
  select venda4.*,
         case
           when custo_manual is not null then custo_manual * quantidade
           when efetivo <= 0 then 0
           else (case when elegivel and unit_bruto < 40 then 40
                      when elegivel and repasse_pct is null and unit_bruto > 90 then 90
                      else unit_bruto end) * (case when quantidade > 0 then quantidade else 1 end)
         end as cmv0,
         case
           when custo_manual is not null then 'manual'
           when efetivo <= 0 then 'formula_devolvido'
           when elegivel and unit_bruto < 40 then 'formula_piso'
           when elegivel and repasse_pct is null and unit_bruto > 90 then 'formula_teto'
           else 'formula'
         end as origem0
    from venda4
),
venda6 as (
  select venda5.*,
         case when st = 'partially_refunded' and resp in ('miguel', 'alan') and cmv0 > 0 then 0 else cmv0 end as cmv_f,
         case when st = 'partially_refunded' and resp in ('miguel', 'alan') and cmv0 > 0 then 'estorno_fornecedor' else origem0 end as origem_f
    from venda5
),
cancelado as (
  select b4.*,
         case when tem_canc then round(canc_tx * share, 2) else 0 end as tx,
         case when tem_canc and not pack_ativo then round(canc_fr * share, 2) else 0 end as fr
    from b4
    cross join lateral (select case when coalesce(b4.venda_pedido, 0) > 0
                                    then b4.valor_venda / b4.venda_pedido else 1 end as share) sh
   where b4.st = 'cancelled'
)
select conta_id, order_id, pack_id, item_id, sku_item, titulo, data_venda, data_venda_ts, st, 'venda',
       quantidade, valor_venda, coalesce(taxa_ml, 0), frete_aj, dev, liq,
       cmv_f, origem_f, imp_v, ads_v, fixo_v, liq - cmv_f - imp_v - ads_v - fixo_v,
       resp, cobriu
  from venda6
union all
select conta_id, order_id, pack_id, item_id, sku_item, titulo, data_venda, data_venda_ts, st,
       case when abs(round(tx + fr, 2)) >= 0.01 then 'devolucao' else 'cancelada' end,
       quantidade, valor_venda,
       case when abs(round(tx + fr, 2)) >= 0.01 then tx else 0 end,
       case when abs(round(tx + fr, 2)) >= 0.01 then fr else 0 end,
       case when abs(round(tx + fr, 2)) >= 0.01 then valor_venda else 0 end,
       case when abs(round(tx + fr, 2)) >= 0.01 then -round(tx + fr, 2) else 0 end,
       case when abs(round(tx + fr, 2)) >= 0.01 then -round(tx + fr, 2) else 0 end,
       case when abs(round(tx + fr, 2)) >= 0.01 then 'devolucao' else 'cancelado' end,
       0, 0, 0, 0,
       resp, false
  from cancelado
$$;

comment on function public.ocelot_vendas_calc(uuid, date, date) is
  'Resultado por item de venda da Ocelot (porte de ml-ocelot-dados/calcItem v24). categoria: venda | cancelada | devolucao. Datas inclusivas.';

-- ---------------------------------------------------------------------------------------------
-- 2) Log das sincronizacoes de vendas (painel e cron). Tabela propria para nao interferir em
--    coletas_log, que alimenta vw_saude_coleta e o watchdog.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.ml_sync_vendas_log (
  id          bigint generated always as identity primary key,
  conta_id    uuid not null references public.contas_ml(id),
  origem      text not null check (origem in ('painel', 'cron', 'manual')),
  usuario_id  uuid,
  janela_de   timestamptz,
  janela_ate  timestamptz,
  ok          boolean not null,
  pedidos     integer,
  linhas      integer,
  erro        text,
  criado_em   timestamptz not null default now()
);
create index if not exists ml_sync_vendas_log_conta_idx on public.ml_sync_vendas_log (conta_id, criado_em desc);
alter table public.ml_sync_vendas_log enable row level security;
revoke all on public.ml_sync_vendas_log from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3) Agregacao do dashboard (periodo). Devolve JSON pronto para a tela.
-- ---------------------------------------------------------------------------------------------
create or replace function public.dashboard_vendas_ocelot(
  p_cliente uuid, p_de date, p_ate date, p_contas uuid[] default null
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_res jsonb;
begin
  if p_cliente is null then raise exception 'cliente obrigatorio'; end if;
  if p_de is null or p_ate is null or p_ate < p_de then
    raise exception 'Intervalo de datas invalido: % a %', p_de, p_ate;
  end if;
  if p_ate - p_de > 400 then raise exception 'Intervalo maximo: 400 dias'; end if;

  with contas as materialized (
    select c.id, c.apelido
      from contas_ml c
     where c.cliente_id = p_cliente
       and (p_contas is null or c.id = any(p_contas))
  ),
  base as materialized (
    select r.* from contas c cross join lateral ocelot_vendas_calc(c.id, p_de, p_ate) r
  ),
  venda as (select * from base where categoria = 'venda'),
  tot as (
    select jsonb_build_object(
      'pedidos',    count(distinct order_id),
      'unidades',   coalesce(sum(quantidade), 0),
      'receita',    round(coalesce(sum(receita), 0), 2),
      'taxa_ml',    round(coalesce(sum(taxa_ml), 0), 2),
      'frete',      round(coalesce(sum(frete), 0), 2),
      'devolvido',  round(coalesce(sum(devolvido), 0), 2),
      'cmv',        round(coalesce(sum(cmv), 0), 2),
      'imposto',    round(coalesce(sum(imposto), 0), 2),
      'ads',        round(coalesce(sum(ads), 0), 2),
      'custo_fixo', round(coalesce(sum(custo_fixo), 0), 2),
      'margem',     round(coalesce(sum(resultado), 0), 2),
      'itens',      count(*),
      'itens_sem_cmv', count(*) filter (where cmv is null),
      'itens_cmv_formula', count(*) filter (where cmv_origem like 'formula%')
    ) as j from venda
  ),
  conta as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'conta_id', c.id, 'nome', c.apelido,
      'pedidos', coalesce(a.pedidos, 0), 'unidades', coalesce(a.unidades, 0),
      'receita', coalesce(a.receita, 0), 'margem', coalesce(a.margem, 0),
      'taxa_ml', coalesce(a.taxa_ml, 0), 'frete', coalesce(a.frete, 0), 'cmv', coalesce(a.cmv, 0),
      'imposto', coalesce(a.imposto, 0), 'ads_fixo', coalesce(a.ads_fixo, 0),
      'itens_sem_cmv', coalesce(a.itens_sem_cmv, 0)
    ) order by c.apelido), '[]'::jsonb) as j
    from contas c
    left join (
      select conta_id, count(distinct order_id) pedidos, sum(quantidade) unidades,
             round(sum(receita), 2) receita, round(sum(resultado), 2) margem,
             round(sum(taxa_ml), 2) taxa_ml, round(sum(frete), 2) frete, round(sum(cmv), 2) cmv,
             round(sum(imposto), 2) imposto, round(sum(ads + custo_fixo), 2) ads_fixo,
             count(*) filter (where cmv is null) itens_sem_cmv
        from venda group by conta_id
    ) a on a.conta_id = c.id
  ),
  dia as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'data', d.data_venda, 'pedidos', d.pedidos, 'unidades', d.unidades,
      'receita', d.receita, 'margem', d.margem
    ) order by d.data_venda), '[]'::jsonb) as j
    from (
      select data_venda, count(distinct order_id) pedidos, sum(quantidade) unidades,
             round(sum(receita), 2) receita, round(sum(resultado), 2) margem
        from venda group by data_venda
    ) d
  ),
  fora as (
    select jsonb_build_object(
      'canceladas', jsonb_build_object(
        'pedidos', count(distinct order_id) filter (where categoria = 'cancelada'),
        'valor',   round(coalesce(sum(receita) filter (where categoria = 'cancelada'), 0), 2)),
      'devolucoes', jsonb_build_object(
        'pedidos', count(distinct order_id) filter (where categoria = 'devolucao'),
        'valor',   round(coalesce(sum(receita) filter (where categoria = 'devolucao'), 0), 2),
        'custo',   round(coalesce(-sum(liquido) filter (where categoria = 'devolucao'), 0), 2)),
      'devolucoes_parciais', jsonb_build_object(
        'pedidos', count(distinct order_id) filter (where categoria = 'venda' and devolvido > 0),
        'valor',   round(coalesce(sum(devolvido) filter (where categoria = 'venda'), 0), 2))
    ) as j from base
  ),
  sku as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'sku', s.sku, 'titulo', coalesce(ap.apelido, s.titulo), 'unidades', s.unidades,
      'receita', s.receita, 'margem', s.margem,
      'margem_pct', case when s.receita > 0 then round(100 * s.margem / s.receita, 1) end,
      'itens_sem_cmv', s.itens_sem_cmv
    ) order by s.receita desc), '[]'::jsonb) as j
    from (
      select coalesce(sku, '(sem SKU) ' || item_id) as sku,
             (array_agg(titulo order by receita desc))[1] as titulo,
             sum(quantidade) as unidades,
             round(sum(receita), 2) as receita,
             round(sum(resultado), 2) as margem,
             count(*) filter (where cmv is null) as itens_sem_cmv
        from venda
       group by coalesce(sku, '(sem SKU) ' || item_id)
       order by sum(receita) desc
       limit 20
    ) s
    left join ocelot_produtos_sku ap
           on ap.sku = s.sku and ap.conta_id in (select id from contas) and nullif(ap.apelido, '') is not null
  )
  select jsonb_build_object(
    'periodo',   jsonb_build_object('de', p_de, 'ate', p_ate, 'dias', p_ate - p_de + 1),
    'totais',    (select j from tot),
    'por_conta', (select j from conta),
    'por_dia',   case when p_ate > p_de then (select j from dia) end,
    'fora',      (select j from fora),
    'top_sku',   (select j from sku),
    'ultima_sincronizacao', (
      select greatest(
        (select max(l.criado_em) from ml_sync_vendas_log l where l.ok and l.conta_id in (select id from contas)),
        (select max(x.captured_at) from ocelot_vendas_itens x where x.conta_id in (select id from contas))))
  ) into v_res;

  return v_res;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4) Ultimos 12 meses (mes em curso incluso), por mes de aprovacao.
-- ---------------------------------------------------------------------------------------------
create or replace function public.dashboard_vendas_ocelot_12m(p_cliente uuid, p_contas uuid[] default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ini  date := (date_trunc('month', v_hoje) - interval '11 months')::date;
  v_res  jsonb;
begin
  if p_cliente is null then raise exception 'cliente obrigatorio'; end if;

  with contas as materialized (
    select c.id from contas_ml c
     where c.cliente_id = p_cliente and (p_contas is null or c.id = any(p_contas))
  ),
  venda as materialized (
    select r.* from contas c cross join lateral ocelot_vendas_calc(c.id, v_ini, v_hoje) r
     where r.categoria = 'venda'
  ),
  meses as (
    select generate_series(v_ini, date_trunc('month', v_hoje)::date, interval '1 month')::date as mes
  ),
  agg as (
    select date_trunc('month', data_venda)::date as mes,
           count(distinct order_id) pedidos, sum(quantidade) unidades,
           round(sum(receita), 2) receita, round(sum(resultado), 2) margem
      from venda group by 1
  )
  select jsonb_build_object(
    'meses', coalesce(jsonb_agg(jsonb_build_object(
        'mes', m.mes,
        'pedidos', coalesce(a.pedidos, 0), 'unidades', coalesce(a.unidades, 0),
        'receita', coalesce(a.receita, 0), 'margem', coalesce(a.margem, 0),
        'em_curso', m.mes = date_trunc('month', v_hoje)::date
      ) order by m.mes), '[]'::jsonb),
    'primeira_venda', (select min(x.data_venda) from ocelot_vendas_itens x where x.conta_id in (select id from contas))
  ) into v_res
  from meses m left join agg a on a.mes = m.mes;

  return v_res;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5) Permissoes das funcoes: so a Edge Function (service_role) executa.
-- ---------------------------------------------------------------------------------------------
revoke all on function public.ocelot_vendas_calc(uuid, date, date) from public, anon, authenticated;
revoke all on function public.dashboard_vendas_ocelot(uuid, date, date, uuid[]) from public, anon, authenticated;
revoke all on function public.dashboard_vendas_ocelot_12m(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.ocelot_vendas_calc(uuid, date, date) to service_role;
grant execute on function public.dashboard_vendas_ocelot(uuid, date, date, uuid[]) to service_role;
grant execute on function public.dashboard_vendas_ocelot_12m(uuid, uuid[]) to service_role;
