import { getStore } from "@netlify/blobs";

// Cada 15 min: si hay un partido de liga ya terminado sin resultado, lo busca en football-data.org y lo guarda.
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN (token gratis de football-data.org).
// El plan gratis cubre las 5 grandes ligas y la Champions; Europa/Conference se quedan manuales.
export const config = { schedule: "*/15 * * * *" };

const N = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// 3 = el nombre coincide exacto con el de la API, 2 = lo contiene, 0 = no coincide
const score = (app, t) => {
  if (!t) return 0;
  const a = N(app), names = [N(t.name), N(t.shortName), N(t.tla)].filter(Boolean);
  if (names.includes(a)) return 3;
  return names.some((n) => (" " + n + " ").includes(" " + a + " ")) ? 2 : 0;
};
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export default async () => {
  const st = (await getStore("superpredict").get("state", { type: "json" })) || {};
  const now = Date.now();
  // partidos de liga (no de copas internas) que ya deberían haber terminado y siguen sin resultado
  const pend = (st.matches || []).filter((m) => {
    const k = Date.parse(m.kickoff);
    return !m.comp && !m.result && k && now > k + 100 * 6e4 && now < k + 5 * 864e5;
  });
  if (!pend.length) return;

  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return console.error("Falta FOOTBALL_DATA_TOKEN");

  // una sola llamada con todas las competiciones del plan (el rango máximo permitido son 10 días)
  const ks = pend.map((m) => Date.parse(m.kickoff));
  const to = Math.max(...ks) + 864e5, from = Math.max(Math.min(...ks) - 864e5, to - 9 * 864e5);
  const r = await fetch(`https://api.football-data.org/v4/matches?status=FINISHED&dateFrom=${day(from)}&dateTo=${day(to)}`, { headers: { "X-Auth-Token": token } });
  if (!r.ok) return console.error("football-data.org respondió", r.status);
  const { matches = [] } = await r.json();

  const ops = [];
  for (const m of pend) {
    let best = null, bs = 0;
    for (const x of matches) {
      const h = score(m.home, x.homeTeam), a = score(m.away, x.awayTeam);
      if (h < 2 || a < 2 || Math.abs(Date.parse(x.utcDate) - Date.parse(m.kickoff)) > 2 * 864e5) continue;
      if (h + a > bs) { bs = h + a; best = x; }
    }
    const s = best && best.score && best.score.fullTime;
    if (s && Number.isInteger(s.home) && Number.isInteger(s.away)) ops.push({ c: "matches", id: m.id, set: { result: { h: s.home, a: s.away } } });
    else console.log("Sin resultado aún o sin coincidencia en la API:", m.home, "-", m.away);
  }
  if (!ops.length) return;
  // se guarda por la propia /api de la app, igual que si lo hiciera el admin
  const w = await fetch(`${process.env.URL}/api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) });
  console.log("Resultados guardados:", ops.length, "→", w.status);
};
