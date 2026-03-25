import { useState, useEffect, useRef } from "react";

/* ─────────────────────────────────────────────
   STORAGE  (persists across sessions)
───────────────────────────────────────────── */
async function dbGet(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
  catch { return null; }
}
async function dbSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

/* ─────────────────────────────────────────────
   CONSTANTS / HELPERS
───────────────────────────────────────────── */
const ROLES = { ADMIN: "admin", TEACHER: "teacher", STUDENT: "student" };
const TEST_STATUS = { SCHEDULED: "scheduled", LIVE: "live", ENDED: "ended" };

function fmt(s) {
  if (!s && s !== 0) return "--";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}
function fmtDate(iso) {
  if (!iso) return "--";
  return new Date(iso).toLocaleString("en-IN", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
}
function getTestStatus(test) {
  if (!test.scheduledAt) return TEST_STATUS.LIVE;
  const now = Date.now();
  const start = new Date(test.scheduledAt).getTime();
  const end = start + (test.durationMins || 180) * 60000;
  if (now < start) return TEST_STATUS.SCHEDULED;
  if (now >= start && now <= end) return TEST_STATUS.LIVE;
  return TEST_STATUS.ENDED;
}

/* ── URL helpers ── */
function getUrlParam(key) {
  const params = new URLSearchParams(window.location.hash.split("?")[1] || window.location.search);
  return params.get(key);
}
function buildShareUrl(testId) {
  const base = window.location.origin + window.location.pathname;
  return `${base}?testId=${testId}`;
}
function buildResultUrl(testId, studentName) {
  const base = window.location.origin + window.location.pathname;
  return `${base}?result=${encodeURIComponent(testId)}&student=${encodeURIComponent(studentName)}`;
}

/* ─────────────────────────────────────────────
   DEMO QUESTIONS
───────────────────────────────────────────── */
const DEMO_QUESTIONS = [
  { id:1, subject:"Physics", type:"mcq", text:"Which of the following correctly gives the Planck length from constants G, hbar and c?", options:["Ghbar2c3","G2hbarc","sqrt(Ghbar/c3)","sqrt(Gc/hbar3)"], correct:2, marks:4, negative:-1 },
  { id:2, subject:"Physics", type:"mcq", text:"A ball is thrown vertically upward at 20 m/s from a 25 m building. Time to hit ground? (g=10)", options:["4 s","5 s","6 s","3 s"], correct:1, marks:4, negative:-1 },
  { id:3, subject:"Physics", type:"integer", text:"Two resistors 4 and 6 ohms are in parallel. Find equivalent resistance x 10.", options:[], correct:24, marks:4, negative:0 },
  { id:4, subject:"Chemistry", type:"mcq", text:"Electronic configuration of Cu (Z=29)?", options:["[Ar]3d9 4s2","[Ar]3d10 4s1","[Ar]3d8 4s2 4p1","[Ar]3d10 4s2"], correct:1, marks:4, negative:-1 },
  { id:5, subject:"Chemistry", type:"mcq", text:"IUPAC name of CH3-CH(OH)-COOH?", options:["2-hydroxypropanoic acid","3-hydroxypropanoic acid","2-hydroxybutanoic acid","Propionic acid"], correct:0, marks:4, negative:-1 },
  { id:6, subject:"Chemistry", type:"integer", text:"How many sigma bonds in benzene (C6H6)?", options:[], correct:12, marks:4, negative:0 },
  { id:7, subject:"Mathematics", type:"mcq", text:"If alpha, beta are roots of x^2 - 3x + 2 = 0, find alpha^2 + beta^2.", options:["5","7","9","13"], correct:0, marks:4, negative:-1 },
  { id:8, subject:"Mathematics", type:"mcq", text:"Value of integral from 0 to pi of sin(x) dx?", options:["0","1","2","pi"], correct:2, marks:4, negative:-1 },
  { id:9, subject:"Mathematics", type:"integer", text:"5 boys, 3 girls seated in a row so no two girls are adjacent. Number of ways?", options:[], correct:14400, marks:4, negative:0 },
];

/* ─────────────────────────────────────────────
   AI PDF PARSER  (Claude API)
───────────────────────────────────────────── */
async function parsePDF(base64, isKey) {
  const prompt = isKey
    ? `Extract answer key from this JEE PDF. Return ONLY JSON: {"answers":[{"q":1,"correct":"B","type":"mcq"},...]}  For integer type put the number. No markdown.`
    : `Extract all questions from this JEE exam PDF. Return ONLY JSON:
{"questions":[{"id":1,"subject":"Physics","type":"mcq","text":"...","options":["A)...","B)...","C)...","D)..."],"marks":4,"negative":-1}]}
For integer type, options=[]. No markdown, no preamble.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:4000,
        messages:[{ role:"user", content:[
          { type:"document", source:{ type:"base64", media_type:"application/pdf", data:base64 }},
          { type:"text", text:prompt }
        ]}]
      })
    });
    const d = await res.json();
    const txt = d.content?.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim();
    return JSON.parse(txt);
  } catch { return null; }
}

/* ─────────────────────────────────────────────
   GOOGLE DRIVE HELPER
───────────────────────────────────────────── */
async function fetchDriveFile(fileId, apiKey) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Drive fetch failed: " + res.status);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/* ==============================================
   MAIN APP
============================================== */
export default function App() {
  const [page, setPage] = useState("login");
  const [user, setUser] = useState(null);
  const [tests, setTests] = useState([]);
  const [activeTest, setActiveTest] = useState(null);
  const [submission, setSubmission] = useState(null);
  const [directTestId, setDirectTestId] = useState(null);
  const [directResult, setDirectResult] = useState(null);

  useEffect(() => {
    (async () => {
      const saved = await dbGet("tests");
      const loadedTests = saved || [];
      if (saved) setTests(loadedTests);

      const testId = getUrlParam("testId");
      const resultId = getUrlParam("result");
      const resultStudent = getUrlParam("student");

      if (resultId && resultStudent) {
        const allResults = await dbGet("all-results") || {};
        const key = `${resultId}__${resultStudent}`;
        const storedResult = allResults[key];
        if (storedResult) {
          const test = loadedTests.find(t => t.id === resultId);
          if (test) {
            setDirectResult({ test, submission: storedResult, studentName: resultStudent });
            setPage("shared-result");
            return;
          }
        }
        setDirectResult({ error: "Result not found. The student may not have submitted yet." });
        setPage("shared-result");
        return;
      }

      if (testId) {
        setDirectTestId(testId);
        setPage("login");
      }
    })();
  }, []);

  const saveTests = async (t) => { setTests(t); await dbSet("tests", t); };

  const login = async (role, name) => {
    setUser({ role, name });
    if (role === ROLES.STUDENT && directTestId) {
      const saved = await dbGet("tests");
      const test = (saved || []).find(t => t.id === directTestId);
      if (test) {
        setActiveTest(test);
        setPage("test");
        return;
      }
    }
    setPage(role === ROLES.STUDENT ? "student" : "admin");
  };

  const handleSubmit = async (sub) => {
    setSubmission(sub);
    const allResults = await dbGet("all-results") || {};
    const key = `${activeTest.id}__${user.name}`;
    allResults[key] = sub;
    await dbSet("all-results", allResults);
    setPage("results");
  };

  if (page === "shared-result") return <SharedResultScreen data={directResult} />;
  if (page === "login") return <LoginScreen onLogin={login} tests={tests} directTestId={directTestId} />;
  if (page === "admin") return <AdminScreen user={user} tests={tests} onSaveTests={saveTests} onLogout={() => { setUser(null); setPage("login"); }} />;
  if (page === "student") return (
    <StudentScreen user={user} tests={tests}
      onStart={(test) => { setActiveTest(test); setPage("test"); }}
      onLogout={() => { setUser(null); setPage("login"); }} />
  );
  if (page === "test") return (
    <TestScreen test={activeTest} student={user} onSubmit={handleSubmit} />
  );
  if (page === "results") return (
    <ResultsScreen test={activeTest} student={user} submission={submission}
      onBack={() => setPage("student")} />
  );
}

/* ─────────────────────────────────────────────
   LOGIN SCREEN
───────────────────────────────────────────── */
function LoginScreen({ onLogin, tests, directTestId }) {
  const [tab, setTab] = useState("student");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const linkedTest = directTestId ? tests.find(t => t.id === directTestId) : null;

  const handle = async () => {
    if (!name.trim()) { setErr("Enter your name"); return; }
    setLoading(true); setErr("");

    if (tab === "student") {
      const studentPasswords = await dbGet("student-passwords") || [];
      if (studentPasswords.length === 0) {
        onLogin(tab, name.trim());
        return;
      }
      const match = studentPasswords.find(
        sp => sp.name.trim().toLowerCase() === name.trim().toLowerCase()
      );
      if (!match) {
        setErr("Your name is not on the access list. Contact your admin.");
        setLoading(false);
        return;
      }
      if (match.password && match.password !== pass) {
        setErr("Wrong password. Please try again.");
        setLoading(false);
        return;
      }
      onLogin(tab, match.name);
    } else {
      if (pass !== "admin123") {
        setErr("Wrong password (hint: admin123)");
        setLoading(false);
        return;
      }
      onLogin(tab, name.trim());
    }
  };

  return (
    <div style={{ minHeight:"100vh", background:"#0a0e1a", display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"Georgia, serif", backgroundImage:"radial-gradient(ellipse at 20% 50%, #0d1b3e 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, #1a0d2e 0%, transparent 60%)" }}>
      <div style={{ width:"100%", maxWidth:420, padding:20 }}>
        <div style={{ textAlign:"center", marginBottom:36 }}>
          <div style={{ fontSize:48, marginBottom:8 }}>🎯</div>
          <div style={{ color:"#e8c97e", fontSize:26, fontWeight:700, letterSpacing:2 }}>TestForge</div>
          <div style={{ color:"rgba(255,255,255,0.4)", fontSize:13, marginTop:4, fontFamily:"monospace", letterSpacing:1 }}>JEE EXAM PLATFORM</div>
        </div>

        {linkedTest && (
          <div style={{ background:"rgba(232,201,126,0.12)", border:"1px solid rgba(232,201,126,0.4)", borderRadius:14, padding:"14px 18px", marginBottom:18, textAlign:"center" }}>
            <div style={{ color:"#e8c97e", fontWeight:700, fontSize:14 }}>📋 You are joining a test</div>
            <div style={{ color:"white", fontWeight:800, fontSize:16, marginTop:4 }}>{linkedTest.title}</div>
            <div style={{ color:"rgba(255,255,255,0.5)", fontSize:12, marginTop:4 }}>{linkedTest.durationMins} min — {linkedTest.questions?.length || 0} Questions</div>
          </div>
        )}

        <div style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(232,201,126,0.2)", borderRadius:20, padding:"32px 28px", backdropFilter:"blur(12px)" }}>
          <div style={{ display:"flex", gap:4, marginBottom:28, background:"rgba(0,0,0,0.3)", borderRadius:10, padding:4 }}>
            {[["student","Student"],["teacher","Teacher"],["admin","Admin"]].map(([r,label]) => (
              <button key={r} onClick={() => { setTab(r); setErr(""); }}
                style={{ flex:1, padding:"9px 4px", borderRadius:8, border:"none", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit",
                  background: tab===r ? "linear-gradient(135deg,#e8c97e,#c9a227)" : "transparent",
                  color: tab===r ? "#0a0e1a" : "rgba(255,255,255,0.5)" }}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div>
              <label style={{ color:"rgba(255,255,255,0.5)", fontSize:11, letterSpacing:2, textTransform:"uppercase", display:"block", marginBottom:7 }}>Full Name</label>
              <input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handle()}
                placeholder="Your name"
                style={{ width:"100%", padding:"12px 14px", borderRadius:10, border:"1px solid rgba(232,201,126,0.25)", background:"rgba(255,255,255,0.05)", color:"white", fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"inherit" }} />
            </div>
            <div>
              <label style={{ color:"rgba(255,255,255,0.5)", fontSize:11, letterSpacing:2, textTransform:"uppercase", display:"block", marginBottom:7 }}>Password</label>
              <input type="password" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handle()}
                placeholder={tab === "student" ? "Enter your password" : "Enter admin password"}
                style={{ width:"100%", padding:"12px 14px", borderRadius:10, border:"1px solid rgba(232,201,126,0.25)", background:"rgba(255,255,255,0.05)", color:"white", fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"inherit" }} />
              {tab !== "student" && <div style={{ color:"rgba(255,255,255,0.25)", fontSize:11, marginTop:5 }}>Demo password: admin123</div>}
            </div>
            {err && <div style={{ background:"rgba(229,57,53,0.15)", border:"1px solid #c62828", borderRadius:8, padding:"9px 13px", color:"#ef9a9a", fontSize:13 }}>{err}</div>}
            <button onClick={handle} disabled={loading}
              style={{ padding:"14px", borderRadius:12, border:"none", background:"linear-gradient(135deg,#e8c97e,#c9a227)", color:"#0a0e1a", fontSize:15, fontWeight:800, cursor:"pointer", fontFamily:"inherit", marginTop:4, letterSpacing:1, opacity:loading?0.7:1 }}>
              {loading ? "Verifying..." : "ENTER PORTAL"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADMIN SCREEN
───────────────────────────────────────────── */
function AdminScreen({ user, tests, onSaveTests, onLogout }) {
  const [view, setView] = useState("dashboard");
  const [form, setForm] = useState({ title:"", subject:"", scheduledAt:"", durationMins:180, mode:"upload", driveApiKey:"", drivePaperFileId:"", driveKeyFileId:"" });
  const [paperFile, setPaperFile] = useState(null);
  const [keyFile, setKeyFile] = useState(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [studentPasswords, setStudentPasswords] = useState([]);
  const [newSP, setNewSP] = useState({ name:"", password:"" });
  const [spMsg, setSpMsg] = useState("");
  const paperRef = useRef(); const keyRef = useRef();

  useEffect(() => {
    (async () => {
      const sp = await dbGet("student-passwords") || [];
      setStudentPasswords(sp);
    })();
  }, []);

  const saveStudentPasswords = async (list) => {
    setStudentPasswords(list);
    await dbSet("student-passwords", list);
  };

  const addStudent = async () => {
    if (!newSP.name.trim()) { setSpMsg("Enter student name"); return; }
    if (!newSP.password.trim()) { setSpMsg("Enter a password"); return; }
    const exists = studentPasswords.find(s => s.name.toLowerCase() === newSP.name.trim().toLowerCase());
    if (exists) { setSpMsg("Student already exists"); return; }
    const updated = [...studentPasswords, { name: newSP.name.trim(), password: newSP.password.trim() }];
    await saveStudentPasswords(updated);
    setNewSP({ name:"", password:"" });
    setSpMsg("Student added!");
    setTimeout(() => setSpMsg(""), 2000);
  };

  const removeStudent = async (name) => {
    const updated = studentPasswords.filter(s => s.name !== name);
    await saveStudentPasswords(updated);
  };

  const updateStudentPassword = async (name, newPass) => {
    const updated = studentPasswords.map(s => s.name === name ? { ...s, password: newPass } : s);
    await saveStudentPasswords(updated);
  };

  const copyLink = (testId) => {
    const url = buildShareUrl(testId);
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(testId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const toBase64 = f => new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(f); });

  const createTest = async () => {
    if (!form.title.trim()) { setStatus("Enter a test title"); return; }
    setLoading(true); setStatus("Processing...");
    let questions = DEMO_QUESTIONS;
    try {
      if (form.mode === "upload") {
        if (paperFile) {
          setStatus("Parsing question paper...");
          const b64 = await toBase64(paperFile);
          const res = await parsePDF(b64, false);
          if (res?.questions?.length) questions = res.questions;
        }
        if (keyFile) {
          setStatus("Parsing answer key...");
          const b64 = await toBase64(keyFile);
          const res = await parsePDF(b64, true);
          if (res?.answers) {
            const map = {}; res.answers.forEach(a=>map[a.q]=a.correct);
            questions = questions.map(q=>({ ...q, correct: map[q.id]??q.correct }));
          }
        }
      } else if (form.mode === "drive") {
        if (!form.driveApiKey || !form.drivePaperFileId) { setStatus("Enter Drive API key and File IDs"); setLoading(false); return; }
        setStatus("Fetching from Google Drive...");
        const paperB64 = await fetchDriveFile(form.drivePaperFileId, form.driveApiKey);
        const parsed = await parsePDF(paperB64, false);
        if (parsed?.questions?.length) questions = parsed.questions;
        if (form.driveKeyFileId) {
          const keyB64 = await fetchDriveFile(form.driveKeyFileId, form.driveApiKey);
          const keyRes = await parsePDF(keyB64, true);
          if (keyRes?.answers) {
            const map={}; keyRes.answers.forEach(a=>map[a.q]=a.correct);
            questions = questions.map(q=>({ ...q, correct: map[q.id]??q.correct }));
          }
        }
      }
    } catch(e) {
      setStatus("Could not parse PDFs, using demo questions");
    }

    const test = {
      id: Date.now().toString(),
      title: form.title,
      subject: form.subject || "Mixed",
      scheduledAt: !form.scheduledAt ? null : form.scheduledAt,
      durationMins: Number(form.durationMins) || 180,
      questions,
      createdBy: user.name,
      createdAt: new Date().toISOString(),
    };
    const updated = [test, ...tests];
    await onSaveTests(updated);
    setStatus("Test created!");
    setLoading(false);
    setView("dashboard");
    setForm({ title:"", subject:"", scheduledAt:"", durationMins:180, mode:"upload", driveApiKey:"", drivePaperFileId:"", driveKeyFileId:"" });
    setPaperFile(null); setKeyFile(null);
  };

  const deleteTest = async (id) => {
    const updated = tests.filter(t=>t.id!==id);
    await onSaveTests(updated);
  };

  const statusColors = {
    [TEST_STATUS.SCHEDULED]:{bg:"#fff3e0",col:"#e65100",dot:"#ff9800"},
    [TEST_STATUS.LIVE]:{bg:"#e8f5e9",col:"#2e7d32",dot:"#43a047"},
    [TEST_STATUS.ENDED]:{bg:"#f5f5f5",col:"#616161",dot:"#9e9e9e"}
  };

  return (
    <div style={{ minHeight:"100vh", background:"#f4f6fb", fontFamily:"Georgia, serif" }}>
      <div style={{ background:"linear-gradient(135deg,#1a1a2e,#16213e)", color:"white", padding:"0 24px", height:58, display:"flex", alignItems:"center", gap:16 }}>
        <span style={{ color:"#e8c97e", fontWeight:800, fontSize:17, letterSpacing:1 }}>🎯 TestForge</span>
        <span style={{ color:"rgba(255,255,255,0.4)", fontSize:12 }}>Admin Panel</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:12, alignItems:"center" }}>
          {[["dashboard","Dashboard"],["create","New Test"],["students","Students"]].map(([v,l])=>(
            <button key={v} onClick={()=>setView(v)}
              style={{ padding:"7px 16px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700,
                background: view===v ? "#e8c97e" : "rgba(255,255,255,0.08)", color: view===v ? "#1a1a2e" : "rgba(255,255,255,0.7)" }}>
              {l}
            </button>
          ))}
          <button onClick={onLogout} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid rgba(255,255,255,0.15)", background:"transparent", color:"rgba(255,255,255,0.6)", cursor:"pointer", fontFamily:"inherit", fontSize:12 }}>Logout</button>
        </div>
      </div>

      <div style={{ maxWidth:920, margin:"0 auto", padding:28 }}>

        {view === "dashboard" && (
          <>
            <div style={{ display:"flex", gap:16, marginBottom:28, flexWrap:"wrap" }}>
              {[
                { label:"Total Tests", val:tests.length, icon:"📝", color:"#3949ab" },
                { label:"Live Now", val:tests.filter(t=>getTestStatus(t)===TEST_STATUS.LIVE).length, icon:"🔴", color:"#e53935" },
                { label:"Scheduled", val:tests.filter(t=>getTestStatus(t)===TEST_STATUS.SCHEDULED).length, icon:"📅", color:"#f57c00" },
                { label:"Completed", val:tests.filter(t=>getTestStatus(t)===TEST_STATUS.ENDED).length, icon:"✅", color:"#2e7d32" },
                { label:"Students", val:studentPasswords.length, icon:"👨‍🎓", color:"#6a1b9a" },
              ].map(({ label,val,icon,color }) => (
                <div key={label} style={{ flex:"1 1 140px", background:"white", borderRadius:14, padding:"20px 22px", boxShadow:"0 2px 10px rgba(0,0,0,0.06)", borderLeft:`4px solid ${color}` }}>
                  <div style={{ fontSize:24 }}>{icon}</div>
                  <div style={{ fontSize:28, fontWeight:800, color, marginTop:6 }}>{val}</div>
                  <div style={{ fontSize:13, color:"#888", marginTop:2 }}>{label}</div>
                </div>
              ))}
            </div>

            <div style={{ background:"white", borderRadius:16, boxShadow:"0 2px 10px rgba(0,0,0,0.06)", overflow:"hidden" }}>
              <div style={{ padding:"18px 24px", borderBottom:"1px solid #f0f0f0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ fontWeight:800, fontSize:16, color:"#1a1a2e" }}>All Tests</div>
                <button onClick={()=>setView("create")} style={{ padding:"8px 18px", borderRadius:9, border:"none", background:"linear-gradient(135deg,#e8c97e,#c9a227)", color:"#1a1a2e", fontWeight:800, cursor:"pointer", fontSize:13 }}>+ New Test</button>
              </div>
              {tests.length === 0 ? (
                <div style={{ padding:48, textAlign:"center", color:"#bbb" }}>
                  <div style={{ fontSize:48, marginBottom:12 }}>📭</div>
                  <div>No tests yet. Create your first test!</div>
                </div>
              ) : tests.map(test => {
                const st = getTestStatus(test);
                const sc = statusColors[st];
                const shareUrl = buildShareUrl(test.id);
                return (
                  <div key={test.id} style={{ padding:"18px 24px", borderBottom:"1px solid #f9f9f9" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
                      <div style={{ flex:1, minWidth:180 }}>
                        <div style={{ fontWeight:700, fontSize:15, color:"#1a1a2e" }}>{test.title}</div>
                        <div style={{ fontSize:12, color:"#888", marginTop:3 }}>{test.subject} — {test.questions?.length||0} Qs — {test.durationMins} min — by {test.createdBy}</div>
                      </div>
                      <div style={{ fontSize:12, color:"#888" }}>{test.scheduledAt ? fmtDate(test.scheduledAt) : "Available Now"}</div>
                      <div style={{ padding:"4px 12px", borderRadius:20, background:sc.bg, color:sc.col, fontSize:12, fontWeight:700, display:"flex", alignItems:"center", gap:6 }}>
                        <div style={{ width:7, height:7, borderRadius:"50%", background:sc.dot }} />{st.charAt(0).toUpperCase()+st.slice(1)}
                      </div>
                      <button onClick={()=>copyLink(test.id)}
                        style={{ padding:"7px 14px", borderRadius:8, border:"none",
                          background: copiedId===test.id ? "#e8f5e9" : "linear-gradient(135deg,#3949ab,#5c6bc0)",
                          color: copiedId===test.id ? "#2e7d32" : "white", cursor:"pointer", fontSize:12, fontWeight:700 }}>
                        {copiedId===test.id ? "Copied!" : "Share Link"}
                      </button>
                      <button onClick={()=>deleteTest(test.id)} style={{ padding:"6px 12px", borderRadius:8, border:"1px solid #ffcdd2", background:"#ffebee", color:"#c62828", cursor:"pointer", fontSize:12, fontWeight:700 }}>Delete</button>
                    </div>
                    <div style={{ marginTop:10, background:"#f8f9ff", borderRadius:8, padding:"8px 12px", display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ fontSize:11, color:"#888", flexShrink:0 }}>Link:</span>
                      <span style={{ fontSize:11, color:"#3949ab", fontFamily:"monospace", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{shareUrl}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {view === "students" && (
          <div>
            <div style={{ background:"white", borderRadius:20, boxShadow:"0 2px 16px rgba(0,0,0,0.08)", padding:32, marginBottom:24 }}>
              <h2 style={{ margin:"0 0 8px", color:"#1a1a2e", fontSize:20 }}>Student Access Control</h2>
              <p style={{ color:"#888", fontSize:13, margin:"0 0 24px" }}>
                Add students with their passwords. Only listed students can log in.
                If this list is empty, anyone can log in as a student.
              </p>

              <div style={{ background:"#f8f9ff", borderRadius:14, padding:20, border:"1px solid #e8eaf6", marginBottom:24 }}>
                <div style={{ fontWeight:700, color:"#3949ab", fontSize:14, marginBottom:14 }}>Add Student</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr auto", gap:12, alignItems:"end" }}>
                  <div>
                    <Label>Student Name</Label>
                    <input value={newSP.name} onChange={e=>setNewSP(p=>({...p,name:e.target.value}))}
                      placeholder="e.g. Dushan"
                      style={{ width:"100%", padding:"11px 13px", borderRadius:10, border:"1px solid #ddd", fontSize:14, outline:"none", background:"white", boxSizing:"border-box", fontFamily:"inherit" }} />
                  </div>
                  <div>
                    <Label>Password</Label>
                    <input value={newSP.password} onChange={e=>setNewSP(p=>({...p,password:e.target.value}))}
                      placeholder="e.g. dushan123"
                      style={{ width:"100%", padding:"11px 13px", borderRadius:10, border:"1px solid #ddd", fontSize:14, outline:"none", background:"white", boxSizing:"border-box", fontFamily:"inherit" }} />
                  </div>
                  <button onClick={addStudent}
                    style={{ padding:"11px 22px", borderRadius:10, border:"none", background:"linear-gradient(135deg,#3949ab,#5c6bc0)", color:"white", fontWeight:800, cursor:"pointer", fontSize:14, fontFamily:"inherit", whiteSpace:"nowrap" }}>
                    Add Student
                  </button>
                </div>
                {spMsg && <div style={{ marginTop:10, color:"#2e7d32", fontSize:13, fontWeight:600 }}>{spMsg}</div>}
              </div>

              {studentPasswords.length === 0 ? (
                <div style={{ textAlign:"center", padding:"32px 0", color:"#bbb" }}>
                  <div style={{ fontSize:40, marginBottom:10 }}>🚪</div>
                  <div>No students added yet. Anyone can log in as a student.</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontWeight:700, color:"#555", fontSize:13, marginBottom:12 }}>
                    {studentPasswords.length} Student{studentPasswords.length !== 1 ? "s" : ""} registered
                  </div>
                  {studentPasswords.map((sp) => (
                    <StudentPasswordRow key={sp.name} sp={sp} onRemove={removeStudent} onUpdate={updateStudentPassword} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {view === "create" && (
          <div style={{ background:"white", borderRadius:20, boxShadow:"0 2px 16px rgba(0,0,0,0.08)", padding:32 }}>
            <h2 style={{ margin:"0 0 24px", color:"#1a1a2e", fontSize:20 }}>Create New Test</h2>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:18 }}>
              <div style={{ gridColumn:"1/-1" }}>
                <Label>Test Title</Label>
                <Input value={form.title} onChange={v=>setForm(f=>({...f,title:v}))} placeholder="e.g. JEE Main Mock Test 1" />
              </div>
              <div>
                <Label>Subject / Topic</Label>
                <Input value={form.subject} onChange={v=>setForm(f=>({...f,subject:v}))} placeholder="Physics / Chemistry / All" />
              </div>
              <div>
                <Label>Duration (minutes)</Label>
                <Input type="number" value={form.durationMins} onChange={v=>setForm(f=>({...f,durationMins:v}))} placeholder="180" />
              </div>
            </div>

            <div style={{ marginTop:24 }}>
              <Label>Schedule Date and Time (leave blank for immediate)</Label>
              <input type="datetime-local" value={form.scheduledAt} onChange={e=>setForm(f=>({...f,scheduledAt:e.target.value}))}
                style={{ padding:"11px 14px", borderRadius:10, border:"1px solid #ddd", fontSize:14, outline:"none", fontFamily:"inherit", background:"#fafafa" }} />
            </div>

            <div style={{ marginTop:24 }}>
              <Label>How to load the question paper?</Label>
              <div style={{ display:"flex", gap:10, marginTop:8, flexWrap:"wrap" }}>
                {[["upload","Upload PDF"],["drive","Google Drive"],["demo","Use Demo Questions"]].map(([val,lbl])=>(
                  <button key={val} onClick={()=>setForm(f=>({...f,mode:val}))}
                    style={{ padding:"10px 20px", borderRadius:10, border:`2px solid ${form.mode===val?"#e8c97e":"#e0e0e0"}`,
                      background:form.mode===val?"#fffde7":"white", color:form.mode===val?"#7c6a00":"#888",
                      fontWeight:700, cursor:"pointer", fontSize:13, fontFamily:"inherit" }}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {form.mode === "upload" && (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginTop:20 }}>
                {[["Question Paper PDF", paperRef, paperFile, setPaperFile],["Answer Key PDF", keyRef, keyFile, setKeyFile]].map(([lbl,ref,file,setter])=>(
                  <div key={lbl}>
                    <Label>{lbl}</Label>
                    <div onClick={()=>ref.current.click()} style={{ border:"2px dashed #d0d0d0", borderRadius:12, padding:20, textAlign:"center", cursor:"pointer", background:file?"#f0fdf4":"#fafafa" }}>
                      <input type="file" accept=".pdf" ref={ref} style={{ display:"none" }} onChange={e=>setter(e.target.files[0])} />
                      {file ? <div style={{ color:"#2e7d32", fontSize:13, fontWeight:600 }}>{file.name}</div>
                             : <div style={{ color:"#bbb", fontSize:13 }}>Click to upload PDF</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {form.mode === "drive" && (
              <div style={{ marginTop:20, background:"#f8f9ff", borderRadius:14, padding:20, border:"1px solid #e8eaf6" }}>
                <div style={{ fontWeight:700, color:"#3949ab", marginBottom:14, fontSize:14 }}>Google Drive Settings</div>
                <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                  <div>
                    <Label>Google Drive API Key</Label>
                    <Input value={form.driveApiKey} onChange={v=>setForm(f=>({...f,driveApiKey:v}))} placeholder="AIzaSy..." />
                  </div>
                  <div>
                    <Label>Question Paper Google Drive File ID</Label>
                    <Input value={form.drivePaperFileId} onChange={v=>setForm(f=>({...f,drivePaperFileId:v}))} placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs..." />
                  </div>
                  <div>
                    <Label>Answer Key Google Drive File ID (optional)</Label>
                    <Input value={form.driveKeyFileId} onChange={v=>setForm(f=>({...f,driveKeyFileId:v}))} placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs..." />
                  </div>
                </div>
              </div>
            )}

            {form.mode === "demo" && (
              <div style={{ marginTop:16, background:"#e8f5e9", borderRadius:12, padding:16, fontSize:13, color:"#2e7d32", border:"1px solid #a5d6a7" }}>
                Will use 9 sample JEE questions (3 Physics, 3 Chemistry, 3 Mathematics)
              </div>
            )}

            {status && (
              <div style={{ marginTop:16, padding:"12px 16px", borderRadius:10, background:"#e3f2fd", color:"#1565c0", fontSize:13, fontWeight:600 }}>
                {status}
              </div>
            )}

            <div style={{ display:"flex", gap:12, marginTop:24 }}>
              <button onClick={()=>setView("dashboard")} style={{ padding:"13px 24px", borderRadius:12, border:"2px solid #e0e0e0", background:"white", color:"#555", fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>Cancel</button>
              <button onClick={createTest} disabled={loading}
                style={{ flex:1, padding:"13px", borderRadius:12, border:"none", background:loading?"#ccc":"linear-gradient(135deg,#1a1a2e,#3949ab)", color:"white", fontWeight:800, cursor:loading?"default":"pointer", fontSize:15, fontFamily:"inherit" }}>
                {loading ? "Creating..." : "Create Test"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   STUDENT PASSWORD ROW
───────────────────────────────────────────── */
function StudentPasswordRow({ sp, onRemove, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [newPass, setNewPass] = useState(sp.password);

  return (
    <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px", background:"#fafbff", borderRadius:10, marginBottom:8, border:"1px solid #e8eaf6" }}>
      <div style={{ width:36, height:36, borderRadius:"50%", background:"linear-gradient(135deg,#3949ab,#5c6bc0)", color:"white", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:14, flexShrink:0 }}>
        {sp.name[0].toUpperCase()}
      </div>
      <div style={{ flex:1 }}>
        <div style={{ fontWeight:700, color:"#1a1a2e", fontSize:14 }}>{sp.name}</div>
        {editing ? (
          <div style={{ display:"flex", gap:8, marginTop:6 }}>
            <input value={newPass} onChange={e=>setNewPass(e.target.value)}
              style={{ padding:"6px 10px", borderRadius:7, border:"1px solid #3949ab", fontSize:13, outline:"none", flex:1 }} />
            <button onClick={()=>{ onUpdate(sp.name, newPass); setEditing(false); }}
              style={{ padding:"6px 12px", borderRadius:7, border:"none", background:"#3949ab", color:"white", fontWeight:700, cursor:"pointer", fontSize:12 }}>Save</button>
            <button onClick={()=>{ setNewPass(sp.password); setEditing(false); }}
              style={{ padding:"6px 10px", borderRadius:7, border:"1px solid #ddd", background:"white", cursor:"pointer", fontSize:12 }}>Cancel</button>
          </div>
        ) : (
          <div style={{ fontSize:12, color:"#888", marginTop:2 }}>Password: {"*".repeat(sp.password.length)}</div>
        )}
      </div>
      {!editing && (
        <button onClick={()=>setEditing(true)}
          style={{ padding:"6px 12px", borderRadius:7, border:"1px solid #e8eaf6", background:"white", color:"#3949ab", cursor:"pointer", fontSize:12, fontWeight:700 }}>
          Edit
        </button>
      )}
      <button onClick={()=>onRemove(sp.name)}
        style={{ padding:"6px 12px", borderRadius:7, border:"1px solid #ffcdd2", background:"#ffebee", color:"#c62828", cursor:"pointer", fontSize:12, fontWeight:700 }}>
        Remove
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────
   STUDENT SCREEN
───────────────────────────────────────────── */
function StudentScreen({ user, tests, onStart, onLogout }) {
  const available = tests.filter(t => getTestStatus(t) === TEST_STATUS.LIVE);
  const upcoming = tests.filter(t => getTestStatus(t) === TEST_STATUS.SCHEDULED);
  const ended = tests.filter(t => getTestStatus(t) === TEST_STATUS.ENDED);

  return (
    <div style={{ minHeight:"100vh", background:"#f4f6fb", fontFamily:"Georgia, serif" }}>
      <div style={{ background:"linear-gradient(135deg,#1a1a2e,#16213e)", color:"white", padding:"0 24px", height:58, display:"flex", alignItems:"center", gap:16 }}>
        <span style={{ color:"#e8c97e", fontWeight:800, fontSize:17, letterSpacing:1 }}>🎯 TestForge</span>
        <span style={{ color:"rgba(255,255,255,0.4)", fontSize:12 }}>Student Portal</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:12, alignItems:"center" }}>
          <span style={{ color:"rgba(255,255,255,0.6)", fontSize:13 }}>👤 {user.name}</span>
          <button onClick={onLogout} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid rgba(255,255,255,0.15)", background:"transparent", color:"rgba(255,255,255,0.6)", cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Logout</button>
        </div>
      </div>

      <div style={{ maxWidth:860, margin:"0 auto", padding:28 }}>
        <div style={{ fontWeight:800, fontSize:22, color:"#1a1a2e", marginBottom:6 }}>Welcome back, {user.name}</div>
        <div style={{ color:"#888", fontSize:14, marginBottom:28 }}>Here are your available tests</div>

        <Section title="Available Now" count={available.length} color="#e53935">
          {available.length === 0 ? <Empty text="No live tests right now" /> : available.map(test => (
            <TestCard key={test.id} test={test} status={TEST_STATUS.LIVE}
              action={<button onClick={()=>onStart(test)} style={{ padding:"10px 22px", borderRadius:10, border:"none", background:"linear-gradient(135deg,#e53935,#c62828)", color:"white", fontWeight:800, cursor:"pointer", fontSize:13, fontFamily:"inherit" }}>Start Test</button>} />
          ))}
        </Section>

        <Section title="Scheduled" count={upcoming.length} color="#f57c00">
          {upcoming.length === 0 ? <Empty text="No upcoming tests" /> : upcoming.map(test => (
            <TestCard key={test.id} test={test} status={TEST_STATUS.SCHEDULED}
              action={<Countdown target={new Date(test.scheduledAt).getTime()} />} />
          ))}
        </Section>

        <Section title="Completed" count={ended.length} color="#2e7d32">
          {ended.length === 0 ? <Empty text="No past tests" /> : ended.map(test => (
            <TestCard key={test.id} test={test} status={TEST_STATUS.ENDED}
              action={<span style={{ color:"#888", fontSize:13 }}>Test ended</span>} />
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, count, color, children }) {
  return (
    <div style={{ marginBottom:32 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
        <div style={{ fontWeight:800, fontSize:16, color:"#1a1a2e" }}>{title}</div>
        <div style={{ background:color, color:"white", borderRadius:20, padding:"2px 10px", fontSize:12, fontWeight:700 }}>{count}</div>
      </div>
      {children}
    </div>
  );
}
function Empty({ text }) {
  return <div style={{ background:"white", borderRadius:14, padding:"24px", textAlign:"center", color:"#bbb", fontSize:14, boxShadow:"0 1px 6px rgba(0,0,0,0.05)" }}>{text}</div>;
}
function TestCard({ test, status, action }) {
  const sc = { [TEST_STATUS.LIVE]:{bg:"#e8f5e9",col:"#2e7d32"}, [TEST_STATUS.SCHEDULED]:{bg:"#fff3e0",col:"#e65100"}, [TEST_STATUS.ENDED]:{bg:"#f5f5f5",col:"#616161"} };
  return (
    <div style={{ background:"white", borderRadius:16, padding:"20px 24px", marginBottom:12, boxShadow:"0 2px 10px rgba(0,0,0,0.06)", display:"flex", alignItems:"center", gap:20, flexWrap:"wrap" }}>
      <div style={{ flex:1, minWidth:180 }}>
        <div style={{ fontWeight:700, fontSize:16, color:"#1a1a2e" }}>{test.title}</div>
        <div style={{ fontSize:13, color:"#888", marginTop:4 }}>{test.subject} — {test.questions?.length||0} Questions — {test.durationMins} min</div>
        <div style={{ fontSize:12, color:"#aaa", marginTop:3 }}>{test.scheduledAt ? `Scheduled: ${fmtDate(test.scheduledAt)}` : "Available immediately"}</div>
      </div>
      {action}
    </div>
  );
}
function Countdown({ target }) {
  const [diff, setDiff] = useState(Math.max(0, Math.floor((target - Date.now()) / 1000)));
  useEffect(() => { const t = setInterval(()=>setDiff(Math.max(0, Math.floor((target-Date.now())/1000))), 1000); return ()=>clearInterval(t); }, [target]);
  const h = Math.floor(diff/3600), m = Math.floor((diff%3600)/60), s = diff%60;
  return <div style={{ fontWeight:800, fontSize:18, color:"#e65100", fontVariantNumeric:"tabular-nums" }}>{`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`}</div>;
}

/* ─────────────────────────────────────────────
   TEST SCREEN  (NTA-style)
───────────────────────────────────────────── */
const Q_STATUS = { NV:"nv", NA:"na", ANS:"ans", MR:"mr", AMR:"amr" };
const Q_COLORS = { nv:"#9e9e9e", na:"#e53935", ans:"#43a047", mr:"#7b1fa2", amr:"#7b1fa2" };

function TestScreen({ test, student, onSubmit }) {
  const qs = test.questions || DEMO_QUESTIONS;
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [intInputs, setIntInputs] = useState({});
  const [qStatus, setQStatus] = useState(() => { const s={}; qs.forEach((_,i)=>s[i]=i===0?Q_STATUS.NA:Q_STATUS.NV); return s; });
  const [timeLeft, setTimeLeft] = useState((test.durationMins||180)*60);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const t = setInterval(()=>setTimeLeft(p=>{ if(p<=1){ clearInterval(t); doSubmit(); return 0; } return p-1; }), 1000);
    return ()=>clearInterval(t);
  }, []);

  const cur = qs[idx];
  const setQS = (i, s) => setQStatus(p=>({...p,[i]:s}));

  const saveNext = (mark=false) => {
    const ans = cur.type==="integer" ? intInputs[idx] : answers[idx];
    const has = ans!==undefined && ans!==null && ans!=="";
    setQS(idx, has ? (mark?Q_STATUS.AMR:Q_STATUS.ANS) : (mark?Q_STATUS.MR:Q_STATUS.NA));
    const nxt = idx+1;
    if (nxt < qs.length) { if(qStatus[nxt]===Q_STATUS.NV) setQS(nxt,Q_STATUS.NA); setIdx(nxt); }
  };

  const doSubmit = () => {
    const finalAns = {};
    qs.forEach((q,i) => { finalAns[i] = q.type==="integer" ? parseFloat(intInputs[i]) : answers[i]; });
    onSubmit({ answers:finalAns, qStatuses:qStatus, timeTaken:(test.durationMins||180)*60 - timeLeft });
  };

  const counts = Object.values(qStatus).reduce((a,s)=>{a[s]=(a[s]||0)+1;return a;},{});
  const timerC = timeLeft<600?"#e53935":timeLeft<1800?"#ff9800":"#4fc3f7";
  const subjects = [...new Set(qs.map(q=>q.subject))];

  return (
    <div style={{ minHeight:"100vh", background:"#f0f2f5", fontFamily:"Segoe UI, sans-serif", display:"flex", flexDirection:"column" }}>
      <div style={{ background:"#1a237e", color:"white", padding:"0 20px", height:52, display:"flex", alignItems:"center", gap:16, flexShrink:0 }}>
        <span style={{ fontWeight:800, color:"#ffca28", fontSize:14 }}>NTA</span>
        <span style={{ fontWeight:700, fontSize:13, flex:1 }}>{test.title}</span>
        <span style={{ fontSize:12, color:"rgba(255,255,255,0.6)" }}>👤 {student.name}</span>
        <div style={{ background:"#0d47a1", borderRadius:8, padding:"4px 14px", fontWeight:800, fontSize:16, color:timerC, fontVariantNumeric:"tabular-nums" }}>⏱ {fmt(timeLeft)}</div>
      </div>
      <div style={{ background:"#283593", display:"flex", padding:"0 16px", gap:2 }}>
        {subjects.map(s=>(
          <button key={s} onClick={()=>setIdx(qs.findIndex(q=>q.subject===s))}
            style={{ padding:"9px 16px", border:"none", borderRadius:"6px 6px 0 0", fontWeight:700, fontSize:12, cursor:"pointer",
              background:cur.subject===s?"white":"transparent", color:cur.subject===s?"#1a237e":"rgba(255,255,255,0.65)" }}>
            {s}
          </button>
        ))}
      </div>

      <div style={{ display:"flex", flex:1, minHeight:0 }}>
        <div style={{ flex:1, padding:20, overflowY:"auto", minWidth:0 }}>
          <div style={{ background:"white", borderRadius:14, padding:26, boxShadow:"0 2px 10px rgba(0,0,0,0.07)", marginBottom:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:14 }}>
              <div style={{ fontWeight:800, color:"#1a237e", fontSize:16 }}>
                Q{idx+1}
                <span style={{ fontSize:11, background:"#e8eaf6", color:"#3949ab", borderRadius:6, padding:"2px 8px", marginLeft:8 }}>{cur.subject}</span>
                <span style={{ fontSize:11, background:cur.type==="integer"?"#fff3e0":"#e3f2fd", color:cur.type==="integer"?"#e65100":"#1565c0", borderRadius:6, padding:"2px 8px", marginLeft:6 }}>{cur.type==="integer"?"Integer":"MCQ"}</span>
              </div>
              <span style={{ fontSize:12, color:"#777" }}>+{cur.marks} / {cur.negative}</span>
            </div>
            <p style={{ fontSize:14, lineHeight:1.85, color:"#222", margin:"0 0 22px" }}>{cur.text}</p>
            {cur.type==="mcq" ? (
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {cur.options.map((opt,oi)=>{
                  const sel = answers[idx]===oi;
                  return (
                    <div key={oi} onClick={()=>setAnswers(p=>({...p,[idx]:oi}))}
                      style={{ padding:"12px 16px", borderRadius:10, border:`2px solid ${sel?"#3949ab":"#e8e8e8"}`, background:sel?"#e8eaf6":"white", cursor:"pointer", display:"flex", gap:12, alignItems:"center" }}>
                      <div style={{ width:26, height:26, borderRadius:"50%", background:sel?"#3949ab":"#f0f0f0", color:sel?"white":"#666", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, fontSize:12, flexShrink:0 }}>{["A","B","C","D"][oi]}</div>
                      <span style={{ fontSize:13 }}>{opt}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div>
                <div style={{ fontSize:13, color:"#666", fontWeight:600, marginBottom:8 }}>Enter Integer Answer:</div>
                <input type="number" value={intInputs[idx]||""} onChange={e=>setIntInputs(p=>({...p,[idx]:e.target.value}))}
                  style={{ padding:"12px 16px", borderRadius:10, border:"2px solid #3949ab", fontSize:18, fontWeight:700, width:180, outline:"none", textAlign:"center" }} />
              </div>
            )}
          </div>

          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <Btn color="#43a047" onClick={()=>saveNext(false)}>SAVE AND NEXT</Btn>
            <Btn color="#ff9800" onClick={()=>saveNext(true)}>SAVE AND MARK REVIEW</Btn>
            <Btn color="#607d8b" outline onClick={()=>{ setAnswers(p=>{const n={...p};delete n[idx];return n;}); setIntInputs(p=>{const n={...p};delete n[idx];return n;}); }}>CLEAR</Btn>
            <Btn color="#7b1fa2" onClick={()=>{ setQS(idx,Q_STATUS.MR); if(idx+1<qs.length)setIdx(idx+1); }}>MARK AND NEXT</Btn>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:12 }}>
            <button disabled={idx===0} onClick={()=>setIdx(i=>i-1)} style={{ padding:"9px 18px", borderRadius:8, border:"2px solid #ddd", background:"white", cursor:idx===0?"default":"pointer", opacity:idx===0?0.4:1, fontWeight:600, fontSize:13 }}>BACK</button>
            <button onClick={()=>setConfirm(true)} style={{ padding:"9px 22px", borderRadius:8, border:"none", background:"#e53935", color:"white", fontWeight:800, cursor:"pointer", fontSize:13 }}>SUBMIT TEST</button>
            <button disabled={idx===qs.length-1} onClick={()=>setIdx(i=>i+1)} style={{ padding:"9px 18px", borderRadius:8, border:"2px solid #ddd", background:"white", cursor:idx===qs.length-1?"default":"pointer", opacity:idx===qs.length-1?0.4:1, fontWeight:600, fontSize:13 }}>NEXT</button>
          </div>
        </div>

        <div style={{ width:240, background:"white", borderLeft:"1px solid #eee", padding:16, overflowY:"auto", flexShrink:0 }}>
          <div style={{ marginBottom:14 }}>
            {[{s:Q_STATUS.NV,l:"Not Visited"},{s:Q_STATUS.NA,l:"Not Answered"},{s:Q_STATUS.ANS,l:"Answered"},{s:Q_STATUS.MR,l:"Marked"},{s:Q_STATUS.AMR,l:"Ans+Marked"}].map(({s,l})=>(
              <div key={s} style={{ display:"flex", alignItems:"center", gap:7, marginBottom:5, fontSize:11 }}>
                <div style={{ width:20,height:20,borderRadius:4,background:Q_COLORS[s],color:"white",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:9 }}>{counts[s]||0}</div>
                <span style={{ color:"#555" }}>{l}</span>
              </div>
            ))}
          </div>
          <div style={{ fontWeight:700, fontSize:12, color:"#1a237e", marginBottom:8 }}>Question Palette</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
            {qs.map((_,i)=>(
              <div key={i} onClick={()=>{ if(qStatus[i]===Q_STATUS.NV) setQS(i,Q_STATUS.NA); setIdx(i); }}
                style={{ width:32,height:32,borderRadius:6,background:i===idx?"#1a237e":Q_COLORS[qStatus[i]],color:"white",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,cursor:"pointer",border:i===idx?"3px solid #ffca28":"none" }}>
                {i+1}
              </div>
            ))}
          </div>
        </div>
      </div>

      {confirm && (
        <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999 }}>
          <div style={{ background:"white",borderRadius:20,padding:36,maxWidth:400,width:"90%",textAlign:"center" }}>
            <div style={{ fontSize:40,marginBottom:10 }}>⚠️</div>
            <h2 style={{ margin:"0 0 8px",color:"#1a237e" }}>Submit Test?</h2>
            <p style={{ color:"#666",margin:"0 0 20px" }}>Answered: {counts[Q_STATUS.ANS]||0} of {qs.length}. Cannot undo.</p>
            <div style={{ display:"flex",gap:12,justifyContent:"center" }}>
              <button onClick={()=>setConfirm(false)} style={{ padding:"12px 24px",borderRadius:10,border:"2px solid #ddd",background:"white",fontWeight:700,cursor:"pointer" }}>Cancel</button>
              <button onClick={doSubmit} style={{ padding:"12px 24px",borderRadius:10,border:"none",background:"#e53935",color:"white",fontWeight:700,cursor:"pointer" }}>Yes, Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   RESULTS SCREEN  (with shareable link)
───────────────────────────────────────────── */
function ResultsScreen({ test, student, submission, onBack }) {
  const qs = test.questions || DEMO_QUESTIONS;
  const { answers, timeTaken } = submission;
  const [tab, setTab] = useState("overview");
  const [expanded, setExpanded] = useState(null);
  const [copied, setCopied] = useState(false);

  const shareResult = () => {
    const url = buildResultUrl(test.id, student.name);
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const results = qs.map((q,i)=>{
    const given = answers[i];
    const blank = given===undefined||given===null||given===""||( typeof given==="number"&&isNaN(given));
    const correct = !blank && String(given)===String(q.correct);
    const wrong = !blank && !correct;
    return { ...q, given, isCorrect:correct, isWrong:wrong, isSkipped:blank, earned: correct?q.marks:wrong?q.negative:0 };
  });

  const maxMarks = results.reduce((s,r)=>s+r.marks,0);
  const scored = results.reduce((s,r)=>s+r.earned,0);
  const nCorrect = results.filter(r=>r.isCorrect).length;
  const nWrong = results.filter(r=>r.isWrong).length;
  const nSkip = results.filter(r=>r.isSkipped).length;
  const pct = Math.max(0,Math.round((scored/maxMarks)*100));
  const grade = pct>=85?"A+":pct>=70?"A":pct>=55?"B":pct>=40?"C":"D";
  const gradeC = pct>=70?"#2e7d32":pct>=40?"#f57c00":"#e53935";

  const bySub = {};
  results.forEach(r=>{ if(!bySub[r.subject]) bySub[r.subject]={c:0,w:0,s:0,marks:0,max:0}; const b=bySub[r.subject]; if(r.isCorrect)b.c++;else if(r.isWrong)b.w++;else b.s++; b.marks+=r.earned; b.max+=r.marks; });

  return (
    <div style={{ minHeight:"100vh", background:"#f4f6fb", fontFamily:"Georgia, serif" }}>
      <div style={{ background:"linear-gradient(135deg,#1a1a2e,#283593)", color:"white", padding:"28px 24px" }}>
        <div style={{ maxWidth:880, margin:"0 auto" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12 }}>
            <div>
              <div style={{ fontWeight:800, fontSize:22, marginBottom:4 }}>📊 Test Results</div>
              <div style={{ opacity:0.6, fontSize:13 }}>{test.title} — {student.name} — Time: {fmt(timeTaken)}</div>
            </div>
            <button onClick={shareResult}
              style={{ padding:"11px 20px", borderRadius:12, border: copied ? "1px solid #66bb6a" : "1px solid rgba(255,255,255,0.25)",
                background: copied ? "rgba(67,160,71,0.3)" : "rgba(255,255,255,0.15)", color:"white", fontWeight:700, cursor:"pointer", fontSize:13 }}>
              {copied ? "Result Link Copied!" : "Share My Result"}
            </button>
          </div>
          <div style={{ display:"flex", gap:16, marginTop:20, flexWrap:"wrap" }}>
            {[{l:"Score",v:`${scored}/${maxMarks}`,c:gradeC},{l:"Percentage",v:`${pct}%`,c:gradeC},{l:"Grade",v:grade,c:gradeC},{l:"Correct",v:nCorrect,c:"#80deea"},{l:"Wrong",v:nWrong,c:"#ef9a9a"},{l:"Skipped",v:nSkip,c:"#fff9c4"}].map(({l,v,c})=>(
              <div key={l} style={{ background:"rgba(255,255,255,0.1)", borderRadius:12, padding:"14px 20px", textAlign:"center", minWidth:80 }}>
                <div style={{ fontSize:22, fontWeight:800, color:c }}>{v}</div>
                <div style={{ fontSize:11, opacity:0.6, marginTop:2 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:880, margin:"0 auto", padding:24 }}>
        <div style={{ display:"flex", gap:4, marginBottom:22, background:"white", borderRadius:12, padding:5, boxShadow:"0 2px 8px rgba(0,0,0,0.06)" }}>
          {[["overview","Overview"],["subject","By Subject"],["solutions","Solutions"]].map(([t,l])=>(
            <button key={t} onClick={()=>setTab(t)} style={{ flex:1, padding:"10px", borderRadius:8, border:"none", background:tab===t?"#1a237e":"transparent", color:tab===t?"white":"#555", fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>{l}</button>
          ))}
        </div>

        {tab==="overview" && (
          <div style={{ background:"white", borderRadius:16, padding:24, boxShadow:"0 2px 8px rgba(0,0,0,0.06)" }}>
            <h3 style={{ margin:"0 0 18px", color:"#1a237e", fontSize:16 }}>Score Breakdown</h3>
            {[{l:"Correct",v:nCorrect,col:"#43a047"},{l:"Wrong",v:nWrong,col:"#e53935"},{l:"Skipped",v:nSkip,col:"#9e9e9e"}].map(({l,v,col})=>(
              <div key={l} style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:6 }}>
                  <span style={{ fontWeight:600 }}>{l}</span><span style={{ color:col, fontWeight:700 }}>{v}/{qs.length}</span>
                </div>
                <div style={{ height:10, background:"#f0f0f0", borderRadius:5, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${(v/qs.length)*100}%`, background:col, borderRadius:5 }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {tab==="subject" && Object.entries(bySub).map(([sub,d])=>{
          const pct2 = Math.max(0,Math.round((d.marks/d.max)*100));
          const cols = {Physics:{bg:"#1e3a5f",acc:"#4fc3f7"},Chemistry:{bg:"#1b4332",acc:"#69f0ae"},Mathematics:{bg:"#4a1942",acc:"#f48fb1"}};
          const c = cols[sub]||{bg:"#1a237e",acc:"#e8c97e"};
          return (
            <div key={sub} style={{ background:"white", borderRadius:16, overflow:"hidden", boxShadow:"0 2px 8px rgba(0,0,0,0.06)", marginBottom:14 }}>
              <div style={{ background:c.bg, color:"white", padding:"16px 24px", display:"flex", justifyContent:"space-between" }}>
                <span style={{ fontWeight:700, fontSize:16 }}>{sub}</span>
                <span style={{ fontWeight:800, fontSize:20, color:c.acc }}>{d.marks}/{d.max}</span>
              </div>
              <div style={{ padding:20 }}>
                <div style={{ height:8, background:"#f0f0f0", borderRadius:4, marginBottom:16, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${pct2}%`, background:c.acc, borderRadius:4 }} />
                </div>
                <div style={{ display:"flex", gap:20 }}>
                  {[["✅",d.c,"#43a047","Correct"],["❌",d.w,"#e53935","Wrong"],["⬜",d.s,"#9e9e9e","Skipped"]].map(([ic,n,col,l])=>(
                    <div key={l} style={{ textAlign:"center" }}>
                      <div style={{ fontSize:20, fontWeight:800, color:col }}>{n}</div>
                      <div style={{ fontSize:12, color:"#888" }}>{ic} {l}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

        {tab==="solutions" && results.map((r,i)=>{
          const bg = r.isCorrect?"#e8f5e9":r.isWrong?"#ffebee":"#f9f9f9";
          const border = r.isCorrect?"#a5d6a7":r.isWrong?"#ef9a9a":"#e0e0e0";
          return (
            <div key={i} style={{ background:bg, border:`1px solid ${border}`, borderRadius:12, overflow:"hidden", marginBottom:10 }}>
              <div onClick={()=>setExpanded(expanded===i?null:i)} style={{ padding:"13px 18px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontWeight:600, fontSize:13 }}>{r.isCorrect?"✅":r.isWrong?"❌":"⬜"} Q{i+1}. <span style={{ fontWeight:400, color:"#555" }}>{r.text.slice(0,55)}...</span></span>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <span style={{ fontWeight:800, fontSize:13, color:r.earned>0?"#2e7d32":r.earned<0?"#c62828":"#888" }}>{r.earned>0?"+":""}{r.earned}</span>
                  <span style={{ color:"#bbb" }}>{expanded===i?"▲":"▼"}</span>
                </div>
              </div>
              {expanded===i && (
                <div style={{ padding:"0 18px 18px", borderTop:`1px solid ${border}` }}>
                  <p style={{ margin:"12px 0 14px", fontSize:13, lineHeight:1.75 }}>{r.text}</p>
                  {r.type==="mcq" ? r.options.map((opt,oi)=>(
                    <div key={oi} style={{ padding:"8px 12px", borderRadius:8, marginBottom:6, fontSize:13,
                      background:String(r.correct)===String(oi)?"#c8e6c9":String(r.given)===String(oi)?"#ffcdd2":"white",
                      border:`1px solid ${String(r.correct)===String(oi)?"#81c784":"#e0e0e0"}`,
                      fontWeight:String(r.correct)===String(oi)?700:400 }}>
                      {["A","B","C","D"][oi]}) {opt}
                      {String(r.correct)===String(oi)&&" - Correct Answer"}
                      {String(r.given)===String(oi)&&String(r.given)!==String(r.correct)&&" - Your Answer"}
                    </div>
                  )) : (
                    <div style={{ fontSize:14 }}>
                      <div>Your answer: <b>{r.given??"-"}</b></div>
                      <div>Correct: <b style={{ color:"#2e7d32" }}>{r.correct}</b></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <button onClick={onBack} style={{ marginTop:22, padding:"13px 32px", borderRadius:12, border:"none", background:"linear-gradient(135deg,#1a1a2e,#3949ab)", color:"white", fontWeight:800, fontSize:15, cursor:"pointer", display:"block", width:"100%", fontFamily:"inherit" }}>
          Back to Dashboard
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   SHARED RESULT SCREEN  (public view via link)
───────────────────────────────────────────── */
function SharedResultScreen({ data }) {
  if (!data) return <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"Georgia, serif", color:"#888" }}>Loading...</div>;

  if (data.error) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"Georgia, serif", background:"#f4f6fb" }}>
      <div style={{ textAlign:"center", padding:40 }}>
        <div style={{ fontSize:60, marginBottom:16 }}>🔍</div>
        <div style={{ fontSize:20, fontWeight:700, color:"#1a1a2e", marginBottom:8 }}>Result Not Found</div>
        <div style={{ color:"#888", fontSize:14 }}>{data.error}</div>
        <button onClick={()=>window.location.href=window.location.pathname} style={{ marginTop:24, padding:"12px 28px", borderRadius:12, border:"none", background:"#1a237e", color:"white", fontWeight:700, cursor:"pointer", fontSize:14 }}>Go to Home</button>
      </div>
    </div>
  );

  const { test, submission, studentName } = data;
  const qs = test.questions || DEMO_QUESTIONS;
  const { answers, timeTaken } = submission;

  const results = qs.map((q,i)=>{
    const given = answers[i];
    const blank = given===undefined||given===null||given===""||( typeof given==="number"&&isNaN(given));
    const correct = !blank && String(given)===String(q.correct);
    const wrong = !blank && !correct;
    return { ...q, given, isCorrect:correct, isWrong:wrong, isSkipped:blank, earned: correct?q.marks:wrong?q.negative:0 };
  });

  const maxMarks = results.reduce((s,r)=>s+r.marks,0);
  const scored = results.reduce((s,r)=>s+r.earned,0);
  const nCorrect = results.filter(r=>r.isCorrect).length;
  const nWrong = results.filter(r=>r.isWrong).length;
  const nSkip = results.filter(r=>r.isSkipped).length;
  const pct = Math.max(0,Math.round((scored/maxMarks)*100));
  const grade = pct>=85?"A+":pct>=70?"A":pct>=55?"B":pct>=40?"C":"D";
  const gradeC = pct>=70?"#2e7d32":pct>=40?"#f57c00":"#e53935";

  return (
    <div style={{ minHeight:"100vh", background:"#f4f6fb", fontFamily:"Georgia, serif" }}>
      <div style={{ background:"linear-gradient(135deg,#1a1a2e,#283593)", color:"white", padding:"28px 24px" }}>
        <div style={{ maxWidth:700, margin:"0 auto" }}>
          <div style={{ fontSize:13, color:"rgba(255,255,255,0.5)", marginBottom:6 }}>🎯 TestForge — Shared Result</div>
          <div style={{ fontWeight:800, fontSize:24, marginBottom:4 }}>{studentName}'s Result</div>
          <div style={{ opacity:0.6, fontSize:13 }}>{test.title} — Time: {fmt(timeTaken)}</div>
          <div style={{ display:"flex", gap:14, marginTop:20, flexWrap:"wrap" }}>
            {[{l:"Score",v:`${scored}/${maxMarks}`,c:gradeC},{l:"Percentage",v:`${pct}%`,c:gradeC},{l:"Grade",v:grade,c:gradeC},{l:"Correct",v:nCorrect,c:"#80deea"},{l:"Wrong",v:nWrong,c:"#ef9a9a"},{l:"Skipped",v:nSkip,c:"#fff9c4"}].map(({l,v,c})=>(
              <div key={l} style={{ background:"rgba(255,255,255,0.1)", borderRadius:12, padding:"14px 20px", textAlign:"center", minWidth:72 }}>
                <div style={{ fontSize:22, fontWeight:800, color:c }}>{v}</div>
                <div style={{ fontSize:11, opacity:0.6, marginTop:2 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ maxWidth:700, margin:"0 auto", padding:24 }}>
        <div style={{ background:"white", borderRadius:16, padding:24, boxShadow:"0 2px 8px rgba(0,0,0,0.06)" }}>
          <h3 style={{ margin:"0 0 18px", color:"#1a237e", fontSize:16 }}>Performance Breakdown</h3>
          {[{l:"Correct",v:nCorrect,col:"#43a047"},{l:"Wrong",v:nWrong,col:"#e53935"},{l:"Skipped",v:nSkip,col:"#9e9e9e"}].map(({l,v,col})=>(
            <div key={l} style={{ marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:6 }}>
                <span style={{ fontWeight:600 }}>{l}</span><span style={{ color:col, fontWeight:700 }}>{v}/{qs.length}</span>
              </div>
              <div style={{ height:10, background:"#f0f0f0", borderRadius:5, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${(v/qs.length)*100}%`, background:col, borderRadius:5 }} />
              </div>
            </div>
          ))}
        </div>
        <button onClick={()=>window.location.href=window.location.pathname}
          style={{ marginTop:20, padding:"13px 32px", borderRadius:12, border:"none", background:"linear-gradient(135deg,#1a1a2e,#3949ab)", color:"white", fontWeight:800, fontSize:14, cursor:"pointer", display:"block", width:"100%", fontFamily:"inherit" }}>
          Try TestForge
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   SMALL HELPERS
───────────────────────────────────────────── */
function Label({ children }) {
  return <label style={{ color:"#555", fontSize:12, fontWeight:700, letterSpacing:0.5, display:"block", marginBottom:7, textTransform:"uppercase" }}>{children}</label>;
}
function Input({ value, onChange, placeholder, type="text" }) {
  return (
    <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
      style={{ width:"100%", padding:"11px 13px", borderRadius:10, border:"1px solid #ddd", fontSize:14, outline:"none", background:"#fafafa", boxSizing:"border-box", fontFamily:"inherit" }} />
  );
}
function Btn({ children, onClick, color, outline }) {
  return (
    <button onClick={onClick} style={{ padding:"10px 18px", borderRadius:9, border:outline?`2px solid ${color}`:"none",
      background:outline?"white":color, color:outline?color:"white", fontWeight:700, fontSize:12, cursor:"pointer", fontFamily:"Segoe UI, sans-serif" }}>
      {children}
    </button>
  );
}
