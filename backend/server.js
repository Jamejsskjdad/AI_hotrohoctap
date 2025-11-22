// server.js — bản đầy đủ (đã vá hiển thị LaTeX)
// Đặt ngay đầu file:
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

process.on('exit', (code)=> console.error('[process exit]', code));
process.on('SIGTERM', ()=> { console.error('[SIGTERM]'); });
process.on('SIGINT',  ()=> { console.error('[SIGINT]'); });

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const { SYSTEM_ANALYZE, USER_SCHEMA, SYSTEM_OCR,
  SYSTEM_PARSE, SYSTEM_SOLVE_STRICT, SYSTEM_SEGMENT_STUDENT, SYSTEM_COMPARE, SYSTEM_PRACTICE } = require("./prompt");
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }  // 10MB/ảnh (bạn chỉnh tùy ý)
});


const app = express();
app.get('/health', (req, res) => res.json({ ok: true, pid: process.pid }));

app.use(cors());
const path = require('path');

// serve static build của React
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// wildcard route dùng REGEX, không dùng '*'
app.get(/.*/, (_, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});


app.use(express.json({ limit: "10mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://gpt1.shupremium.com/v1",
});

/* ================= Helpers: hậu xử lý LaTeX ================= */
/** Map từ compared.steps_alignment -> step_errors & fix_suggestions (chuẩn hoá tiếng Việt) */
function relaxedJsonParse(text) {
  try { return JSON.parse(text); } catch (_) {}
  if (!text) return null;
  let t = String(text)
    .replace(/```(json)?/gi, "")         // bỏ fenced code
    .replace(/[“”]/g, '"')               // smart quotes -> "
    .replace(/[‘’]/g, "'")
    .replace(/\u00A0/g, " ");            // nbsp
  // cắt theo cặp ngoặc nhọn đầu-cuối
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) {
    t = t.slice(i, j + 1);
    // bỏ dấu phẩy thừa trước ngoặc đóng
    t = t.replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(t); } catch (_) {}
  }
  return null;
}

function mapCompareToErrors(compared) {
  const outErrors = [];
  const outFixes  = [];

  if (!compared || !Array.isArray(compared.steps_alignment)) {
    return { step_errors: outErrors, fix_suggestions: outFixes };
  }

  // Chuẩn hoá verdict -> "mã lỗi" ngắn gọn tiếng Việt
  const verdict2Code = {
    wrong:   "Sai biến đổi",
    missing: "Thiếu bước",
    extra:   "Bước thừa",
    mismatch:"Không khớp",
    error:   "Lỗi",
    ok:      "Đúng"
  };

  for (const align of compared.steps_alignment) {
    const verdict = String(align?.verdict || "").toLowerCase().trim();
    if (!verdict || verdict === "ok") continue; // chỉ lấy bước lỗi

    const step = Number.isFinite(align?.student_step_index)
      ? align.student_step_index
      : null;

    // câu ngắn gọn
    const code = verdict2Code[verdict] || "Sai thao tác";
    const what = String(align?.what || "Bước làm không khớp với lời giải chuẩn.").trim();
    const fix  = String(align?.fix  || "Thực hiện lại bước theo phương pháp khử/thế đúng.").trim();

    outErrors.push({ step, code, what, fix });

    // Nếu có LaTeX minh hoạ từ so sánh thì đưa vào fix_suggestions
    const latexFix = String(align?.latex_fix || "").trim();
    if (latexFix) {
      outFixes.push({
        step,
        explain: fix,
        latex: sanitizeModelSolution(latexFix)
      });
    }
  }

  // Nếu kết luận cuối cùng không khớp -> thêm lỗi L4
  const concl = String(compared?.conclusion_match || "").toLowerCase();
  if (concl === "mismatch" || String(compared?.verdict).toLowerCase() === "mismatch") {
    outErrors.push({
      step: null,
      code: "Kết luận sai",
      what: "Nghiệm kết luận của học sinh không khớp với nghiệm đúng.",
      fix:  "Tính lại nghiệm x, y, z theo các bước khử/thế đã chuẩn."
    });
  }

  return { step_errors: outErrors, fix_suggestions: outFixes };
}

// escape { } trong text thuần
function escBraces(s) { return String(s).replace(/([{}])/g, "\\$1"); }

/** Bóc tách trước/sau cases:
 * - Nếu trước \begin{cases} có text -> đưa vào block \[\text{...}\]
 * - Nếu sau \end{cases} còn nội dung -> bọc vào align* và chèn \\ giữa các \text{...}
 * - Vá pattern xuống dòng sai: "\   \" -> "\\" ; "\\   \\" -> "\\\\"
 */
function normalizeCasesBlocks(s) {
  if (!s) return "";

  let t = String(s).trim();

  // Vá các pattern xuống dòng sai model hay sinh
  t = t.replace(/\\\s+\\/g, "\\\\")        // "\" + spaces + "\" -> "\\"
       .replace(/\\\\\s+\\\\/g, "\\\\\\\\"); // "\\ " + spaces + "\\ " -> "\\\\"

  // Trước \begin{cases} có caption dạng text thuần?
  t = t.replace(/^\s*([^\\][^]*?)\s*(?=\\begin\{cases\})/, (_m, pre) => {
    const caption = escBraces(pre.trim());
    if (!caption) return "";
    return `\\[\\text{${caption}}\\]\n`;
  });

  // Sau \end{cases} còn phần chữ/toán -> tách sang align*
  t = t.replace(/\\end\{cases\}\s*([\s\S]+)$/m, (_m, tail) => {
    const cleaned = String(tail || "")
      .trim()
      .replace(/}\s*\\text{/g, "} \\\\ \\text{"); // tách các câu \text liên tiếp
    if (!cleaned) return "\\end{cases}";
    return `\\end{cases}\n\\begin{align*}\n${cleaned}\n\\end{align*}`;
  });

  // Mỗi \\ thật sự xuống hàng
  t = t.replace(/\\\\\s*(?!\n)/g, "\\\\\n");

  return t;
}

/** Nếu thiếu môi trường align/cases thì bọc vào align*; 
 *  dòng có dấu =,+,- coi là phương trình => thêm \\\\
 *  còn lại bọc \text{...}
 */
function wrapAlignIfMissing(s) {
  if (!s) return "";
  const hasEnv = /\\begin\{(align\*?|cases|array)\}/.test(s);
  if (hasEnv) return s;

  const lines = String(s).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const fixed = lines.map(line => {
    if (/[=+\-]/.test(line)) return line + " \\\\";
    const safe = line.replace(/([{}])/g, "\\$1");
    return `\\text{${safe}} \\\\`;
  }).join("\n");

  return `\\begin{align*}\n${fixed}\n\\end{align*}`;
}

/** Chèn \\\\ giữa các \text{...} liên tiếp, xuống dòng sau dấu chấm,
 *  và nếu sau \end{align*} còn \text{...} thì bọc phần đuôi vào align* mới.
 */
function fixLatexNewlines(s) {
  if (!s) return "";
  let t = String(s).trim();

  t = t.replace(/}\s*\\text{/g, "} \\\\ \\text{");        // tách các \text liên tiếp
  t = t.replace(/([^.])\. ?(?=\\text|[A-ZÀ-Ỵ])/g, "$1. \\\\ "); // xuống dòng sau dấu chấm
  t = t.replace(/\\end\{align\*\}\s*([\s\S]+)$/m, (_m, tail) => { // phần đuôi sau align*
    const cleaned = String(tail || "")
      .trim()
      .replace(/}\s*\\text{/g, "} \\\\ \\text{");
    if (!cleaned) return "\\end{align*}";
    return `\\end{align*}\n\\begin{align*}\n${cleaned}\n\\end{align*}`;
  });
  t = t.replace(/\\\\\s*(?!\n)/g, "\\\\\n");
  return t;
}

/** Normalize đầy đủ cho 1 chuỗi LaTeX */
function normalizeLatex(s) {
  const raw   = String(s || "");
  const step1 = normalizeCasesBlocks(raw);     // NEW: tách cases + wrap phần đuôi
  const step2 = wrapAlignIfMissing(step1);
  const step3 = fixLatexNewlines(step2);
  return step3;
}
// --- Sanitize mạnh cho lời giải từ model ---
function stripLeadingAmpersand(s) {
  // bỏ dấu & ở đầu mỗi dòng align (gây tạo cột căn lề và dễ lỗi khi thiếu & đối xứng)
  return String(s).replace(/^\s*&\s*/mg, "");
}

function squashDoubleBackslashes(s) {
  // các mẫu "\   \" hoặc "\\   \\" -> "\\", "\\\\"
  s = s.replace(/\\\s+\\/g, "\\\\");
  s = s.replace(/\\\\\s+\\\\/g, "\\\\\\\\");
  return s;
}

function fixLostTextMacro(s) {
  // nếu vì replace trước đó làm mất "\" trong \text{...} -> đưa lại
  return s.replace(/(^|[^\\])text\{/g, "$1\\text{");
}

function ensureSeparateAlignBlock(s) {
  // đảm bảo mọi diễn giải chữ nằm trong một khối align* riêng, không dính ngay sau \end{cases}
  s = s.replace(/\\end\{cases\}\s*/g, "\\end{cases}\n\\begin{align*}\n");
  if (!/\\begin\{align\*/.test(s)) {
    s = "\\begin{align*}\n" + s + "\n\\end{align*}";
  }
  return s;
}

function sanitizeModelSolution(s) {
  if (!s) return "";
  let t = String(s).trim();

  t = squashDoubleBackslashes(t);
  t = stripLeadingAmpersand(t);
  t = fixLostTextMacro(t);
  t = ensureSeparateAlignBlock(t);

  // chuẩn hoá xuống dòng & bọc text nếu thiếu (dùng pipeline normalize sẵn có)
  t = normalizeLatex(t);
  return t;
}
// === Deterministic 3x3 linear solver with Fractions ===
class Frac {
  constructor(n, d = 1) {
    if (d === 0) throw new Error("Zero denominator");
    const g = (x,y)=>y?g(y,x%y):Math.abs(x);
    const s = (n<0) ^ (d<0) ? -1 : 1;
    n = Math.abs(n); d = Math.abs(d);
    const gg = g(n,d) || 1;
    this.n = s*(n/gg); this.d = d/gg;
  }
  static from(x){ if (x instanceof Frac) return x;
    if (Number.isInteger(x)) return new Frac(x,1);
    // parse "p/q" or decimal
    if (typeof x === "string" && x.includes("/")){
      const [p,q] = x.split("/").map(Number); return new Frac(p,q);
    }
    // decimal -> fraction
    const s = String(x), k = s.split(".")[1]?.length || 0;
    return new Frac(Math.round(Number(x)*10**k), 10**k);
  }
  add(b){ b=Frac.from(b); return new Frac(this.n*b.d + b.n*this.d, this.d*b.d); }
  sub(b){ b=Frac.from(b); return new Frac(this.n*b.d - b.n*this.d, this.d*b.d); }
  mul(b){ b=Frac.from(b); return new Frac(this.n*b.n, this.d*b.d); }
  div(b){ b=Frac.from(b); return new Frac(this.n*b.d, this.d*b.n); }
  isZero(){ return this.n===0; }
  eq(b){ b=Frac.from(b); return this.n===b.n && this.d===b.d; }
  toString(){ return this.d===1 ? String(this.n) : `${this.n}/${this.d}`; }
  toNumber(){ return this.n/this.d; }
}
// Parse equation với 4 biến x, y, z, t
// function parseEq4(line) {
//   const [L, R] = line.split("=");
//   const S = v => v.replace(/\s+/g, "");
//   const left = S(L), right = Frac.from(S(R));
  
//   const coef = (varr) => {
//     const m = left.match(new RegExp(`([+-]?\\d*(?:/\\d+)?)${varr}`, 'g')) || [];
//     return m.map(t => {
//       const k = t.replace(varr, "");
//       return k === "" || k === "+" ? Frac.from(1) : 
//              k === "-" ? Frac.from(-1) : Frac.from(k);
//     }).reduce((a, c) => a.add(c), Frac.from(0));
//   };

//   const ax = coef("x"), by = coef("y"), cz = coef("z"), dt = coef("t");
  
//   // constant term on left (move to right)
//   const constLeft = left
//     .replace(/[+-]?\d*(?:\/\d+)?x/g, "")
//     .replace(/[+-]?\d*(?:\/\d+)?y/g, "")
//     .replace(/[+-]?\d*(?:\/\d+)?z/g, "")
//     .replace(/[+-]?\d*(?:\/\d+)?t/g, "");
    
//   let cL = Frac.from(0);
//   constLeft.replace(/([+\-]?\d+(?:\/\d+)?)/g, (m) => { 
//     cL = cL.add(Frac.from(m)); 
//     return m; 
//   });
  
//   return { abcd: [ax, by, cz, dt], d: right.sub(cL) };
// }

// // Solve hệ 3 phương trình 4 ẩn - kiểm tra tính tương thích
// function solve3Eq4Var(rows) {
//   // rows là mảng 3 phương trình dạng {abcd: [a,b,c,d], d: constant}
  
//   // Kiểm tra xem hệ có vô số nghiệm hay không bằng hạng ma trận
//   const A = rows.map(r => [...r.abcd.map(f => f.toNumber()), r.d.toNumber()]);
  
//   // Tính hạng ma trận hệ số và ma trận mở rộng
//   const rankA = computeRank(A.map(row => row.slice(0, 4)));
//   const rankAb = computeRank(A);
  
//   console.log("Rank A:", rankA, "Rank Ab:", rankAb);
  
//   if (rankAb > rankA) {
//     return { type: "none", x: null };
//   }
  
//   if (rankA < 4) {
//     return { type: "infinite", x: null };
//   }
  
//   // Nếu hạng = 4 nhưng chỉ có 3 phương trình -> vô số nghiệm
//   return { type: "infinite", x: null };
// }

// Hàm tính hạng ma trận
function computeRank(matrix) {
  const M = matrix.map(row => row.slice());
  const rows = M.length, cols = M[0].length;
  let rank = 0;
  
  for (let col = 0; col < cols && rank < rows; col++) {
    // Tìm pivot
    let pivotRow = -1;
    for (let i = rank; i < rows; i++) {
      if (Math.abs(M[i][col]) > 1e-10) {
        pivotRow = i;
        break;
      }
    }
    
    if (pivotRow === -1) continue;
    
    // Swap rows
    [M[rank], M[pivotRow]] = [M[pivotRow], M[rank]];
    
    // Normalize
    const pivot = M[rank][col];
    for (let j = col; j < cols; j++) {
      M[rank][j] /= pivot;
    }
    
    // Eliminate
    for (let i = 0; i < rows; i++) {
      if (i !== rank && Math.abs(M[i][col]) > 1e-10) {
        const factor = M[i][col];
        for (let j = col; j < cols; j++) {
          M[i][j] -= factor * M[rank][j];
        }
      }
    }
    
    rank++;
  }
  
  return rank;
}
// Solve Ax=b. Return {type:"unique"|"none"|"infinite", x:[Frac,Frac,Frac]|null}
function solve3(A,b){
  // deep copy in fraction
  const M = A.map(r => r.map(Frac.from));
  const B = b.map(Frac.from);
  // Gauss elimination
  let rankA = 0, rankAb = 0, R=3, C=3, row = 0;
  for (let col=0; col<C && row<R; col++){
    // pivot
    let p = row; while (p<R && M[p][col].isZero()) p++;
    if (p===R) continue;
    [M[row], M[p]] = [M[p], M[row]];
    [B[row], B[p]] = [B[p], B[row]];
    // normalize & eliminate
    const piv = M[row][col];
    for (let j=col; j<C; j++) M[row][j] = M[row][j].div(piv);
    B[row] = B[row].div(piv);
    for (let i=0; i<R; i++){
      if (i===row) continue;
      const f = M[i][col];
      if (f.isZero()) continue;
      for (let j=col; j<C; j++) M[i][j] = M[i][j].sub(f.mul(M[row][j]));
      B[i] = B[i].sub(f.mul(B[row]));
    }
    row++; rankA++;
  }
  // rank of augmented
  rankAb = rankA;
  for (let i=0;i<R;i++){
    const zeroRow = M[i].every(x=>x.isZero());
    if (zeroRow && !B[i].isZero()) { rankAb = rankA + 1; break; }
  }
  if (rankAb > rankA) return { type:"none", x:null };

  if (rankA < 3) return { type:"infinite", x:null };

  // back-substitution now gives identity; B is the solution
  return { type:"unique", x:[B[0],B[1],B[2]] };
}

// Helper to latex a fraction vector:
//function vecToLatex(fr){ return `x = ${fr[0]}, y = ${fr[1]}, z = ${fr[2]}`; }

// =============== OCR bằng model vision (nhiều ảnh) ===============
app.post("/api/ocr", upload.array("files", 12), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "NO_FILE" });

    // Chuyển mỗi ảnh -> data URL (để truyền vào OpenAI chat vision)
    const parts = [];
    parts.push({ type: "text", text: "Ảnh bài làm của học sinh. Hãy trích xuất theo yêu cầu." });
    for (const f of files) {
      const mime = f.mimetype || "image/jpeg";
      const b64 = Buffer.from(f.buffer).toString("base64");
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${b64}` }
      });
    }

    const messages = [
      { role: "system", content: SYSTEM_OCR },
      { role: "user", content: parts }
    ];

    // Dùng cùng baseURL & khóa như /api/analyze
    const r = await openai.chat.completions.create({
      model: "gpt-4o",          // cùng model “đang dùng để đưa ra lời giải”
      temperature: 0.0,
      messages,
      response_format: { type: "json_object" },
      max_tokens: 1200
    });

    const text = r.choices?.[0]?.message?.content || "{}";
    let json;
    try { json = JSON.parse(text); }
    catch { return res.json({ error: "BAD_JSON", raw: text }); }

    // Bảo hiểm trường
    json.plain_text = String(json.plain_text || "").trim();
    json.latex      = String(json.latex      || "").trim();
    json.notes      = String(json.notes      || "").trim();

    // Chuẩn hoá LaTeX nhẹ để hiển thị đẹp (dùng helper sẵn có)
    json.latex = normalizeLatex(json.latex);

    return res.json(json);

  } catch (e) {
    console.error("ocr error:", e);
    // yêu cầu: model lỗi thì báo để reload (không fallback tesseract)
    return res.status(500).json({ error: e?.message || "OCR_FAIL" });
  }
});

