import { createClient } from "jsr:@supabase/supabase-js@2";
const API="https://api.mercadolibre.com";const CLIENT_ID="6065152162276049";
const OCELOT_CONTA="30fa53d4-60c0-40f6-9832-63b4cb313797";const OCELOT_UID=1781963191;
const BRT=3*3600*1000;
function json(o:unknown,s=200){return new Response(JSON.stringify(o),{status:s,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,content-type,x-collector-secret,apikey","Access-Control-Allow-Methods":"GET,POST,OPTIONS"}});}
async function getToken(supabase:any,c:string){const {data:cr}=await supabase.from("credenciais_ml").select("*").eq("conta_id",c).single();if(!cr)throw new Error("sem cred");if(new Date(cr.expires_at).getTime()-Date.now()>6e5)return cr.access_token;const b=new URLSearchParams({grant_type:"refresh_token",client_id:CLIENT_ID,client_secret:Deno.env.get("ML_CLIENT_SECRET")!,refresh_token:cr.refresh_token});const r=await fetch(`${API}/oauth/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:b});const t=await r.json();await supabase.from("credenciais_ml").update({access_token:t.access_token,refresh_token:t.refresh_token,expires_at:new Date(Date.now()+(t.expires_in??21600)*1000).toISOString()}).eq("conta_id",c);return t.access_token;}
async function g(u:string,h:any){try{const r=await fetch(u,{headers:h});if(!r.ok)return null;return await r.json();}catch(_){return null;}}
// v5 (25/07/2026): passou a persistir buyer_id/buyer_nickname/shipping_id.
// v6 (03/08/2026): BUG CRITICO corrigido -- teto rigido de offset>=1000 numa unica janela [from,to]
// causava perda silenciosa de pedidos mais antigos quando o volume no periodo passava de 1000.
// Fix: janela total dividida em pedacos de 7 dias, paginacao reinicia a cada pedaco.
// v7 (03/08/2026): aceita params opcionais from/to (ISO) para permitir backfill em janelas
// pequenas e explicitas (usado para reprocessar julho/2026 inteiro sem estourar o timeout de
// 150s do edge function em uma chamada so). Se from/to nao vierem, comportamento antigo (dias
// trailing a partir de agora) e mantido.
// v9 (04/10/2026): dois bugs achados na conciliacao de setembro com a planilha do Tiago:
//  (1) sale_fee do ML e POR UNIDADE -- a tarifa gravada ignorava a quantidade (venda de 2 un
//      descontava a tarifa de 1). Agora taxa_ml = sale_fee * quantidade.
//  (2) data_venda somava 3h ao UTC em vez de subtrair -- venda das 21h+ (horario de Brasilia)
//      do dia 28 caia certo, mas a das 18h-21h do ultimo dia do mes caia no mes seguinte.
//      Agora data_venda = date_created convertido para o horario de Brasilia (UTC-3).
// v10 (05/10/2026): data da venda = data de APROVACAO do pedido (date_closed), igual ao relatorio
// de vendas do ML (pedido do Tiago). Ex.: pedido criado 29/08 e pago 04/09 conta em setembro.
// Como a busca do ML e por date_created, a janela de busca volta FOLGA_DIAS a mais para pegar
// pedidos criados antes e aprovados dentro do periodo. Sem date_closed (nao aprovado), usa date_created.
const FOLGA_DIAS=15;
// v11 (05/10/2026): grava pagamento_status_detail (status_detail do pagamento no Mercado Pago).
// Em mediacao, "bpp_covered" = o ML cobriu (vendedor fica com o dinheiro, fornecedor recebe CMV normal);
// "bpp_refunded" = o reembolso saiu do vendedor (prejuizo cobrado do fornecedor).
// v12 (06/10/2026): Dashboard de Vendas.
//  (1) por=atualizacao busca pedidos por order.date_last_updated (pega aprovacao, cancelamento e
//      devolucao recentes de pedidos criados antes da janela). Sem o parametro, nada muda.
//      Se o ML recusar esse filtro, cai para date_created e avisa na resposta.
//  (2) falha da busca no ML deixava de ser silenciosa: a resposta traz ok=false e o erro.
//  (3) toda execucao vai para ml_sync_vendas_log (base do "ultima sincronizacao" e do
//      "pula se sincronizou ha menos de 2 min"). origem: cron (segredo), painel (segredo + origem=painel), manual (JWT).
function pagamentoPrincipal(payments:any[]){
  if(!payments||!payments.length)return {forma_pagamento:null,parcelas:null,status_detail:null};
  const aprovado=payments.find((p:any)=>p.status==="approved")||payments[0];
  const cobertura=payments.find((p:any)=>p.status_detail==="bpp_covered");
  return {forma_pagamento:aprovado.payment_type??null,parcelas:aprovado.installments??null,
          status_detail:(cobertura||aprovado).status_detail??null};
}
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,content-type,x-collector-secret,apikey","Access-Control-Allow-Methods":"GET,POST,OPTIONS"}});
  const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const secret=req.headers.get("x-collector-secret");
  const {data:cfg}=await supabase.from("app_config").select("v").eq("k","collector_secret").single();
  let authed=!!secret&&!!cfg&&secret===cfg.v;
  const viaSegredo=authed;let usuarioId:string|null=null;
  if(!authed){const jwt=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");const {data:{user}}=await supabase.auth.getUser(jwt);authed=!!user;usuarioId=user?.id??null;
  if(user){ const { data: _pode } = await supabase.rpc("app_pode", { p_uid: user.id, p_chave: "ocelot" });
    if (!_pode) return json({ error: "sem permissao" }, 403); }}
  if(!authed)return json({error:"unauthorized"},401);
  const url=new URL(req.url);
  const dias=Number(url.searchParams.get("dias")||"30");
  const fromParam=url.searchParams.get("from");
  const toParam=url.searchParams.get("to");
  const semFolga=url.searchParams.get("folga")==="0";
  const porAtualizacao=url.searchParams.get("por")==="atualizacao";
  const origemParam=url.searchParams.get("origem");
  const origem=viaSegredo?(origemParam==="painel"?"painel":"cron"):"manual";
  const usuarioLog=viaSegredo?(/^[0-9a-f-]{36}$/.test(url.searchParams.get("usuario")||"")?url.searchParams.get("usuario"):null):usuarioId;
  async function logar(ok:boolean,extra:Record<string,unknown>){
    await supabase.from("ml_sync_vendas_log").insert({conta_id:OCELOT_CONTA,origem,usuario_id:usuarioLog,ok,...extra});
  }
  let tok:string;
  try{tok=await getToken(supabase,OCELOT_CONTA);if(!tok)throw new Error("token do ML indisponivel");}
  catch(e){await logar(false,{erro:String((e as Error).message||e).slice(0,300)});return json({ok:false,erro:"token do ML indisponivel"},502);}
  const h={Authorization:`Bearer ${tok}`};
  let fromMs:number,toMs:number;
  if(fromParam&&toParam){
    fromMs=new Date(fromParam).getTime();
    toMs=new Date(toParam).getTime();
  }else{
    const now=new Date();
    fromMs=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())-((dias-1)*86400000)-BRT;
    toMs=Date.now();
  }
  if(!semFolga)fromMs-=FOLGA_DIAS*86400000;
  const from=new Date(fromMs).toISOString();
  const to=new Date(toMs).toISOString();
  const WEEK=7*86400000;
  let ordersRaw:any[]=[];
  let cursor=fromMs;
  let campoBusca=porAtualizacao?"date_last_updated":"date_created";
  let aviso:string|null=null;
  const falhasBusca:string[]=[];
  async function buscar(campo:string,cf:string,ct:string,offset:number,limit:number){
    try{const r=await fetch(`${API}/orders/search?seller=${OCELOT_UID}&order.${campo}.from=${cf}&order.${campo}.to=${ct}&sort=date_desc&limit=${limit}&offset=${offset}`,{headers:h});
      if(!r.ok)return {ok:false,status:r.status,json:null};return {ok:true,status:r.status,json:await r.json()};}
    catch(_){return {ok:false,status:0,json:null};}
  }
  while(cursor<toMs){
    const chunkEndMs=Math.min(cursor+WEEK,toMs);
    const chunkFrom=new Date(cursor).toISOString();
    const chunkTo=new Date(chunkEndMs).toISOString();
    let offset=0;const limit=50;
    for(let p=0;p<40;p++){
      let rr=await buscar(campoBusca,chunkFrom,chunkTo,offset,limit);
      if(!rr.ok&&campoBusca==="date_last_updated"&&offset===0&&rr.status===400){
        campoBusca="date_created";aviso="ML recusou a busca por data de atualizacao; usada a data de criacao";
        rr=await buscar(campoBusca,chunkFrom,chunkTo,offset,limit);
      }
      if(!rr.ok){falhasBusca.push(`busca de pedidos ${chunkFrom.slice(0,10)}: ML ${rr.status||"sem resposta"}`);break;}
      const sr=rr.json;
      if(!sr||!sr.results||!sr.results.length)break;
      ordersRaw=ordersRaw.concat(sr.results);
      offset+=limit;
      if(offset>=(sr.paging?.total??0))break;
    }
    cursor=chunkEndMs;
  }
  const shipCache:Record<string,number|null>={};
  async function freteVendedor(shipId:number){
    const key=String(shipId);
    if(key in shipCache)return shipCache[key];
    const s=await g(`${API}/shipments/${shipId}`,h);
    const opt=s?.shipping_option;
    let v:number|null=null;
    if(opt&&typeof opt.list_cost==="number"&&typeof opt.cost==="number"){v=Math.max(0,opt.list_cost-opt.cost);}
    shipCache[key]=v;return v;
  }
  let gravados=0,erros=0;
  for(const o of ordersRaw){
    try{
      const items=o.order_items||[];
      if(!items.length)continue;
      const dataRef=o.date_closed||o.date_created;
      const dataVendaDt=new Date(dataRef);
      const dataVenda=new Date(dataVendaDt.getTime()-BRT).toISOString().slice(0,10);
      const valorTotalPedido=items.reduce((s:number,it:any)=>s+(Number(it.unit_price||0)*Number(it.quantity||1)),0);
      let freteTotal:number|null=null;
      if(o.shipping?.id)freteTotal=await freteVendedor(o.shipping.id);
      const devolvidoTotal=(o.payments||[]).reduce((s:number,p:any)=>s+Number(p.transaction_amount_refunded||0),0);
      const {forma_pagamento,parcelas,status_detail}=pagamentoPrincipal(o.payments||[]);
      const buyerId=o.buyer?.id??null;
      const buyerNickname=o.buyer?.nickname??null;
      const shippingId=o.shipping?.id??null;
      for(const it of items){
        const itemId=it.item?.id;if(!itemId)continue;
        const qtd=Number(it.quantity||1);
        const valorVenda=Number(it.unit_price||0)*qtd;
        const taxaMl=Number(it.sale_fee||0)*qtd;
        const share=(valorTotalPedido>0)?(valorVenda/valorTotalPedido):0;
        const freteItem=(freteTotal!=null)?(freteTotal*share):null;
        const devolvidoItem=devolvidoTotal>0?(devolvidoTotal*share):0;
        const valorLiquido=valorVenda-taxaMl-(freteItem||0)-devolvidoItem;
        const {error}=await supabase.from("ocelot_vendas_itens").upsert({
          conta_id:OCELOT_CONTA,order_id:o.id,pack_id:o.pack_id||null,item_id:itemId,titulo:it.item?.title||null,
          quantidade:qtd,preco_unitario:it.unit_price,valor_venda:valorVenda,taxa_ml:taxaMl,frete_vendedor:freteItem,
          valor_devolvido:devolvidoItem,valor_liquido:valorLiquido,status:o.status,data_venda:dataVenda,data_venda_ts:dataRef,
          forma_pagamento,parcelas,pagamento_status_detail:status_detail,buyer_id:buyerId,buyer_nickname:buyerNickname,shipping_id:shippingId,captured_at:new Date().toISOString()
        },{onConflict:"conta_id,order_id,item_id"});
        if(error)erros++;else gravados++;
      }
    }catch(_e){erros++;}
  }
  const okFinal=falhasBusca.length===0&&erros===0;
  const erroTxt=[...falhasBusca,...(erros?[`${erros} linha(s) com erro ao gravar`]:[])].join("; ")||null;
  await logar(okFinal,{janela_de:from,janela_ate:to,pedidos:ordersRaw.length,linhas:gravados,erro:erroTxt});
  return json({ok:okFinal,pedidos_encontrados:ordersRaw.length,linhas_gravadas:gravados,erros,periodo:{from,to},busca_por:campoBusca,aviso,falhas:falhasBusca});
});
