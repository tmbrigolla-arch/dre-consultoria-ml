import { createClient } from "jsr:@supabase/supabase-js@2";
const OCELOT_CONTA="30fa53d4-60c0-40f6-9832-63b4cb313797";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,content-type,apikey","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
function json(o:unknown,s=200){return new Response(JSON.stringify(o),{status:s,headers:{...cors,"Content-Type":"application/json"}});}
// v6 (07/10/2026): fechamento de mes revisado (o botao do Cadastro so enxergava o mes corrente e fechou
// outubro com 6 dias de venda, travando o custo fixo em 10% de cada venda).
//  * parametros: recusa alterar mes FECHADO (antes, mudar % de um mes fechado mexia nos numeros dele);
//  * fechar_mes: so fecha mes que ja terminou (horario de Brasilia); Ads congela no TACoS MENSAL do proprio
//    mes (sem snapshot mensal, mantem o % salvo em vez de usar o TACoS de outro periodo); imposto padrao 5,5%
//    (era 4,5%); receita do mes lida com range (sem corte de 1.000 linhas);
//  * reabrir_mes (novo): destrava o mes; % do custo fixo volta a ser recalculado.
// v7 (07/10/2026): durante o mes valem os % do ultimo mes fechado; o fechamento grava os reais.
//  * TACoS do mes (1o ao ultimo dia): se o snapshot mensal ainda nao existe, coleta no ML na hora
//    (ml-fechar-mes da conta Ocelot); sem TACoS real, NAO fecha (antes caia no % salvo).
//  * reabrir_mes recusa se o repasse do mes ja foi registrado (desfazer o registro antes).
function mesAtualBRT(){const d=new Date(Date.now()-3*3600*1000);return d.toISOString().slice(0,7)+"-01";}
function proximoMes(m:string){const dt=new Date(m+"T00:00:00Z");return new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth()+1,1)).toISOString().slice(0,10);}
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  const {data:{user}}=await supabase.auth.getUser(jwt);
  if(!user)return json({error:"unauthorized"},401);
  { const { data: _pode } = await supabase.rpc("app_pode", { p_uid: user.id, p_chave: "editar_cadastro" });
    if (!_pode) return json({ error: "sem permissao" }, 403); }
  let body:any={};try{body=await req.json();}catch(_){}
  const tipo=body.tipo;
  // v4 (09/09/2026): o cadastro de CMV passou a ser por SKU (atributo SELLER_SKU do anuncio).
  // A linha em ocelot_custos_sku agora tem OU sku preenchido (item_id null) OU item_id preenchido
  // (sku null, usado so pros anuncios que nao tem SKU no ML) -- garantido por check constraint.
  // Uma linha por SKU+mes vale pra TODOS os anuncios daquele SKU. Salvar aqui tambem limpa os
  // marcadores conferir/conflito, porque salvar = o Tiago confirmou o valor daquele SKU.
  // Upsert manual (select -> update/insert) em vez de .upsert(): os indices unicos sao PARCIAIS
  // (where sku is not null / where item_id is not null) e o PostgREST nao resolve onConflict neles.
  if(tipo==="custo"){
    const {mes_competencia,custo_unitario,observacao}=body;
    const sku=(body.sku==null||String(body.sku).trim()==="")?null:String(body.sku).trim();
    const item_id=(body.item_id==null||String(body.item_id).trim()==="")?null:String(body.item_id).trim().toUpperCase();
    if(!mes_competencia||custo_unitario==null)return json({error:"faltando mes_competencia/custo_unitario"},400);
    if(!sku&&!item_id)return json({error:"informe sku ou item_id"},400);
    if(sku&&item_id)return json({error:"informe sku OU item_id, nao os dois"},400);
    let sel=supabase.from("ocelot_custos_sku").select("id").eq("conta_id",OCELOT_CONTA).eq("mes_competencia",mes_competencia);
    sel=sku?sel.eq("sku",sku):sel.eq("item_id",item_id).is("sku",null);
    const {data:ex}=await sel.maybeSingle();
    const patch:any={custo_unitario,observacao:observacao||null,conferir:false,conflito:null,atualizado_em:new Date().toISOString()};
    if(ex){
      const {error}=await supabase.from("ocelot_custos_sku").update(patch).eq("id",ex.id);
      if(error)return json({error:error.message},500);
    }else{
      const {error}=await supabase.from("ocelot_custos_sku").insert({conta_id:OCELOT_CONTA,sku,item_id,mes_competencia,...patch});
      if(error)return json({error:error.message},500);
    }
    return json({ok:true,chave:sku?("sku:"+sku):("mlb:"+item_id)});
  }
  // v4: apagar uma linha de custo cadastrado (por id).
  if(tipo==="custo_apagar"){
    const {id}=body;
    if(!id)return json({error:"faltando id"},400);
    const {error}=await supabase.from("ocelot_custos_sku").delete().eq("conta_id",OCELOT_CONTA).eq("id",id);
    if(error)return json({error:error.message},500);
    return json({ok:true});
  }
  // v1 (07/08/2026): grava quem banca o CMV de UMA venda especifica (order_id+item_id), pro seletor
  // Ocelot/Miguel/Alan que aparece ao lado do CMV na "DRE por venda".
  if(tipo==="responsavel"){
    const {order_id,item_id,responsavel_cmv}=body;
    if(!order_id||!item_id||!responsavel_cmv)return json({error:"faltando order_id/item_id/responsavel_cmv"},400);
    if(["ocelot","miguel","alan"].indexOf(responsavel_cmv)===-1)return json({error:"responsavel_cmv invalido (use ocelot|miguel|alan)"},400);
    const {error}=await supabase.from("ocelot_vendas_itens").update({responsavel_cmv}).eq("conta_id",OCELOT_CONTA).eq("order_id",order_id).eq("item_id",item_id);
    if(error)return json({error:error.message},500);
    return json({ok:true});
  }
  if(tipo==="parametros"){
    const {mes_competencia,imposto_pct,gestao_pct,ads_pct,custo_fixo_mensal}=body;
    if(!mes_competencia)return json({error:"faltando mes_competencia"},400);
    const {data:ex}=await supabase.from("ocelot_parametros").select("id,fechado").eq("conta_id",OCELOT_CONTA).eq("mes_competencia",mes_competencia).maybeSingle();
    if(ex?.fechado)return json({error:"Mês fechado: reabra o mês antes de alterar os percentuais."},409);
    const patch:any={atualizado_em:new Date().toISOString()};
    if(imposto_pct!=null)patch.imposto_pct=imposto_pct;
    if(gestao_pct!=null)patch.gestao_pct=gestao_pct;
    if(ads_pct!=null)patch.ads_pct=ads_pct;
    if(custo_fixo_mensal!=null)patch.custo_fixo_mensal=custo_fixo_mensal;
    if(ex){const {error}=await supabase.from("ocelot_parametros").update(patch).eq("id",ex.id);if(error)return json({error:error.message},500);}
    else{const {error}=await supabase.from("ocelot_parametros").insert({conta_id:OCELOT_CONTA,mes_competencia,...patch});if(error)return json({error:error.message},500);}
    return json({ok:true});
  }
  if(tipo==="fechar_mes"){
    const {mes_competencia}=body;
    if(!mes_competencia||!/^\d{4}-\d{2}-01$/.test(mes_competencia))return json({error:"faltando mes_competencia (AAAA-MM-01)"},400);
    if(mes_competencia>=mesAtualBRT())return json({error:"Só dá para fechar um mês que já terminou."},409);
    const nextMonth=proximoMes(mes_competencia);
    const {data:aggReal}=await supabase.from("ocelot_vendas_itens").select("valor_venda,valor_liquido,status").eq("conta_id",OCELOT_CONTA).gte("data_venda",mes_competencia).lt("data_venda",nextMonth).range(0,9999);
    const naoCancelados=(aggReal||[]).filter((r:any)=>r.status!=="cancelled");
    const receitaBruta=naoCancelados.reduce((s:number,r:any)=>s+Number(r.valor_venda||0),0);
    const receitaLiquida=naoCancelados.reduce((s:number,r:any)=>s+Number(r.valor_liquido||0),0);
    const {data:p}=await supabase.from("ocelot_parametros").select("*").eq("conta_id",OCELOT_CONTA).eq("mes_competencia",mes_competencia).maybeSingle();
    if(p?.fechado)return json({error:"Este mês já está fechado."},409);
    const custoFixo=p?Number(p.custo_fixo_mensal):800;
    const fixoPct=receitaBruta>0?Math.min(50,(custoFixo/receitaBruta)*100):0;
    const lerTacos=async()=>{const {data}=await supabase.from("snapshots").select("tacos").eq("conta_id",OCELOT_CONTA).eq("granularidade","mensal").eq("periodo_inicio",mes_competencia).not("tacos","is",null).limit(1).maybeSingle();return data?Number(data.tacos)*100:null;};
    let tacosMes=await lerTacos();
    let coletouAgora=false;
    if(tacosMes==null){
      // coleta o TACoS do mes inteiro (1o ao ultimo dia) no ML; o segredo do coletor fica so no servidor
      const {data:cfg}=await supabase.from("app_config").select("v").eq("k","collector_secret").single();
      try{
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ml-fechar-mes?mes=${mes_competencia.slice(0,7)}&conta_id=${OCELOT_CONTA}`,{method:"POST",headers:{"x-collector-secret":cfg?.v||""}});
      }catch(_){/* trata abaixo */}
      tacosMes=await lerTacos();coletouAgora=true;
    }
    if(tacosMes==null)return json({error:"Não foi possível obter o TACoS de "+mes_competencia.slice(0,7)+" no Mercado Livre (1º ao último dia do mês). O mês não foi fechado; tente de novo mais tarde."},409);
    const adsPctCongelado=tacosMes;
    const {error}=await supabase.from("ocelot_parametros").upsert({conta_id:OCELOT_CONTA,mes_competencia,custo_fixo_mensal:custoFixo,imposto_pct:p?.imposto_pct??5.5,gestao_pct:p?.gestao_pct??5.5,ads_pct:adsPctCongelado,receita_liquida_mes:receitaLiquida,fixo_pct_calculado:fixoPct,fechado:true,atualizado_em:new Date().toISOString()},{onConflict:"conta_id,mes_competencia"});
    if(error)return json({error:error.message},500);
    return json({ok:true,receita_bruta_mes:receitaBruta,receita_liquida_mes:receitaLiquida,fixo_pct_calculado:fixoPct,ads_pct_congelado:adsPctCongelado,ads_origem:"tacos_mensal",tacos_coletado_agora:coletouAgora});
  }
  if(tipo==="reabrir_mes"){
    const {mes_competencia}=body;
    if(!mes_competencia)return json({error:"faltando mes_competencia"},400);
    const {data:p}=await supabase.from("ocelot_parametros").select("id,fechado").eq("conta_id",OCELOT_CONTA).eq("mes_competencia",mes_competencia).maybeSingle();
    if(!p||!p.fechado)return json({error:"Este mês não está fechado."},409);
    // v7: com repasse registrado, reabrir mudaria os % de vendas ja pagas
    const {data:regs}=await supabase.from("ocelot_pagamentos_fornecedor").select("fornecedor_id").eq("conta_id",OCELOT_CONTA).eq("mes_competencia",mes_competencia).eq("pago",true);
    if((regs||[]).length)return json({error:"O repasse deste mês já foi registrado para "+(regs||[]).length+" fornecedor(es). Desfaça o registro na aba Repasse a fornecedores antes de reabrir o mês."},409);
    const {error}=await supabase.from("ocelot_parametros").update({fechado:false,fixo_pct_calculado:null,receita_liquida_mes:null,atualizado_em:new Date().toISOString()}).eq("id",p.id);
    if(error)return json({error:error.message},500);
    return json({ok:true});
  }
  return json({error:"tipo invalido (use custo|custo_apagar|responsavel|parametros|fechar_mes|reabrir_mes)"},400);
});
