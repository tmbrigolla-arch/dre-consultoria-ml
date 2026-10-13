// ml-ocelot-etiquetas v1 (13/10/2026) - aba "Etiquetas de Envio" da Gestao Ocelot.
// Copia do que ja roda no antoninho-comissoes (ml-etiquetas), no padrao deste projeto (_shared/ocelot.ts).
//
// Por que existe: a etiqueta era baixada em ZPL, convertida no Labelary e impressa como imagem; a janela de
// impressao reescalava (codigo de barras borrado/cortado) e a fila travava. Aqui o servidor busca a etiqueta
// OFICIAL do ML e a tela manda para a termica pelo QZ Tray (ZPL cru, ou o PDF do ML pelo driver).
//
// POST { acao: "listar" }                          -> envios da Ocelot prontos/aguardando para imprimir, status AO VIVO
// POST { acao: "zpl", shipment_ids: [..] }         -> { ok, zpl, etiquetas, impressos[], falhas[] }   (max 50)
// POST { acao: "pdf", shipment_ids: [..] }         -> { ok, pdf_base64, impressos[], falhas[] }       (max 50)
// POST { acao: "qz_certificado" }                  -> { ok, certificado }
// POST { acao: "qz_assinar", texto }               -> { ok, assinatura }  (RSASSA-PKCS1-v1_5 SHA-512, base64)
//
// Travas:
//   1. exigirUsuario(..., "ocelot_etiquetas") + conta Ocelot dentro de app_contas do usuario;
//   2. so imprime envio que e da conta Ocelot (conferido em ocelot_vendas_itens);
//   3. token do ML so aqui dentro (tokenML), nunca na resposta;
//   4. par de chaves do QZ gerado aqui na 1a chamada e guardado em app_segredos (sem acesso de anon/authenticated):
//      a chave privada nunca sai do servidor; o certificado publico e baixado pela tela (override.crt do QZ).
// So leitura no ML (baixar etiqueta marca "printed" do lado do ML, como no site).
import { adminClient, CORS, exigirUsuario, json, ml, tokenML, ML_API } from "../_shared/ocelot.ts";
import { unzipSync, strFromU8 } from "npm:fflate@0.8.2";
import * as x509 from "npm:@peculiar/x509@1.14.3";

const OCELOT_CONTA = "30fa53d4-60c0-40f6-9832-63b4cb313797";
const DIAS = 30;
const CACHE_MIN = 1;             // status consultado ha menos de 1 min nao vai ao ML de novo
const PARALELO = 8;
const MAX_LOTE = 50;             // limite do /shipment_labels
const FINAIS = new Set(["delivered", "cancelled", "shipped", "not_delivered"]);
// ready_to_ship com estes substatus = ja saiu da Ocelot (postado/coletado): nao tem mais etiqueta para imprimir
const SAIU = new Set(["dropped_off", "picked_up", "in_hub", "in_transit", "in_warehouse"]);

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function emLotes<T>(lista: T[], n: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < lista.length; i += n) await Promise.all(lista.slice(i, i + n).map(fn));
}

// ---------------------------------------------------------------- QZ Tray
const ALG_QZ = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };

