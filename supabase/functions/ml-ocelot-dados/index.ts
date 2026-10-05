import { createClient } from "jsr:@supabase/supabase-js@2";
const OCELOT_CONTA="30fa53d4-60c0-40f6-9832-63b4cb313797";
const MIGUEL_ID="9e88add9-8405-46db-8bd4-e128ee9ce65a";
const ALAN_ID="e7e5a84c-9294-4d80-a251-d3f36dc83d46";
const CMV_PISO=40, CMV_TETO=90;
// v20 (04/10/2026): regra de repasse ao fornecedor igual a planilha do Tiago.
// A partir de 2026-09 (ou em qualquer mes com ocelot_parametros.repasse_pct preenchido), item sem
// custo cadastrado usa: CMV = liquido do ML - repasse_pct% x receita (17,5%), piso R$40 por unidade
// em cuba do Miguel, SEM teto. Meses anteriores seguem a regra antiga (imposto+gestao+ads+fixo, piso/teto).
// v21 (05/10/2026): devolucoes/mediacoes depois do envio, igual a planilha do Tiago.
// Pedido cancelado passa a olhar a FATURA do ML daquele pedido (ml_faturamento_detalhe, categorias
// taxa_ml + frete): o que o ML cobrou e nao estornou e custo real. Se sobrou custo, o item entra na DRE
// como "devolucao com custo": receita = venda, devolucao = venda, tarifa/frete = o que ficou cobrado,
// liquido = -custo, e o CMV = liquido (negativo) -- o prejuizo vai pro fornecedor, a Ocelot nao retem.
// Se a fatura zerou (tudo estornado), o cancelamento fica zerado e oculto, como antes.
// Item cancelado dentro de pacote que tem outro item ativo nao assume frete: o frete e do pacote e
// ja esta nos itens ativos (o ML lanca o frete bruto do pacote no pedido cancelado).
// Tambem: o rateio do frete do pacote passou a considerar so os itens nao cancelados.
// v22 (05/10/2026): devolucao com custo traz cmv_original (CMV da venda antes da devolucao), usado no
// quadro de repasse: a venda conta no mes dela pelo CMV normal; no mes seguinte o fornecedor devolve
// cmv_original + o prejuizo de tarifa/frete (pedido do Tiago: devolucoes chegam depois do pagamento).
// v23 (05/10/2026): (1) pedido cancelado com pagamento "bpp_covered" (o ML cobriu a mediacao, o vendedor
// ficou com o dinheiro) vira VENDA NORMAL: CMV normal pro fornecedor. (2) devolucao com custo traz
// cmv_pago_registrado = CMV gravado quando o repasse daquele mes foi registrado (ocelot_pagamento_itens);
// o estorno usa esse valor (tem que ser o mesmo que foi pago). (3) params de/ate (periodo livre) e
// so_devolucoes=1 (devolve so as devolucoes com custo -- usado pra montar os estornos pendentes).
// (4) resposta traz repasses (ocelot_pagamentos_fornecedor) e estornos_aplicados (ocelot_estorno_detalhe).
// v24 (05/10/2026): aba Repasse a fornecedores. cmv_pago_registrado vem em TODO item que tem CMV gravado
// num fechamento (nao so cancelados); modo so_alterados=1 devolve as vendas de um periodo que ja foram pagas
// e mudaram de situacao depois (cancelada/devolvida, coberta pelo ML, devolucao parcial) -- base dos ajustes
// do fechamento seguinte; resposta traz adiantamentos (ocelot_adiantamentos).
const REPASSE_DESDE="2026-09-01", REPASSE_PADRAO=17.5;
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,content-type,apikey","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
function json(o:unknown,s=200){return new Response(JSON.stringify(o),{status:s,headers:{...cors,"Content-Type":"application/json"}});}
function mesDe(dataVenda:string){return dataVenda.slice(0,7)+"-01";}
function elegivelPisoTeto(titulo:string,fidFornecedor:string|null|undefined){
  const t=(titulo||"").toLowerCase();
  if(fidFornecedor===MIGUEL_ID)return t.indexOf("cuba")!==-1;
  if(fidFornecedor===ALAN_ID)return t.indexOf("balan")!==-1;
  return false;
}
// v20: mesma precedencia da planilha -- pochete/copo termico (Ocelot) primeiro, depois Miguel
// (concreto), depois Alan (madeira). "banco" e "bau" passaram a ser do Alan.
function classifyResponsavel(titulo:string):string|null{
  const t=(titulo||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
  if(t.indexOf("pochete")!==-1||t.indexOf("copo termico")!==-1)return "ocelot";
  if(t.indexOf("cuba")!==-1||t.indexOf("porta copo")!==-1||t.indexOf("porta-copo")!==-1||t.indexOf("portacopo")!==-1
     ||t.indexOf("porta joia")!==-1||t.indexOf("porta-joia")!==-1||t.indexOf("portajoia")!==-1
     ||t.indexOf("saboneteira")!==-1||t.indexOf("ralo")!==-1||t.indexOf("valvula")!==-1
     ||(t.indexOf("peso")!==-1&&t.indexOf("porta")!==-1))return "miguel";
  if(t.indexOf("balan")!==-1||t.indexOf("prateleira")!==-1||t.indexOf("banco")!==-1||t.indexOf("bau")!==-1)return "alan";
  return null;
}
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  const {data:{user}}=await supabase.auth.getUser(jwt);
  if(!user)return json({error:"unauthorized"},401);
  { const { data: _pode } = await supabase.rpc("app_pode", { p_uid: user.id, p_chave: "ocelot" });
    if (!_pode) return json({ error: "sem permissao" }, 403); }
  const url=new URL(req.url);
  const mesParam=url.searchParams.get("mes");
  const deParam=url.searchParams.get("de"), ateParam=url.searchParams.get("ate");
  const soDevolucoes=url.searchParams.get("so_devolucoes")==="1";
  const soAlterados=url.searchParams.get("so_alterados")==="1";
  let desde:string, ateExclusive:string|null=null, dias:number;
  if(deParam&&ateParam){
    desde=deParam;ateExclusive=ateParam;dias=0;
  }else if(mesParam){
    desde=mesParam;
    const dt=new Date(mesParam+"T00:00:00Z");
    ateExclusive=new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth()+1,1)).toISOString().slice(0,10);
    dias=0;
  }else{
    dias=Number(url.searchParams.get("dias")||"30");
    desde=new Date(Date.now()-dias*86400000).toISOString().slice(0,10);
  }
  let q=supabase.from("ocelot_vendas_itens").select("*").eq("conta_id",OCELOT_CONTA).gte("data_venda",desde);
  if(ateExclusive)q=q.lt("data_venda",ateExclusive);
  const {data:vendasTodas}=await q.order("data_venda_ts",{ascending:false});
  const {data:custos}=await supabase.from("ocelot_custos_sku").select("*").eq("conta_id",OCELOT_CONTA).order("mes_competencia",{ascending:false});
  const {data:parametros}=await supabase.from("ocelot_parametros").select("*").eq("conta_id",OCELOT_CONTA).order("mes_competencia",{ascending:false});
  const {data:mesesRows}=await supabase.from("ocelot_vendas_itens").select("data_venda").eq("conta_id",OCELOT_CONTA);
  const mesesDisponiveis=Array.from(new Set((mesesRows||[]).map((r:any)=>mesDe(r.data_venda)))).sort().reverse();
  const {data:mapaFornecedor}=await supabase.from("ocelot_item_fornecedor").select("item_id,fornecedor_id").eq("conta_id",OCELOT_CONTA);
  const fornecedorPorItem:Record<string,string|null>={};
  for(const m of (mapaFornecedor||[]))fornecedorPorItem[m.item_id]=m.fornecedor_id;
  // v18 (09/09/2026): preco/status/permalink vem da ULTIMA coleta de item_metrics, lida por
  // periodo_fim exato. Antes o mapa de permalink usava um select sem filtro de periodo, que o
  // PostgREST corta em 1000 linhas -- com 2.7k linhas de historico isso era um truncamento silencioso.
  const {data:ultPer}=await supabase.from("item_metrics").select("periodo_fim").eq("conta_id",OCELOT_CONTA).order("periodo_fim",{ascending:false}).limit(1).maybeSingle();
  const ultimoPeriodo=ultPer?.periodo_fim||null;
  const infoItem:Record<string,any>={};
  if(ultimoPeriodo){
    const {data:itensAtuais}=await supabase.from("item_metrics").select("item_id,titulo,preco,status,permalink").eq("conta_id",OCELOT_CONTA).eq("periodo_fim",ultimoPeriodo).range(0,4999);
    for(const r of (itensAtuais||[]))infoItem[r.item_id]={titulo:r.titulo,preco:r.preco==null?null:Number(r.preco),status:r.status,permalink:r.permalink};
  }
  const {data:infoPerm}=await supabase.from("ocelot_itens_info").select("item_id,permalink");
  const permalinkMap:Record<string,string>={};
  for(const k in infoItem)if(infoItem[k].permalink)permalinkMap[k]=infoItem[k].permalink;
  for(const r of (infoPerm||[]))if(r.permalink&&!permalinkMap[r.item_id])permalinkMap[r.item_id]=r.permalink;
  // v17: SKU. O SKU do anuncio esta no atributo SELLER_SKU (NAO no seller_custom_field, que na
  // Ocelot esta 100% vazio). ocelot_itens_sku guarda o mapa item_id -> sku, mantido pelo cron
  // ml-ocelot-skus. O CMV cadastrado e por SKU+mes; item_id+mes so como excecao (anuncio sem SKU).
  const {data:skuRows}=await supabase.from("ocelot_itens_sku").select("item_id,sku,titulo").eq("conta_id",OCELOT_CONTA).range(0,4999);
  const skuPorItem:Record<string,string|null>={};
  const catalogo:Record<string,any>={};
  const semSkuMap:Record<string,any>={};
  function anuncioDe(item_id:string,tituloFallback:string){
    const inf=infoItem[item_id]||{};
    return {item_id,titulo:inf.titulo||tituloFallback||item_id,preco:inf.preco==null?null:inf.preco,
            status:inf.status||null,permalink:inf.permalink||permalinkMap[item_id]||null};
  }
  for(const r of (skuRows||[])){
    skuPorItem[r.item_id]=r.sku||null;
    if(r.sku){
      if(!catalogo[r.sku])catalogo[r.sku]={sku:r.sku,titulo:r.titulo||r.sku,anuncios:[],unid:0};
      catalogo[r.sku].anuncios.push(anuncioDe(r.item_id,r.titulo));
      const t=r.titulo||"";
      if(t&&t.length<String(catalogo[r.sku].titulo).length)catalogo[r.sku].titulo=t;
    }else{
      semSkuMap[r.item_id]=Object.assign(anuncioDe(r.item_id,r.titulo),{unid:0});
    }
  }
  const {data:qtdRows}=await supabase.from("ocelot_vendas_itens").select("item_id,quantidade,status,titulo").eq("conta_id",OCELOT_CONTA).range(0,9999);
  for(const r of (qtdRows||[])){
    if(r.status==="cancelled")continue;
    const s=skuPorItem[r.item_id];
    if(s&&catalogo[s])catalogo[s].unid+=Number(r.quantidade||0);
    else if(!s){
      if(!semSkuMap[r.item_id])semSkuMap[r.item_id]=Object.assign(anuncioDe(r.item_id,r.titulo),{unid:0});
      semSkuMap[r.item_id].unid+=Number(r.quantidade||0);
    }
  }
  const skus=Object.keys(catalogo).map((k)=>{
    const c=catalogo[k];
    const precos=c.anuncios.map((a:any)=>a.preco).filter((p:any)=>p!=null);
    c.anuncios.sort((a:any,b:any)=>(Number(b.preco||0)-Number(a.preco||0)));
    return {sku:c.sku,titulo:c.titulo,n_mlbs:c.anuncios.length,unid:c.unid,
            preco_min:precos.length?Math.min(...precos):null,preco_max:precos.length?Math.max(...precos):null,
            ativos:c.anuncios.filter((a:any)=>a.status==="active").length,
            mlbs:c.anuncios.map((a:any)=>a.item_id),anuncios:c.anuncios};
  }).sort((a:any,b:any)=>(b.unid-a.unid)||String(a.sku).localeCompare(String(b.sku)));
  const itensSemSku=Object.keys(semSkuMap).map((k)=>semSkuMap[k]).filter((x:any)=>x.unid>0)
    .sort((a:any,b:any)=>b.unid-a.unid);
  const custoSkuMap:Record<string,number>={};
  const custoMlbMap:Record<string,number>={};
  for(const c of (custos||[])){
    if(c.sku)custoSkuMap[c.sku+"|"+c.mes_competencia]=Number(c.custo_unitario);
    else if(c.item_id)custoMlbMap[c.item_id+"|"+c.mes_competencia]=Number(c.custo_unitario);
  }
  const paramMap:Record<string,any>={};
  for(const p of (parametros||[]))paramMap[p.mes_competencia]=p;
  const vendas=vendasTodas||[];
  // v23: mediacao coberta pelo ML (bpp_covered) = venda normal
  for(const v of vendas){
    if(v.status==="cancelled"&&v.pagamento_status_detail==="bpp_covered"){
      v.status="paid";v.ml_cobriu=true;v.valor_devolvido=0;
      v.valor_liquido=Number(v.valor_venda||0)-Number(v.taxa_ml||0)-Number(v.frete_vendedor||0);
    }
  }
  // v21: pacotes com pelo menos um item ativo (o frete do pacote fica nos itens ativos)
  const packAtivo:Record<string,boolean>={};
  for(const v of vendas)if(v.status!=="cancelled")packAtivo[String(v.pack_id||v.order_id)]=true;
  // v21: custo que ficou na fatura do ML para cada pedido cancelado (taxa de venda + frete)
  const custoCancelado:Record<string,{tx:number,fr:number}>={};
  const idsCanc=Array.from(new Set(vendas.filter((v:any)=>v.status==="cancelled").map((v:any)=>String(v.order_id))));
  if(idsCanc.length){
    const {data:mapaCat}=await supabase.from("ml_mapa_categoria").select("codigo,categoria");
    const catDe:Record<string,string>={};
    for(const m of (mapaCat||[]))catDe[m.codigo]=m.categoria;
    for(let i=0;i<idsCanc.length;i+=150){
      const lote=idsCanc.slice(i,i+150);
      const {data:fat}=await supabase.from("ml_faturamento_detalhe").select("order_id,detail_sub_type,valor").eq("conta_id",OCELOT_CONTA).in("order_id",lote).range(0,9999);
      for(const d of (fat||[])){
        const cat=catDe[d.detail_sub_type];
        if(cat!=="taxa_ml"&&cat!=="frete")continue;
        const k=String(d.order_id);
        if(!custoCancelado[k])custoCancelado[k]={tx:0,fr:0};
        if(cat==="taxa_ml")custoCancelado[k].tx+=Number(d.valor||0);else custoCancelado[k].fr+=Number(d.valor||0);
      }
    }
  }
  // v23/v24: CMV que ficou registrado como pago (snapshot do fechamento), por venda
  const cmvPagoMap:Record<string,number>={};
  const fornPagoMap:Record<string,string>={};
  for(let off=0;off<50000;off+=1000){ // PostgREST entrega no maximo 1000 linhas por chamada
    const {data:pg}=await supabase.from("ocelot_pagamento_itens").select("order_id,item_id,cmv_pago,fornecedor_id").eq("conta_id",OCELOT_CONTA).gte("data_venda",desde).lt("data_venda",ateExclusive||"2999-01-01").order("id").range(off,off+999);
    for(const r of (pg||[])){cmvPagoMap[String(r.order_id)+"|"+r.item_id]=Number(r.cmv_pago);fornPagoMap[String(r.order_id)+"|"+r.item_id]=r.fornecedor_id;}
    if(!pg||pg.length<1000)break;
  }
  const vendaPorPedido:Record<string,number>={};
  for(const v of vendas)vendaPorPedido[String(v.order_id)]=(vendaPorPedido[String(v.order_id)]||0)+Number(v.valor_venda||0);
  const porPackFrete:Record<string,any[]>={};
  for(const v of vendas){
    const k=String(v.pack_id||v.order_id);
    (porPackFrete[k]=porPackFrete[k]||[]).push(v);
  }
  for(const k in porPackFrete){
    const itensPack=porPackFrete[k];
    const orderIdsUnicos=new Set(itensPack.map((it:any)=>String(it.order_id)));
    if(orderIdsUnicos.size<=1)continue;
    const freteTotalPacote=Number(itensPack[0].frete_vendedor||0);
    const ativos=itensPack.filter((it:any)=>it.status!=="cancelled");
    const base=ativos.length?ativos:itensPack;
    const somaVendaPacote=base.reduce((s:number,it:any)=>s+Number(it.valor_venda||0),0);
    for(const it of itensPack){
      if(ativos.length&&it.status==="cancelled")continue;
      const share=somaVendaPacote>0?Number(it.valor_venda||0)/somaVendaPacote:1/base.length;
      const freteItem=freteTotalPacote*share;
      it.frete_vendedor=freteItem;
      it.valor_liquido=Number(it.valor_venda||0)-Number(it.taxa_ml||0)-freteItem-Number(it.valor_devolvido||0);
    }
  }
  const mesesPresentes=new Set<string>();
  for(const v of (vendasTodas||[]))mesesPresentes.add(mesDe(v.data_venda));
  const {data:snapsAll}=await supabase.from("snapshots").select("periodo_inicio,periodo_fim,tacos,granularidade").eq("conta_id",OCELOT_CONTA).not("tacos","is",null).order("periodo_fim",{ascending:false}).limit(40);
  const tacosPctMap:Record<string,number>={};
  const tacosFonteMap:Record<string,string>={};
  for(const mes of mesesPresentes){
    const exato=(snapsAll||[]).find((s:any)=>s.granularidade==="mensal"&&s.periodo_inicio===mes);
    if(exato){tacosPctMap[mes]=Number(exato.tacos)*100;tacosFonteMap[mes]="mensal ("+mes+")";continue;}
    const recente=(snapsAll||[])[0];
    if(recente){tacosPctMap[mes]=Number(recente.tacos)*100;tacosFonteMap[mes]="aproximado (ultimo snapshot, "+recente.periodo_inicio+" a "+recente.periodo_fim+")";}
  }
  const fixoPctMap:Record<string,number>={};
  for(const mes of mesesPresentes){
    const p=paramMap[mes]||{imposto_pct:5.5,gestao_pct:5.5,ads_pct:5,custo_fixo_mensal:800,fechado:false};
    if(p.fechado&&p.fixo_pct_calculado!=null){fixoPctMap[mes]=Number(p.fixo_pct_calculado);continue;}
    const dt=new Date(mes+"T00:00:00Z");const nextMes=new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth()+1,1)).toISOString().slice(0,10);
    const {data:aggMes}=await supabase.from("ocelot_vendas_itens").select("valor_venda,status").eq("conta_id",OCELOT_CONTA).gte("data_venda",mes).lt("data_venda",nextMes).neq("status","cancelled");
    const receitaBrutaMes=(aggMes||[]).reduce((s:number,r:any)=>s+Number(r.valor_venda||0),0);
    fixoPctMap[mes]=receitaBrutaMes>0?Math.min(50,(Number(p.custo_fixo_mensal)/receitaBrutaMes)*100):0;
  }
  const repassePctMap:Record<string,number|null>={};
  function repasseDoMes(mes:string):number|null{
    const p=paramMap[mes];
    if(p&&p.repasse_pct!=null)return Number(p.repasse_pct);
    return mes>=REPASSE_DESDE?REPASSE_PADRAO:null;
  }
  for(const mes of mesesPresentes)repassePctMap[mes]=repasseDoMes(mes);
  function calcItem(v:any):any{
    const mes=mesDe(v.data_venda);
    const p=paramMap[mes]||{imposto_pct:5.5,gestao_pct:5.5,ads_pct:5};
    const valorVenda=Number(v.valor_venda);
    const valorLiquido=Number(v.valor_liquido);
    const skuItem=skuPorItem[v.item_id]||null;
    let custoManual:number|undefined=undefined;
    let cmv_chave:string|null=null;
    if(skuItem!=null&&custoSkuMap[skuItem+"|"+mes]!=null){custoManual=custoSkuMap[skuItem+"|"+mes];cmv_chave="sku:"+skuItem;}
    else if(custoMlbMap[v.item_id+"|"+mes]!=null){custoManual=custoMlbMap[v.item_id+"|"+mes];cmv_chave="mlb:"+v.item_id;}
    const responsavel_cmv=v.responsavel_cmv||classifyResponsavel(v.titulo);
    let cmv_origem:string,cmv_unitario:number,cmv_total:number,ads_pct_usado:number|null=null;
    let imposto_valor:number|null=null,ads_valor:number|null=null,custofixo_valor:number|null=null,resultado:number;
    if(v.status==="cancelled"){
      const cc=custoCancelado[String(v.order_id)];
      const shareP=vendaPorPedido[String(v.order_id)]>0?valorVenda/vendaPorPedido[String(v.order_id)]:1;
      const r2=(x:number)=>Math.round(x*100)/100+0;
      const tx=cc?r2(cc.tx*shareP):0;
      const fr=(cc&&!packAtivo[String(v.pack_id||v.order_id)])?r2(cc.fr*shareP):0;
      const custo=r2(tx+fr);
      if(Math.abs(custo)>=0.01){
        // devolucao/mediacao com custo: entra na DRE; CMV = liquido (prejuizo vai pro fornecedor)
        const liq=-custo;
        const qd=Number(v.quantidade)||1;
        // v22: CMV que o fornecedor recebeu (ou receberia) por essa venda antes da devolucao -- mesma regra
        // de uma venda normal sobre os valores originais. Estorno no mes seguinte = cmv_original + prejuizo.
        const original=calcItem({...v,status:"paid",valor_devolvido:0,
          valor_liquido:valorVenda-Number(v.taxa_ml||0)-Number(v.frete_vendedor||0)});
        const cmv_original=Math.max(0,Number(original.cmv_total)||0);
        const kp=String(v.order_id)+"|"+v.item_id;
        const cmv_pago_registrado=(kp in cmvPagoMap)?cmvPagoMap[kp]:null;
        return {...v,sku:skuItem,cmv_chave:null,mes_competencia:mes,devolucao_com_custo:true,cmv_original,cmv_pago_registrado,
          taxa_ml:tx,frete_vendedor:fr,valor_devolvido:valorVenda,valor_liquido:liq,
          cmv_origem:"devolucao",cmv_unitario:liq/qd,cmv_total:liq,resultado:0,ads_pct_usado:null,
          imposto_valor:0,ads_valor:0,custofixo_valor:0,responsavel_cmv};
      }
      cmv_origem="cancelado";cmv_unitario=0;cmv_total=0;resultado=0;
      return {...v,sku:skuItem,cmv_chave:null,taxa_ml:0,frete_vendedor:0,valor_liquido:0,valor_devolvido:0,mes_competencia:mes,cmv_origem,cmv_unitario,cmv_total,resultado,ads_pct_usado,imposto_valor,ads_valor,custofixo_valor,responsavel_cmv};
    }
    ads_pct_usado=p.fechado?Number(p.ads_pct):(tacosPctMap[mes]??Number(p.ads_pct));
    const pctFixo=fixoPctMap[mes]||0;
    const valorDevolvido=Number(v.valor_devolvido||0);
    const valorVendaEfetivo=Math.max(0,valorVenda-valorDevolvido);
    imposto_valor=valorVendaEfetivo*Number(p.imposto_pct)/100;
    ads_valor=valorVendaEfetivo*ads_pct_usado/100;
    custofixo_valor=valorVendaEfetivo*pctFixo/100;
    const repassePct=repassePctMap[mes]??repasseDoMes(mes);
    if(custoManual!=null){
      cmv_origem="manual";cmv_unitario=custoManual;cmv_total=custoManual*Number(v.quantidade);
    }else if(valorVendaEfetivo<=0){
      cmv_origem="formula_devolvido";cmv_unitario=0;cmv_total=0;
    }else if(repassePct!=null){
      // regra da planilha: repasse = liquido - repasse_pct% da receita; piso R$40/un em cuba do Miguel; sem teto
      const cmv_total_bruto=valorLiquido-valorVendaEfetivo*repassePct/100;
      const cmv_unit_bruto=Number(v.quantidade)>0?cmv_total_bruto/Number(v.quantidade):cmv_total_bruto;
      const ehCubaMiguel=responsavel_cmv==="miguel"&&(v.titulo||"").toLowerCase().indexOf("cuba")!==-1;
      if(ehCubaMiguel&&cmv_unit_bruto<CMV_PISO){
        cmv_unitario=CMV_PISO;cmv_origem="formula_piso";
      }else{
        cmv_origem="formula";cmv_unitario=cmv_unit_bruto;
      }
      cmv_total=Number(v.quantidade)>0?cmv_unitario*Number(v.quantidade):cmv_unitario;
    }else{
      const gestao_valor=valorVendaEfetivo*Number(p.gestao_pct)/100;
      const retencao=imposto_valor+ads_valor+custofixo_valor+gestao_valor;
      const cmv_total_bruto=valorLiquido-retencao;
      const cmv_unit_bruto=Number(v.quantidade)>0?cmv_total_bruto/Number(v.quantidade):cmv_total_bruto;
      const fidFornecedor=fornecedorPorItem[v.item_id];
      const podeAplicarPisoTeto=elegivelPisoTeto(v.titulo,fidFornecedor);
      if(podeAplicarPisoTeto&&cmv_unit_bruto<CMV_PISO){
        cmv_unitario=CMV_PISO;cmv_origem="formula_piso";
      }else if(podeAplicarPisoTeto&&cmv_unit_bruto>CMV_TETO){
        cmv_unitario=CMV_TETO;cmv_origem="formula_teto";
      }else{
        cmv_origem="formula";cmv_unitario=cmv_unit_bruto;
      }
      cmv_total=Number(v.quantidade)>0?cmv_unitario*Number(v.quantidade):cmv_unitario;
    }
    if(v.status==="partially_refunded"&&(responsavel_cmv==="miguel"||responsavel_cmv==="alan")&&cmv_total>0){
      cmv_origem="estorno_fornecedor";cmv_unitario=0;cmv_total=0;
    }
    resultado=valorLiquido-cmv_total-imposto_valor-ads_valor-custofixo_valor;
    return {...v,sku:skuItem,cmv_chave,mes_competencia:mes,cmv_origem,cmv_unitario,cmv_total,resultado,ads_pct_usado,imposto_valor,ads_valor,custofixo_valor,responsavel_cmv};
  }
  const vendasCalc=vendas.map(calcItem).map((v:any)=>{const kp=String(v.order_id)+"|"+v.item_id;
    return {...v,permalink:permalinkMap[v.item_id]||null,cmv_pago_registrado:(kp in cmvPagoMap)?cmvPagoMap[kp]:null,cmv_pago_fornecedor_id:fornPagoMap[kp]||null};});
  // v21: "cancelado" agora so e o cancelamento SEM custo (oculto); devolucao com custo conta na DRE
  const cancelados=vendasCalc.filter((v:any)=>v.status==="cancelled"&&!v.devolucao_com_custo);
  const devolucoesCusto=vendasCalc.filter((v:any)=>v.devolucao_com_custo);
  const porPedido:Record<string,any>={};
  for(const v of vendasCalc){
    const k=String(v.pack_id||v.order_id);
    if(!porPedido[k])porPedido[k]={order_id:v.order_id,pack_id:v.pack_id,order_ids:[],is_carrinho:false,data_venda:v.data_venda,data_venda_ts:v.data_venda_ts,status:v.status,itens:[],valor_venda:0,taxa_ml:0,frete_vendedor:0,valor_devolvido:0,valor_liquido:0,cmv_total:0,resultado:0,imposto_valor:0,ads_valor:0,custofixo_valor:0,tem_breakdown:false,devolucao_com_custo:false,forma_pagamento:v.forma_pagamento??null,parcelas:v.parcelas??null};
    const p=porPedido[k];
    p.itens.push(v);
    if(!p.order_ids.includes(v.order_id))p.order_ids.push(v.order_id);
    p.is_carrinho=p.order_ids.length>1;
    if(v.status!=="cancelled")p.status=v.status;
    if(v.devolucao_com_custo)p.devolucao_com_custo=true;
    p.valor_venda+=Number(v.valor_venda||0);
    p.taxa_ml+=Number(v.taxa_ml||0);
    p.frete_vendedor+=Number(v.frete_vendedor||0);
    p.valor_devolvido+=Number(v.valor_devolvido||0);
    p.valor_liquido+=Number(v.valor_liquido||0);
    p.cmv_total+=Number(v.cmv_total||0);
    p.resultado+=Number(v.resultado||0);
    if(v.imposto_valor!=null){p.imposto_valor+=Number(v.imposto_valor||0);p.ads_valor+=Number(v.ads_valor||0);p.custofixo_valor+=Number(v.custofixo_valor||0);p.tem_breakdown=true;}
  }
  const pedidos=Object.values(porPedido).sort((a:any,b:any)=>new Date(b.data_venda_ts).getTime()-new Date(a.data_venda_ts).getTime());
  const resumo={faturamento_bruto:0,taxa_ml:0,frete:0,devolvido:0,receita_liquida:0,cmv:0,margem_bruta:0,n_vendas:0,n_itens:0};
  const porFormaPagamento:Record<string,{n_vendas:number,valor_venda:number}>={};
  const porResponsavel:Record<string,{cmv:number,n_itens:number}>={ocelot:{cmv:0,n_itens:0},miguel:{cmv:0,n_itens:0},alan:{cmv:0,n_itens:0},sem_classificar:{cmv:0,n_itens:0}};
  for(const v of vendasCalc){
    if(v.status==="cancelled"&&!v.devolucao_com_custo)continue;
    resumo.faturamento_bruto+=Number(v.valor_venda||0);
    resumo.taxa_ml+=Number(v.taxa_ml||0);
    resumo.frete+=Number(v.frete_vendedor||0);
    resumo.devolvido+=Number(v.valor_devolvido||0);
    resumo.receita_liquida+=Number(v.valor_liquido||0);
    resumo.cmv+=Number(v.cmv_total||0);
    resumo.n_itens+=1;
    const chaveResp=v.responsavel_cmv||"sem_classificar";
    const bucket=porResponsavel[chaveResp]||porResponsavel.sem_classificar;
    bucket.cmv+=Number(v.cmv_total||0);
    bucket.n_itens+=1;
  }
  resumo.n_vendas=(pedidos as any[]).filter((p:any)=>p.status!=="cancelled").length;
  resumo.margem_bruta=resumo.receita_liquida-resumo.cmv;
  for(const p of (pedidos as any[])){
    if(p.status==="cancelled")continue;
    const fp=p.forma_pagamento||"não identificado";
    if(!porFormaPagamento[fp])porFormaPagamento[fp]={n_vendas:0,valor_venda:0};
    porFormaPagamento[fp].n_vendas+=1;
    porFormaPagamento[fp].valor_venda+=Number(p.valor_venda||0);
  }
  const waterfall={faturamento_bruto:0,cancelamentos:0,devolucoes:0,faturamento_liquido:0,impostos:0,receita_liquida:0};
  for(const v of (vendasTodas||[])){
    const vv=Number(v.valor_venda||0);
    const mes=mesDe(v.data_venda);
    const p=paramMap[mes]||{imposto_pct:5.5};
    waterfall.faturamento_bruto+=vv;
    if(v.status==="cancelled"){waterfall.cancelamentos+=vv;continue;}
    waterfall.devolucoes+=Number(v.valor_devolvido||0);
    const contribLiquido=vv-Number(v.valor_devolvido||0);
    waterfall.impostos+=contribLiquido*Number(p.imposto_pct)/100;
  }
  waterfall.faturamento_liquido=waterfall.faturamento_bruto-waterfall.cancelamentos-waterfall.devolucoes;
  waterfall.receita_liquida=waterfall.faturamento_liquido-waterfall.impostos;
  const {data:repasses}=await supabase.from("ocelot_pagamentos_fornecedor").select("*").eq("conta_id",OCELOT_CONTA);
  const {data:estornosAplicados}=await supabase.from("ocelot_estorno_detalhe").select("fornecedor_id,mes_origem,mes_absorcao,order_id,item_id,titulo,data_venda,valor_pago_antes,valor_atual,diferenca").eq("conta_id",OCELOT_CONTA).range(0,9999);
  const {data:adiantamentos}=await supabase.from("ocelot_adiantamentos").select("id,fornecedor_id,mes_competencia,valor,data,observacao").eq("conta_id",OCELOT_CONTA).range(0,9999);
  if(soAlterados){
    // (a) venda paga num fechamento que mudou depois; (b) venda que ficou FORA de um fechamento registrado
    const FID:Record<string,string>={miguel:MIGUEL_ID,alan:ALAN_ID};
    const mesReg=new Set((repasses||[]).filter((r:any)=>r.pago).map((r:any)=>r.fornecedor_id+"|"+r.mes_competencia));
    for(const v of vendasCalc){
      if(v.cmv_pago_registrado==null&&FID[v.responsavel_cmv]&&mesReg.has(FID[v.responsavel_cmv]+"|"+v.mes_competencia)
         &&(v.status!=="cancelled"||v.devolucao_com_custo)&&Math.abs(Number(v.cmv_total||0))>=0.01)v.nao_incluida=true;
    }
    const itens=vendasCalc.filter((v:any)=>v.nao_incluida||(v.cmv_pago_registrado!=null&&(v.status==="cancelled"||v.ml_cobriu||v.status==="partially_refunded")))
      .map((v:any)=>({order_id:v.order_id,pack_id:v.pack_id,item_id:v.item_id,titulo:v.titulo,data_venda:v.data_venda,mes_competencia:v.mes_competencia,
        quantidade:v.quantidade,valor_venda:v.valor_venda,valor_liquido:v.valor_liquido,status:v.status,ml_cobriu:!!v.ml_cobriu,
        devolucao_com_custo:!!v.devolucao_com_custo,cmv_total:v.cmv_total,cmv_pago_registrado:v.cmv_pago_registrado,
        cmv_pago_fornecedor_id:v.cmv_pago_fornecedor_id,nao_incluida:!!v.nao_incluida,responsavel_cmv:v.responsavel_cmv}));
    return json({itens,de:desde,ate:ateExclusive,repasses:repasses||[],estornos_aplicados:estornosAplicados||[],adiantamentos:adiantamentos||[]});
  }
  if(soDevolucoes){
    const peds=(pedidos as any[]).map((p:any)=>({...p,itens:p.itens.filter((it:any)=>it.devolucao_com_custo)})).filter((p:any)=>p.itens.length);
    return json({pedidos:peds,de:desde,ate:ateExclusive,repasses:repasses||[],estornos_aplicados:estornosAplicados||[]});
  }
  const {data:snap}=await supabase.from("snapshots").select("ad_spend,periodo_fim").eq("conta_id",OCELOT_CONTA).order("periodo_fim",{ascending:false}).limit(1).maybeSingle();
  return json({pedidos,resumo,waterfall,por_forma_pagamento:porFormaPagamento,por_responsavel:porResponsavel,cancelados_count:new Set(cancelados.map((v:any)=>String(v.order_id))).size,devolucoes_custo_count:new Set(devolucoesCusto.map((v:any)=>String(v.order_id))).size,custos:custos||[],parametros:parametros||[],skus,itens_sem_sku:itensSemSku,itens_periodo:ultimoPeriodo,fixo_pct_por_mes:fixoPctMap,tacos_pct_por_mes:tacosPctMap,tacos_fonte_por_mes:tacosFonteMap,repasse_pct_por_mes:repassePctMap,ads_referencia:snap||null,repasses:repasses||[],adiantamentos:adiantamentos||[],estornos_aplicados:estornosAplicados||[],dias,mes_filtro:mesParam,meses_disponiveis:mesesDisponiveis});
});
