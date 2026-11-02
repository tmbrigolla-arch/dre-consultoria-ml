-- 02/11/2026 (regra do Tiago): o % retido no repasse tem de cobrir TODOS os custos da conta, para sobrar
-- exatamente a gestao (5,5%). No fechamento do mes:
--   ads_pct            = Ads da FATURA do ML do mes / faturamento liquido do mes x 100
--   fixo_pct_calculado = (custo fixo + Minha Pagina + tarifas extras da fatura) / faturamento liquido x 100
-- Faturamento liquido = mesma base da DRE e da retencao por venda (venda - devolucao das vendas validas).
-- Antes: Ads dividido pelas vendas BRUTAS do ML (com canceladas) e custo fixo sem Minha Pagina/tarifas extras.
create or replace function public.ocelot_base_fechamento(p_conta uuid, p_mes date)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with fat as (
    select coalesce(sum(receita-devolvido) filter (where categoria='venda'),0) liq
      from ocelot_vendas_calc(p_conta, p_mes, (p_mes + interval '1 month' - interval '1 day')::date)
  ), d as (select dre_ocelot(p_conta, p_mes) j)
  select jsonb_build_object(
    'fat_liquido', round(fat.liq,2),
    'ads_fatura', round(coalesce((d.j->'custos'->>'ads_real')::numeric,0),2),
    'tarifas_conta', round(coalesce((d.j->'custos'->>'tarifas_nao_repassadas')::numeric,0),2),
    'tem_fatura', exists(select 1 from ml_faturamento_detalhe x where x.conta_id=p_conta and x.mes_competencia=p_mes))
  from fat, d
$$;
revoke all on function public.ocelot_base_fechamento(uuid,date) from public, anon;
grant execute on function public.ocelot_base_fechamento(uuid,date) to authenticated, service_role;
