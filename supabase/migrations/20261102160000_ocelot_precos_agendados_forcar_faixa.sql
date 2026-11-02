-- 02/11/2026: preco agendado ("manter a promocao") que a pessoa confirmou FORA da faixa segura (metade a dobro da
-- tabela). O cron grava sem barrar pela faixa; o log fica com origem "agendado+fora_faixa".
alter table public.ocelot_precos_agendados add column if not exists forcar_faixa boolean not null default false;
