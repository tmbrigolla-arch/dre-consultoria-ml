-- Ads lancado depois do fechamento entra no mes seguinte (07/10/2026, regra do Tiago: fecha no dia 2).
-- No dia 2 o Mercado Livre ainda pode nao ter lancado todo o gasto de Ads dos ultimos dias do mes.
-- ml-ocelot-set fechar_mes passa a gravar o gasto de Ads e as vendas do ML que usou (ads_valor_fechamento,
-- vendas_ml_fechamento). No fechamento do mes seguinte ele recoleta o mes anterior (ja completo) e a
-- diferenca (ads_ajuste_anterior, em R$) soma no Ads do mes novo:
--   ads_pct = (gasto de Ads do mes + ajuste do mes anterior) / vendas do ML no mes x 100.
-- O % do mes anterior continua travado (repasse dele pode ja ter sido pago).
alter table public.ocelot_parametros
  add column if not exists ads_valor_fechamento numeric,
  add column if not exists vendas_ml_fechamento numeric,
  add column if not exists ads_ajuste_anterior numeric,
  add column if not exists ads_ajuste_mes date;

comment on column public.ocelot_parametros.ads_valor_fechamento is 'Gasto de Ads (R$) do mes lido no fechamento';
comment on column public.ocelot_parametros.vendas_ml_fechamento is 'Vendas do ML (R$, base do TACoS) do mes lidas no fechamento';
comment on column public.ocelot_parametros.ads_ajuste_anterior is 'Ads (R$) do mes anterior lancado pelo ML depois do fechamento dele, somado no Ads deste mes';
comment on column public.ocelot_parametros.ads_ajuste_mes is 'Mes de onde veio ads_ajuste_anterior';

-- meses ja fechados: registra o gasto do snapshot mensal atual (ja completo), para o proximo
-- fechamento ter a base de comparacao
update public.ocelot_parametros p
   set ads_valor_fechamento = s.ad_spend,
       vendas_ml_fechamento = s.vendas
  from public.snapshots s
 where p.conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797'
   and p.fechado and p.ads_valor_fechamento is null
   and s.conta_id = p.conta_id and s.granularidade = 'mensal' and s.periodo_inicio = p.mes_competencia
   and s.ad_spend is not null;
