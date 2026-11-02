import { getStore } from "@netlify/blobs";

// Forma (últimos 5 partidos), últimos enfrentamientos y estadísticas de toda la temporada de dos equipos, para el botón de historial de la tarjeta de jornada.
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN. Uso: /.netlify/functions/forma?home=Real%20Madrid&away=Barcelona
// Los nombres son los de la app; aquí se convierten a equipos de football-data.org con la misma lógica que "resultados".
// El plan gratis solo cubre las 5 grandes ligas y la Champions: de otros equipos saldrán menos datos.
const API = "https://api.football-data.org/v4";
const COMPS = ["PD", "PL", "BL1", "SA", "FL1", "CL"];
const H = 36e5, DIA = 24 * H;
const TTL_DATOS = 1 * H, TTL_EQUIPOS = 7 * DIA;

const N = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const T = (s) => N(s).split(" ").filter(Boolean);
// Mismos alias que en resultados.mjs y en el Calendario del index (nombre de la app normalizado → nombres de la API normalizados)
const ALIAS = {
  "racing de santander": ["santander", "racing santander", "real racing club de santander", "racing club de santander"],
  "bayer leverkusen": ["leverkusen", "bayer 04 leverkusen", "b04"],
  "rennes": ["stade rennais", "stade rennais fc", "stade rennais fc 1901", "rennais", "ren"],
  "sabah fk": ["sabah", "fk sabah"],
  "sl bratislava": ["slovan bratislava", "sk slovan bratislava", "slovan"],
  "pae aek": ["aek athens", "aek athens fc", "aek"],
  "shaktar": ["shakhtar donetsk", "fc shakhtar donetsk", "shakhtar"],
  "sporting cp": ["sporting clube de portugal", "sporting lisbon", "sporting"],
  "slavia praha": ["sk slavia praha", "slavia prague"],
};
// 3 = exacto (o alias), 2 = lo contiene, 1 = tiene todas sus palabras, 0 = no coincide
const score = (app, t) => {
  if (!t) return 0;
  const a = N(app), names = [N(t.name), N(t.shortName), N(t.tla)].filter(Boolean);
  if (names.includes(a) || (ALIAS[a] || []).some((x) => names.includes(x))) return 3;
  if (names.some((n) => (" " + n + " ").includes(" " + a + " "))) return 2;
  const ta = T(a);
  return ta.length && names.some((n) => ta.every((w) => T(n).includes(w))) ? 1 : 0;
};

class Fallo extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export default async (req) => {
  const token = (typeof Netlify !== "undefined" && Netlify.env.get("FOOTBALL_DATA_TOKEN")) || process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return Response.json({ error: "Falta FOOTBALL_DATA_TOKEN" }, { status: 500 });
  const q = new URL(req.url).searchParams;
  const nombres = { home: (q.get("home") || "").trim(), away: (q.get("away") || "").trim() };
  if (!nombres.home || !nombres.away) return Response.json({ error: "Faltan los equipos" }, { status: 400 });

  const call = async (path) => {
    const r = await fetch(API + path, { headers: { "X-Auth-Token": token } });
    if (r.status === 429) throw new Fallo("Demasiadas consultas a la API de fútbol. Prueba de nuevo en un minuto.", 429);
    if (!r.ok) throw new Fallo("football-data.org respondió " + r.status, r.status);
    return r.json();
  };
  let store = null;
  try { store = getStore("forma-cache"); } catch (e) { /* sin caché: funciona igual, solo gasta más llamadas */ }
  const leer = async (k) => { try { return store ? await store.get(k, { type: "json" }) : null; } catch (e) { return null; } };
  const guardar = async (k, v) => { try { if (store) await store.setJSON(k, v); } catch (e) { /* ignorar */ } };