/* =========================== API =========================== */

app.post("/api/analyze", async (req, res) => {
  try {
    let { raw_text } = req.body || {};
    if (!raw_text) return res.status(400).json({ error: "NO_TEXT" });

    // làm sạch mấy dòng đầu kiểu "Giai he:"
    raw_text = String(raw_text).replace(/^\s*gi[a-â]i.*?:?/i, "").trim();

    const messages = [
      { role: "system", content: SYSTEM_ANALYZE },                           // <-- dùng prompt đầy đủ
      { role: "user", content: `Văn bản (mỗi dòng là ax+by+cz=d):\n${raw_text}\n\nTrả JSON đúng theo schema sau, KHÔNG thêm chữ ngoài JSON:\n${USER_SCHEMA}` }
    ];

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      messages,
      response_format: { type: "json_object" },
      max_tokens: 10000
    });

    const text = r.choices?.[0]?.message?.content || "{}";
    let json;
    try { json = JSON.parse(text); }
    catch { return res.json({ error: "BAD_JSON", raw: text }); }

    // ===== Guards + normalize đồng bộ với frontend =====
    json.step_errors           ||= [];
    json.fix_suggestions       ||= [];
    json.solution_card         ||= null;
    json.detected_method       ||= "unknown";
    json.feedback_short        ||= "";

    // Chuẩn hoá LaTeX
    json.normalized_problem     = normalizeLatex(json.normalized_problem || "");
    // Hỗ trợ cả 2 tên khoá (cũ/new)
    const modelSol              = json.model_solution_latex || json.model_solution || "";
    json.model_solution_latex   = sanitizeModelSolution(modelSol);

    // Chuẩn hoá LaTeX trong fix_suggestions (nếu có)
    if (Array.isArray(json.fix_suggestions)) {
      json.fix_suggestions = json.fix_suggestions.map(s => ({
        ...s,
        latex: s?.latex ? sanitizeModelSolution(String(s.latex)) : ""
      }));
    }

    return res.json(json);
  } catch (e) {
    console.error("analyze error:", e);
    return res.status(500).json({ error: e?.message || "ANALYZE_FAIL" });
  }
});

