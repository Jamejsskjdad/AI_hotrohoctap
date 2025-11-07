// server.js — bản đầy đủ (đã vá hiển thị LaTeX)
// Đặt ngay đầu file:
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('exit', (code)=> console.error('[process exit]', code));
process.on('SIGTERM', ()=> { console.error('[SIGTERM]'); });
process.on('SIGINT',  ()=> { console.error('[SIGINT]'); });

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const { SYSTEM_ANALYZE, USER_SCHEMA } = require("./prompt");
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }  // 10MB/ảnh (bạn chỉnh tùy ý)
});
const { SYSTEM_OCR } = require("./prompt");

const app = express();
app.get('/health', (req, res) => res.json({ ok: true, pid: process.pid }));

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://gpt1.shupremium.com/v1",
});

/* ================= Helpers: hậu xử lý LaTeX ================= */

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
      model: "gpt-4o-mini",          // cùng model “đang dùng để đưa ra lời giải”
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
// start server
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
