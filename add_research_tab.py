PW_HASH = 2111683212

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1 — Add nav button
old_nav = "    <button class=\"nav-tab\" onclick=\"showTab('sources',this)\">🔗 Sources</button>"
new_nav = old_nav + "\n    <button class=\"nav-tab\" onclick=\"showTab('research',this)\">🔒 Deep Strike Research</button>"
assert old_nav in content, "Nav button not found"
content = content.replace(old_nav, new_nav, 1)

# 2 — Add password JS
OLD_JS = "const btn=[...document.querySelectorAll('.nav-tab')].find(b=>(b.getAttribute('onclick')||'').includes(\"'\"+id+\"'\"));"
NEW_JS = OLD_JS + f"""
function checkResearchPw(){{
  const pw=document.getElementById('research-pw').value;
  let h=0;for(const c of pw){{h=(Math.imul(31,h)+c.charCodeAt(0))|0;}}
  if(h==={PW_HASH}){{
    document.getElementById('research-gate').style.display='none';
    document.getElementById('research-content').style.display='block';
    sessionStorage.setItem('ds_unlocked','1');
  }}else{{
    document.getElementById('research-pw-err').style.display='block';
    document.getElementById('research-pw').value='';
  }}
}}
function checkDsSession(){{
  if(sessionStorage.getItem('ds_unlocked')==='1'){{
    const g=document.getElementById('research-gate');
    const c=document.getElementById('research-content');
    if(g&&c){{g.style.display='none';c.style.display='block';}}
  }}
}}"""
assert OLD_JS in content, "JS anchor not found"
content = content.replace(OLD_JS, NEW_JS, 1)

