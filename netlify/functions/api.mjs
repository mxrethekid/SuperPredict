import { getStore } from "@netlify/blobs";

export const config = { path: "/api" };

const KEY = "state";
const empty = () => ({ players: [], matches: [], preds: {} });
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function applyOps(st, ops) {
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

export default async (req) => {
  const store = getStore("superpredict");
  let st = (await store.get(KEY, { type: "json" })) || empty();
  st.players ||= [];
  st.matches ||= [];
  st.preds ||= {};

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (Array.isArray(body.ops) && body.ops.length) {
      applyOps(st, body.ops);
      await store.setJSON(KEY, st);
    }
  }
  return json({ state: st });
};
