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

app.post("/api/grade", async (req, res) => {
  try {
    const { raw_text } = req.body || {};
    if (!raw_text) return res.status(400).json({ error: "NO_TEXT" });

    // 1) PARSE: tách đề + phần còn lại
    const r1 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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

    // 2) SOLVE (STRICT): máy tự giải theo kiến thức nền tảng
    const r2 = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      response_format: { type: "json_object" },
      max_tokens: 4000,
      messages: [
        { role: "system", content: SYSTEM_SOLVE_STRICT },
        { role: "user", content: `problem_plain:\n${parsed.problem_plain}` }
      ]
    });
    let solved = {};
    try { solved = JSON.parse(r2.choices?.[0]?.message?.content || "{}"); }
    catch { return res.json({ error: "BAD_JSON_SOLVE", raw: r2.choices?.[0]?.message?.content }); }

    solved.method           = String(solved.method || "unknown");
    solved.solution_summary = String(solved.solution_summary || "").trim();
    solved.solution_latex   = sanitizeModelSolution(String(solved.solution_latex || ""));
    if (!Array.isArray(solved.main_steps)) solved.main_steps = [];

    // 3) SEGMENT_STUDENT: phân đoạn bài làm học sinh
    const r3 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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
        { role: "system", content: SYSTEM_COMPARE + "\n\nNgôn ngữ đầu ra: CHỈ tiếng Việt, không dùng tiếng Anh." },
        { role: "user", content:
`golden:
${JSON.stringify(goldenMin)}

student:
${JSON.stringify(studentMin)}`
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
          { role: "system", content: SYSTEM_COMPARE + "\n\nCHỈ TRẢ JSON 1 DÒNG, KHÔNG MARKDOWN, KHÔNG GIẢI THÍCH. Ngôn ngữ: **chỉ tiếng Việt**." },
          { role: "user", content:
    `golden:
    ${JSON.stringify(goldenMin)}

    student:
    ${JSON.stringify(studentMin)}`
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

    const payload = {
      normalized_problem: parsed.problem_latex,
      model_solution_latex: solved.solution_latex,
      solution_card: {
        solution_summary: solved.solution_summary || "",
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
        model: "gpt-4o-mini",
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