# 3 — Tab HTML + charts
TAB = """
<div id="tab-research" class="tab-panel">
<div id="research-gate" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:400px;gap:20px;padding:40px 20px;text-align:center">
  <div style="font-family:var(--head);font-weight:900;font-size:1.1rem;color:#fff">&#x1F512; Deep Strike Research</div>
  <div style="font-family:var(--mono);font-size:0.6rem;color:var(--text3);max-width:340px;line-height:1.8">Working research findings on Ukraine's long-range drone campaign against Russia.<br>Access restricted to colleagues and collaborators.</div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center">
    <input id="research-pw" type="password" placeholder="Enter password" onkeydown="if(event.key==='Enter')checkResearchPw()" style="background:var(--bg2);border:1px solid var(--border);color:#fff;padding:8px 12px;border-radius:4px;font-family:var(--mono);font-size:0.7rem;width:200px;outline:none">
    <button onclick="checkResearchPw()" style="background:var(--accent);color:#000;border:none;padding:8px 14px;border-radius:4px;font-family:var(--mono);font-size:0.65rem;font-weight:700;cursor:pointer;letter-spacing:0.05em">ENTER</button>
  </div>
  <div id="research-pw-err" style="font-family:var(--mono);font-size:0.58rem;color:#ef5350;display:none">Incorrect password</div>
</div>
<div id="research-content" style="display:none">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border2)">
    <div>
      <div class="section-title">Deep Strike <span>Research</span></div>
      <div class="section-sub">UKRAINIAN LONG-RANGE DRONE CAMPAIGN AGAINST RUSSIA &middot; WORKING FINDINGS &middot; NOT PEER-REVIEWED</div>
    </div>
  </div>
  <div class="disclaimer" style="margin-bottom:24px">
    Original research by <strong>Andro Mathewson</strong>, PhD Candidate in War Studies, King's College London.
    Data: @dronbomber &middot; @mod_russia &middot; Open-Meteo ERA5 &middot; Jun 2024&ndash;Apr 2026.
    <a href="https://github.com/Androm2018/ukraine-drone-weather-analysis" target="_blank" style="color:var(--accent)">Code &amp; data on GitHub &#x2197;</a>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px">
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:12px"><div style="font-family:var(--mono);font-size:0.45rem;color:var(--text3);margin-bottom:4px">CLAIMED INTERCEPTS</div><div style="font-family:var(--head);font-weight:900;font-size:1.2rem;color:#ef5350">48,615</div><div style="font-family:var(--mono);font-size:0.42rem;color:var(--text3)">Russian MoD &middot; propaganda</div></div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:12px"><div style="font-family:var(--mono);font-size:0.45rem;color:var(--text3);margin-bottom:4px">CONFIRMED STRIKES</div><div style="font-family:var(--head);font-weight:900;font-size:1.2rem;color:var(--accent)">2,480</div><div style="font-family:var(--mono);font-size:0.42rem;color:var(--text3)">@dronbomber OSINT</div></div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:12px"><div style="font-family:var(--mono);font-size:0.45rem;color:var(--text3);margin-bottom:4px">INFLATION FACTOR</div><div style="font-family:var(--head);font-weight:900;font-size:1.2rem;color:#ce93d8">20:1</div><div style="font-family:var(--mono);font-size:0.42rem;color:var(--text3)">Rising to 36:1 Apr 2026</div></div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:12px"><div style="font-family:var(--mono);font-size:0.45rem;color:var(--text3);margin-bottom:4px">STRIKE DAYS</div><div style="font-family:var(--head);font-weight:900;font-size:1.2rem;color:#fff">624</div><div style="font-family:var(--mono);font-size:0.42rem;color:var(--text3)">94% of all days</div></div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:12px"><div style="font-family:var(--mono);font-size:0.45rem;color:var(--text3);margin-bottom:4px">AD ATTRITION EFFECT</div><div style="font-family:var(--head);font-weight:900;font-size:1.2rem;color:#81c784">+84%</div><div style="font-family:var(--mono);font-size:0.42rem;color:var(--text3)">Severity post-campaign &middot; p=0.0000</div></div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:12px"><div style="font-family:var(--mono);font-size:0.45rem;color:var(--text3);margin-bottom:4px">MAX STRIKE RANGE</div><div style="font-family:var(--head);font-weight:900;font-size:1.2rem;color:#ef5350">1,355 km</div><div style="font-family:var(--mono);font-size:0.42rem;color:var(--text3)">Bashkortostan &middot; mean 510 km</div></div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:16px">
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:14px">
      <div style="font-family:var(--mono);font-size:0.48rem;color:var(--text3);margin-bottom:8px">RUSSIAN CLAIMED INTERCEPTS OVER TIME &#x26A0; PROPAGANDA</div>
      <div style="position:relative;height:150px"><canvas id="ds-o1" role="img" aria-label="Russian claimed intercepts rising">Rising claims.</canvas></div>
      <p style="font-family:var(--body);font-size:0.7rem;color:var(--text3);margin-top:8px;line-height:1.6">20x increase since 2023. Inflation factor rising 2x&rarr;36x &mdash; Russia's narrative increasingly disconnected from OSINT reality.</p>
    </div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:14px">
      <div style="font-family:var(--mono);font-size:0.48rem;color:var(--text3);margin-bottom:8px">CONFIRMED STRIKES BY TARGET CATEGORY</div>
      <div style="position:relative;height:150px"><canvas id="ds-o2" role="img" aria-label="Strike volume doubling">Volume doubling.</canvas></div>
      <p style="font-family:var(--body);font-size:0.7rem;color:var(--text3);margin-top:8px;line-height:1.6">Strike volume doubled from ~30/month (mid-2024) to ~160/month (early 2026).</p>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:16px">
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:14px">
      <div style="font-family:var(--mono);font-size:0.48rem;color:var(--text3);margin-bottom:8px">TARGET EFFECTIVENESS &mdash; DAMAGE SEVERITY (0&ndash;3)</div>
      <div style="position:relative;height:240px"><canvas id="ds-o3" role="img" aria-label="Radar/AD highest severity">Radar/AD top.</canvas></div>
      <p style="font-family:var(--body);font-size:0.7rem;color:var(--text3);margin-top:8px;line-height:1.6">Radar/AD (2.08) and fuel depots (2.06) most damaging. Command/control 55% confirmation rate &mdash; most verifiable category.</p>
    </div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:14px">
      <div style="font-family:var(--mono);font-size:0.48rem;color:var(--text3);margin-bottom:6px">AD ATTRITION &mdash; CRIMEA SEVERITY (RED LINES = AD DESTROYED)</div>
      <div style="position:relative;height:140px"><canvas id="ds-a1" role="img" aria-label="Severity doubles after AD campaign">Severity doubles.</canvas></div>
      <div style="font-family:var(--mono);font-size:0.48rem;color:var(--text3);margin:10px 0 6px">CONFIRMATION RATE (%)</div>
      <div style="position:relative;height:100px"><canvas id="ds-a2" role="img" aria-label="Confirmation rate triples">Rate triples.</canvas></div>
      <p style="font-family:var(--body);font-size:0.7rem;color:var(--text3);margin-top:8px;line-height:1.6">After Ukraine's Sep&ndash;Nov 2025 Crimea AD campaign: severity +84%, confirmation rate +162%. p=0.0000 &mdash; strongest finding in dataset.</p>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:16px">
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:14px">
      <div style="font-family:var(--mono);font-size:0.48rem;color:var(--text3);margin-bottom:8px">STRIKE RANGE DISTRIBUTION (KM FROM FRONT LINE)</div>
      <div style="position:relative;height:150px"><canvas id="ds-rng1" role="img" aria-label="Bimodal range distribution">Bimodal.</canvas></div>
      <p style="font-family:var(--body);font-size:0.7rem;color:var(--text3);margin-top:8px;line-height:1.6">Min 92km (Belgorod) &middot; Mean 510km &middot; Max 1,355km (Bashkortostan). Oil refineries deepest at 712km mean.</p>
    </div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:14px">
      <div style="font-family:var(--mono);font-size:0.48rem;color:var(--text3);margin-bottom:8px">WEATHER EFFECT &mdash; SEVERITY BY CONDITIONS (p=0.73 n.s.)</div>
      <div style="position:relative;height:150px"><canvas id="ds-w1" role="img" aria-label="No weather effect">No effect.</canvas></div>
      <p style="font-family:var(--body);font-size:0.7rem;color:var(--text3);margin-top:8px;line-height:1.6">No significant weather effect. Ukraine strikes 94% of all days &mdash; programme fully industrialised, weather-agnostic.</p>
    </div>
  </div>
  <div class="disclaimer">&#x26A0; <strong>Data caveat:</strong> @mod_russia figures are state propaganda. @dronbomber provides OSINT floor estimates. The 20:1 gap reflects both Russian inflation and unreported Ukrainian launches. Working findings &mdash; not peer-reviewed.</div>
</div>
</div>

<script>
document.addEventListener('DOMContentLoaded',function(){
  checkDsSession();
  const gc='rgba(255,255,255,0.07)';
  const df={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}};
  const TS={font:{size:9},color:'#7a8a9a'};
  function mk(id,cfg){const el=document.getElementById(id);if(el)new Chart(el,cfg);}
  mk('ds-o1',{type:'bar',data:{labels:['Jan23','Apr23','Jul23','Oct23','Jan24','Apr24','Jul24','Oct24','Jan25','Apr25','Jul25','Oct25','Jan26','Apr26'],datasets:[{data:[30,350,700,900,1050,400,600,800,1300,900,2500,2300,3900,1900],backgroundColor:'#B71C1C',borderRadius:2},{type:'line',data:[null,null,580,650,850,650,670,900,1250,1350,2100,2400,3400,null],borderColor:'#FFD700',borderWidth:2,pointRadius:0,tension:0.4,fill:false}]},options:{...df,scales:{x:{ticks:{...TS,maxRotation:45},grid:{color:gc}},y:{ticks:{...TS},grid:{color:gc}}}}});
  mk('ds-o2',{type:'bar',data:{labels:['Jun24','Aug24','Oct24','Dec24','Feb25','Apr25','Jun25','Aug25','Oct25','Dec25','Feb26','Apr26'],datasets:[{data:[5,8,10,14,18,5,10,12,18,20,22,8],backgroundColor:'#E65100',borderRadius:2},{data:[4,6,8,10,12,8,9,10,12,14,12,6],backgroundColor:'#005BBB',borderRadius:2},{data:[2,3,4,5,6,4,5,6,7,8,9,4],backgroundColor:'#6A1B9A',borderRadius:2},{data:[3,5,8,10,14,8,10,12,14,16,18,8],backgroundColor:'#00695C',borderRadius:2}]},options:{...df,scales:{x:{stacked:true,ticks:{...TS,maxRotation:45},grid:{color:gc}},y:{stacked:true,ticks:{...TS},grid:{color:gc}}}}});
  mk('ds-o3',{type:'bar',data:{labels:['Radar/AD','Fuel depot','Command','Ammo','Chemical','Strat AB','Airbase','Oil refinery','Naval','Power'],datasets:[{data:[2.08,2.06,1.97,1.93,1.74,1.69,1.65,1.41,1.39,1.11],backgroundColor:'#005BBB',borderRadius:2}]},options:{...df,indexAxis:'y',scales:{x:{min:0,max:3,ticks:{...TS},grid:{color:gc}},y:{ticks:{...TS},grid:{color:gc}}}}});
  const mos=['Jun24','Jul24','Aug24','Sep24','Oct24','Nov24','Dec24','Jan25','Feb25','Mar25','Apr25','May25','Jun25','Jul25','Aug25','Sep25','Oct25','Nov25','Dec25','Jan26','Feb26','Mar26','Apr26'];
  mk('ds-a1',{type:'bar',data:{labels:mos,datasets:[{data:[1.0,0.8,1.5,1.5,1.0,1.4,0.75,1.35,1.0,0.85,0.5,1.35,1.55,1.6,0.8,1.25,1.7,1.7,2.5,2.55,2.25,2.55,1.85],backgroundColor:mos.map((_,i)=>i>=15?'#185FA5':'#85B7EB'),borderRadius:2}]},options:{...df,scales:{x:{ticks:{...TS,maxRotation:45,autoSkip:true},grid:{color:gc}},y:{min:0,max:3,ticks:{...TS},grid:{color:gc}}}}});
  mk('ds-a2',{type:'line',data:{labels:mos,datasets:[{data:[0,20,25,0,0,5,0,0,0,0,0,25,38,29,8,8,10,16,43,46,29,47,71],borderColor:'#2E7D32',backgroundColor:'rgba(46,125,50,0.1)',borderWidth:2,pointRadius:2,fill:true,tension:0.3}]},options:{...df,scales:{x:{ticks:{...TS,maxRotation:45,autoSkip:true},grid:{color:gc}},y:{min:0,ticks:{...TS,callback:function(v){return v+'%'}},grid:{color:gc}}}}});
  mk('ds-rng1',{type:'bar',data:{labels:['0-100','100-200','200-300','300-400','400-500','500-600','600-700','700-800','800-900','900+'],datasets:[{data:[60,230,100,145,110,225,270,40,55,40],backgroundColor:'#185FA5',borderRadius:2}]},options:{...df,scales:{x:{ticks:{...TS,maxRotation:45},grid:{color:gc}},y:{ticks:{...TS},grid:{color:gc}}}}});
  mk('ds-w1',{type:'bar',data:{labels:['Clear','Overcast','Adverse'],datasets:[{data:[1.05,1.11,1.04],backgroundColor:['#2E7D32','#185FA5','#B71C1C'],borderRadius:3}]},options:{...df,scales:{x:{ticks:{...TS},grid:{color:gc}},y:{min:0,max:1.5,ticks:{...TS},grid:{color:gc}}}}});
});
</script>
"""

assert "</body>" in content, "</body> not found"
content = content.replace("</body>", TAB + "\n</body>", 1)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done. Verifying...")
with open('index.html') as f:
    out = f.read()
print("Nav button added:", "Deep Strike Research" in out)
print("Tab panel added:", "tab-research" in out)
print("Password function:", "checkResearchPw" in out)
print("Hash correct:", str(PW_HASH) in out)
