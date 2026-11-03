// SuperPredict en Cloudflare Workers: página (carpeta public), /api (estado compartido), calendario, forma y resultados automáticos.
// Un solo archivo. Los datos se guardan en un Durable Object (base de datos SQLite con consistencia fuerte: dos móviles a la vez no se pisan).
// Secreto necesario: FOOTBALL_DATA_TOKEN (Workers & Pages → tu proyecto → Settings → Variables and Secrets).
import { DurableObject } from "cloudflare:workers";

const DIA = 864e5;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// ======================= Base de datos (Durable Object) =======================
const CH = 100000;   // los valores se parten en trozos para no pasar el límite de tamaño por fila
const emptyState = () => ({ players: [], matches: [], preds: {} });

function applyOps(st, ops) {   // misma lógica que tenía api.mjs
  for (const o of ops) {
    if (o.c === "preds") {
      const m = (st.preds[o.m] = st.preds[o.m] || {});
      if (o.v === null) delete m[o.p];
      else m[o.p] = o.v;
      if (!Object.keys(m).length) delete st.preds[o.m];
    } else if (o.c === "players" || o.c === "matches") {
      const arr = st[o.c];
      const i = arr.findIndex((x) => x.id === o.id);
      if (o.rm) {
        if (i >= 0) arr.splice(i, 1);
        continue;
      }
      const e = i >= 0 ? arr[i] : { id: o.id };
      Object.assign(e, o.set || {});
      (o.del || []).forEach((k) => delete e[k]);
      if (i < 0) arr.push(e);
    }
  }
}

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT NOT NULL, i INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, i))");
  }
  _get(k) {
    const rows = this.sql.exec("SELECT v FROM kv WHERE k = ? ORDER BY i", k).toArray();
    return rows.length ? JSON.parse(rows.map((r) => r.v).join("")) : null;
  }
  _set(k, val) {
    const s = JSON.stringify(val);
    this.sql.exec("DELETE FROM kv WHERE k = ?", k);
    let n = 0;
    do { this.sql.exec("INSERT INTO kv (k, i, v) VALUES (?, ?, ?)", k, n, s.slice(n * CH, (n + 1) * CH)); n++; } while (n * CH < s.length);
  }
  async get(k) { return this._get(k); }
  async set(k, v) { this._set(k, v); return true; }
  _state() {
    const st = this._get("state") || emptyState();
    st.players ||= []; st.matches ||= []; st.preds ||= {};
    return st;
  }
  async getState() { return this._state(); }
  // Todo es síncrono dentro del objeto: leer, aplicar y guardar ocurre de una vez, sin que otra petición se cuele en medio.
  async applyOps(ops) {
    const st = this._state();
    if (Array.isArray(ops) && ops.length) { applyOps(st, ops); this._set("state", st); }
    return st;
  }
}

// ======================= Calendario =======================
// Devuelve los partidos de las 5 grandes ligas y la Champions de una semana (para que el admin elija partido con un toque).
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN. Uso: /.netlify/functions/calendario?from=2026-10-30
const CAL_COMPS = "PD,PL,BL1,SA,FL1,CL";

async function calendario(req, env) {
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) return Response.json({ error: "Falta FOOTBALL_DATA_TOKEN" }, { status: 500 });

  const q = new URL(req.url).searchParams.get("from");
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q || "") ? q : day(Date.now());
  const ini = Date.parse(from + "T00:00:00Z"), fin = ini + 7 * DIA;

  const r = await fetch(
    `https://api.football-data.org/v4/matches?competitions=${CAL_COMPS}&dateFrom=${from}&dateTo=${day(fin)}`,
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
}

// ======================= Forma del equipo =======================
// Forma (últimos 5 partidos), últimos enfrentamientos y estadísticas de toda la temporada de dos equipos, para el botón de historial de la tarjeta de jornada.
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN. Uso: /.netlify/functions/forma?home=Real%20Madrid&away=Barcelona
// Los nombres son los de la app; aquí se convierten a equipos de football-data.org con la misma lógica que "resultados".
// El plan gratis solo cubre las 5 grandes ligas y la Champions: de otros equipos saldrán menos datos.
const FD_API = "https://api.football-data.org/v4";
const FORMA_COMPS = ["PD", "PL", "BL1", "SA", "FL1", "CL"];
const H = 36e5, DIA_F = 24 * H;
const TTL_DATOS = 1 * H, TTL_EQUIPOS = 7 * DIA_F;