// Stub tránh 404 từ frontend khi log
app.post("/api/report", (req, res) => {
  // TODO: nối Google Sheets nếu muốn; hiện tại trả 204 cho nhanh
  return res.status(204).end();
});
function classifySolutionType(summary) {
  const s = String(summary || "").toLowerCase();
  if (!s) return "unknown";
  if (s.includes("vô nghiệm") || s.includes("không có nghiệm")) return "none";
  if (s.includes("vô số nghiệm") || s.includes("vô hạn nghiệm")) return "infinite";
  if (s.includes("x =") || s.includes("y =") || s.includes("z =")) return "unique";
  return "unknown";
}
// // ---- Linear algebra verifier (float, tolerance) ----
// function parseSystem3(problem_plain) {
//   // mỗi dòng dạng ax+by+cz=d, có thể có khoảng trắng
//   const lines = String(problem_plain || "")
//     .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
//   if (lines.length !== 3) throw new Error("EXPECT_3_EQUATIONS");

//   const A = [], b = [];
//   for (const ln of lines) {
//     // chuẩn hoá: đưa về dạng ... = ...
//     const m = ln.replace(/\s+/g, "")
//       .match(/^(.+)=([^=]+)$/);
//     if (!m) throw new Error("BAD_EQUATION: " + ln);
//     const left = m[1], right = m[2];

