-- Aba "A entregar" (09/10/2026): ocelot_entregas passa a guardar o prazo de despacho do ML.
--   data_limite_envio = /shipments/{id}/sla expected_date (ate quando o pacote precisa sair);
--   data_envio        = status_history.date_shipped (quando saiu de fato);
--   sla_status        = on_time / delayed ... devolvido pelo ML no /sla;
--   logistic_type     = xd_drop_off, cross_docking, self_service (Flex), fulfillment...
-- A tabela ja existia (coletor antigo, nunca rodou em producao) e fica como cache dos envios.
alter table public.ocelot_entregas
  add column if not exists data_limite_envio date,
  add column if not exists data_envio date,
  add column if not exists sla_status text,
  add column if not exists logistic_type text;
