-- 02/11/2026: leitura e gravacao da foto do fechamento pela tela (RPC, sem mexer nas Edge Functions).
-- ocelot_fotos_fechamento: para cada venda paga num repasse registrado no periodo, o CMV pago, a foto
-- (receita/devolucao/tarifa/frete/liquido no fechamento) e o valor devolvido de hoje.
create or replace function public.ocelot_fotos_fechamento(p_de date, p_ate date)
returns table(order_id bigint, item_id text, fornecedor_id uuid, mes_competencia date, cmv_pago numeric,
              snap_venda numeric, snap_devolvido numeric, snap_taxa numeric, snap_frete numeric, snap_liquido numeric,
              devolvido_hoje numeric)
language sql stable security definer set search_path to 'public' as $$
  select p.order_id, p.item_id, p.fornecedor_id, p.mes_competencia, p.cmv_pago,
         p.snap_venda, p.snap_devolvido, p.snap_taxa, p.snap_frete, p.snap_liquido,
         coalesce(v.valor_devolvido,0)
    from ocelot_pagamento_itens p
    left join ocelot_vendas_itens v on v.conta_id=p.conta_id and v.order_id=p.order_id and v.item_id=p.item_id
   where (app_pode(auth.uid(),'ocelot') or app_pode(auth.uid(),'ocelot_repasse'))
     and p.mes_competencia >= p_de and p.mes_competencia < p_ate
$$;
revoke all on function public.ocelot_fotos_fechamento(date,date) from public, anon;
grant execute on function public.ocelot_fotos_fechamento(date,date) to authenticated;

-- ocelot_gravar_foto_fechamento: chamada logo depois de "Registrar fechamento" com a foto de cada venda.
-- p_itens = [{order_id,item_id,venda,devolvido,taxa,frete,liquido}, ...]
create or replace function public.ocelot_gravar_foto_fechamento(p_fornecedor_id uuid, p_mes date, p_itens jsonb)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  if not app_pode(auth.uid(),'editar_cadastro') then raise exception 'sem permissao'; end if;
  update ocelot_pagamento_itens p
     set snap_venda=round((x->>'venda')::numeric,2), snap_devolvido=round(coalesce((x->>'devolvido')::numeric,0),2),
         snap_taxa=round(coalesce((x->>'taxa')::numeric,0),2), snap_frete=round(coalesce((x->>'frete')::numeric,0),2),
         snap_liquido=round(coalesce((x->>'liquido')::numeric,0),2)
    from jsonb_array_elements(p_itens) x
   where p.fornecedor_id=p_fornecedor_id and p.mes_competencia=p_mes
     and p.order_id=(x->>'order_id')::bigint and p.item_id=x->>'item_id';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.ocelot_gravar_foto_fechamento(uuid,date,jsonb) from public, anon;
grant execute on function public.ocelot_gravar_foto_fechamento(uuid,date,jsonb) to authenticated;
