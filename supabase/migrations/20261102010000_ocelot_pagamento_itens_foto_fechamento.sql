-- 02/11/2026: foto da venda no fechamento do repasse (pedido do Tiago).
-- Alem do CMV pago, o registro do repasse grava receita, devolucao, tarifa, frete e liquido de cada venda
-- como estavam no fechamento. Assim:
--  * a DRE de um mes com repasse registrado fica congelada (mostra a venda como foi fechada);
--  * o que muda depois (devolucao, mediacao coberta pelo ML, venda que ficou fora do fechamento) entra na
--    DRE do mes seguinte como "vendas de meses anteriores", pela diferenca entre hoje e a foto.
alter table public.ocelot_pagamento_itens
  add column if not exists snap_venda numeric,
  add column if not exists snap_devolvido numeric,
  add column if not exists snap_taxa numeric,
  add column if not exists snap_frete numeric,
  add column if not exists snap_liquido numeric;

comment on column public.ocelot_pagamento_itens.snap_venda is 'Receita da venda no fechamento do repasse';
comment on column public.ocelot_pagamento_itens.snap_liquido is 'Liquido do ML da venda no fechamento do repasse';

-- Setembro/2026 (unico mes registrado antes desta mudanca) foi preenchido a mao em 02/11/2026:
--  * vendas sem mudanca: valores atuais de ocelot_vendas_calc (iguais aos do fechamento);
--  * 17 vendas que mudaram depois (15 devolvidas em outubro, a mediacao 2000018716858628 e a coberta
--    pelo ML 2000018404915270): valores da planilha "resultado setembro de 2026" (colunas H, I+J+K, Q, R).
-- Backup antes do preenchimento: ocelot_pagamento_itens_bkp_20261102.
