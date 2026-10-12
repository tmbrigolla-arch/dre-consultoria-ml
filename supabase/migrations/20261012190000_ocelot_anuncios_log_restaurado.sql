-- Trava anti-exclusao (12/10/2026): anuncio marcado como excluido que volta a existir no ML e restaurado
-- sozinho pelo ml-ocelot-anuncios e fica registrado no log como 'restaurado'.
alter table public.ocelot_anuncios_log drop constraint if exists ocelot_anuncios_log_tipo_check;
alter table public.ocelot_anuncios_log add constraint ocelot_anuncios_log_tipo_check
  check (tipo in ('status', 'estoque', 'excluido', 'restaurado'));
