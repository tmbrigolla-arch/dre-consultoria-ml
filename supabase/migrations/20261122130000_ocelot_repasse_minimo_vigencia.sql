-- Repasse minimo com VIGENCIA (22/11/2026, pedido do Tiago): o minimo vale so para as vendas feitas a partir do
-- momento em que foi cadastrado; quando e alterado, o valor novo vale das vendas daquele momento em diante (as
-- anteriores ficam com o valor que valia na hora delas). Apagar o minimo tambem vale dali em diante.
-- Historico em ocelot_repasse_minimo_hist, gravado por trigger em ocelot_repasse_minimo (a tela e a edge function
-- ml-ocelot-preco continuam gravando so em ocelot_repasse_minimo). valor null = minimo removido.
-- Carga inicial: cada minimo atual vale desde o atualizado_em dele (o historico anterior nao existia).
-- ocelot_vendas_calc passa a buscar o minimo vigente no data_venda_ts da venda (sem ts, o fim do dia da venda).
create table if not exists public.ocelot_repasse_minimo_hist (
  id bigserial primary key,
  conta_id uuid not null,
  tipo text not null check (tipo in ('sku', 'mlb')),
  chave text not null,
  valor numeric(12,2),               -- null = minimo removido a partir de vigente_desde
  vigente_desde timestamptz not null,
  usuario_id uuid,
  criado_em timestamptz not null default now()
);
create index if not exists ocelot_repasse_minimo_hist_busca
  on public.ocelot_repasse_minimo_hist (conta_id, tipo, chave, vigente_desde desc);
alter table public.ocelot_repasse_minimo_hist enable row level security;
revoke all on public.ocelot_repasse_minimo_hist from public, anon, authenticated;

insert into public.ocelot_repasse_minimo_hist (conta_id, tipo, chave, valor, vigente_desde, usuario_id)
select m.conta_id, m.tipo, m.chave, m.valor, m.atualizado_em, m.usuario_id
  from public.ocelot_repasse_minimo m
 where not exists (select 1 from public.ocelot_repasse_minimo_hist h
                    where h.conta_id = m.conta_id and h.tipo = m.tipo and h.chave = m.chave);

create or replace function public.ocelot_repasse_minimo_hist_trg()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
begin
  if tg_op = 'DELETE' then
    insert into ocelot_repasse_minimo_hist (conta_id, tipo, chave, valor, vigente_desde, usuario_id)
    values (old.conta_id, old.tipo, old.chave, null, now(), old.usuario_id);
    return old;
  end if;
  if tg_op = 'UPDATE' and new.valor is not distinct from old.valor then return new; end if;
  insert into ocelot_repasse_minimo_hist (conta_id, tipo, chave, valor, vigente_desde, usuario_id)
  values (new.conta_id, new.tipo, new.chave, new.valor, now(), new.usuario_id);
  return new;
end
$f$;
revoke all on function public.ocelot_repasse_minimo_hist_trg() from public, anon, authenticated;
drop trigger if exists ocelot_repasse_minimo_hist on public.ocelot_repasse_minimo;
create trigger ocelot_repasse_minimo_hist after insert or update or delete on public.ocelot_repasse_minimo
  for each row execute function public.ocelot_repasse_minimo_hist_trg();

-- ocelot_vendas_calc: minimo vigente na hora da venda (antes: o minimo atual)
do $mig$
declare d text; a text;
begin
  d := pg_get_functiondef('public.ocelot_vendas_calc(uuid,date,date)'::regprocedure);
  a := d;
  d := replace(d,
$a$    left join lateral (select coalesce(
        (select r.valor from ocelot_repasse_minimo r
          where r.conta_id = p_conta and r.tipo = 'sku' and r.chave = nullif(s.sku, '')),
        (select r.valor from ocelot_repasse_minimo r
          where r.conta_id = p_conta and r.tipo = 'mlb' and r.chave = b3.item_id)) as valor) rmin on true$a$,
$b$    left join lateral (select coalesce(b3.data_venda_ts,
                                       ((b3.data_venda + 1)::timestamp at time zone 'America/Sao_Paulo')) as ts) tv on true
    left join lateral (select coalesce(
        (select h.valor from ocelot_repasse_minimo_hist h
          where h.conta_id = p_conta and h.tipo = 'sku' and h.chave = nullif(s.sku, '') and h.vigente_desde <= tv.ts
          order by h.vigente_desde desc, h.id desc limit 1),
        (select h.valor from ocelot_repasse_minimo_hist h
          where h.conta_id = p_conta and h.tipo = 'mlb' and h.chave = b3.item_id and h.vigente_desde <= tv.ts
          order by h.vigente_desde desc, h.id desc limit 1)) as valor) rmin on true$b$);
  if d = a then raise exception 'ocelot_vendas_calc: join do minimo nao encontrado'; end if;
  execute d;
end
$mig$;
