// ml-ocelot-horario-corte v1 (06/10/2026) - agenda de corte/coleta do Mercado Envios (xd_drop_off)
// das contas da Ocelot. Replica ml-horario-corte v4 do antoninho-comissoes, com autenticacao de verdade:
//   * cron 'ocelot-horario-corte-diario' (07:00 de Brasilia): header x-cron-secret, conferido em tempo
//     constante contra app_segredos (o original usava a anon key como "senha");
//   * botao "Atualizar" do dashboard: JWT do usuario + permissao ocelot_dashboard, so nas contas dele.
// So LE do ML. Grava a agenda em ml_horario_corte e, quando difere da ultima, uma linha por dia
// alterado em ml_horario_corte_alteracao (vira alerta na tela ate o usuario clicar "ciente").
// Campos que mudam todo dia sem ser alteracao (date, is_past, motorista, veiculo) ficam fora da
// comparacao. A API oscila: a diferenca so vale se mais 2 leituras (4 s de intervalo) confirmarem.
import { adminClient, contasOcelot, CORS, erroML, exigirUsuario, json, ml, segredoConfere } from "../_shared/ocelot.ts";

const LOGISTICA = "xd_drop_off";
const DIAS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DIA_PT: Record<string, string> = {
  monday: "segunda", tuesday: "terça", wednesday: "quarta", thursday: "quinta",
  friday: "sexta", saturday: "sábado", sunday: "domingo",
};

type Corte = { corte: string; coleta: string; facility: string };
type Dia = { trabalha: boolean; data?: string; cortes: Corte[] };
type Agenda = Record<string, Dia>;

// Proxima ocorrencia (hoje inclusive) de cada dia da semana, em Brasilia (sem horario de verao).
function dataDoDia(dia: string): string {
  const agora = new Date(Date.now() - 3 * 3600 * 1000);
  const hoje = (agora.getUTCDay() + 6) % 7; // 0 = segunda
  const alvo = DIAS.indexOf(dia);
  return new Date(agora.getTime() + ((alvo - hoje + 7) % 7) * 86400000).toISOString().slice(0, 10);
}
const dataBR = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function normalizar(schedule: any): Agenda {
  const ag: Agenda = {};
  for (const d of DIAS) {
    const x = schedule?.[d] || {};
    const cortes: Corte[] = (Array.isArray(x.detail) ? x.detail : [])
      .filter((det: any) => !det.logistic_type || det.logistic_type === LOGISTICA)
      .map((det: any) => ({ corte: det.cutoff || "", coleta: det.from || "", facility: det.facility_id || "" }))
      .sort((a: Corte, b: Corte) => (a.corte + a.coleta).localeCompare(b.corte + b.coleta));
    ag[d] = { trabalha: x.work === true, data: dataDoDia(d), cortes };
  }
  return ag;
}

// Compara por campos (o jsonb reordena chaves; "data" muda todo dia e fica de fora).
function chaveDia(d: Dia | undefined | null): string {
  if (!d) return "null";
  const cortes = (d.cortes || []).map((c) => `${c.corte || ""}|${c.coleta || ""}|${c.facility || ""}`).sort().join(";");
  return `${d.trabalha === true}#${cortes}`;
}
const chaveAgenda = (a: Agenda) => DIAS.map((d) => chaveDia(a[d])).join("/");

function descreverDia(d: Dia | undefined): string {
  if (!d || !d.trabalha || d.cortes.length === 0) return "sem expedição";
  return d.cortes.map((c) => `corte ${c.corte}${c.coleta ? ` (coleta ${c.coleta})` : ""}`).join(" / ");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, 405);
  const admin = adminClient();

  let uid: string | null = null;
  if (!(await segredoConfere(admin, "cron_horario_corte", req.headers.get("x-cron-secret")))) {
    const u = await exigirUsuario(admin, req, "ocelot_dashboard");
    if (u instanceof Response) return u;
    uid = u.id;
  }
  const contas = (await contasOcelot(admin, uid)).filter((c) => c.status === "ativa" && c.ml_user_id);

  const resultado = await Promise.all(contas.map(async (c) => {
    const agora = new Date().toISOString();
    try {
      const buscar = async (): Promise<Agenda> => {
        const r = await ml(admin, c.id, `/users/${c.ml_user_id}/shipping/schedule/${LOGISTICA}`);
        if (!r.ok) throw new Error(erroML(r));
        return normalizar(r.json?.schedule);
      };
      const nova = await buscar();
      const { data: atual } = await admin.from("ml_horario_corte").select("agenda").eq("conta_id", c.id).maybeSingle();
      const antiga: Agenda | null = atual?.agenda || null;

      if (antiga && chaveAgenda(antiga) !== chaveAgenda(nova)) {
        const chave = chaveAgenda(nova);
        for (let i = 0; i < 2; i++) {
          await new Promise((res) => setTimeout(res, 4000));
          if (chaveAgenda(await buscar()) !== chave) {
            await admin.from("ml_horario_corte").update({
              consultado_em: agora, erro: "ML devolveu agendas diferentes em leituras seguidas; mantida a anterior",
            }).eq("conta_id", c.id);
            return { conta_id: c.id, ok: true, instavel: true, alteracoes: [] };
          }
        }
      }

      const alteracoes: any[] = [];
      if (antiga) {
        for (const d of DIAS) {
          if (chaveDia(antiga[d]) !== chaveDia(nova[d])) {
            const data = nova[d]?.data || dataDoDia(d);
            alteracoes.push({
              conta_id: c.id, dia: d, data, antes: antiga[d] ?? null, depois: nova[d] ?? null,
              resumo: `${c.nome} · ${DIA_PT[d]} ${dataBR(data)}: ${descreverDia(antiga[d])} → ${descreverDia(nova[d])}`,
            });
          }
        }
        if (alteracoes.length) await admin.from("ml_horario_corte_alteracao").insert(alteracoes);
      }
      await admin.from("ml_horario_corte").upsert({
        conta_id: c.id, logistic_type: LOGISTICA, agenda: nova, consultado_em: agora, erro: null,
        ...(alteracoes.length ? { alterado_em: agora } : {}),
      }, { onConflict: "conta_id" });
      return { conta_id: c.id, ok: true, alteracoes: alteracoes.map((a) => a.resumo) };
    } catch (e) {
      // guarda o erro sem apagar a ultima agenda boa
      const erro = (e as Error).message;
      const { data: existe } = await admin.from("ml_horario_corte").select("conta_id").eq("conta_id", c.id).maybeSingle();
      if (existe) await admin.from("ml_horario_corte").update({ consultado_em: agora, erro }).eq("conta_id", c.id);
      else await admin.from("ml_horario_corte").insert({ conta_id: c.id, consultado_em: agora, erro });
      return { conta_id: c.id, ok: false, erro };
    }
  }));
  return json({ ok: resultado.every((r) => r.ok), contas: resultado });
});