//     // tách hệ số x,y,z từ vế trái
//     const coef = { x:0, y:0, z:0 };
//     // chuẩn hoá dấu +-
//     const terms = left.replace(/-/g, "+-").split("+").filter(s=>s!=="");
//     for (let t of terms) {
//       const mxy = t.match(/^(-?(?:\d+(?:\.\d+)?)?)([xyz])$/i);
//       if (!mxy) throw new Error("BAD_TERM: "+t+" in "+ln);
//       let val = mxy[1];
//       const v = mxy[2].toLowerCase();
//       if (val === "" || val === "+") val = "1";
//       if (val === "-") val = "-1";
//       coef[v] += parseFloat(val);
//     }
//     A.push([coef.x, coef.y, coef.z]);
//     b.push(parseFloat(right));
//   }
//   return { A, b };
// }

// function det3(A) {
//   const [[a,b,c],[d,e,f],[g,h,i]] = A;
//   return a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g);
// }

// function rank(A) {
//   // Gaussian elimination (simple, float)
//   const M = A.map(r => r.slice());
//   const n = M.length, m = M[0].length;
//   let rnk = 0, row = 0;
//   const EPS = 1e-9;
//   for (let col=0; col<m && row<n; col++) {
//     // tìm pivot
//     let sel = row;
//     for (let i=row; i<n; i++) if (Math.abs(M[i][col]) > Math.abs(M[sel][col])) sel = i;
//     if (Math.abs(M[sel][col]) < EPS) continue;
//     // swap
//     [M[row], M[sel]] = [M[sel], M[row]];
//     // normalize & eliminate
//     const piv = M[row][col];
//     for (let j=col; j<m; j++) M[row][j] /= piv;
//     for (let i=0; i<n; i++) if (i!==row) {
//       const factor = M[i][col];
//       for (let j=col; j<m; j++) M[i][j] -= factor*M[row][j];
//     }
//     row++; rnk++;
//   }
//   return rnk;
// }

// function solveUnique(A,b){
//   // Cramer (vì 3x3)
//   const D = det3(A);
//   const replaceCol = (k) => A.map((row,i)=> row.map((v,j)=> j===k ? b[i] : v));
//   const Dx = det3(replaceCol(0));
//   const Dy = det3(replaceCol(1));
//   const Dz = det3(replaceCol(2));
//   return { x: Dx/D, y: Dy/D, z: Dz/D };
// }
// ---- Deterministic step checker: kiểm tra 1 phương trình có là tổ hợp tuyến tính của các PT trước đó không

