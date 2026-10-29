export default async (req) => {
  const id = new URL(req.url).searchParams.get("id");
  const r = await fetch(`https://api.football-data.org/v4/matches/${id}`, {
    headers: { "X-Auth-Token": Netlify.env.get("FOOTBALL_DATA_TOKEN") }
  });
  const m = await r.json();
  return Response.json({
    estado: m.status,
    local: m.score?.fullTime?.home,
    visitante: m.score?.fullTime?.away
  });
};
