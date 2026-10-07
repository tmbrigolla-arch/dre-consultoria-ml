-- disparar_fatura (07/10/2026): ficava executavel por qualquer um com a chave publica do site (grant
-- padrao para PUBLIC). Ela dispara a coleta da fatura do ML usando o collector_secret, entao qualquer
-- pessoa podia acionar chamadas ao Mercado Livre em nome das contas. Nenhuma tela chama essa funcao:
-- so os crons fat-ocelot-atual / fat-ocelot-anterior, que rodam como postgres (dono) e nao dependem
-- deste grant. Fica so para o servidor.
revoke all on function public.disparar_fatura(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.disparar_fatura(uuid, text, text, integer) to service_role;