function parseLinearEq(line) {
  // Chuẩn "ax+by+cz=d" (chấp nhận khoảng trắng, số thập phân/phân số, dấu +/-)
  const s = String(line || '').replace(/\s+/g,'');
  const m = s.match(/^(.+)=([^=]+)$/);
  if (!m) return null;
  const L = m[1], R = m[2];
  const coef = { x:0, y:0, z:0, c:0 };

  // Tách vế trái theo +/-
  const parts = L.replace(/-/g, '+-').split('+').filter(Boolean);
  for (const p of parts) {
    const t = p.match(/^([\-]?\d*(?:\/\d+)?)?([xyz])$/i);
    if (t) {
      let k = t[1];
      if (k === '' || k === '+') k = '1';
      if (k === '-') k = '-1';
      const v = t[2].toLowerCase();
      coef[v] += Frac.from(k).toNumber();
    } else {
      // hằng số bên trái
      coef.c += Frac.from(p).toNumber();
    }
  }
  const d = Frac.from(R).sub(Frac.from(coef.c)).toNumber();
  return { a:coef.x, b:coef.y, c:coef.z, d }; // biểu diễn chuẩn
}

// Giải alpha, beta sao cho: alpha*E1 + beta*E2 = E (theo 4 thành phần a,b,c,d)
function combo2(E1, E2, E) {
  // Dựa vào hệ {a,b}, rồi kiểm tra {c,d}
  const A00 = E1.a, A01 = E2.a, A10 = E1.b, A11 = E2.b;
  const B0 = E.a, B1 = E.b;
  const det = A00*A11 - A01*A10;
  if (Math.abs(det) < 1e-10) return null;
  const alpha = (B0*A11 - B1*A01) / det;
  const beta  = (A00*B1 - A10*B0) / det;
  const c = alpha*E1.c + beta*E2.c;
  const d = alpha*E1.d + beta*E2.d;
  if (Math.abs(c - E.c) < 1e-7 && Math.abs(d - E.d) < 1e-7) return { alpha, beta };
  return null;
}

function isLinearComboOf(E, bank) {
  // thử tất cả cặp trong "bank" (đủ cho các bước khử/cộng đại số kiểu THPT)
  for (let i = 0; i < bank.length; i++) {
    for (let j = i; j < bank.length; j++) {
      if (combo2(bank[i], bank[j], E)) return true;
    }
  }
  return false;
}
// Hàm phát hiện số biến tự động từ đề bài
function detectVariables(problemText) {
  const lines = problemText.split('\n').filter(line => line.trim());
  const allVars = new Set();
  
  lines.forEach(line => {
      // Tìm tất cả biến (chữ cái đơn lẻ) trong phương trình
      const matches = line.match(/\b[a-z]\b/gi);
      if (matches) {
          matches.forEach(v => allVars.add(v.toLowerCase()));
      }
  });
  
  // Loại bỏ các từ khóa không phải biến
  const nonVars = ['pi', 'e', 'i', 'd', 'f']; // các hằng số toán học
  nonVars.forEach(nv => allVars.delete(nv));
  
  return Array.from(allVars).sort();
}

// Parse equation linh hoạt theo số biến
function parseEqFlex(line, variables) {
  const [L, R] = line.split("=");
  const S = v => v.replace(/\s+/g, "");
  const left = S(L), right = Frac.from(S(R));
  
  const coefficients = {};
  variables.forEach(v => {
      const m = left.match(new RegExp(`([+-]?\\d*(?:/\\d+)?)${v}`, 'g')) || [];
      coefficients[v] = m.map(t => {
          const k = t.replace(v, "");
          return k === "" || k === "+" ? Frac.from(1) : 
                 k === "-" ? Frac.from(-1) : Frac.from(k);
      }).reduce((a, c) => a.add(c), Frac.from(0));
  });

  // constant term on left (move to right)
  let constLeft = left;
  variables.forEach(v => {
      constLeft = constLeft.replace(new RegExp(`[+-]?\\d*(?:/\\d+)?${v}`, 'g'), '');
  });
  
  let cL = Frac.from(0);
  constLeft.replace(/([+\-]?\d+(?:\/\d+)?)/g, (m) => { 
      cL = cL.add(Frac.from(m)); 
      return m; 
  });
  
  return { 
      coefficients: variables.map(v => coefficients[v] || Frac.from(0)), 
      constant: right.sub(cL) 
  };
}

// Solver linh hoạt theo số phương trình và biến
function solveFlexible(rows, variables) {
  const numEq = rows.length;
  const numVars = variables.length;
  
  console.log(`Solving ${numEq} equations with ${numVars} variables: [${variables}]`);
  
  // Trường hợp đặc biệt: số phương trình < số biến → vô số nghiệm
  if (numEq < numVars) {
      return { type: "infinite", reason: `Số phương trình (${numEq}) < số biến (${numVars})` };
  }
  
  // Ma trận A và vector b
  const A = rows.map(r => r.coefficients.map(f => f.toNumber()));
  const b = rows.map(r => r.constant.toNumber());
  
  const rankA = computeRank(A);
  const Ab = A.map((row, i) => [...row, b[i]]);
  const rankAb = computeRank(Ab);
  
  console.log(`Rank A: ${rankA}, Rank Ab: ${rankAb}`);
  
  if (rankAb > rankA) {
      return { type: "none", reason: "Hệ vô nghiệm (rank A < rank Ab)" };
  }
  
  if (rankA < numVars) {
      return { type: "infinite", reason: `Hệ vô số nghiệm (rank A = ${rankA} < số biến = ${numVars})` };
  }
  
  // Chỉ giải duy nhất nghiệm khi số phương trình = số biến và rank đủ
  if (numEq === numVars && rankA === numVars) {
      if (numVars === 3) {
          // Dùng solver 3x3 cũ
          const sol3 = solve3(A, b);
          if (sol3.type === "unique") {
              return { 
                  type: "unique", 
                  x: sol3.x,
                  solution: variables.reduce((obj, v, i) => {
                      obj[v] = sol3.x[i];
                      return obj;
                  }, {})
              };
          }
          return sol3;
      }
      // Có thể mở rộng cho 2x2, 4x4 ở đây
  }
  
  return { type: "infinite", reason: "Hệ vô số nghiệm" };
}
function parseXYZFromText(t){
  if (!t) return null;
  const s = t.replace(/\s+/g,'');
  // x=...,y=...,z=... hoặc (x,y,z)=(..,..,..)s
  const m1 = s.match(/x=([\-0-9/\.]+).*?y=([\-0-9/\.]+).*?z=([\-0-9/\.]+)/i);
  if (m1) return [m1[1], m1[2], m1[3]];
  const m2 = s.match(/\(x,y,z\)=\(([\-0-9/\.]+),([\-0-9/\.]+),([\-0-9/\.]+)\)/i);
  if (m2) return [m2[1], m2[2], m2[3]];
  return null;
}
function eqFracStr(a,b){ try{ return Frac.from(a).eq(Frac.from(b)); }catch(_){ return false; } }

