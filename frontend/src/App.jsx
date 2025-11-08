import { useRef, useState } from "react";
import "./style.css";
import MathBlock from "./components/MathBlock.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

function safeStr(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "undefined" || s === "null") return "";
  return s;
}

export default function App() {
  const fileRef = useRef(null);
     const [previews, setPreviews] = useState([]);     // NEW: nhiều ảnh
     const [rawText, setRawText] = useState("");       // plain_text từ OCR    
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function handleFiles(e) {                    // NEW
         const files = Array.from(e.target.files || []);
         if (!files.length) return;
    
         // hiển thị preview nhiều ảnh
         const pv = await Promise.all(files.map(f => new Promise(res => {
           const r = new FileReader();
           r.onload = ev => res(String(ev.target?.result || ""));
           r.readAsDataURL(f);
        })));
         setPreviews(pv);
    
         // gửi FormData đến /api/ocr
         setLoading(true);
         const fd = new FormData();
         files.forEach(f => fd.append("files", f));
         try {
           const ocr = await fetch(`${API_BASE}/api/ocr`, { method: "POST", body: fd })
             .then(r => r.json());
           if (ocr?.error) throw new Error(ocr.error);
           setRawText(ocr.plain_text || "");
         } catch (err) {
           alert("OCR lỗi, vui lòng thử lại.\n" + (err?.message || ""));
         } finally {
           setLoading(false);
         }
  }

  async function analyze() {
    if (!rawText) return;
    setLoading(true);
    const t0 = performance.now();
    const analyzed = await fetch(`${API_BASE}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_text: rawText }),
    }).then((r) => r.json());
    if (analyzed?.error) {
      alert("API lỗi: " + analyzed.error);
      setLoading(false);
      return;
    }
    const ms = Math.round(performance.now() - t0);
    setResult(analyzed);

    // log (không chặn UI)
    fetch(`${API_BASE}/api/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: "",
        ocr_conf: "",
        method: analyzed.detected_method,
        errors: analyzed.step_errors,
        normalized_problem: analyzed.normalized_problem,
        response_ms: ms,
      }),
    }).catch(() => {});
    setLoading(false);
    setTimeout(() => document.getElementById("result")?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  function resetAll() {
    setPreviews([]);   
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  const fullSolution = safeStr(
    result?.model_solution_latex ?? result?.model_solution ?? ""
  );
  return (
    <main className="wrap">
      <div className="card">
        <div className="header">
          <h1><i className="fa-solid fa-brain" /> Ứng dụng AI Hỗ Trợ Nhận Diện và Sửa Lỗi</h1>
          <p>Hệ phương trình bậc nhất ba ẩn - Đề tài KHKT</p>
        </div>

        <div className="upload" onClick={() => fileRef.current?.click()}>
           <i className={`fa-solid ${previews.length ? "fa-check-circle" : "fa-cloud-upload-alt"} icon`} />
           <div className="label">Tải lên ảnh lời giải của học sinh</div>
           <p className="hint">Chọn **nhiều** ảnh (JPG/PNG)</p>
           <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={handleFiles} />
           {previews.length > 0 && previews.map((src, i) => (
             <img key={i} src={src} className="preview" />
           ))}
         </div>

        <div className="btns">
          <button className="btn primary" disabled={!rawText || loading} onClick={analyze}>
            <i className="fa-solid fa-search" /> {loading ? "Đang phân tích..." : "Phân tích lời giải"}
          </button>
          <button className="btn" onClick={resetAll}>
            <i className="fa-solid fa-rotate-right" /> Thử lại bài khác
          </button>
        </div>

        {rawText && (
          <details className="box">
            <summary>Văn bản OCR</summary>
            <pre className="pre">{rawText}</pre>
          </details>
        )}       
        {result && (
          <section id="result" className="box">
            <h2><i className="fa-solid fa-clipboard-check" /> Kết quả phân tích</h2>

            {/* Đề bài chuẩn hoá */}
            {safeStr(result?.normalized_problem) && (
              <div className="subbox">
                <h3 className="title"><i className="fa-solid fa-square-root-variable" /> Đề bài chuẩn hoá</h3>
                <MathBlock latex={safeStr(result?.normalized_problem)} />
              </div>
            )}

            {/* Lỗi phát hiện */}
            <div className="subbox">
              <h3 className="title warn"><i className="fa-solid fa-triangle-exclamation" /> Lỗi phát hiện</h3>
              {(result.step_errors?.length ?? 0) > 0 ? (
                result.step_errors.map((e, i) => (
                  <div key={i} className="error">
                    <b>{e.step != null ? `Bước ${e.step}` : "Bước ?"} — {e.code}</b> — {e.what}
                    {e.fix ? ` (Sửa: ${e.fix})` : ""}
                  </div>
                ))
              ) : (
                <div className="text-gray-500">Không phát hiện lỗi nào hoặc kết quả rỗng.</div>
              )}
            </div>
           

            {/* Gợi ý sửa lỗi */}
            <div className="subbox" style={{ background: "#FFF6E5" }}>
              <h3 className="title"><i className="fa-regular fa-lightbulb" /> Gợi ý sửa lỗi</h3>
              {(result.fix_suggestions?.length ?? 0) > 0 ? (
                result.fix_suggestions.map((s, i) => {
                  const latex = safeStr(s?.latex);
                  return (
                    <div key={i} style={{ marginBottom: 12 }}>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>
                        Bước {s.step} (sửa): {s.explain}
                      </div>
                      {latex && <MathBlock latex={latex} />}
                    </div>
                  );
                })
              ) : (
                <div className="text-gray-500">Chưa có gợi ý cụ thể.</div>
              )}
            </div>
            {/* Lời giải đúng */}
            <div className="subbox" style={{ background: "#e8f5e9" }}>
              <h3 className="title ok"><i className="fa-solid fa-circle-check" /> Lời giải đúng</h3>
              <div style={{ paddingLeft: 10 }}>
                <details style={{ marginBottom: 10 }}>
                  <summary><b>Hệ phương trình (xem/ẩn)</b></summary>
                  <MathBlock latex={safeStr(result?.normalized_problem)} />
                </details>

                {/* Tóm tắt gọn (nếu có) */}
                {result.solution_card?.solution_summary && 
                result.solution_card.solution_summary !== "unknown" &&(
                  <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                    <b>Nghiệm:</b>
                    {(/[\\^_{}]|\\frac|\\dfrac|\\left|\\right/.test(result.solution_card.solution_summary))
                      ? <MathBlock latex={String(result.solution_card.solution_summary)} inline />
                      : <span>{result.solution_card.solution_summary}</span>}
                  </div>
                )}

                {result.solution_card?.method_used && (
                  <p><b>Phương pháp giải:</b> {result.solution_card.method_used}</p>
                )}
                {result.solution_card?.main_steps?.length > 0 && (
                  <div>
                    <b>Các bước giải chi tiết:</b>
                    <ul>
                      {result.solution_card.main_steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Bản LaTeX đầy đủ */}
                {fullSolution.length > 0 ? (
                  <div className="subbox" style={{ marginTop: 12 }}>
                    <MathBlock latex={fullSolution} />
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Font Awesome CDN */}
      <link
        rel="stylesheet"
        href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css"
      />
    </main>
  );
}
