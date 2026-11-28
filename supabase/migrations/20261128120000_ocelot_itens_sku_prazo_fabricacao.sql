alter table public.ocelot_itens_sku
  add column if not exists prazo_fabricacao_dias integer,
  add column if not exists prazo_lido_em timestamptz;
comment on column public.ocelot_itens_sku.prazo_fabricacao_dias is 'Prazo de fabricacao (sale_terms MANUFACTURING_TIME) do anuncio no ML, em dias. NULL = sem prazo (pronta entrega). Gravado pelo ml-ocelot-anuncios (sincronizar e acao prazo).';
comment on column public.ocelot_itens_sku.prazo_lido_em is 'Quando o prazo de fabricacao foi lido no ML pela ultima vez.';
