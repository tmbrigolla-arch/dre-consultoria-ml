// ml-ocelot-a-entregar v1 (09/10/2026) - aba "A entregar" da Gestao Ocelot.
// v2 (09/10/2026): so o que ainda depende da Ocelot. Saiu da lista: postado/coletado (o ML mostra "A caminho"
// mesmo com status ready_to_ship + substatus dropped_off/picked_up/in_hub), shipped, nao entregue e Full.
// v3 (18/10/2026): venda em fabricacao (pending/manufacturing) ficava sem data de envio e fora dos filtros
// Hoje/7 dias/Atrasadas (o /sla do ML vem vazio ate a fabricacao acabar); agora usa o fim do prazo de
// fabricacao do pedido (manufacturing_ending_date) como data de referencia.
// v4 (18/10/2026): custos por venda (taxa ML, frete, imposto, ads, custo fixo) e gestao, da mesma ocelot_vendas_calc
// da DRE por venda: valor - custos - gestao = repasse estimado.
// v5 (18/10/2026): SKU de cada item (para a busca da tela por MLB, SKU ou numero da venda).
// v6 (18/10/2026): separacao por fornecedor. Dono do item = ocelot_item_fornecedor, senao a palavra-chave
//   (ocelot_fornecedor_sugerido). Usuario em ocelot_usuario_fornecedor (Miguel, Alan) so recebe os itens do proprio
//   fornecedor + envios_extra (Miguel despacha os do Tiago), e o repasse so dos itens dele. Pacote misto mostra de
//   quem sao os outros itens; item sem dono aparece para todos com aviso. Saem da resposta os custos/gestao da v4.
//
// POST { }  -> vendas pagas que ainda nao foram entregues, agrupadas por venda (pacote = pack_id),
//              com prazo de despacho, previsao de entrega, itens (MLB + link), valor e repasse estimado.
//
// Fluxo:
//   1. sincroniza vendas novas no ML (ml-ocelot-vendas, mesma janela do Dashboard; pula se < 2 min);
//   2. pega as vendas pagas dos ultimos DIAS dias em ocelot_vendas_itens;
//   3. atualiza no ML (/shipments e /shipments/{id}/sla) os envios que ainda nao terminaram e cujo cache
//      em ocelot_entregas tem mais de CACHE_MIN minutos -- entregue/cancelado nao e consultado de novo;
//   4. repasse estimado = cmv de ocelot_vendas_calc (mesma regra da DRE por venda e do Repasse).
// So leitura no ML. Filtro por data de envio e feito na tela (a lista e pequena).
import { adminClient, CORS, exigirUsuario, json, ml } from "../_shared/ocelot.ts";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const DIAS = 30;                 // venda paga ha mais de 30 dias e ainda nao entregue = caso de mediacao, nao de expedicao
const CACHE_MIN = 3;             // envio consultado ha menos de 3 min nao vai ao ML de novo
const PARALELO = 8;
const SYNC_PULA_MIN = 2, JANELA_MIN_H = 2, JANELA_MAX_H = 48;
const FINAIS = new Set(["delivered", "cancelled", "shipped", "not_delivered"]);
// ready_to_ship com estes substatus = pacote ja entregue na agencia ou coletado pela transportadora
const ENTREGUE_AGENCIA = new Set(["dropped_off", "picked_up", "in_hub", "in_transit", "in_warehouse"]);
const saiuDaOcelot = (e: any) => !!e && (FINAIS.has(e.shipping_status) || ENTREGUE_AGENCIA.has(e.shipping_substatus)
  || !!e.data_envio || e.logistic_type === "fulfillment");

const dia = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : null);

