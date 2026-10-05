import { createClient } from "jsr:@supabase/supabase-js@2";
const OCELOT_CONTA="30fa53d4-60c0-40f6-9832-63b4cb313797";
const MIGUEL_ID="9e88add9-8405-46db-8bd4-e128ee9ce65a";
const ALAN_ID="e7e5a84c-9294-4d80-a251-d3f36dc83d46";
const CMV_PISO=40, CMV_TETO=90;
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,content-type,apikey","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
function json(o:unknown,s=200){return new Response(JSON.stringify(o),{status:s,headers:{...cors,"Content-Type":"application/json"}});}
function mesDe(dataVenda:string){return dataVenda.slice(0,7)+"-01";}
function elegivelPisoTeto(titulo:string,fidFornecedor:string|null|undefined){
  const t=(titulo||"").toLowerCase();
  if(fidFornecedor===MIGUEL_ID)return t.indexOf("cuba")!==-1;
  if(fidFornecedor===ALAN_ID)return t.indexOf("balan")!==-1;
  return false;
}
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  const {data:{user}}=await supabase.auth.getUser(jwt);
  if(!user)return json({error:"unauthorized"},401);
  { const { data: _pode } = await supabase.rpc("app_pode", { p_uid: user.id, p_chave: "editar_cadastro" });
    if (!_pode) return json({ error: "sem permissao" }, 403); }
  const body=await req.json().catch(()=>({}));

  if(body.tipo==="mapear_item"){
    const {error}=await supabase.from("ocelot_item_fornecedor").upsert({
      conta_id:OCELOT_CONTA,item_id:body.item_id,fornecedor_id:body.fornecedor_id||null,
      observacao:body.observacao||"editado manualmente",atualizado_em:new Date().toISOString()
    },{onConflict:"conta_id,item_id"});
    if(error)return json({error:error.message},400);
    return json({ok:true});
  }

  if(body.tipo==="registrar_reclamacao"){
    const {fornecedor_id,order_id,item_id,mes_competencia,valor,de_quem,observacao}=body;
    if(!mes_competencia||valor==null||!de_quem)return json({error:"mes_competencia, valor e de_quem sao obrigatorios"},400);
    if(de_quem!=="tiago"&&de_quem!=="fornecedor")return json({error:"de_quem deve ser 'tiago' ou 'fornecedor'"},400);
    const {error}=await supabase.from("ocelot_custo_reclamacao").insert({
      conta_id:OCELOT_CONTA,fornecedor_id:fornecedor_id||null,order_id:order_id||null,item_id:item_id||null,
      mes_competencia,valor:Number(valor),de_quem,observacao:observacao||null
    });
    if(error)return json({error:error.message},400);
    return json({ok:true});
  }

  if(body.tipo==="remover_reclamacao"){
    const {error}=await supabase.from("ocelot_custo_reclamacao").delete().eq("conta_id",OCELOT_CONTA).eq("id",body.id).eq("aplicado",false);
    if(error)return json({error:error.message},400);
    return json({ok:true});
  }

  // v8 (05/10/2026): registro do repasse feito pela DRE sintetica (quadro "Repasse aos fornecedores").
  // A tela manda o CMV de cada venda do mes (o que esta sendo pago) e os estornos aplicados. Grava:
  //  - ocelot_pagamento_itens: CMV pago por venda (snapshot) -- se a venda for devolvida depois, o estorno
  //    usa exatamente esse valor (regra do Tiago: descontar o mesmo CMV que foi pago);
  //  - ocelot_estorno_detalhe: cada devolucao descontada neste repasse (nao desconta de novo depois);
  //  - ocelot_pagamentos_fornecedor: totais do mes (produtos, estorno, valor transferido).
  if(body.tipo==="registrar_repasse"){
    const FORN:Record<string,string>={miguel:MIGUEL_ID,alan:ALAN_ID};
    const fornecedorId=FORN[String(body.fornecedor||"")];
    const mes=body.mes_competencia;
    if(!fornecedorId||!mes)return json({error:"fornecedor (miguel/alan) e mes_competencia obrigatorios"},400);
    const itens=Array.isArray(body.itens)?body.itens:[];
    const estornos=Array.isArray(body.estornos)?body.estornos:[];
    const valorProdutos=Number(body.valor_produtos||0), valorEstorno=Number(body.valor_estorno||0);
    await supabase.from("ocelot_pagamento_itens").delete().eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).eq("mes_competencia",mes);
    await supabase.from("ocelot_estorno_detalhe").delete().eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).eq("mes_absorcao",mes);
    const linhas=itens.map((it:any)=>({conta_id:OCELOT_CONTA,fornecedor_id:fornecedorId,mes_competencia:mes,order_id:it.order_id,item_id:it.item_id,
      titulo:it.titulo||null,quantidade:Number(it.quantidade)||1,data_venda:it.data_venda,cmv_pago:Number(it.cmv||0)}));
    for(let i=0;i<linhas.length;i+=500){
      const {error}=await supabase.from("ocelot_pagamento_itens").insert(linhas.slice(i,i+500));
      if(error)return json({error:"itens: "+error.message},400);
    }
    if(estornos.length){
      const {error}=await supabase.from("ocelot_estorno_detalhe").insert(estornos.map((e:any)=>({conta_id:OCELOT_CONTA,fornecedor_id:fornecedorId,
        mes_origem:e.mes_origem,mes_absorcao:mes,order_id:e.order_id,item_id:e.item_id,titulo:e.titulo||null,data_venda:e.data_venda||null,
        valor_pago_antes:Number(e.cmv_pago||0),valor_atual:-Number(e.prejuizo||0),diferenca:Number(e.total||0)})));
      if(error)return json({error:"estornos: "+error.message},400);
    }
    const {error:upErr}=await supabase.from("ocelot_pagamentos_fornecedor").upsert({
      conta_id:OCELOT_CONTA,fornecedor_id:fornecedorId,mes_competencia:mes,pago:true,valor_pago:valorProdutos,
      estorno_aplicado:valorEstorno,valor_transferido:valorProdutos-valorEstorno,estorno_absorvido_por:null,
      data_pagamento:new Date().toISOString(),atualizado_em:new Date().toISOString()
    },{onConflict:"conta_id,fornecedor_id,mes_competencia"});
    if(upErr)return json({error:upErr.message},400);
    return json({ok:true,itens:linhas.length,estornos:estornos.length});
  }

  if(body.tipo==="desfazer_repasse"){
    const FORN:Record<string,string>={miguel:MIGUEL_ID,alan:ALAN_ID};
    const fornecedorId=FORN[String(body.fornecedor||"")];
    const mes=body.mes_competencia;
    if(!fornecedorId||!mes)return json({error:"fornecedor (miguel/alan) e mes_competencia obrigatorios"},400);
    await supabase.from("ocelot_pagamento_itens").delete().eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).eq("mes_competencia",mes);
    await supabase.from("ocelot_estorno_detalhe").delete().eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).eq("mes_absorcao",mes);
    await supabase.from("ocelot_pagamentos_fornecedor").delete().eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).eq("mes_competencia",mes);
    return json({ok:true});
  }

  if(body.tipo==="marcar_pago"){
    const fornecedorId=body.fornecedor_id, mes=body.mes_competencia;
    if(!fornecedorId||!mes)return json({error:"fornecedor_id e mes_competencia obrigatorios"},400);

    const {data:mapa}=await supabase.from("ocelot_item_fornecedor").select("*").eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId);
    const itemIds=(mapa||[]).map((m:any)=>m.item_id);
    const {data:vendas}=await supabase.from("ocelot_vendas_itens").select("*").eq("conta_id",OCELOT_CONTA).in("item_id",itemIds.length?itemIds:["__none__"]);
    const {data:custos}=await supabase.from("ocelot_custos_sku").select("*").eq("conta_id",OCELOT_CONTA);
    const {data:parametros}=await supabase.from("ocelot_parametros").select("*").eq("conta_id",OCELOT_CONTA);
    const custoMap:Record<string,number>={};
    for(const c of (custos||[]))custoMap[c.item_id+"|"+c.mes_competencia]=Number(c.custo_unitario);
    const paramMap:Record<string,any>={};
    for(const p of (parametros||[]))paramMap[p.mes_competencia]=p;
    const mesesPresentes=new Set<string>();
    for(const v of (vendas||[]))mesesPresentes.add(mesDe(v.data_venda));
    const {data:snapsAll}=await supabase.from("snapshots").select("periodo_inicio,periodo_fim,tacos,granularidade").eq("conta_id",OCELOT_CONTA).not("tacos","is",null).order("periodo_fim",{ascending:false}).limit(40);
    const tacosPctMap:Record<string,number>={};
    for(const m of mesesPresentes){
      const exato=(snapsAll||[]).find((s:any)=>s.granularidade==="mensal"&&s.periodo_inicio===m);
      if(exato){tacosPctMap[m]=Number(exato.tacos)*100;continue;}
      const recente=(snapsAll||[])[0];
      if(recente)tacosPctMap[m]=Number(recente.tacos)*100;
    }
    const fixoPctMap:Record<string,number>={};
    for(const m of mesesPresentes){
      const p=paramMap[m]||{custo_fixo_mensal:800,fechado:false};
      if(p.fechado&&p.fixo_pct_calculado!=null){fixoPctMap[m]=Number(p.fixo_pct_calculado);continue;}
      const dt=new Date(m+"T00:00:00Z");const nextMes=new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth()+1,1)).toISOString().slice(0,10);
      const {data:aggMes}=await supabase.from("ocelot_vendas_itens").select("valor_venda,status").eq("conta_id",OCELOT_CONTA).gte("data_venda",m).lt("data_venda",nextMes).neq("status","cancelled");
      const receitaBrutaMes=(aggMes||[]).reduce((s:number,r:any)=>s+Number(r.valor_venda||0),0);
      fixoPctMap[m]=receitaBrutaMes>0?Math.min(50,(Number(p.custo_fixo_mensal)/receitaBrutaMes)*100):0;
    }
    function cmvDoItem(v:any){
      if(v.status==="cancelled")return 0;
      const m=mesDe(v.data_venda);
      const p=paramMap[m]||{imposto_pct:4.5,gestao_pct:5.5,ads_pct:5};
      const valorVenda=Number(v.valor_venda), valorLiquido=Number(v.valor_liquido);
      const custoManual=custoMap[v.item_id+"|"+m];
      if(custoManual!=null)return custoManual*Number(v.quantidade);
      const valorDevolvido=Number(v.valor_devolvido||0);
      const valorVendaEfetivo=Math.max(0,valorVenda-valorDevolvido);
      if(valorVendaEfetivo<=0)return 0; // devolucao total: sem imposto/custo/CMV
      const adsPct=p.fechado?Number(p.ads_pct):(tacosPctMap[m]??Number(p.ads_pct));
      const pctTotal=Number(p.imposto_pct)+Number(p.gestao_pct)+adsPct+(fixoPctMap[m]||0);
      const bruto=valorLiquido-(valorVendaEfetivo*pctTotal/100);
      if(elegivelPisoTeto(v.titulo,fornecedorId)){
        const qtd=Number(v.quantidade)||1;
        const unit=bruto/qtd;
        if(unit<CMV_PISO)return CMV_PISO*qtd;
        if(unit>CMV_TETO)return CMV_TETO*qtd;
      }
      return bruto;
    }
    const totalPorMes:Record<string,number>={};
    const itensPorMes:Record<string,any[]>={};
    for(const v of (vendas||[])){
      if(v.status==="cancelled")continue;
      const m=mesDe(v.data_venda);
      const cmv=cmvDoItem(v);
      totalPorMes[m]=(totalPorMes[m]||0)+cmv;
      (itensPorMes[m]=itensPorMes[m]||[]).push({order_id:v.order_id,item_id:v.item_id,titulo:v.titulo,quantidade:v.quantidade,data_venda:v.data_venda,cmv});
    }

    const {data:pagamentosAnteriores}=await supabase.from("ocelot_pagamentos_fornecedor").select("*").eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).eq("pago",true).is("estorno_absorvido_por",null);
    let estornoADeduzir=0;
    const mesesParaMarcarAbsorvido:string[]=[];
    for(const pag of (pagamentosAnteriores||[])){
      if(pag.mes_competencia===mes)continue;
      const atual=totalPorMes[pag.mes_competencia]||0;
      const delta=Math.max(0,Number(pag.valor_pago||0)-atual);
      if(delta>0.005){estornoADeduzir+=delta;mesesParaMarcarAbsorvido.push(pag.mes_competencia);}
    }

    const detalhesEstornoParaInserir:any[]=[];
    for(const mesOrigem of mesesParaMarcarAbsorvido){
      const {data:snapshotItens}=await supabase.from("ocelot_pagamento_itens").select("*").eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).eq("mes_competencia",mesOrigem);
      const atuaisMap:Record<string,number>={};
      for(const it of (itensPorMes[mesOrigem]||[]))atuaisMap[String(it.order_id)+"|"+it.item_id]=it.cmv;
      for(const snap of (snapshotItens||[])){
        const chave=String(snap.order_id)+"|"+snap.item_id;
        const atual=atuaisMap[chave]??0;
        const diferenca=Number(snap.cmv_pago)-atual;
        if(diferenca>0.005){
          detalhesEstornoParaInserir.push({
            conta_id:OCELOT_CONTA,fornecedor_id:fornecedorId,mes_origem:mesOrigem,mes_absorcao:mes,
            order_id:snap.order_id,item_id:snap.item_id,titulo:snap.titulo,data_venda:snap.data_venda,
            valor_pago_antes:snap.cmv_pago,valor_atual:atual,diferenca
          });
        }
      }
    }
    if(detalhesEstornoParaInserir.length){
      await supabase.from("ocelot_estorno_detalhe").insert(detalhesEstornoParaInserir);
    }

    const {data:reclamacoesPendentes}=await supabase.from("ocelot_custo_reclamacao").select("*").eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).eq("de_quem","fornecedor").eq("aplicado",false);
    let reclamacaoADeduzir=0;
    const idsReclamacaoAplicar:string[]=[];
    for(const r of (reclamacoesPendentes||[])){
      reclamacaoADeduzir+=Number(r.valor);
      idsReclamacaoAplicar.push(r.id);
    }
    if(idsReclamacaoAplicar.length){
      await supabase.from("ocelot_custo_reclamacao").update({aplicado:true,mes_absorcao:mes}).in("id",idsReclamacaoAplicar);
    }

    const totalMesAtual=totalPorMes[mes]||0;
    const valorTransferido=Math.max(0,totalMesAtual-estornoADeduzir-reclamacaoADeduzir);

    const {error:upErr}=await supabase.from("ocelot_pagamentos_fornecedor").upsert({
      conta_id:OCELOT_CONTA,fornecedor_id:fornecedorId,mes_competencia:mes,
      pago:true,valor_pago:totalMesAtual,valor_transferido:valorTransferido,estorno_aplicado:estornoADeduzir,
      data_pagamento:new Date().toISOString(),atualizado_em:new Date().toISOString()
    },{onConflict:"conta_id,fornecedor_id,mes_competencia"});
    if(upErr)return json({error:upErr.message},400);

    if(mesesParaMarcarAbsorvido.length){
      await supabase.from("ocelot_pagamentos_fornecedor").update({estorno_absorvido_por:mes}).eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",fornecedorId).in("mes_competencia",mesesParaMarcarAbsorvido);
    }

    const itensParaSnapshot=(itensPorMes[mes]||[]).map((it:any)=>({
      conta_id:OCELOT_CONTA,fornecedor_id:fornecedorId,mes_competencia:mes,
      order_id:it.order_id,item_id:it.item_id,titulo:it.titulo,quantidade:it.quantidade,
      data_venda:it.data_venda,cmv_pago:it.cmv
    }));
    if(itensParaSnapshot.length){
      await supabase.from("ocelot_pagamento_itens").upsert(itensParaSnapshot,{onConflict:"conta_id,fornecedor_id,mes_competencia,order_id,item_id"});
    }

    return json({ok:true,total_mes_atual:totalMesAtual,estorno_deduzido:estornoADeduzir,reclamacao_deduzida:reclamacaoADeduzir,valor_transferido:valorTransferido,meses_estorno_absorvido:mesesParaMarcarAbsorvido});
  }

  if(body.tipo==="desmarcar_pago"){
    const {error}=await supabase.from("ocelot_pagamentos_fornecedor").update({pago:false,estorno_absorvido_por:null}).eq("conta_id",OCELOT_CONTA).eq("fornecedor_id",body.fornecedor_id).eq("mes_competencia",body.mes_competencia);
    if(error)return json({error:error.message},400);
    return json({ok:true});
  }

  return json({error:"tipo invalido"},400);
});