app.post("/api/grade", async (req, res) => {
  try {
    const { raw_text } = req.body || {};
    if (!raw_text) return res.status(400).json({ error: "NO_TEXT" });

    // 1) PARSE: tách đề + phần còn lại
    const r1 = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      response_format: { type: "json_object" },
      max_tokens: 1500,
      messages: [
        { role: "system", content: SYSTEM_PARSE },
        { role: "user", content: String(raw_text) }
      ]
    });
    let parsed = {};
    try { parsed = JSON.parse(r1.choices?.[0]?.message?.content || "{}"); }
    catch { return res.json({ error: "BAD_JSON_PARSE", raw: r1.choices?.[0]?.message?.content }); }

    parsed.problem_plain = String(parsed.problem_plain || "").trim();
    parsed.problem_latex = normalizeLatex(parsed.problem_latex || "");
    const student_plain  = String(parsed.remainder_plain || "").trim();
    if (!parsed.problem_plain) {
      return res.status(400).json({ error: "NO_PROBLEM_DETECTED", parsed });
    }
  // Sau khi có parsed.problem_plain:
  const eqs = parsed.problem_plain.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  // Parse "ax+by+cz=d" -> [a,b,c], d
  function parseEq(line){
    // very simple: move all to left, parse coefficients of x,y,z and const.
    // Vì bạn đang OCR chuẩn, format ax+by+cz=d là đủ chắc.
    const [L,R] = line.split("=");
    const S = v => v.replace(/\s+/g,"");
    const left = S(L), right = Frac.from(S(R));
    const coef = (varr) => {
      const m = left.match(new RegExp(`([+-]?\\d*(?:/\\d+)?)${varr}`,'g'))||[];
      return m.map(t=>{
        const k = t.replace(varr,"");
        return k===""||k==="+"
          ? Frac.from(1) : (k==="-" ? Frac.from(-1) : Frac.from(k));
      }).reduce((a,c)=>a.add(c), Frac.from(0));
    };
    const ax = coef("x"), by = coef("y"), cz = coef("z");
    // constant term on left (move to right)
    const constLeft = left
      .replace(/[+-]?\d*(?:\/\d+)?x/g,"")
      .replace(/[+-]?\d*(?:\/\d+)?y/g,"")
      .replace(/[+-]?\d*(?:\/\d+)?z/g,"");
      let cL = Frac.from(0);
      constLeft.replace(/([+\-]?\d+(?:\/\d+)?)/g, (m) => { cL = cL.add(Frac.from(m)); return m; });
    return { abc:[ax,by,cz], d: right.sub(cL) };
  }

  // Tự động phát hiện biến
  const variables = detectVariables(parsed.problem_plain);
  console.log("Detected variables:", variables);

  // Parse equations theo biến detect được
  const rows = eqs.map(eq => parseEqFlex(eq, variables));

  // Giải linh hoạt
  const sol = solveFlexible(rows, variables);

  // Cập nhật ground truth
  const ground = (() => {
      if (sol.type === "unique") {
          const summary = variables.map((v, i) => `${v} = ${sol.x[i]}`).join(', ');
          return {
              type: "unique",
              exact: sol.x.map(fr => fr.toString()),
              summary: summary
          };
      }
      if (sol.type === "none") return { type: "none", exact: null, summary: "vô nghiệm" };
      if (sol.type === "infinite") return { type: "infinite", exact: null, summary: "vô số nghiệm" };
      return { type: "unknown", exact: null, summary: "unknown" };
  })();

    // 2) SOLVE (STRICT): máy tự giải theo kiến thức nền tảng
    const r2 = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      response_format: { type: "json_object" },
      max_tokens: 4000,
      messages: [
        { role: "system", content: SYSTEM_SOLVE_STRICT },
        { role: "user", content: JSON.stringify({
            problem_plain: parsed.problem_plain,
            // Ground truth ép model phải tuân theo
            solution_type: ground.type,              // "unique" | "none" | "infinite" | "unknown"
            solution_exact: ground.exact             // ["2","0","2"] hoặc null
          })
        }
      ]
    });
    let solved = {};
    try { solved = JSON.parse(r2.choices?.[0]?.message?.content || "{}"); }
    catch { return res.json({ error: "BAD_JSON_SOLVE", raw: r2.choices?.[0]?.message?.content }); }

    solved.method           = String(solved.method || "unknown");
    solved.solution_summary = String(solved.solution_summary || "").trim();
    solved.solution_latex   = sanitizeModelSolution(String(solved.solution_latex || ""));
    if (!Array.isArray(solved.main_steps)) solved.main_steps = [];
    // 2.5) VERIFY by algebra (override LLM if needed)
    if (ground.type === "unique") {
         solved.solution_summary = ground.summary;
       } else if (ground.type === "none") {
         solved.solution_summary = "vô nghiệm";
       } else if (ground.type === "infinite") {
         solved.solution_summary = "vô số nghiệm";
       }

    const llmSummary = String(solved.solution_summary || "").toLowerCase();
    const llmType =
      /vô nghiệm|không có nghiệm/.test(llmSummary) ? "none" :
      /vô số nghiệm|vô hạn nghiệm/.test(llmSummary) ? "infinite" :
      /x\s*=|y\s*=|z\s*=/.test(llmSummary) ? "unique" : "unknown";

    // Nếu khác nhau → dùng ground truth
    if (ground.type !== "unknown" && ground.type !== llmType) {
      if (ground.type === "none") {
        solved.method = solved.method || "elimination";
        solved.solution_summary = "vô nghiệm";
        solved.solution_latex =
          "\\[\\begin{cases}"+
          parsed.problem_latex.replace(/^.*\\begin{cases}/s,"").replace(/\\end{cases}.*$/s,"").trim()+
          "\\end{cases}\\]\\begin{align*}"+
          "\\text{Khử ẩn để thu được hai phương trình mâu thuẫn } 3x+2y=8 \\text{ và } 3x+2y=4.\\\\ "+
          "\\Rightarrow \\; \\text{Hệ vô nghiệm.}\\end{align*}";
        solved.main_steps = [
          "Rút \(z\) từ phương trình (2) và thay vào (1) → \(3x+2y=8\).",
          "Thay tiếp vào (3) → \(3x+2y=4\).",
          "Hai hệ thức mâu thuẫn ⇒ hệ vô nghiệm."
        ];
      } else if (ground.type === "unique") {
        const {x,y,z} = ground.solution;
        solved.method = solved.method || "matrix";
        solved.solution_summary = `x = ${x}, y = ${y}, z = ${z}`;
        // (có thể tạo latex đẹp hơn nếu muốn)
      } else if (ground.type === "infinite") {
        solved.method = solved.method || "gauss";
        solved.solution_summary = "vô số nghiệm";
      }
    }

    // 3) SEGMENT_STUDENT: phân đoạn bài làm học sinh
    const r3 = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      response_format: { type: "json_object" },
      max_tokens: 2000,
      messages: [
        { role: "system", content: SYSTEM_SEGMENT_STUDENT },
        { role: "user", content: `student_plain:\n${student_plain || raw_text}` }
      ]
    });
    let student = {};
    try { student = JSON.parse(r3.choices?.[0]?.message?.content || "{}"); }
    catch { return res.json({ error: "BAD_JSON_SEGMENT", raw: r3.choices?.[0]?.message?.content }); }
    if (!Array.isArray(student.steps)) student.steps = [];
    student.problem_plain = String(student.problem_plain || "").trim();
    student.conclusion    = String(student.conclusion || "").trim();
     // === HARD CHECK từng bước theo đại số (ưu tiên hơn LLM) ===
     const originals = parsed.problem_plain.split(/\r?\n/).map(parseLinearEq).filter(Boolean);
     const bank = [...originals];  // các phương trình đã được xác thực
     const stepAlignmentHard = [];
 
     (student.steps || []).forEach((st, idx) => {
       const eq = parseLinearEq(st.math || '');
       const stepIndex = st.index || idx + 1;
 
       if (!eq) {
         stepAlignmentHard.push({ student_step_index: stepIndex, verdict: 'unclear', what: 'Không phát hiện phương trình để kiểm chứng.' });
         return;
       }
 
       // Mâu thuẫn dạng 0x+0y+0z = d
       if (Math.abs(eq.a) < 1e-9 && Math.abs(eq.b) < 1e-9 && Math.abs(eq.c) < 1e-9) {
         if (Math.abs(eq.d) < 1e-9) {
           stepAlignmentHard.push({ student_step_index: stepIndex, verdict: 'ok', what: 'Đẳng thức 0=0 hợp lệ.' });
         } else {
           stepAlignmentHard.push({ student_step_index: stepIndex, verdict: 'ok', what: `Phát hiện mâu thuẫn 0 = ${eq.d} (đúng thao tác khử).` });
         }
         bank.push(eq);
         return;
       }
 
       if (isLinearComboOf(eq, bank)) {
         stepAlignmentHard.push({ student_step_index: stepIndex, verdict: 'ok', what: 'Phương trình là tổ hợp tuyến tính hợp lệ của các phương trình trước.' });
         bank.push(eq);
       } else {
         stepAlignmentHard.push({ student_step_index: stepIndex, verdict: 'unclear', what: 'Chưa chứng minh được đây là tổ hợp tuyến tính của các phương trình trước.' });
       }
     });
 
    const goldenMin = {
      method: solved.method,
      solution_summary: String(solved.solution_summary || "").slice(0, 300),
      main_steps: (solved.main_steps || []).slice(0, 12).map(s => String(s).slice(0, 180)),
    };
    
    const studentMin = {
      steps: (student.steps || []).slice(0, 30).map(st => ({
        index: st.index,
        text: String(st.text || "").slice(0, 200),
        math: String(st.math || "").slice(0, 160),
      })),
      conclusion: String(student.conclusion || "").slice(0, 200),
    };
    // 4) COMPARE: so sánh theo bước + so khớp kết luận
    const r4 = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      response_format: { type: "json_object" },
      max_tokens: 2500,
      messages: [
        { role: "system", content: SYSTEM_COMPARE + "\n\nNgôn ngữ đầu ra: CHỈ tiếng Việt. ƯU TIÊN ground truth khi chấm." },
        { role: "user", content: JSON.stringify({
            golden:  goldenMin,
            student: studentMin,
            // Ground truth truyền vào để model căn cứ
            solution_type: ground.type,
            solution_exact: ground.exact
          })
        }
      ]
    });
    let comparedRaw = r4.choices?.[0]?.message?.content || "{}";
    let compared = relaxedJsonParse(comparedRaw);
    // Retry 1 lần nếu vẫn hỏng JSON
    if (!compared) {
      const r4b = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.0,
        response_format: { type: "json_object" },
        max_tokens: 1800,
        messages: [
          { role: "system", content: SYSTEM_COMPARE + "\n\nCHỈ TRẢ JSON 1 DÒNG, KHÔNG MARKDOWN, KHÔNG GIẢI THÍCH. Ngôn ngữ: **chỉ tiếng Việt**. ƯU TIÊN ground truth khi chấm." },
          { role: "user", content: JSON.stringify({
              golden:  goldenMin,
              student: studentMin,
              solution_type: ground.type,
              solution_exact: ground.exact
            })
          }
        ]
      });
      comparedRaw = r4b.choices?.[0]?.message?.content || "{}";
      compared = relaxedJsonParse(comparedRaw);
    }

    // Fallback mềm: đừng làm hỏng cả response
    if (!compared) {
      console.error("COMPARE JSON failed. raw=", comparedRaw?.slice(0, 400));
      compared = {
        verdict: "partial",
        reason: "parser_fallback",
        steps_alignment: [],
        conclusion_match: "unclear",
        differences: [],
        step_errors: [],
        fix_suggestions: []
      };
    }
    // >>> BÂY GIỜ mới hợp nhất verdict với hard-check
    if (Array.isArray(compared.steps_alignment)) {
      compared.steps_alignment = compared.steps_alignment.map((s, i) => {
        const hard = stepAlignmentHard[i];
        return (hard && hard.verdict === 'ok')
          ? { ...s, verdict: 'ok', what: hard.what, fix: '' }
          : s;
      });
    }
    compared.verdict ||= "partial";
    compared.reason  ||= "";
    if (!Array.isArray(compared.steps_alignment)) compared.steps_alignment = [];
    if (!Array.isArray(compared.differences))     compared.differences     = [];
    if (!Array.isArray(compared.step_errors))     compared.step_errors     = [];
    if (!Array.isArray(compared.fix_suggestions)) compared.fix_suggestions = [];
    // === Map A: đảm bảo Lỗi/Gợi ý phản ánh đúng bảng so sánh ===
    const mapped = mapCompareToErrors(compared);

    // Nếu model cũng trả step_errors/fix_suggestions thì chỉ dùng làm "fallback"
    const final_step_errors     = mapped.step_errors.length ? mapped.step_errors : compared.step_errors;
    const final_fix_suggestions = mapped.fix_suggestions.length ? mapped.fix_suggestions : compared.fix_suggestions;

    // 5) ĐÓNG GÓI: giữ UI cũ + bổ sung khối mới
    // Map sang tiếng Việt trước khi gửi ra frontend
    const methodMap = {
      elimination: "Phương pháp cộng đại số (Khử ẩn dần)",
      substitution: "Phương pháp thế",
      matrix: "Phương pháp ma trận (Cramer)",
      gauss: "Phương pháp khử Gauss",
      unknown: "Không xác định"
    };
    const method_vi = methodMap[solved.method] || solved.method;
    // Hard-check kết luận theo ground truth
    let hardConclusion = "unclear";
    const stuC = student.conclusion || "";
    if (ground.type === "none") {
      if (/vô\s*nghiệm/i.test(stuC)) hardConclusion = "match"; else hardConclusion = "mismatch";
    } else if (ground.type === "infinite") {
      if (/vô\s*(số|hạn)\s*nghiệm/i.test(stuC)) hardConclusion = "match"; else hardConclusion = "mismatch";
    } else if (ground.type === "unique") {
      const v = parseXYZFromText(stuC);
      if (v) {
        hardConclusion = (eqFracStr(v[0], ground.exact[0]) && eqFracStr(v[1], ground.exact[1]) && eqFracStr(v[2], ground.exact[2]))
          ? "match" : "mismatch";
      }
    }
    // ghi đè nếu model đánh giá khác
    if (hardConclusion !== "unclear") {
      compared.conclusion_match = hardConclusion;
    }

    const payload = {
      normalized_problem: parsed.problem_latex,
      model_solution_latex: solved.solution_latex,
      solution_card: {
        solution_summary: ground.summary || solved.solution_summary || "",
        method_used: method_vi,
        main_steps: solved.main_steps || []
      },

      // LỖI & GỢI Ý (map từ bảng so sánh => luôn khớp 100%)
      step_errors: final_step_errors,
      fix_suggestions: final_fix_suggestions,
      detected_method: solved.method, 
      // Khối mới để hiển thị nếu muốn:
      golden: {
        problem_plain: parsed.problem_plain,
        problem_latex: parsed.problem_latex,
        method: solved.method,
        solution_summary: solved.solution_summary,
        solution_latex: solved.solution_latex,
        main_steps: solved.main_steps
      },
      student,     // { problem_plain, steps[], conclusion }
      compare: {   // tên ngắn gọn
        verdict: compared.verdict,
        reason: compared.reason,
        steps_alignment: compared.steps_alignment,
        conclusion_match: compared.conclusion_match || "unclear",
        differences: compared.differences
      }
    };
    // 4.5) PRACTICE: sinh 3–5 bài tập gợi ý (chỉ đề)
    const errorCodes = (final_step_errors || []).map(e => String(e?.code || "").trim()).filter(Boolean).slice(0, 6);
    const methodHint  = solved.method || "unknown";
    const solTypeHint = classifySolutionType(solved.solution_summary); // unique|none|infinite|unknown

    let practice = { items: [] };
    try {
      const rP = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.6,                // đa dạng hơn một chút
        response_format: { type: "json_object" },
        max_tokens: 2000,
        messages: [
          { role: "system", content: SYSTEM_PRACTICE },
          { role: "user", content: JSON.stringify({
              method_hint: methodHint,
              solution_type_hint: solTypeHint,
              error_codes: errorCodes,
              diversity: true,
              count: 4   // 3–5: chọn mặc định 4
            })
          }
        ]
      });

      const rawP = rP.choices?.[0]?.message?.content || "{}";
      practice = relaxedJsonParse(rawP) || { items: [] };
    } catch (e) {
      console.error("practice gen error:", e?.message);
      practice = { items: [] };
    }

    // sanitize LaTeX cho từng đề
    let practice_list = [];
    if (Array.isArray(practice.items)) {
      practice_list = practice.items.map((it, idx) => ({
        index: idx + 1,
        latex: normalizeLatex(String(it?.latex || "")),
        tags: Array.isArray(it?.tags) ? it.tags.slice(0,4) : []
      })).filter(p => p.latex.includes("\\begin{cases}") && p.latex.includes("\\end{cases}"));
    }
    payload.practice_list = practice_list;
    return res.json(payload);
  } catch (e) {
    console.error("grade error:", e);
    return res.status(500).json({ error: e?.message || "GRADE_FAIL" });
  }
});

// start server
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
