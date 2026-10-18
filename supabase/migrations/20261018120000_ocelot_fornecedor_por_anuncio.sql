-- Separacao por fornecedor (18/10/2026, pedido do Tiago): Miguel e Alan so veem o que e deles em Vendas a entregar
-- e Repasse a fornecedores. O dono de cada anuncio passa a ser gravado em ocelot_item_fornecedor (antes era so a
-- palavra no titulo); a palavra-chave continua como reserva para anuncio novo ainda sem dono.
--   Miguel: cuba, porta-joias, peso+porta, porta copo, saboneteira, ralo, valvula + pisante, garrafeiro, quadro Face de Jesus (concreto)
--   Alan:   balanco, banco, bau, prateleira + porta de armario/decorativa farmhouse e porta-chaves (madeira)
--   Tiago:  pochete, copo termico + caneca/copao termico, cinto tatico, mini band/faixa elastica, camera de acao,
--           boneco soldado, pinturas a oleo / quadros pintados (codigo 'ocelot' na DRE, como ja era)
-- Tiago vira fornecedor para ter o proprio repasse, que so ele ve.

-- 1. fornecedor Tiago
insert into public.ocelot_fornecedores (id, conta_id, nome)
values ('91c31303-ab54-43c0-9b36-88b7bd8d5c54', '30fa53d4-60c0-40f6-9832-63b4cb313797', 'Tiago')
on conflict (id) do nothing;

