// ==== CONFIG: replace with your published CSV URLs ====
const TEAMS_CSV_URL   = "teams.csv";
const MATCHES_CSV_URL = "matches.csv";

// ==== Helpers ====
async function fetchCSV(url){
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).map(l => l.split(","));
  const headers = lines[0].map(h => h.trim());
  return lines.slice(1).map(row => Object.fromEntries(headers.map((h,i)=>[h, (row[i]||"").trim()])));
}

function toNum(v){ const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function groupBy(arr, key){ const m=new Map(); arr.forEach(it=>{ const k=it[key]; if(!m.has(k)) m.set(k,[]); m.get(k).push(it); }); return m; }

function computeStandings(matches){
  const teamsSet = new Set();
  matches.forEach(m=>{ teamsSet.add(m.home_team); teamsSet.add(m.away_team); });
  const byTeam = {};
  [...teamsSet].forEach(name=>byTeam[name]={team:name,gp:0,w:0,l:0,pts:0,sets_w:0,sets_l:0,pf:0,pa:0});

  matches.filter(m=>m.status!=="scheduled").forEach(m=>{
    const H = byTeam[m.home_team], A = byTeam[m.away_team];
    H.gp++; A.gp++;

    let hs=0, as=0, hp=0, ap=0;
    [[m.set1_h,m.set1_a],[m.set2_h,m.set2_a],[m.set3_h,m.set3_a]].forEach(s=>{
      const [h,a]=s;
      // Ignore sets where both h and a are 0 or undefined
      if ((h == null && a == null) || (h === 0 && a === 0)) return;
      if(h==null || a==null) return;
      if(h>a) hs++; else as++;
      hp += h; ap += a;
    });

    H.sets_w += hs; H.sets_l += as; H.pf += hp; H.pa += ap;
    A.sets_w += as; A.sets_l += hs; A.pf += ap; A.pa += hp;

    // Debug: log set counts and match info
    console.log(`Match: ${m.home_team} vs ${m.away_team}, hs: ${hs}, as: ${as}, sets: [${m.set1_h},${m.set1_a}],[${m.set2_h},${m.set2_a}],[${m.set3_h},${m.set3_a}]`);

    // Volleyball points system (strict)
    if ((hs === 2 && as === 0)) { // Home wins 2-0
      H.w++; A.l++;
      H.pts += 3; A.pts += 0;
    } else if (hs === 2 && as === 1) { // Home wins 2-1
      H.w++; A.l++;
      H.pts += 2; A.pts += 1;
    } else if (as === 2 && hs === 0) { // Away wins 2-0
      A.w++; H.l++;
      A.pts += 3; H.pts += 0;
    } else if (as === 2 && hs === 1) { // Away wins 2-1
      A.w++; H.l++;
      A.pts += 2; H.pts += 1;
    }
    if(m.status==="forfeit"){ /* Optional: add -1 to forfeiter here if you mark who forfeited */ }
  });

  const rows = Object.values(byTeam).map(t=>({
    ...t,
    set_ratio: t.sets_l ? t.sets_w/t.sets_l : (t.sets_w? t.sets_w : 0),
    points_ratio: t.pa ? t.pf/t.pa : (t.pf? t.pf : 0)
  }));

  rows.sort((a,b)=> b.pts-a.pts || b.set_ratio-a.set_ratio || b.points_ratio-a.points_ratio || a.team.localeCompare(b.team));
  return rows;
}

function renderStandings(rows){
  const el = document.getElementById("standingsTable");
  const th = ["Team","GP","W","L","Pts","Sets W–L","Set Ratio","PF","PA","Pts Ratio"];
  const html = [
    `<table class="table">`,
    `<thead><tr>${th.map(h=>`<th>${h}</th>`).join("")}</tr></thead>`,
    `<tbody>`,
    ...rows.map(r=>`<tr>
      <td>${r.team}</td>
      <td>${r.gp}</td>
      <td>${r.w}</td>
      <td>${r.l}</td>
      <td>${r.pts}</td>
      <td>${r.sets_w}-${r.sets_l}</td>
      <td>${r.set_ratio.toFixed(2)}</td>
      <td>${r.pf}</td>
      <td>${r.pa}</td>
      <td>${r.points_ratio.toFixed(2)}</td>
    </tr>`),
    `</tbody></table>`
  ].join("");
  el.innerHTML = html;
}

function toDateKey(d){ return d ? d : "9999-12-31"; } // schedule unknown dates last

function groupMatchesByRound(matches){
  const g = groupBy(matches, "round");
  const rounds = [...g.entries()].map(([r,list]) => [Number(r), list.sort((a,b)=>`${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))])
                     .sort((a,b)=>a[0]-b[0]);
  return rounds;
}

function findNextRoundIndex(grouped){
  const today = new Date().toISOString().slice(0,10);
  const idx = grouped.findIndex(([round, list]) => list.some(m => (m.status==="scheduled") && (toDateKey(m.date) >= today)));
  return idx === -1 ? 0 : idx;
}

function renderRound(grouped, idx){
  const [round, list] = grouped[idx] || [0,[]];
  document.getElementById("roundTitle").textContent = `Round ${round}`;
  const ul = document.getElementById("roundList");
  ul.innerHTML = list.map(m=>{
    const status = m.status==="played" ? `<span class="status played">Final</span>` : `<span class="status scheduled">Scheduled</span>`;
    let lineRight;
    if (m.status === "played") {
      // Count sets won by each team
      let homeSets = 0, awaySets = 0;
      [[m.set1_h, m.set1_a], [m.set2_h, m.set2_a], [m.set3_h, m.set3_a]].forEach(([h, a]) => {
        if (h == null || a == null) return;
        if (h > a) homeSets++;
        else if (a > h) awaySets++;
      });
      lineRight = `${homeSets} – ${awaySets}`;
    } else {
      lineRight = `${m.date || "TBD"} ${m.time || ""}`;
    }
    return `<li class="round-item">
      <div>
        <div><strong>${m.home_team}</strong> vs <strong>${m.away_team}</strong></div>
        <div class="note">${status}</div>
      </div>
      <div class="note">${lineRight}</div>
    </li>`;
  }).join("");
  return [round, list];
}

// ==== Boot ====
(async function(){
  // fetch data
  const rawMatches = await fetchCSV(MATCHES_CSV_URL);
  const matches = rawMatches.map(r=>({
    id: r.id, round: Number(r.round), date: r.date || "", time: r.time || "",
    home_team: r.home_team, away_team: r.away_team,
    set1_h: toNum(r.set1_h), set1_a: toNum(r.set1_a),
    set2_h: toNum(r.set2_h), set2_a: toNum(r.set2_a),
    set3_h: toNum(r.set3_h), set3_a: toNum(r.set3_a),
    status: (r.status||"scheduled").toLowerCase()
  }));

  const standings = computeStandings(matches);
  renderStandings(standings);

  const grouped = groupMatchesByRound(matches);
  let idx = findNextRoundIndex(grouped);
  renderRound(grouped, idx);

  document.getElementById("prevRound").addEventListener("click", ()=>{ idx=(idx-1+grouped.length)%grouped.length; renderRound(grouped, idx); });
  document.getElementById("nextRound").addEventListener("click", ()=>{ idx=(idx+1)%grouped.length; renderRound(grouped, idx); });
})();