const NF = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const TF = (s) => NF(s).split(" ").filter(Boolean);
// Mismos alias que en resultados.mjs y en el Calendario del index (nombre de la app normalizado → nombres de la API normalizados)
const ALIAS_F = {
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
const scoreF = (app, t) => {
  if (!t) return 0;
  const a = NF(app), names = [NF(t.name), NF(t.shortName), NF(t.tla)].filter(Boolean);
  if (names.includes(a) || (ALIAS_F[a] || []).some((x) => names.includes(x))) return 3;
  if (names.some((n) => (" " + n + " ").includes(" " + a + " "))) return 2;
  const ta = TF(a);
  return ta.length && names.some((n) => ta.every((w) => TF(n).includes(w))) ? 1 : 0;
};

class FalloF extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function forma(req, env, cache) {
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) return Response.json({ error: "Falta FOOTBALL_DATA_TOKEN" }, { status: 500 });
  const q = new URL(req.url).searchParams;
  const nombres = { home: (q.get("home") || "").trim(), away: (q.get("away") || "").trim() };
  if (!nombres.home || !nombres.away) return Response.json({ error: "Faltan los equipos" }, { status: 400 });

  const call = async (path) => {
    const r = await fetch(FD_API + path, { headers: { "X-Auth-Token": token } });
    if (r.status === 429) throw new FalloF("Demasiadas consultas a la API de fútbol. Prueba de nuevo en un minuto.", 429);
    if (!r.ok) throw new FalloF("football-data.org respondió " + r.status, r.status);
    return r.json();
  };
  const leer = async (k) => { try { return await cache.get(k); } catch (e) { return null; } };
  const guardar = async (k, v) => { try { await cache.set(k, v); } catch (e) { /* ignorar */ } };

  try {
    // 1) ids de los equipos (se guardan 7 días: la primera vez puede costar hasta 6 llamadas)
    let tm = await leer("equipos");
    if (!tm || !Array.isArray(tm.list) || Date.now() - tm.t > TTL_EQUIPOS) tm = { t: Date.now(), list: [], done: [] };
    const buscar = (nombre) => {
      let best = null, bs = 0;
      for (const t of tm.list) { const s = scoreF(nombre, t); if (s > bs) { bs = s; best = t; } }
      return bs >= 1 ? best : null;
    };
    let eh = buscar(nombres.home), ea = buscar(nombres.away);
    for (const c of FORMA_COMPS) {
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
    const clave = `datos6:${eh ? eh.id : "x" + NF(nombres.home)}-${ea ? ea.id : "x" + NF(nombres.away)}:${Number.isFinite(ko) ? new Date(ko).toISOString().slice(0, 10) : "s"}`;
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
}

// ======================= Resultados automáticos =======================
// Cada 15 min: si hay un partido de liga ya terminado sin resultado, lo busca en football-data.org y lo guarda.
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN (token gratis de football-data.org).
// El plan gratis cubre las 5 grandes ligas y la Champions; Europa/Conference se quedan manuales.
async function resultados(env, estado) {
  const st = (await estado.getState()) || {};
  const now = Date.now();
  // partidos de liga (no de copas internas) que ya deberían haber terminado y siguen sin resultado
  const pend = (st.matches || []).filter((m) => {
    const k = Date.parse(m.kickoff);
    return !m.comp && !m.result && k && now > k + 100 * 6e4 && now < k + 5 * 864e5;
  });
  if (!pend.length) return;

  const token = env.FOOTBALL_DATA_TOKEN;
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
      const h = scoreF(m.home, x.homeTeam), a = scoreF(m.away, x.awayTeam);
      if (h < 1 || a < 1 || Math.abs(Date.parse(x.utcDate) - Date.parse(m.kickoff)) > 2 * 864e5) continue;
      if (h + a > bs) { bs = h + a; best = x; }
    }
    const s = best && best.score && best.score.fullTime;
    if (s && Number.isInteger(s.home) && Number.isInteger(s.away)) ops.push({ c: "matches", id: m.id, set: { result: { h: s.home, a: s.away } } });
    else console.log("Sin resultado aún o sin coincidencia en la API:", m.home, "-", m.away);
  }
  if (!ops.length) return;
  // se guarda directamente en la base de datos, igual que si lo hiciera el admin desde /api
  await estado.applyOps(ops);
  console.log("Resultados guardados:", ops.length);
}

// ======================= Rutas =======================
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "") || "/";
    const estado = env.STORE.get(env.STORE.idFromName("estado"));
    if (p === "/api") {
      let st;
      if (req.method === "POST") {
        let body;
        try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
        st = await estado.applyOps(body && body.ops);
      } else st = await estado.getState();
      return json({ state: st });
    }
    if (p === "/.netlify/functions/calendario") return calendario(req, env);
    if (p === "/.netlify/functions/forma") return forma(req, env, env.STORE.get(env.STORE.idFromName("cache")));
    // la página y el resto de archivos de la carpeta public
    return env.ASSETS.fetch(p === "/" ? new Request(new URL("/index.html", url), req) : req);
  },
  // Cada 15 minutos (cron de wrangler.jsonc): resultados automáticos de los partidos de liga ya terminados
  async scheduled(event, env, ctx) {
    ctx.waitUntil(resultados(env, env.STORE.get(env.STORE.idFromName("estado"))).catch((e) => console.error("resultados:", e && e.message)));
  },
};