  try {
    // 1) ids de los equipos (se guardan 7 días: la primera vez puede costar hasta 6 llamadas)
    let tm = await leer("equipos");
    if (!tm || !Array.isArray(tm.list) || Date.now() - tm.t > TTL_EQUIPOS) tm = { t: Date.now(), list: [], done: [] };
    const buscar = (nombre) => {
      let best = null, bs = 0;
      for (const t of tm.list) { const s = score(nombre, t); if (s > bs) { bs = s; best = t; } }
      return bs >= 1 ? best : null;
    };
    let eh = buscar(nombres.home), ea = buscar(nombres.away);
    for (const c of COMPS) {
      if (eh && ea) break;
      if (tm.done.includes(c)) continue;
      try {
        const j = await call(`/competitions/${c}/teams`);
        for (const t of j.teams || []) if (!tm.list.some((x) => x.id === t.id)) tm.list.push({ id: t.id, name: t.name, shortName: t.shortName, tla: t.tla });
        tm.done.push(c);
      } catch (e) { if (e.status === 429) throw e; /* competición no disponible en el plan */ }
      eh = buscar(nombres.home); ea = buscar(nombres.away);
    }
    await guardar("equipos", tm);

    const ko = Date.parse(q.get("kickoff") || "");   // hora del partido en la app: sirve para saber de qué competición es
    const clave = `datos6:${eh ? eh.id : "x" + N(nombres.home)}-${ea ? ea.id : "x" + N(nombres.away)}:${Number.isFinite(ko) ? new Date(ko).toISOString().slice(0, 10) : "s"}`;
    const debug = q.get("debug") === "1";
    const hit = debug ? null : await leer(clave);
    if (hit && Date.now() - hit.t < TTL_DATOS) return Response.json(hit.data, { headers: { "cache-control": "public, max-age=600" } });

    // 2) partidos de la temporada de cada equipo (una llamada por equipo)
    const d = new Date(), season = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    const partidos = async (t) => {
      if (!t) return [];
      try { return (await call(`/teams/${t.id}/matches?season=${season}&limit=100`)).matches || []; }
      catch (e) { if (e.status === 429) throw e; try { return (await call(`/teams/${t.id}/matches?limit=100`)).matches || []; } catch (e2) { if (e2.status === 429) throw e2; return []; } }
    };
    const [mh, ma] = [await partidos(eh), await partidos(ea)];
    const entre = (m) => eh && ea && ((m.homeTeam.id === eh.id && m.awayTeam.id === ea.id) || (m.homeTeam.id === ea.id && m.awayTeam.id === eh.id));
    // El partido de la API que es este mismo (los dos equipos, hora más cercana a la de la app, máx. 36 h); da la competición.
    // Sin hora de la app, se usa el próximo partido pendiente entre ambos.
    const entreMs = mh.filter(entre);
    const proximo = Number.isFinite(ko)
      ? entreMs.map((m) => ({ m, dif: Math.abs(Date.parse(m.utcDate) - ko) })).filter((x) => x.dif <= 36 * H).sort((a, b) => a.dif - b.dif).map((x) => x.m)[0]
      : entreMs.filter((m) => m.status !== "FINISHED" && m.status !== "AWARDED").sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate))[0];
    const compCode = proximo && proximo.competition ? proximo.competition.code : null;

    const ahora = Date.now();
    const jugado = (m) => (m.status === "FINISHED" || m.status === "AWARDED") && Date.parse(m.utcDate) <= ahora && m.score && m.score.fullTime && Number.isInteger(m.score.fullTime.home) && Number.isInteger(m.score.fullTime.away);
    const resumen = (t, ms, lado, compCode) => {   // lado: "home" = sus datos como local, "away" = como visitante
      if (!t) return { id: null, n: 0, form: [], stats: null };
      const fin = ms.filter(jugado).sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));   // toda la temporada actual
      const rec = fin.map((m) => {
        const loc = m.homeTeam.id === t.id, ft = m.score.fullTime, gf = loc ? ft.home : ft.away, ga = loc ? ft.away : ft.home;
        return { d: m.utcDate, r: gf > ga ? "G" : gf < ga ? "P" : "E", gf, ga, opp: (loc ? m.awayTeam : m.homeTeam).shortName || (loc ? m.awayTeam : m.homeTeam).name, loc, comp: m.competition && m.competition.code };
      });
      const recS = compCode ? rec.filter((r) => r.comp === compCode) : rec;   // forma y estadísticas solo de la competición del partido (si se conoce)
      const n = recS.length;
      let stats = null;
      if (n) {
        const gft = recS.reduce((a, r) => a + r.gf, 0), gat = recS.reduce((a, r) => a + r.ga, 0);
        stats = {
          gf: gft / n, ga: gat / n, gft, gat,   // medias por partido y totales de la temporada
          win: Math.round(recS.filter((r) => r.r === "G").length / n * 100),
          cs: recS.filter((r) => r.ga === 0).length,   // porterías a cero (número)
        };
      }
      return { id: t.id, n, form: recS.slice(-5), stats, all: rec };
    };
    const home = resumen(eh, mh, "home", compCode), away = resumen(ea, ma, "away", compCode);

    // 3) últimos enfrentamientos: primero el endpoint head2head del partido que enfrenta a ambos; si no, los de esta temporada
    let h2h = [];
    if (eh && ea) {
      const cand = mh.filter(entre).sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate));
      const fut = proximo || cand.find((m) => m.status !== "FINISHED") || cand[0];
      let lista = [];
      if (fut) { try { lista = (await call(`/matches/${fut.id}/head2head?limit=10`)).matches || []; } catch (e) { if (e.status === 429) throw e; } }
      if (!lista.length) lista = cand;
      const vistos = new Set();
      h2h = lista.filter(jugado).filter((m) => entre(m) && !vistos.has(m.id) && vistos.add(m.id))
        .sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate)).slice(0, 5)
        .map((m) => ({ d: m.utcDate, h: m.homeTeam.id === eh.id ? "home" : "away", hs: m.score.fullTime.home, as: m.score.fullTime.away, comp: m.competition && m.competition.code }));
    }
    const gana = (x) => (x.hs === x.as ? "d" : (x.hs > x.as) === (x.h === "home") ? "h" : "a");
    const cuenta = { h: 0, d: 0, a: 0 };
    h2h.forEach((x) => cuenta[gana(x)]++);

    if (debug) return Response.json({ season, equipos: { home: eh, away: ea }, compCode, home, away, h2h });
    delete home.all; delete away.all;
    const data = { season, comp: compCode, home, away, h2h: { matches: h2h, hw: cuenta.h, d: cuenta.d, aw: cuenta.a }, falta: { home: !eh, away: !ea } };
    await guardar(clave, { t: Date.now(), data });
    return Response.json(data, { headers: { "cache-control": "public, max-age=600" } });
  } catch (e) {
    return Response.json({ error: e.message || "Error inesperado" }, { status: e.status === 429 ? 429 : 502 });
  }
};
