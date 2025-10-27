// ==== Configuration: CSV data sources ====
const TEAMS_CSV_URL   = "teams.csv";
const MATCHES_CSV_URL = "matches.csv";

// ==== Helper Functions ====
async function fetchCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).map(l => l.split(","));
  const headers = lines[0].map(h => h.trim());
  return lines.slice(1).map(row =>
    Object.fromEntries(headers.map((h, i) => [h, (row[i] || "").trim()]))
  );
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function groupBy(arr, key) {
  const m = new Map();
  arr.forEach(item => {
    const k = item[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  });
  return m;
}

// Compute standings from match results
function computeStandings(matches) {
  const teamsSet = new Set();
  matches.forEach(m => {
    teamsSet.add(m.home_team);
    teamsSet.add(m.away_team);
  });

  const byTeam = {};
  [...teamsSet].forEach(name => {
    byTeam[name] = {
      team: name, gp: 0, w: 0, l: 0, pts: 0,
      sets_w: 0, sets_l: 0, pf: 0, pa: 0
    };
  });

  // Tally up stats for each played match
  matches
    .filter(m => m.status !== "scheduled")
    .forEach(m => {
      const H = byTeam[m.home_team], A = byTeam[m.away_team];
      H.gp++; A.gp++;
      let hs = 0, as = 0, hp = 0, ap = 0;
      // Sum sets and points
      [[m.set1_h, m.set1_a], [m.set2_h, m.set2_a], [m.set3_h, m.set3_a]].forEach(set => {
        const [h, a] = set;
        // Only consider set if scores exist (ignore 0-0 placeholders)
        if ((h == null && a == null) || (h === 0 && a === 0)) return;
        if (h == null || a == null) return;
        // Determine set winner
        if (h > a) hs++; else if (a > h) as++;
        hp += Number(h) || 0;
        ap += Number(a) || 0;
      });
      // Update cumulative stats
      H.sets_w += hs; H.sets_l += as; H.pf += hp; H.pa += ap;
      A.sets_w += as; A.sets_l += hs; A.pf += ap; A.pa += hp;
      // Assign wins/losses and league points
      if (hs === 2 && as === 0) {        // Home wins 2-0
        H.w++; A.l++; H.pts += 3; A.pts += 0;
      } else if (hs === 2 && as === 1) { // Home wins 2-1
        H.w++; A.l++; H.pts += 2; A.pts += 1;
      } else if (as === 2 && hs === 0) { // Away wins 2-0
        A.w++; H.l++; A.pts += 3; H.pts += 0;
      } else if (as === 2 && hs === 1) { // Away wins 2-1
        A.w++; H.l++; A.pts += 2; H.pts += 1;
      }
      // (If needed, handle forfeits or special cases here)
    });

  // Prepare rows for standings table
  const rows = Object.values(byTeam).map(team => ({
    ...team,
    set_ratio: team.sets_l ? team.sets_w / team.sets_l : (team.sets_w ? team.sets_w : 0),
    points_ratio: team.pa ? team.pf / team.pa : (team.pf ? team.pf : 0)
  }));
  // Sort standings: by league points, then set ratio, then point ratio, then team name
  rows.sort((a, b) =>
    b.pts - a.pts ||
    b.set_ratio - a.set_ratio ||
    b.points_ratio - a.points_ratio ||
    a.team.localeCompare(b.team)
  );
  return rows;
}

function renderStandings(rows) {
  const tableDiv = document.getElementById("standingsTable");
  const headers = ["Team", "GP", "W", "L", "Pts", "Sets W–L", "Set Ratio", "PF", "PA", "Pts Ratio"];
  const html = [
    `<table class="table">`,
    `<thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>`,
    `<tbody>`,
    ...rows.map(r => `<tr>
        <td>${r.team}</td>
        <td>${r.gp}</td>
        <td>${r.w}</td>
        <td>${r.l}</td>
        <td>${r.pts}</td>
        <td>${r.sets_w}–${r.sets_l}</td>
        <td>${r.set_ratio.toFixed(2)}</td>
        <td>${r.pf}</td>
        <td>${r.pa}</td>
        <td>${r.points_ratio.toFixed(2)}</td>
      </tr>`),
    `</tbody></table>`
  ].join("");
  tableDiv.innerHTML = html;
}

// Group matches by round and sort by time
function groupMatchesByRound(matches) {
  const groupedMap = groupBy(matches, "round");
  const rounds = [...groupedMap.entries()].map(([round, list]) => [
    Number(round),
    list.sort((a, b) => (`${a.date} ${a.time}`).localeCompare(`${b.date} ${b.time}`))
  ]);
  rounds.sort((a, b) => a[0] - b[0]);
  return rounds;
}

// Find the index of the next upcoming round (the first round with any scheduled future match)
function findNextRoundIndex(groupedRounds) {
  const today = new Date().toISOString().slice(0, 10);
  const idx = groupedRounds.findIndex(([rnd, matches]) =>
    matches.some(m => m.status === "scheduled" && (m.date ? m.date >= today : true))
  );
  return idx === -1 ? 0 : idx;
}

// Real-time live score overlay using Firestore
async function attachLiveOverlay(matchList) {
  // Remove any existing listeners to avoid duplicates
  if (!window._liveUnsubs) window._liveUnsubs = [];
  window._liveUnsubs.forEach(unsub => { try { unsub(); } catch(e){} });
  window._liveUnsubs = [];

  // Dynamically import Firestore functions for listening (already initialized in index.html)
  const { doc, onSnapshot } = await import("https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js");
  
  matchList.forEach(match => {
    const ref = doc(window.db, "matches", String(match.id));
    const unsubscribe = onSnapshot(ref, snapshot => {
      const data = snapshot.data();
      const li = document.querySelector(`li.round-item[data-id="${match.id}"]`);
      if (!li) return;  // If match element is not in the current round view, skip
      const statusEl = li.querySelector(".status");
      const rightEl = li.querySelector(".round-right");
      const whenText = (match.date || "TBD") + (match.time ? " " + match.time : "");

      if (!data) {
        // No live data for this match: use CSV status
        if (match.status.toLowerCase() === "played") {
          statusEl.textContent = "Final";
          statusEl.className = "status played";
        } else {
          statusEl.textContent = "Scheduled";
          statusEl.className = "status scheduled";
        }
        rightEl.textContent = whenText;
        return;
      }

      // Compute sets won from the live data
      let homeSets = 0, awaySets = 0;
      [[data.set1_h, data.set1_a], [data.set2_h, data.set2_a], [data.set3_h, data.set3_a]].forEach(set => {
        if (!set || set[0] == null || set[1] == null) return;
        if (set[0] > set[1]) homeSets++;
        else if (set[1] > set[0]) awaySets++;
      });

      if (data.status === "live") {
        statusEl.textContent = "Live";
        statusEl.className = "status live";
        rightEl.textContent = `${homeSets} – ${awaySets} | ${whenText}`;
      } else if (data.status === "played") {
        statusEl.textContent = "Final";
        statusEl.className = "status played";
        rightEl.textContent = `${homeSets} – ${awaySets} | ${whenText}`;
      } else {
        // Fallback for any other status
        statusEl.textContent = "Scheduled";
        statusEl.className = "status scheduled";
        rightEl.textContent = whenText;
      }
    });
    window._liveUnsubs.push(unsubscribe);
  });
}

// Render a given round’s fixture list and attach live listeners
function renderRound(groupedRounds, index) {
  const [roundNum, matches] = groupedRounds[index] || [0, []];
  document.getElementById("roundTitle").textContent = `Round ${roundNum}`;
  const ul = document.getElementById("roundList");
  ul.innerHTML = matches.map(m => {
    const whenText = (m.date || "TBD") + (m.time ? " " + m.time : "");
    const statusText = (m.status === "played") ? "Final" : "Scheduled";
    const statusClass = (m.status === "played") ? "status played" : "status scheduled";
    return `<li class="round-item" data-id="${m.id}">
              <div>
                <div><strong>${m.home_team}</strong> vs <strong>${m.away_team}</strong></div>
                <div class="${statusClass} status">${statusText}</div>
              </div>
              <div class="round-right">${whenText}</div>
            </li>`;
  }).join("");
  attachLiveOverlay(matches);
  return [roundNum, matches];
}

// ==== Initial Load ====
(async function() {
  // Fetch initial data from CSV files
  const rawMatches = await fetchCSV(MATCHES_CSV_URL);
  const matches = rawMatches.map(m => ({
    id: m.id,
    round: Number(m.round),
    date: m.date || "",
    time: m.time || "",
    home_team: m.home_team,
    away_team: m.away_team,
    set1_h: toNum(m.set1_h), set1_a: toNum(m.set1_a),
    set2_h: toNum(m.set2_h), set2_a: toNum(m.set2_a),
    set3_h: toNum(m.set3_h), set3_a: toNum(m.set3_a),
    status: (m.status || "scheduled").toLowerCase()
  }));

  // Compute and display standings
  const standingsData = computeStandings(matches);
  renderStandings(standingsData);

  // Group matches by round and show the nearest upcoming round
  const groupedRounds = groupMatchesByRound(matches);
  let currentIndex = findNextRoundIndex(groupedRounds);
  renderRound(groupedRounds, currentIndex);

  // Carousel navigation for rounds
  document.getElementById("prevRound").addEventListener("click", () => {
    currentIndex = (currentIndex - 1 + groupedRounds.length) % groupedRounds.length;
    renderRound(groupedRounds, currentIndex);
  });
  document.getElementById("nextRound").addEventListener("click", () => {
    currentIndex = (currentIndex + 1) % groupedRounds.length;
    renderRound(groupedRounds, currentIndex);
  });
})();
