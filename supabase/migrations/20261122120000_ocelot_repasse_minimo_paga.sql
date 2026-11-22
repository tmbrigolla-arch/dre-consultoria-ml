-- Repasse minimo por produto passa a valer no PAGAMENTO (22/11/2026, pedido do Tiago).
-- Antes (20261102140000) o minimo do Cadastro so avisava na tela de preco/promocao.
-- Regra, a partir de nov/2026 (mes aberto; outubro e anteriores ja foram fechados e nao mudam):
--   * produto com repasse minimo cadastrado (SKU; senao o anuncio): o repasse por unidade nunca fica abaixo
--     dele -- vale para qualquer produto do fornecedor, nao so cuba/balanco; e substitui o piso de R$ 40;
--   * produto sem minimo cadastrado: como antes (piso de R$ 40/un em cuba do Miguel e balanco do Alan);
--   * custo cadastrado do mes continua com prioridade (o minimo nao se aplica);
--   * piso em pacote (20261007170000): os itens com piso do mesmo pacote e fornecedor somam a formula e comparam
--     com a soma dos pisos de cada um (antes 40 x unidades).
-- Mesma regra em ml-ocelot-dados (calcItem) e _shared/ocelot-margem.ts / ml-ocelot-promocoes.
do $mig$
declare d text; a text;
begin
  d := pg_get_functiondef('public.ocelot_vendas_calc(uuid,date,date)'::regprocedure);
  a := d;

  -- 1. minimo do produto: SKU primeiro, senao o anuncio (mesma precedencia de ml-ocelot-preco)
  d := replace(d,
$a$    left join ocelot_item_fornecedor f on f.conta_id = p_conta and f.item_id = b3.item_id
$a$,
$b$    left join ocelot_item_fornecedor f on f.conta_id = p_conta and f.item_id = b3.item_id
    left join lateral (select coalesce(
        (select r.valor from ocelot_repasse_minimo r
          where r.conta_id = p_conta and r.tipo = 'sku' and r.chave = nullif(s.sku, '')),
        (select r.valor from ocelot_repasse_minimo r
          where r.conta_id = p_conta and r.tipo = 'mlb' and r.chave = b3.item_id)) as valor) rmin on true
$b$);
  if d = a then raise exception 'ocelot_vendas_calc: join do fornecedor nao encontrado'; end if;
  a := d;
  d := replace(d, E'         f.fornecedor_id,\n', E'         f.fornecedor_id,\n         rmin.valor as rep_min,\n');
  if d = a then raise exception 'ocelot_vendas_calc: coluna fornecedor_id nao encontrada'; end if;
  a := d;

  -- 2. piso por unidade do item: minimo cadastrado (desde nov/2026) ou R$ 40 em cuba/balanco
  d := replace(d,
$a$  select venda4.*,
         (mes >= date '2026-10-01' and repasse_pct is not null and elegivel and custo_manual is null$a$,
$b$  select venda4.*,
         case when mes >= date '2026-11-01' and repasse_pct is not null and rep_min is not null then rep_min
              when elegivel then 40 end as piso_un,
         (mes >= date '2026-10-01' and repasse_pct is not null
          and (elegivel or (mes >= date '2026-11-01' and rep_min is not null)) and custo_manual is null$b$);
  if d = a then raise exception 'ocelot_vendas_calc: venda4b nao encontrada'; end if;
  a := d;

  -- 3. piso em pacote: soma da formula contra a soma dos pisos de cada item
  d := replace(d,
    'sum(cmv_bruto) over w >= 40 * sum(case when quantidade > 0 then quantidade else 1 end) over w',
    'sum(cmv_bruto) over w >= sum(piso_un * (case when quantidade > 0 then quantidade else 1 end)) over w');
  if d = a then raise exception 'ocelot_vendas_calc: regra do pacote nao encontrada'; end if;
  a := d;

  -- 4. aplica o piso do item
  d := replace(d, 'when elegivel and not pacote_cobre and unit_bruto < 40 then 40',
                  'when piso_un is not null and not pacote_cobre and unit_bruto < piso_un then piso_un');
  if d = a then raise exception 'ocelot_vendas_calc: piso (valor) nao encontrado'; end if;
  a := d;
  d := replace(d, $a$when elegivel and not pacote_cobre and unit_bruto < 40 then 'formula_piso'$a$,
                  $b$when piso_un is not null and not pacote_cobre and unit_bruto < piso_un then 'formula_piso'$b$);
  if d = a then raise exception 'ocelot_vendas_calc: piso (origem) nao encontrado'; end if;

  execute d;
end
$mig$;
