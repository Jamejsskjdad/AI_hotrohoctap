import { useRef, useState } from "react";
import Tesseract from "tesseract.js";
import "./style.css"
import MathBlock from "./components/MathBlock.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

export default function App() {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState("");
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => setPreview(String(ev.target?.result || ""));
    reader.readAsDataURL(f);

    // OCR trên client
    setLoading(true);
    const { data } = await Tesseract.recognize(f, "eng", { tessjs_create_tsv: "1" });
    setRawText(data.text || "");
    setLoading(false);
  }

  async function analyze() {
    if (!rawText) return;
    setLoading(true);
    const t0 = performance.now();
    const analyzed = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_text: rawText })
    }).then(r => r.json());
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
        fileId: "", ocr_conf: "", method: analyzed.detected_method,
        errors: analyzed.step_errors, normalized_problem: analyzed.normalized_problem,
        response_ms: ms
      })
    }).catch(()=>{});

    setLoading(false);
    setTimeout(() => document.getElementById("result")?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  function resetAll() {
    setPreview(""); setRawText(""); setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <main className="wrap">
      <div className="card">
        <div className="header">
          <h1><i className="fa-solid fa-brain" /> Ứng dụng AI Hỗ Trợ Nhận Diện và Sửa Lỗi</h1>
          <p>Hệ phương trình bậc nhất ba ẩn - Đề tài KHKT</p>
        </div>

        <div className="upload" onClick={() => fileRef.current?.click()}>
          <i className={`fa-solid ${preview ? "fa-check-circle" : "fa-cloud-upload-alt"} icon`} />
          <div className="label">Tải lên ảnh lời giải của học sinh</div>
          <p className="hint">Nhấn để chọn ảnh (JPG, PNG)</p>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
          {preview && <img src={preview} className="preview" />}
        </div>

        <div className="btns">
          <button className="btn primary" disabled={!rawText || loading} onClick={analyze}>
            <i className="fa-solid fa-search" /> {loading ? "Đang phân tích..." : "Phân tích lời giải"}
          </button>
          <button className="btn" onClick={resetAll}><i className="fa-solid fa-rotate-right" /> Thử lại bài khác</button>
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

            {/* Đề bài chuẩn hóa */}
            {result?.normalized_problem && (
              <div className="subbox">
                <h3 className="title"><i className="fa-solid fa-square-root-variable"/> Đề bài chuẩn hoá</h3>
                <MathBlock latex={String(result?.normalized_problem || "")} />
              </div>
            )}

            {/* Lỗi phát hiện */}
            <div className="subbox">
              <h3 className="title warn"><i className="fa-solid fa-triangle-exclamation"/> Lỗi phát hiện</h3>
              {(result.step_errors?.length ?? 0) > 0
                ? result.step_errors.map((e, i) => (
                    <div key={i} className="error"><b>{e.code}</b> — {e.what} (Sửa: {e.fix})</div>
                  ))
                : <div className="text-gray-500">Không phát hiện lỗi nào hoặc kết quả rỗng.</div>
              }
            </div>

            {/* Gợi ý sửa lỗi */}
            <div className="subbox" style={{background:"#FFF6E5"}}>
              <h3 className="title"><i className="fa-regular fa-lightbulb"/> Gợi ý sửa lỗi</h3>
              {(result.fix_suggestions?.length ?? 0) > 0 ? (
                result.fix_suggestions.map((s, i) => (
                  <div key={i} style={{marginBottom:12}}>
                    <div style={{fontWeight:600, marginBottom:6}}>Bước {s.step} (sửa): {s.explain}</div>
                    {s.latex && <MathBlock latex={String(s.latex)} />}
                  </div>
                ))
              ) : (
                <div className="text-gray-500">Chưa có gợi ý cụ thể.</div>
              )}
            </div>

            {/* Lời giải đúng – thẻ xanh gọn */}
            <div className="subbox" style={{background:"#e8f5e9"}}>
              <h3 className="title ok"><i className="fa-solid fa-circle-check"/> Lời giải đúng</h3>

              <div style={{paddingLeft:10}}>
              <details style={{marginBottom:10}}>
                <summary><b>Hệ phương trình (xem/ẩn)</b></summary>
                <MathBlock latex={String(result.normalized_problem || "")} />
              </details>

                {result.solution_card?.solution_summary && (
                  <p style={{marginTop:10}}><b>Nghiệm:</b> {result.solution_card.solution_summary}</p>
                )}

                {result.solution_card?.method_used && (
                  <p><b>Phương pháp giải:</b> {result.solution_card.method_used}</p>
                )}

                {result.solution_card?.main_steps?.length > 0 && (
                  <div>
                    <b>Các bước giải chi tiết:</b>
                    <ul>
                      {result.solution_card.main_steps.map((s,i)=>(
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}


      </div>
      {/* Font Awesome CDN */}
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css"/>
    </main>
  );
}
