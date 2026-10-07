-- Correcao dos fechamentos de mes da Ocelot (07/10/2026), decidida pelo Tiago.
--
-- 1) Outubro foi fechado por engano em 06/10 (o botao do Cadastro so enxergava o mes corrente):
--    o % do custo fixo ficou travado em 10,13% de cada venda, calculado com 6 dias de receita.
--    Reabre: o % volta a ser recalculado conforme entram vendas.
-- 2) Julho, agosto e setembro ja terminaram e estavam abertos. Fecha com a mesma regra do
--    ml-ocelot-set v6 (fechar_mes): custo fixo % = custo fixo / receita bruta das vendas nao canceladas
--    (teto 50%), Ads = TACoS do snapshot MENSAL do proprio mes. Sao os mesmos valores que ocelot_pct_mes
--    ja usava com o mes aberto, entao nenhum numero desses meses muda: so param de mudar sozinhos.

update public.ocelot_parametros
   set fechado = false, fixo_pct_calculado = null, receita_liquida_mes = null, atualizado_em = now()
 where conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797' and mes_competencia = '2026-10-01' and fechado;

with meses as (
  select unnest(array['2026-07-01','2026-08-01','2026-09-01']::date[]) as mes
),
calc as (
  select m.mes,
         coalesce(sum(v.valor_venda) filter (where v.status <> 'cancelled'), 0) as receita_bruta,
         coalesce(sum(v.valor_liquido) filter (where v.status <> 'cancelled'), 0) as receita_liquida,
         (select s.tacos * 100 from public.snapshots s
           where s.conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797' and s.granularidade = 'mensal'
             and s.periodo_inicio = m.mes and s.tacos is not null limit 1) as ads_mensal
    from meses m
    left join public.ocelot_vendas_itens v
           on v.conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797'
          and v.data_venda >= m.mes and v.data_venda < (m.mes + interval '1 month')
   group by m.mes
)
update public.ocelot_parametros p
   set fechado = true,
       receita_liquida_mes = c.receita_liquida,
       fixo_pct_calculado = case when c.receita_bruta > 0 then least(50, p.custo_fixo_mensal / c.receita_bruta * 100) else 0 end,
       ads_pct = coalesce(c.ads_mensal, p.ads_pct),
       atualizado_em = now()
  from calc c
 where p.conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797'
   and p.mes_competencia = c.mes
   and not p.fechado;
