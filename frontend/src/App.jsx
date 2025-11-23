import "./style.css";
import MathBlock from "./components/MathBlock.jsx";
import { useRef, useState, useMemo, useEffect } from "react";

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
  const [iconCount, setIconCount] = useState(20);
  useEffect(() => {
    const update = () => {
      const h = document.body.scrollHeight;
  
      // Tính số icon dựa trên chiều cao trang
      // ví dụ: 1 icon trên mỗi 180px chiều cao
      const count = Math.ceil(h / 180);
  
      setIconCount(count);
    };
  
    update();
  
    // chạy lại mỗi khi resize hoặc thay đổi layout
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [result]); // chạy lại mỗi khi kết quả được hiển thị
  
  // ===== Icon nền sinh ngẫu nhiên quanh khối card =====
  const autoIcons = useMemo(() => {
    const RANDOM_MATH_ICONS = [
      "fa-square-root-variable",
      "fa-xmark",
      "fa-divide",
      "fa-plus-minus",
      "fa-plus",
      "fa-equals",
      "fa-circle-dot",
    ];
    const DRIFTS = ["driftSmallA", "driftSmallB", "driftSmallC"];
  
    return Array.from({ length: iconCount }).map((_, i) => {
      const icon = RANDOM_MATH_ICONS[i % RANDOM_MATH_ICONS.length];
  
      const left = 12 + Math.random() * 76;   // sát khu vực trung tâm
      const top = 5 + Math.random() * 90 * (i / iconCount); // trải đều theo chiều cao
  
      const size = 32 + (i % 5) * 5;
      const drift = DRIFTS[i % DRIFTS.length];
      const duration = 14 + (i % 5) * 3;
      const delay = -Math.random() * 20;
  
      return (
        <i
          key={`auto-${i}`}
          className={`fa-solid ${icon} math-icon auto-math-icon`}
          style={{
            left: `${left}%`,
            top: `${top}%`,
            fontSize: `${size}px`,
            opacity: 0.35,
            animationName: drift,
            animationDuration: `${duration}s`,
            animationDelay: `${delay}s`,
          }}
        />
      );
    });
  }, [iconCount]);
  

  async function handleFiles(e) {                    // NEW
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    // hiển thị preview nhiều ảnh
    const pv = await Promise.all(
      files.map(
        (f) =>
          new Promise((res) => {
            const r = new FileReader();
            r.onload = (ev) => res(String(ev.target?.result || ""));
            r.readAsDataURL(f);
          })
      )
    );
    setPreviews(pv);

    // gửi FormData đến /api/ocr
    setLoading(true);
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    try {
      const ocr = await fetch(`${API_BASE}/api/ocr`, {
        method: "POST",
        body: fd,
      }).then((r) => r.json());
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
    setTimeout(
      () =>
        document
          .getElementById("result")
          ?.scrollIntoView({ behavior: "smooth" }),
      50
    );
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
      {/* Lớp icon toán học ở nền background */}
      <div className="math-bg" aria-hidden="true">
        {/* góc trên trái */}
        <i className="fa-solid fa-square-root-variable math-icon math-icon-1" />
        <i className="fa-solid fa-xmark math-icon math-icon-2" />

        {/* phía trên phải */}
        <i className="fa-solid fa-divide math-icon math-icon-3" />
        <i className="fa-solid fa-infinity math-icon math-icon-4" />

        {/* giữa trái / giữa phải */}
        <i className="fa-solid fa-superscript math-icon math-icon-5" />
        <i className="fa-solid fa-plus-minus math-icon math-icon-6" />

        {/* dưới trái / dưới phải */}
        <i className="fa-solid fa-plus math-icon math-icon-7" />
        <i className="fa-solid fa-equals math-icon math-icon-8" />

        {/* thêm vài icon nhỏ làm nền phụ */}
        <i className="fa-solid fa-circle-dot math-icon math-icon-9" />
        <i className="fa-solid fa-minus math-icon math-icon-10" />
        <i className="fa-solid fa-square-root-variable math-icon math-icon-11" />
        <i className="fa-solid fa-divide math-icon math-icon-12" />
        {/* ICON KHOA HỌC – KỸ THUẬT */}
        <i className="fa-solid fa-robot tech-icon tech-icon-1" />
        <i className="fa-solid fa-microchip tech-icon tech-icon-2" />
        <i className="fa-solid fa-gears tech-icon tech-icon-3" />
        <i className="fa-solid fa-atom tech-icon tech-icon-4" />
        {/* Icon toán học bổ sung – kích thước nhỏ hơn, rải quanh mép màn hình */}
        <i className="fa-solid fa-square-root-variable math-icon math-icon-13" />
        <i className="fa-solid fa-divide math-icon math-icon-14" />
        <i className="fa-solid fa-plus-minus math-icon math-icon-15" />
        <i className="fa-solid fa-circle-dot math-icon math-icon-16" />

        {/* Icon khoa học – kỹ thuật bổ sung */}
        <i className="fa-solid fa-brain tech-icon tech-icon-5" />
        <i className="fa-solid fa-flask tech-icon tech-icon-6" />
        {/* Icon toán học bổ sung – nằm sát hai bên khối card chính */}
        <i className="fa-solid fa-xmark math-icon math-icon-17" />
        <i className="fa-solid fa-plus math-icon math-icon-18" />
        <i className="fa-solid fa-square-root-variable math-icon math-icon-19" />
        <i className="fa-solid fa-divide math-icon math-icon-20" />
        
        {autoIcons}
      </div>
      <div className="card">
        <div className="header">
          <h1>
            <i className="fa-solid fa-brain" /> Ứng dụng AI Hỗ Trợ Nhận Diện và
            Sửa Lỗi
          </h1>
          <p>Hệ phương trình bậc nhất ba ẩn</p>
        </div>

        <div className="upload" onClick={() => fileRef.current?.click()}>
          <i
            className={`fa-solid ${
              previews.length ? "fa-check-circle" : "fa-cloud-upload-alt"
            } icon`}
          />
          <div className="label">Tải lên ảnh lời giải của học sinh</div>
          <p className="hint">Chọn nhiều ảnh (JPG/PNG)</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={handleFiles}
          />
          {previews.length > 0 &&
            previews.map((src, i) => <img key={i} src={src} className="preview" />)}
        </div>

        <div className="btns">
          <button
            className="btn primary"
            disabled={!rawText || loading}
            onClick={analyze}
          >
            <i className="fa-solid fa-search" />{" "}
            {loading ? "Đang phân tích..." : "Phân tích lời giải"}
          </button>
          <button className="btn" onClick={resetAll}>
            <i className="fa-solid fa-rotate-right" /> Thử lại bài khác
          </button>
        </div>

        {rawText && (
          <details className="box">
            <summary>Bài làm của học sinh sau khi chuyển đổi</summary>
            <pre className="pre">{rawText}</pre>
          </details>
        )}
        {result && (
          <section id="result" className="box">
            <h2>
              <i className="fa-solid fa-clipboard-check" /> Kết quả phân tích
            </h2>

            {/* Đề bài chuẩn hoá */}
            {safeStr(result?.normalized_problem) && (
              <div className="subbox">
                <h3 className="title">
                  <i className="fa-solid fa-square-root-variable" /> Đề bài chuẩn
                  hoá
                </h3>
                <MathBlock latex={safeStr(result?.normalized_problem)} />
              </div>
            )}

            {/* Lỗi phát hiện */}
            <div className="subbox">
              <h3 className="title warn">
                <i className="fa-solid fa-triangle-exclamation" /> Lỗi phát hiện
              </h3>
              {(result.step_errors?.length ?? 0) > 0 ? (
                result.step_errors.map((e, i) => (
                  <div key={i} className="error">
                    <b>
                      {e.step != null ? `Bước ${e.step}` : "Bước ?"} — {e.code}
                    </b>{" "}
                    — {e.what}
                    {e.fix ? ` (Sửa: ${e.fix})` : ""}
                  </div>
                ))
              ) : (
                <div className="text-gray-500">
                  Không phát hiện lỗi nào hoặc kết quả rỗng.
                </div>
              )}
            </div>

            {/* Gợi ý sửa lỗi */}
            <div className="subbox" style={{ background: "#FFF6E5" }}>
              <h3 className="title">
                <i className="fa-regular fa-lightbulb" /> Gợi ý sửa lỗi
              </h3>
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
              <h3 className="title ok">
                <i className="fa-solid fa-circle-check" /> Lời giải đúng
              </h3>
              <div style={{ paddingLeft: 10 }}>
                <details style={{ marginBottom: 10 }}>
                  <summary>
                    <b>Hệ phương trình (xem/ẩn)</b>
                  </summary>
                  <MathBlock latex={safeStr(result?.normalized_problem)} />
                </details>

                {/* Tóm tắt gọn (nếu có) */}
                {result.solution_card?.solution_summary &&
                  result.solution_card.solution_summary !== "unknown" && (
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                      }}
                    >
                      <b>Nghiệm:</b>
                      {(/[\\^_{}]|\\frac|\\dfrac|\\left|\\right/.test(
                        result.solution_card.solution_summary
                      )) ? (
                        <MathBlock
                          latex={String(result.solution_card.solution_summary)}
                          inline
                        />
                      ) : (
                        <span>{result.solution_card.solution_summary}</span>
                      )}
                    </div>
                  )}

                {result.solution_card?.method_used && (
                  <p>
                    <b>Phương pháp giải:</b> {result.solution_card.method_used}
                  </p>
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

                {/* Bài tập gợi ý (chỉ đề) */}
                {Array.isArray(result?.practice_list) &&
                  result.practice_list.length > 0 && (
                    <div className="subbox">
                      <h3 className="title">
                        <i className="fa-solid fa-list-check" /> Bài tập gợi ý
                      </h3>
                      <div style={{ display: "grid", gap: 12 }}>
                        {result.practice_list.map((p) => (
                          <div
                            key={p.index}
                            className="box"
                            style={{ background: "#f9f9ff" }}
                          >
                            <div
                              style={{ fontWeight: 600, marginBottom: 6 }}
                            >{`Bài ${p.index}`}</div>
                            <MathBlock latex={safeStr(p.latex)} />
                            {Array.isArray(p.tags) && p.tags.length > 0 && (
                              <div
                                style={{
                                  marginTop: 6,
                                  fontSize: 12,
                                  color: "#666",
                                }}
                              >
                                {p.tags.map((t, i) => (
                                  <span key={i} style={{ marginRight: 8 }}>
                                    #{t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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
