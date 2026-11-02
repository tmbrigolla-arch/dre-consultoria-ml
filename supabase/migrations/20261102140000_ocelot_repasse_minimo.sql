-- Repasse minimo por produto (02/11/2026, pedido do Tiago). Campo no Cadastro: o minimo que o fornecedor
-- deve receber por unidade daquele SKU (ou anuncio sem SKU). Vazio = padrao R$ 40. Por enquanto so AVISA
-- (mudar preco / promocao que deixe o repasse abaixo do minimo); nao muda a regra de pagamento do repasse.
-- RLS sem policy: so a edge function ml-ocelot-preco (service_role) le e grava.
create table if not exists public.ocelot_repasse_minimo (
  conta_id uuid not null,
  tipo text not null check (tipo in ('sku', 'mlb')),
  chave text not null,              -- SKU ou MLB
  valor numeric(12,2) not null check (valor > 0),
  usuario_id uuid,
  atualizado_em timestamptz not null default now(),
  primary key (conta_id, tipo, chave)
);
alter table public.ocelot_repasse_minimo enable row level security;
revoke all on public.ocelot_repasse_minimo from public, anon, authenticated;
