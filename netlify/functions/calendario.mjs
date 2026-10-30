// Devuelve los partidos de las 5 grandes ligas y la Champions de una semana (para que el admin elija partido con un toque).
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN. Uso: /.netlify/functions/calendario?from=2026-10-30
const COMPS = "PD,PL,BL1,SA,FL1,CL";
const DIA = 864e5;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export default async (req) => {
  const token = Netlify.env.get("FOOTBALL_DATA_TOKEN");
  if (!token) return Response.json({ error: "Falta FOOTBALL_DATA_TOKEN" }, { status: 500 });

  const q = new URL(req.url).searchParams.get("from");
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q || "") ? q : day(Date.now());
  const ini = Date.parse(from + "T00:00:00Z"), fin = ini + 7 * DIA;

  const r = await fetch(
    `https://api.football-data.org/v4/matches?competitions=${COMPS}&dateFrom=${from}&dateTo=${day(fin)}`,
    { headers: { "X-Auth-Token": token } }
  );
  if (!r.ok) return Response.json({ error: "football-data.org respondió " + r.status }, { status: 502 });
  const { matches = [] } = await r.json();

  const eq = (t) => ({ name: (t && t.name) || "", short: (t && t.shortName) || "", tla: (t && t.tla) || "" });
  const out = matches
    .filter((m) => !["CANCELLED", "POSTPONED", "SUSPENDED"].includes(m.status))
    .filter((m) => { const k = Date.parse(m.utcDate); return k >= ini && k < fin; })
    .map((m) => ({ id: m.id, comp: m.competition && m.competition.code, kickoff: m.utcDate, home: eq(m.homeTeam), away: eq(m.awayTeam) }))
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));

  return Response.json({ from, matches: out }, { headers: { "cache-control": "public, max-age=300" } });
};