-- 2. palavra-chave -> fornecedor (mesma regra da DRE + os itens que o Tiago classificou em 18/10/2026)
create or replace function public.ocelot_fornecedor_sugerido(p_titulo text)
returns uuid language sql immutable as $$
  select case
    when tn like '%pochete%' or tn like '%copo termico%' then '91c31303-ab54-43c0-9b36-88b7bd8d5c54'::uuid
    when tn like '%cuba%' or tn like '%porta copo%' or tn like '%porta-copo%' or tn like '%portacopo%'
      or tn like '%porta joia%' or tn like '%porta-joia%' or tn like '%portajoia%'
      or tn like '%saboneteira%' or tn like '%ralo%' or tn like '%valvula%' or (tn like '%peso%' and tn like '%porta%')
      or tn like '%pisante%' or tn like '%garrafeiro%' or tn like '%face de jesus%'
      then '9e88add9-8405-46db-8bd4-e128ee9ce65a'::uuid
    when tn like '%balan%' or tn like '%prateleira%' or tn like '%banco%' or tn like '%bau%'
      or tn like '%porta armario%' or tn like '%porta decoracao%' or tn like '%porta chaves%'
      then 'e7e5a84c-9294-4d80-a251-d3f36dc83d46'::uuid
    -- itens do Tiago classificados em 18/10: por ultimo, para "cinto"/"camera" num titulo de cuba ou balanco nao roubarem
    when tn like '%caneca termica%' or tn like '%copao termico%' or tn like '%cinto%' or tn like '%mini band%'
      or tn like '%faixa elastica%' or tn like '%faixas elasticas%' or tn like '%camera de acao%' or tn like '%boneco soldado%'
      or tn like '%pintura a oleo%' or tn like '%quadro pintado%'
      then '91c31303-ab54-43c0-9b36-88b7bd8d5c54'::uuid
  end
  from (select translate(lower(coalesce(p_titulo, '')), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') as tn) t
$$;

-- 3. grava o dono de todo anuncio conhecido que ainda nao tem (nao mexe nos 80 ja gravados)
insert into public.ocelot_item_fornecedor (conta_id, item_id, fornecedor_id, observacao, atualizado_em)
select '30fa53d4-60c0-40f6-9832-63b4cb313797', x.item_id, public.ocelot_fornecedor_sugerido(x.titulo),
       'classificado em 18/10/2026 (palavra-chave + lista do Tiago)', now()
  from (
    select s.item_id, coalesce(s.titulo, i.titulo) as titulo
      from public.ocelot_itens_sku s left join public.ocelot_itens_info i using (item_id)
     where s.conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797'
    union
    select distinct on (v.item_id) v.item_id, v.titulo
      from public.ocelot_vendas_itens v
     where v.conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797'
  ) x
 where public.ocelot_fornecedor_sugerido(x.titulo) is not null
on conflict (conta_id, item_id) do nothing;

-- 4. usuario -> fornecedor. fornecedor_id = de quem e o repasse que ele ve; envios_extra = fornecedores que ele
--    tambem despacha (Miguel despacha os itens do Tiago). Sem linha = ve tudo (admin, Elisangela, Jamille).
create table if not exists public.ocelot_usuario_fornecedor (
  user_id uuid primary key references auth.users (id) on delete cascade,
  fornecedor_id uuid not null references public.ocelot_fornecedores (id),
  envios_extra uuid[] not null default '{}',
  atualizado_em timestamptz not null default now()
);
alter table public.ocelot_usuario_fornecedor enable row level security;   -- sem policy: so as functions (service_role)
insert into public.ocelot_usuario_fornecedor (user_id, fornecedor_id, envios_extra) values
  ('a18ea6c2-30b3-4858-b8b1-2568acfbe342', '9e88add9-8405-46db-8bd4-e128ee9ce65a', '{91c31303-ab54-43c0-9b36-88b7bd8d5c54}'),  -- Miguel (+ Tiago nos envios)
  ('6bb64823-df78-4309-80b1-6721d2375603', 'e7e5a84c-9294-4d80-a251-d3f36dc83d46', '{}')                                     -- Alan
on conflict (user_id) do update set fornecedor_id = excluded.fornecedor_id, envios_extra = excluded.envios_extra, atualizado_em = now();

-- 5. Miguel e Alan: so Vendas a entregar e Repasse (Elisangela continua com Vendas a entregar + Etiquetas)
update public.app_usuarios set perms = jsonb_set(perms, '{menus}', '["ocelot_entregas","ocelot_repasse"]'::jsonb), atualizado_em = now()
 where user_id in ('a18ea6c2-30b3-4858-b8b1-2568acfbe342', '6bb64823-df78-4309-80b1-6721d2375603');
update public.app_usuarios set perms = jsonb_set(perms, '{acoes}', '["exportar_pdf"]'::jsonb), atualizado_em = now()
 where user_id = '6bb64823-df78-4309-80b1-6721d2375603';

-- 6. 'ocelot' (DRE, cadastro, anuncios, precos) nao vale mais para quem so tem Vendas a entregar / Etiquetas /
--    Repasse: antes qualquer menu ocelot_* liberava a DRE inteira pelo servidor.
create or replace function public.app_pode(p_uid uuid, p_chave text)
returns boolean language sql stable security definer set search_path to 'public' as $function$
  select coalesce((
    select u.admin
        or (p_chave='ocelot' and exists(select 1 from jsonb_array_elements_text(u.perms->'menus') m
                                         where m like 'ocelot\_%' and m not in ('ocelot_entregas','ocelot_etiquetas','ocelot_repasse')))
        or (p_chave='consultoria' and ((u.perms->'menus') ? 'semanal' or (u.perms->'menus') ? 'mensal'))
        or (p_chave not in ('__admin','ocelot') and ((u.perms->'menus') ? p_chave or (u.perms->'acoes') ? p_chave))
    from app_usuarios u where u.user_id=p_uid and u.ativo), false);
$function$;

-- 7. ocelot_vendas_calc: dono gravado no anuncio vem antes da palavra-chave
do $$
declare d text; a text;
begin
  d := pg_get_functiondef('public.ocelot_vendas_calc(uuid,date,date)'::regprocedure);
  a := d;
  d := replace(d, E'coalesce(nullif(b3.responsavel_cmv, \'\'),\n           case\n',
    E'coalesce(nullif(b3.responsavel_cmv, \'\'),\n'
    || E'           case f.fornecedor_id when \'9e88add9-8405-46db-8bd4-e128ee9ce65a\'::uuid then \'miguel\'\n'
    || E'                                when \'e7e5a84c-9294-4d80-a251-d3f36dc83d46\'::uuid then \'alan\'\n'
    || E'                                when \'91c31303-ab54-43c0-9b36-88b7bd8d5c54\'::uuid then \'ocelot\' end,\n'
    || E'           case\n');
  if d = a then raise exception 'ocelot_vendas_calc: trecho do responsavel nao encontrado'; end if;
  execute d;
end $$;

-- 8. kit de pochetes marcado em jul/2026 como "sem fornecedor": pochete e do Tiago
update public.ocelot_item_fornecedor set fornecedor_id = '91c31303-ab54-43c0-9b36-88b7bd8d5c54',
       observacao = 'sem fornecedor -> Tiago (pochete), 18/10/2026', atualizado_em = now()
 where conta_id = '30fa53d4-60c0-40f6-9832-63b4cb313797' and fornecedor_id is null;
