// ml-ocelot-atendimento v1 (06/10/2026) - perguntas (pre-venda) e mensagens (pos-venda) do Mercado Livre
// das contas ativas da Ocelot, numa fila so. Replica ml-atendimento v2 do antoninho-comissoes.
//
// POST { acao: "contar" }                                  -> { ok, perguntas, mensagens, total, falhas }
// POST { acao: "listar" }                                  -> { ok, perguntas[], mensagens[], falhas }
// POST { acao: "responder_pergunta", conta_id, question_id, texto }
// POST { acao: "responder_mensagem", conta_id, pack_id, buyer_id, texto }
// POST { acao: "marcar_lida", conta_id, pack_id }          -> tira da fila conversa que nao aceita resposta
//
// Travas:
//   1. so passa admin ou quem tem o menu "atendimento_ml" (app_pode), e so nas contas da Ocelot do usuario;
//   2. toda resposta, toda tentativa recusada pelo ML e todo "marcar como lida" vao para ml_atendimento_log,
//      com o usuario que fez;
//   3. ler mensagens usa mark_as_read=false: abrir a tela NAO marca nada como lido no ML.
//      So marca como lida a conversa respondida (ou dispensada) aqui.
import { adminClient, Conta, contasOcelot, CORS, erroML, exigirUsuario, json, ml } from "../_shared/ocelot.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();
  const auth = await exigirUsuario(admin, req, "atendimento_ml");
  if (auth instanceof Response) return auth;
  const u = auth;

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const acao = String(body?.acao || "");

  const contas = (await contasOcelot(admin, u.id)).filter((c) => c.status === "ativa" && c.ml_user_id);
  const sellerDe = (c: Conta) => Number(c.ml_user_id);

  async function logar(conta_id: string, tipo: string, referencia: string, texto: string | null, ok: boolean, erro: string | null) {
    await admin.from("ml_atendimento_log").insert({ conta_id, tipo, referencia, texto, usuario_id: u.id, usuario_email: u.email, ok, erro });
  }

  // Marca a conversa INTEIRA como lida: o ML so marca as mensagens que a chamada devolve,
  // entao pagina ate o fim (licao do original: com limit=1 a conversa nunca saia da fila).
  async function marcarLida(c: Conta, pack_id: string) {
    let offset = 0;
    let ultima: { status: number; ok: boolean; json: any } | null = null;
    for (let pag = 0; pag < 10; pag++) {
      ultima = await ml(admin, c.id, `/messages/packs/${pack_id}/sellers/${sellerDe(c)}?tag=post_sale&mark_as_read=true&limit=50&offset=${offset}`);
      if (!ultima.ok) break;
      const total = Number(ultima.json?.paging?.total) || 0;
      offset += 50;
      if (offset >= total) break;
    }
    return ultima!;
  }

  // Conversas de pos-venda nao lidas (ignora as do assistente de IA do ML).
  async function naoLidas(c: Conta): Promise<{ pack_id: string; count: number }[]> {
    const r = await ml(admin, c.id, `/messages/unread?role=seller&tag=post_sale`);
    if (!r.ok) throw new Error(`mensagens: ${erroML(r)}`);
    return (r.json?.results || [])
      .map((x: any) => {
        const m = String(x.resource || "").match(/^\/packs\/(\d+)\/sellers\/(\d+)$/);
        return m ? { pack_id: m[1], count: Number(x.count) || 0 } : null;
      })
      .filter(Boolean) as { pack_id: string; count: number }[];
  }

  try {
    if (acao === "contar") {
      const falhas: string[] = [];
      const porConta = await Promise.all(contas.map(async (c) => {
        let perguntas = 0, mensagens = 0;
        try {
          const q = await ml(admin, c.id, `/questions/search?seller_id=${sellerDe(c)}&status=UNANSWERED&api_version=4&limit=1`);
          if (!q.ok) throw new Error(`perguntas: ${erroML(q)}`);
          perguntas = Number(q.json?.total) || 0;
          mensagens = (await naoLidas(c)).length;
        } catch (e) { falhas.push(`${c.nome}: ${(e as Error).message}`); }
        return { conta_id: c.id, perguntas, mensagens };
      }));
      const perguntas = porConta.reduce((s, x) => s + x.perguntas, 0);
      const mensagens = porConta.reduce((s, x) => s + x.mensagens, 0);
      return json({ ok: true, perguntas, mensagens, total: perguntas + mensagens, por_conta: porConta, falhas });
    }

    if (acao === "listar") {
      const falhas: string[] = [];
      const perguntas: any[] = [];
      const mensagens: any[] = [];
      await Promise.all(contas.map(async (c) => {
        try {
          const q = await ml(admin, c.id, `/questions/search?seller_id=${sellerDe(c)}&status=UNANSWERED&api_version=4&limit=50&sort_fields=date_created&sort_types=ASC`);
          if (!q.ok) throw new Error(`perguntas: ${erroML(q)}`);
          const qs = q.json?.questions || [];
          const ids = [...new Set(qs.map((x: any) => x.item_id).filter(Boolean))] as string[];
          const itens: Record<string, any> = {};
          for (let i = 0; i < ids.length; i += 20) {
            const r = await ml(admin, c.id, `/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=id,title,thumbnail,permalink,price,available_quantity`);
            for (const it of (r.json || [])) if (it?.body?.id) itens[it.body.id] = it.body;
          }
          for (const x of qs) {
            const it = itens[x.item_id] || {};
            perguntas.push({
              conta_id: c.id, conta_nome: c.nome, question_id: x.id, texto: x.text, data: x.date_created,
              item_id: x.item_id, titulo: it.title || x.item_id, thumbnail: it.thumbnail || null,
              permalink: it.permalink || null, preco: it.price ?? null, estoque: it.available_quantity ?? null,
            });
          }
        } catch (e) { falhas.push(`${c.nome} (perguntas): ${(e as Error).message}`); }

        try {
          const packs = await naoLidas(c);
          await Promise.all(packs.slice(0, 30).map(async (p) => {
            const r = await ml(admin, c.id, `/messages/packs/${p.pack_id}/sellers/${sellerDe(c)}?tag=post_sale&mark_as_read=false&limit=10`);
            if (!r.ok) { falhas.push(`${c.nome} (conversa ${p.pack_id}): ${erroML(r)}`); return; }
            const msgs = (r.json?.messages || []).map((m: any) => ({
              id: m.id,
              do_cliente: Number(m.from?.user_id) !== sellerDe(c),
              texto: m.text,
              data: m.message_date?.created || m.message_date?.received || null,
              anexos: (m.message_attachments || []).map((a: any) => a.original_filename || a.filename).filter(Boolean),
            })).sort((a: any, b: any) => String(a.data).localeCompare(String(b.data)));
            const doCliente = (r.json?.messages || []).find((m: any) => Number(m.from?.user_id) !== sellerDe(c));
            const st = r.json?.conversation_status || {};
            // Produto, comprador e numero da venda vem das vendas ja gravadas (pacote ou pedido avulso).
            const { data: itensVenda } = await admin.from("ocelot_vendas_itens")
              .select("order_id, titulo, quantidade, buyer_nickname, buyer_id")
              .eq("conta_id", c.id).or(`pack_id.eq.${p.pack_id},order_id.eq.${p.pack_id}`).limit(20);
            const ultimaCliente = [...msgs].reverse().find((m: any) => m.do_cliente);
            mensagens.push({
              conta_id: c.id, conta_nome: c.nome, pack_id: p.pack_id, nao_lidas: p.count,
              buyer_id: doCliente ? Number(doCliente.from.user_id) : (itensVenda?.[0]?.buyer_id ?? null),
              comprador: itensVenda?.[0]?.buyer_nickname || null,
              pedidos: [...new Set((itensVenda || []).map((x: any) => String(x.order_id)))],
              produtos: (itensVenda || []).map((x: any) => `${x.quantidade}× ${x.titulo}`),
              data: ultimaCliente?.data || msgs[msgs.length - 1]?.data || null,
              mensagens: msgs,
              bloqueada: st.status === "blocked",
              motivo_bloqueio: st.substatus || null,
              limite_caracteres: Number(r.json?.seller_max_message_length) || 350,
            });
          }));
        } catch (e) { falhas.push(`${c.nome} (mensagens): ${(e as Error).message}`); }
      }));
      perguntas.sort((a, b) => String(a.data).localeCompare(String(b.data)));
      mensagens.sort((a, b) => String(a.data).localeCompare(String(b.data)));
      return json({ ok: true, perguntas, mensagens, falhas });
    }

    if (acao === "responder_pergunta") {
      const c = contas.find((x) => x.id === String(body.conta_id || ""));
      const question_id = Number(body.question_id);
      const texto = String(body.texto || "").trim();
      if (!c || !Number.isFinite(question_id) || question_id <= 0) return json({ ok: false, erro: "conta_id e question_id obrigatorios" }, 400);
      if (!texto) return json({ ok: false, erro: "resposta vazia" }, 400);
      if (texto.length > 2000) return json({ ok: false, erro: "resposta acima de 2000 caracteres" }, 400);
      const r = await ml(admin, c.id, `/answers`, { method: "POST", body: JSON.stringify({ question_id, text: texto }) });
      const erro = r.ok ? null : erroML(r);
      await logar(c.id, "pergunta", String(question_id), texto, r.ok, erro);
      return r.ok ? json({ ok: true }) : json({ ok: false, erro }, 502);
    }

    if (acao === "responder_mensagem") {
      const c = contas.find((x) => x.id === String(body.conta_id || ""));
      const pack_id = String(body.pack_id || "").replace(/\D/g, "");
      const buyer_id = Number(body.buyer_id);
      const texto = String(body.texto || "").trim();
      if (!c || !pack_id || !Number.isFinite(buyer_id) || buyer_id <= 0) return json({ ok: false, erro: "conta_id, pack_id e buyer_id obrigatorios" }, 400);
      if (!texto) return json({ ok: false, erro: "mensagem vazia" }, 400);
      if (texto.length > 2000) return json({ ok: false, erro: "mensagem acima de 2000 caracteres" }, 400);
      const r = await ml(admin, c.id, `/messages/packs/${pack_id}/sellers/${sellerDe(c)}?tag=post_sale`, {
        method: "POST",
        body: JSON.stringify({ from: { user_id: sellerDe(c) }, to: { user_id: buyer_id }, text: texto }),
      });
      const erro = r.ok ? null : erroML(r);
      await logar(c.id, "mensagem", pack_id, texto, r.ok, erro);
      if (!r.ok) return json({ ok: false, erro }, 502);
      await marcarLida(c, pack_id); // respondeu: sai da fila
      return json({ ok: true });
    }

    if (acao === "marcar_lida") {
      const c = contas.find((x) => x.id === String(body.conta_id || ""));
      const pack_id = String(body.pack_id || "").replace(/\D/g, "");
      if (!c || !pack_id) return json({ ok: false, erro: "conta_id e pack_id obrigatorios" }, 400);
      const r = await marcarLida(c, pack_id);
      await logar(c.id, "marcar_lida", pack_id, null, r.ok, r.ok ? null : erroML(r));
      return r.ok ? json({ ok: true }) : json({ ok: false, erro: erroML(r) }, 502);
    }

    return json({ ok: false, erro: "acao desconhecida" }, 400);
  } catch (e) {
    return json({ ok: false, erro: (e as Error).message }, 500);
  }
});
