-- Percentuais do mes em aberto (07/10/2026), regra do Tiago:
--   durante o mes, Ads e custo fixo usam os % do ULTIMO MES FECHADO (ficam estaveis no dia a dia);
--   ao fechar o mes (ml-ocelot-set fechar_mes) entram os valores reais: TACoS do mes (1o ao ultimo dia)
--   e custo fixo / faturamento do mes. Antes, com o mes aberto, o Ads seguia o TACoS dos ultimos 30 dias
--   e o custo fixo era R$ 800 / vendas ate o dia (25% no comeco de outubro).
--   Sem nenhum mes fechado anterior, mantem o calculo antigo. Mesma regra de ml-ocelot-dados v26.

create or replace function public.ocelot_pct_mes(p_conta uuid, p_mes date)
returns table(imposto_pct numeric, gestao_pct numeric, ads_pct numeric, custo_fixo numeric, fixo_pct numeric,
              fechado boolean, ads_origem text, tem_parametro boolean)
language plpgsql
set search_path = public
as $function$
declare
  v_imp numeric; v_ges numeric; v_ads numeric; v_fix numeric;
  v_fechado boolean; v_fixocalc numeric; v_bruta numeric; v_tacos numeric;
  v_origem text := 'parametro'; v_tem boolean := true;
  v_ant_mes date; v_ant_ads numeric; v_ant_fixo numeric;  -- ultimo mes fechado antes de p_mes
begin
  select o.imposto_pct,o.gestao_pct,o.ads_pct,o.custo_fixo_mensal,o.fechado,o.fixo_pct_calculado
    into v_imp,v_ges,v_ads,v_fix,v_fechado,v_fixocalc
  from ocelot_parametros o
  where o.conta_id=p_conta and o.mes_competencia=p_mes;
  if not found then
    v_imp:=5.5; v_ges:=5.5; v_ads:=5; v_fix:=800; v_fechado:=false; v_fixocalc:=null;
    v_origem:='default'; v_tem:=false;
  end if;

  if coalesce(v_fechado,false) and v_fixocalc is not null then
    -- mes fechado: valores reais travados no fechamento (Ads ja esta em ads_pct)
    fixo_pct := v_fixocalc;
  else
    if not coalesce(v_fechado,false) then
      select o.mes_competencia, o.ads_pct, o.fixo_pct_calculado into v_ant_mes, v_ant_ads, v_ant_fixo
        from ocelot_parametros o
       where o.conta_id=p_conta and o.mes_competencia < p_mes and o.fechado and o.fixo_pct_calculado is not null
       order by o.mes_competencia desc limit 1;
    end if;
    if v_ant_mes is not null then
      -- mes aberto: provisorio com os % do ultimo mes fechado
      v_ads := v_ant_ads;
      fixo_pct := v_ant_fixo;
      v_origem := 'provisorio_' || to_char(v_ant_mes, 'YYYY-MM');
    else
      -- sem mes fechado anterior: calculo antigo
      if not coalesce(v_fechado,false) then
        select s.tacos*100 into v_tacos from snapshots s
          where s.conta_id=p_conta and s.granularidade='mensal'
            and s.periodo_inicio=p_mes and s.tacos is not null limit 1;
        if v_tacos is not null then v_origem:='tacos_mensal';
        else
          select s.tacos*100 into v_tacos from snapshots s
            where s.conta_id=p_conta and s.tacos is not null
            order by s.periodo_fim desc limit 1;
          if v_tacos is not null then v_origem:='tacos_recente'; end if;
        end if;
        if v_tacos is not null then v_ads := v_tacos; end if;
      end if;
      select coalesce(sum(v.valor_venda),0) into v_bruta
        from ocelot_vendas_itens v
       where v.conta_id=p_conta and v.status<>'cancelled'
         and v.data_venda >= p_mes and v.data_venda < (p_mes + interval '1 month');
      fixo_pct := case when v_bruta>0 then least(50, v_fix/v_bruta*100) else 0 end;
    end if;
  end if;
  imposto_pct:=v_imp; gestao_pct:=v_ges; ads_pct:=v_ads;
  custo_fixo:=v_fix; fechado:=coalesce(v_fechado,false);
  ads_origem:=v_origem; tem_parametro:=v_tem;
  return next;
end $function$;