// deno-lint-ignore no-explicit-any
async function chavesQZ(admin: any): Promise<{ certificado: string; chave: CryptoKey }> {
  const ler = async () => {
    const { data } = await admin.from("app_segredos").select("k, v").in("k", ["qz_certificado", "qz_chave_privada"]);
    const m: Record<string, string> = {};
    for (const r of data || []) m[r.k] = r.v;
    return m;
  };
  let m = await ler();
  if (!m.qz_certificado || !m.qz_chave_privada) {
    x509.cryptoProvider.set(crypto);
    const keys = await crypto.subtle.generateKey(ALG_QZ, true, ["sign", "verify"]) as CryptoKeyPair;
    const agora = new Date();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: Date.now().toString(16),
      name: "CN=Ocelot Etiquetas ML, O=DRE Consultoria, C=BR",
      notBefore: new Date(agora.getTime() - 864e5),
      notAfter: new Date(agora.getTime() + 3650 * 864e5),
      signingAlgorithm: ALG_QZ, keys,
      extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
    });
    const pkcs8 = base64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)));
    // os dois numa escrita so; chamada simultanea na 1a vez: a segunda e ignorada e as duas releem
    await admin.from("app_segredos").upsert([
      { k: "qz_chave_privada", v: pkcs8 },
      { k: "qz_certificado", v: cert.toString("pem") },
    ], { onConflict: "k", ignoreDuplicates: true });
    m = await ler();
  }
  const der = Uint8Array.from(atob(m.qz_chave_privada), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey("pkcs8", der.buffer as ArrayBuffer, ALG_QZ, false, ["sign"]);
  return { certificado: m.qz_certificado, chave };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();
  const u = await exigirUsuario(admin, req, "ocelot_etiquetas");
  if (u instanceof Response) return u;
  const { data: contasUsr } = await admin.rpc("app_contas", { p_uid: u.id });
  if (contasUsr !== null && !(contasUsr || []).includes(OCELOT_CONTA)) return json({ ok: false, erro: "conta Ocelot fora do seu acesso" }, 403);

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio */ }
  const acao = String(body?.acao || "");

  try {
    // ------------------------------------------------------------ QZ
    if (acao === "qz_certificado") {
      const { certificado } = await chavesQZ(admin);
      return json({ ok: true, certificado });
    }
    if (acao === "qz_assinar") {
      const { chave } = await chavesQZ(admin);
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(String(body?.texto ?? "")));
      return json({ ok: true, assinatura: base64(new Uint8Array(sig)) });
    }

    // ------------------------------------------------------------ listar (status ao vivo)
    // O cache de ocelot_entregas fica velho: a etiqueta libera minutos depois de a NF entrar
    // (invoice_pending -> ready_to_print). Todo envio ainda na Ocelot e consultado no ML (cache de 1 min).
    if (acao === "listar") {
      const desde = new Date(Date.now() - DIAS * 86_400_000 - 3 * 3_600_000).toISOString().slice(0, 10);
      const { data: vendas, error: ev } = await admin.from("ocelot_vendas_itens")
        .select("order_id, pack_id, item_id, titulo, quantidade, valor_venda, data_venda, data_venda_ts, shipping_id, status")
        .eq("conta_id", OCELOT_CONTA).gte("data_venda", desde).in("status", ["paid", "partially_refunded"])
        .order("data_venda_ts", { ascending: true });
      if (ev) return json({ ok: false, erro: ev.message }, 400);
      // deno-lint-ignore no-explicit-any
      const vs = (vendas || []).filter((v: any) => v.shipping_id);
      // deno-lint-ignore no-explicit-any
      const orderIds = [...new Set(vs.map((v: any) => v.order_id))];
      if (!orderIds.length) return json({ ok: true, envios: [], atualizado_em: new Date().toISOString() });

      // deno-lint-ignore no-explicit-any
      const cache: Record<string, any> = {};
      for (let i = 0; i < orderIds.length; i += 300) {
        const { data } = await admin.from("ocelot_entregas")
          .select("order_id, shipping_status, shipping_substatus, logistic_type, data_envio, receiver_name, atualizado_em")
          .in("order_id", orderIds.slice(i, i + 300));
        for (const e of data || []) cache[String(e.order_id)] = e;
      }
      const porShip: Record<string, number[]> = {};
      for (const v of vs) {
        const k = String(v.shipping_id);
        (porShip[k] ||= []);
        if (!porShip[k].includes(v.order_id)) porShip[k].push(v.order_id);
      }
      // deno-lint-ignore no-explicit-any
      const saiu = (e: any) => !!e && (FINAIS.has(e.shipping_status) || SAIU.has(e.shipping_substatus)
        || !!e.data_envio || e.logistic_type === "fulfillment");
      const agora = Date.now();
      const consultar = Object.keys(porShip).filter((sid) => {
        const e = cache[String(porShip[sid][0])];
        if (!e) return true;
        if (saiu(e)) return false;
        return agora - new Date(e.atualizado_em || 0).getTime() > CACHE_MIN * 60_000;
      });
      let falhasML = 0;
      await emLotes(consultar, PARALELO, async (sid) => {
        const s = await ml(admin, OCELOT_CONTA, `/shipments/${sid}`);
        if (!s.ok || !s.json?.status) { falhasML++; return; }
        // so as colunas de status: data limite/SLA continuam com a aba "Vendas a entregar"
        const linha = {
          conta_id: OCELOT_CONTA, shipping_id: Number(sid),
          shipping_status: s.json.status, shipping_substatus: s.json.substatus ?? null,
          logistic_type: s.json.logistic_type ?? null, atualizado_em: new Date().toISOString(),
        };
        const rows = porShip[sid].map((oid) => {
          // deno-lint-ignore no-explicit-any
          const v = vs.find((x: any) => x.order_id === oid);
          return { ...linha, order_id: oid, pack_id: v?.pack_id ?? null };
        });
        const { error } = await admin.from("ocelot_entregas").upsert(rows, { onConflict: "order_id" });
        if (!error) for (const r of rows) cache[String(r.order_id)] = { ...(cache[String(r.order_id)] || {}), ...r };
      });

      // deno-lint-ignore no-explicit-any
      const envios: Record<string, any> = {};
      for (const v of vs) {
        const e = cache[String(v.order_id)] || {};
        if (saiu(e) || e.shipping_status !== "ready_to_ship") continue;
        const k = String(v.shipping_id);
        const g = (envios[k] ||= {
          shipping_id: k, venda: String(v.pack_id || v.order_id), data_venda: v.data_venda, data_venda_ts: v.data_venda_ts,
          substatus: e.shipping_substatus ?? null, logistic_type: e.logistic_type ?? null,
          comprador: e.receiver_name ?? null,
          ao_vivo: agora - new Date(e.atualizado_em || 0).getTime() < 2 * 60_000,   // status lido agora no ML
          itens: [], quantidade: 0, valor: 0,
        });
        g.itens.push({ item_id: v.item_id, titulo: v.titulo || v.item_id, quantidade: Number(v.quantidade || 0) });
        g.quantidade += Number(v.quantidade || 0);
        g.valor += Number(v.valor_venda || 0);
      }
      // deno-lint-ignore no-explicit-any
      const lista = Object.values(envios).map((g: any) => ({ ...g, valor: Math.round(g.valor * 100) / 100 }))
        // deno-lint-ignore no-explicit-any
        .sort((a: any, b: any) => String(a.data_venda_ts).localeCompare(String(b.data_venda_ts)));
      return json({
        ok: true, envios: lista, consultados_ml: consultar.length,
        aviso: falhasML ? `${falhasML} envio(s) sem resposta do ML (mostrando o ultimo status gravado)` : null,
        atualizado_em: new Date().toISOString(),
      });
    }

    // ------------------------------------------------------------ etiqueta (zpl | pdf)
    if (acao !== "zpl" && acao !== "pdf") return json({ ok: false, erro: `acao desconhecida: ${acao}` }, 400);
    const ids = [...new Set((Array.isArray(body?.shipment_ids) ? body.shipment_ids : [])
      .map((x: unknown) => String(x).trim()).filter((x: string) => /^\d+$/.test(x)))] as string[];
    if (!ids.length) return json({ ok: false, erro: "nenhum envio valido" }, 400);
    if (ids.length > MAX_LOTE) return json({ ok: false, erro: `maximo de ${MAX_LOTE} etiquetas por chamada` }, 400);

    // so envio da conta Ocelot
    const { data: donos } = await admin.from("ocelot_vendas_itens").select("shipping_id")
      .eq("conta_id", OCELOT_CONTA).in("shipping_id", ids.map(Number));
    // deno-lint-ignore no-explicit-any
    const daOcelot = new Set((donos || []).map((d: any) => String(d.shipping_id)));
    const falhas: { shipment_id: string; motivo: string }[] = [];
    for (const id of ids) if (!daOcelot.has(id)) falhas.push({ shipment_id: id, motivo: "envio nao e da conta Ocelot" });
    let lote = ids.filter((id) => daOcelot.has(id));

    const token = await tokenML(admin, OCELOT_CONTA);
    const tipo = acao === "zpl" ? "zpl2" : "pdf";
    let resp: Response | null = null;
    for (let tentativa = 0; tentativa < 3 && lote.length > 0; tentativa++) {
      resp = await fetch(`${ML_API}/shipment_labels?shipment_ids=${lote.join(",")}&response_type=${tipo}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) break;
      const txt = await resp.text();
      // deno-lint-ignore no-explicit-any
      let j: any = null;
      try { j = JSON.parse(txt); } catch { /* nao e json */ }
      // o ML lista quem travou o lote em failed_shipments (ou cause/causes): tira esses e pede de novo
      const travados = new Set<string>();
      // deno-lint-ignore no-explicit-any
      for (const f of (j?.failed_shipments || j?.cause || j?.causes || []) as any[]) {
        const id = String(f?.shipment_id ?? f?.id ?? f ?? "").match(/\d{6,}/)?.[0];
        if (id && lote.includes(id)) {
          travados.add(id);
          falhas.push({ shipment_id: id, motivo: String(f?.status || f?.message || f?.code || j?.message || "recusado pelo ML") });
        }
      }
      if (!travados.size) {
        for (const id of lote) falhas.push({ shipment_id: id, motivo: String(j?.message || j?.error || txt.slice(0, 200) || `ML ${resp.status}`) });
        lote = [];
        resp = null;
        break;
      }
      lote = lote.filter((id) => !travados.has(id));
      resp = null;
    }
    if (!resp || !lote.length) {
      for (const id of lote) falhas.push({ shipment_id: id, motivo: "o ML recusou o lote varias vezes - imprima este envio sozinho" });
      return json({ ok: false, erro: "o ML nao liberou nenhuma etiqueta deste lote", falhas }, 422);
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());

    // impressa do nosso lado tambem (o ML ja marcou do dele ao entregar a etiqueta)
    await admin.from("ocelot_entregas").update({ shipping_substatus: "printed" })
      .eq("conta_id", OCELOT_CONTA).in("shipping_id", lote.map(Number)).eq("shipping_status", "ready_to_ship");

    if (acao === "pdf") return json({ ok: true, pdf_base64: base64(bytes), impressos: lote, falhas });

    // ZPL vem zipado ("PK"); aceita texto puro tambem
    let zpl = "";
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const arquivos = unzipSync(bytes);
      for (const nome of Object.keys(arquivos).sort()) {
        const conteudo = strFromU8(arquivos[nome]);
        if (conteudo.includes("^XA")) zpl += conteudo.trim() + "\n";
      }
    } else {
      zpl = strFromU8(bytes);
    }
    if (!zpl.includes("^XA")) return json({ ok: false, erro: "o ML respondeu sem ZPL", falhas }, 502);
    return json({ ok: true, zpl, etiquetas: (zpl.match(/\^XA/g) || []).length, impressos: lote, falhas });
  } catch (e) {
    return json({ ok: false, erro: (e as Error).message }, 500);
  }
});
