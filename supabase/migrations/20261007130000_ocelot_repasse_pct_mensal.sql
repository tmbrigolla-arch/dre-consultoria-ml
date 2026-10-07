-- Repasse aos fornecedores da Ocelot a partir de outubro/2026 (07/10/2026), regra do Tiago:
--   % do repasse = imposto + gestao (5,5%, a parte da Ocelot) + Ads (TACoS do mes) + custo fixo (salario / receita do mes),
--   todos do proprio mes (ocelot_pct_mes: travados quando o mes e fechado). Antes era 17,5% fixo.
--   Piso de R$40 por unidade em cuba do Miguel e em balanco do Alan, sem teto.
--   Setembro continua 17,5% (ja pago). Mesma regra de ml-ocelot-dados v25.

update public.ocelot_parametros set repasse_pct = null, atualizado_em = now()
 where conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797' and mes_competencia >= '2026-10-01' and repasse_pct = 17.5;

create or replace function public.ocelot_repasse_pct(p_conta uuid, p_mes date)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select o.repasse_pct from ocelot_parametros o where o.conta_id = p_conta and o.mes_competencia = p_mes),
    case when p_mes >= date '2026-10-01'
           then (select p.imposto_pct + p.gestao_pct + p.ads_pct + p.fixo_pct from ocelot_pct_mes(p_conta, p_mes) p)
         when p_mes >= date '2026-09-01' then 17.5 end)
$$;

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
         coalesce(x.status = 'cancelled' and x.pagamento_status_detail = 'bpp_covered', false) as cobriu,
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
                                                 or (mes >= date '2026-10-01' and resp = 'alan' and tl like '%balan%')
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