async function emLotes<T>(lista: T[], n: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < lista.length; i += n) await Promise.all(lista.slice(i, i + n).map(fn));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();
  const u = await exigirUsuario(admin, req, "ocelot_entregas");
  if (u instanceof Response) return u;
  const { data: contasUsr } = await admin.rpc("app_contas", { p_uid: u.id });
  if (contasUsr !== null && !(contasUsr || []).includes(OCELOT_CONTA)) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);
  // escopo do usuario: sem linha = ve tudo (admin, expedicao)
  const { data: uf } = await admin.from("ocelot_usuario_fornecedor").select("fornecedor_id, envios_extra").eq("user_id", u.id).maybeSingle();
  const veEnvio = uf ? new Set<string>([uf.fornecedor_id, ...(uf.envios_extra || [])]) : null;
  const veRepasse = (f: string | null) => !uf || f === uf.fornecedor_id;

  try {
    // 1. vendas novas
    let aviso: string | null = null;
    const { data: ult } = await admin.from("ml_sync_vendas_log").select("criado_em")
      .eq("conta_id", OCELOT_CONTA).eq("ok", true).order("criado_em", { ascending: false }).limit(1).maybeSingle();
    const ultimoOk = ult?.criado_em ? new Date(ult.criado_em).getTime() : null;
    if (!ultimoOk || Date.now() - ultimoOk >= SYNC_PULA_MIN * 60_000) {
      const desdeH = ultimoOk ? (Date.now() - ultimoOk) / 3_600_000 : JANELA_MAX_H;
      const horas = Math.min(JANELA_MAX_H, Math.max(JANELA_MIN_H, Math.ceil(desdeH) + 1));
      const { data: cfg } = await admin.from("app_config").select("v").eq("k", "collector_secret").single();
      const from = new Date(Date.now() - horas * 3_600_000).toISOString(), to = new Date().toISOString();
      try {
        const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ml-ocelot-vendas?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&folga=0&por=atualizacao&origem=painel&usuario=${u.id}`,
          { method: "POST", headers: { "Content-Type": "application/json", "x-collector-secret": cfg?.v || "" }, body: "{}" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) aviso = "nao foi possivel buscar vendas novas no ML agora";
      } catch { aviso = "nao foi possivel buscar vendas novas no ML agora"; }
    }

    // 2. vendas pagas recentes
    const desde = new Date(Date.now() - DIAS * 86_400_000 - 3 * 3_600_000).toISOString().slice(0, 10);
    const { data: vendas, error: ev } = await admin.from("ocelot_vendas_itens")
      .select("order_id, pack_id, item_id, titulo, quantidade, valor_venda, data_venda, data_venda_ts, shipping_id, status")
      .eq("conta_id", OCELOT_CONTA).gte("data_venda", desde).in("status", ["paid", "partially_refunded"])
      .order("data_venda_ts", { ascending: true });
    if (ev) return json({ ok: false, erro: ev.message }, 400);
    const vs = (vendas || []).filter((v: any) => v.shipping_id);
    const orderIds = [...new Set(vs.map((v: any) => v.order_id))];
    if (!orderIds.length) return json({ ok: true, pedidos: [], aviso, atualizado_em: new Date().toISOString() });

    // 3. envios (cache em ocelot_entregas, 1 linha por order_id)
    const cache: Record<string, any> = {};
    for (let i = 0; i < orderIds.length; i += 300) {
      const { data } = await admin.from("ocelot_entregas").select("*").in("order_id", orderIds.slice(i, i + 300));
      for (const e of data || []) cache[String(e.order_id)] = e;
    }
    const porShip: Record<string, number[]> = {};
    for (const v of vs) {
      const k = String(v.shipping_id);
      (porShip[k] ||= []);
      if (!porShip[k].includes(v.order_id)) porShip[k].push(v.order_id);
    }
    const agora = Date.now();
    const consultar = Object.keys(porShip).filter((sid) => {
      const e = cache[String(porShip[sid][0])];
      if (!e) return true;
      if (saiuDaOcelot(e)) return false;
      return agora - new Date(e.atualizado_em || 0).getTime() > CACHE_MIN * 60_000;
    });
    let falhasML = 0;
    await emLotes(consultar, PARALELO, async (sid) => {
      const s = await ml(admin, OCELOT_CONTA, `/shipments/${sid}`);
      if (!s.ok || !s.json) { falhasML++; return; }
      const j = s.json, so = j.shipping_option || {}, sh = j.status_history || {};
      let limite: string | null = null, slaStatus: string | null = null;
      if (!FINAIS.has(j.status) && !ENTREGUE_AGENCIA.has(j.substatus) && !sh.date_shipped) {
        const sla = await ml(admin, OCELOT_CONTA, `/shipments/${sid}/sla`);
        if (sla.ok && sla.json) { limite = dia(sla.json.expected_date); slaStatus = sla.json.status ?? null; }
      } else {
        limite = cache[String(porShip[sid][0])]?.data_limite_envio ?? null;
      }
      if (!limite) limite = dia(so.estimated_handling_limit?.date) || dia(so.buffering?.date);
      // v3: em fabricacao o ML ainda nao tem prazo de despacho: usa o fim do prazo de fabricacao (no pacote, o maior)
      if (!limite && j.status === "pending" && j.substatus === "manufacturing") {
        for (const oid of porShip[sid]) {
          const o = await ml(admin, OCELOT_CONTA, `/orders/${oid}`);
          const d = o.ok ? dia(o.json?.manufacturing_ending_date) : null;
          if (d && (!limite || d > limite)) limite = d;
        }
      }
      const linha = {
        conta_id: OCELOT_CONTA, shipping_id: Number(sid),
        shipping_status: j.status ?? null, shipping_substatus: j.substatus ?? null,
        logistic_type: j.logistic_type ?? null, sla_status: slaStatus,
        data_limite_envio: limite, data_envio: dia(sh.date_shipped),
        data_entrega_estimada: dia(so.estimated_delivery_time?.date) || dia(so.estimated_delivery_limit?.date),
        data_entrega_real: dia(sh.date_delivered), tracking_number: j.tracking_number ?? null,
        atualizado_em: new Date().toISOString(),
      };
      const rows = porShip[sid].map((oid) => {
        const v = vs.find((x: any) => x.order_id === oid);
        return { ...linha, order_id: oid, pack_id: v?.pack_id ?? null };
      });
      const { error } = await admin.from("ocelot_entregas").upsert(rows, { onConflict: "order_id" });
      if (!error) for (const r of rows) cache[String(r.order_id)] = { ...(cache[String(r.order_id)] || {}), ...r };
    });
    if (falhasML) aviso = [aviso, `${falhasML} envio(s) sem resposta do ML (mostrando o ultimo dado gravado)`].filter(Boolean).join("; ");

    // 4. repasse estimado e links dos anuncios
    const { data: calc } = await admin.rpc("ocelot_vendas_calc", { p_conta: OCELOT_CONTA, p_de: desde, p_ate: new Date().toISOString().slice(0, 10) });
    const cmv: Record<string, number | null> = {};
    const skuDe: Record<string, string | null> = {};
    for (const c of calc || []) {
      const k = `${c.order_id}|${c.item_id}`;
      cmv[k] = c.cmv == null ? null : Number(c.cmv);
      skuDe[k] = c.sku ?? null;
    }
    const itemIds = [...new Set(vs.map((v: any) => v.item_id))];
    // v6: dono de cada anuncio
    const { data: forns } = await admin.from("ocelot_fornecedores").select("id, nome").eq("conta_id", OCELOT_CONTA);
    const nomeForn: Record<string, string> = {};
    for (const f of forns || []) nomeForn[f.id] = f.nome;
    const { data: mapa } = await admin.from("ocelot_item_fornecedor").select("item_id, fornecedor_id").eq("conta_id", OCELOT_CONTA).in("item_id", itemIds);
    const fornDe: Record<string, string | null> = {};
    for (const m of mapa || []) if (m.fornecedor_id) fornDe[m.item_id] = m.fornecedor_id;
    for (const id of itemIds.filter((i) => !fornDe[i])) {
      const tit = vs.find((v: any) => v.item_id === id)?.titulo;
      const { data: sug } = await admin.rpc("ocelot_fornecedor_sugerido", { p_titulo: tit || "" });
      fornDe[id] = (sug as string) || null;
    }
    const { data: infos } = await admin.from("ocelot_itens_info").select("item_id, titulo, thumbnail, permalink").in("item_id", itemIds);
    const info: Record<string, any> = {};
    for (const i of infos || []) info[i.item_id] = i;
    const semInfo = itemIds.filter((id) => !info[id]?.permalink);
    for (let i = 0; i < semInfo.length; i += 20) {
      const r = await ml(admin, OCELOT_CONTA, `/items?ids=${semInfo.slice(i, i + 20).join(",")}&attributes=id,title,thumbnail,permalink`);
      for (const x of (Array.isArray(r.json) ? r.json : [])) {
        const b = x.body; if (x.code !== 200 || !b) continue;
        info[b.id] = { item_id: b.id, titulo: b.title, thumbnail: b.thumbnail, permalink: b.permalink };
        await admin.from("ocelot_itens_info").upsert({ ...info[b.id], atualizado_em: new Date().toISOString() }, { onConflict: "item_id" });
      }
    }
    const linkAnuncio = (id: string) => info[id]?.permalink || `https://produto.mercadolivre.com.br/${id.replace(/^MLB/, "MLB-")}`;

    // 5. agrupa por venda (pacote); item de outro fornecedor nao vai para a tela, so o nome dele no pacote
    const grupos: Record<string, any> = {};
    const outros: Record<string, Set<string>> = {};
    for (const v of vs) {
      const e = cache[String(v.order_id)] || {};
      if (saiuDaOcelot(e)) continue;
      const k = String(v.pack_id || v.order_id);
      const fid = fornDe[v.item_id] || null;
      if (veEnvio && fid && !veEnvio.has(fid)) { (outros[k] ||= new Set()).add(nomeForn[fid] || "outro fornecedor"); continue; }
      const g = (grupos[k] ||= {
        venda: k, pacote: !!v.pack_id, order_ids: [], data_venda: v.data_venda, data_venda_ts: v.data_venda_ts,
        shipping_status: e.shipping_status ?? null, shipping_substatus: e.shipping_substatus ?? null,
        logistic_type: e.logistic_type ?? null, sla_status: e.sla_status ?? null,
        data_limite_envio: e.data_limite_envio ?? null, data_envio: e.data_envio ?? null,
        data_entrega_estimada: e.data_entrega_estimada ?? null,
        itens: [], quantidade: 0, valor: 0, repasse: 0, repasse_incompleto: false, repasse_visivel: false, sem_dono: false,
      });
      if (!g.order_ids.includes(v.order_id)) g.order_ids.push(v.order_id);
      const mostraRep = veRepasse(fid);
      const rp = mostraRep ? cmv[`${v.order_id}|${v.item_id}`] : null;
      if (!fid) g.sem_dono = true;
      g.itens.push({ fornecedor: fid ? (nomeForn[fid] || null) : null, item_id: v.item_id, titulo: v.titulo || info[v.item_id]?.titulo || v.item_id, link: linkAnuncio(v.item_id),
        sku: skuDe[`${v.order_id}|${v.item_id}`] ?? null, thumbnail: info[v.item_id]?.thumbnail || null, quantidade: Number(v.quantidade || 0), valor: Number(v.valor_venda || 0), repasse: rp ?? null });
      g.quantidade += Number(v.quantidade || 0);
      g.valor += Number(v.valor_venda || 0);
      if (mostraRep) { g.repasse_visivel = true; if (rp == null) g.repasse_incompleto = true; else g.repasse += rp; }
    }
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const pedidos = Object.values(grupos).map((g: any) => ({
      ...g, valor: r2(g.valor), repasse: g.repasse_visivel ? r2(g.repasse) : null,
      outros_fornecedores: [...(outros[g.venda] || [])].sort(),
      data_ref_envio: g.data_envio || g.data_limite_envio,
      link: `https://www.mercadolivre.com.br/vendas/${g.venda}/detalhe`,
    }));
    pedidos.sort((a: any, b: any) => (a.data_ref_envio || "9999").localeCompare(b.data_ref_envio || "9999") || String(a.data_venda_ts).localeCompare(String(b.data_venda_ts)));
    const semDono = pedidos.filter((p: any) => p.sem_dono).length;
    return json({ ok: true, pedidos, aviso, sem_dono: semDono, escopo: uf ? (nomeForn[uf.fornecedor_id] || null) : null,
      consultados_ml: consultar.length, atualizado_em: new Date().toISOString() });
  } catch (e) {
    return json({ ok: false, erro: (e as Error).message }, 500);
  }
});
