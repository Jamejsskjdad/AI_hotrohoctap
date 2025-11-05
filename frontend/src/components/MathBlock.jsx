import { useEffect, useRef } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

export default function MathBlock({ latex, inline = false }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      // KaTeX render
      katex.render(String(latex || ""), ref.current, {
        throwOnError: false,
        displayMode: !inline,
        macros: { "\\R": "\\mathbb{R}" },
        strict: "ignore",
        trust: true,
      });
    } catch {
      ref.current.textContent = latex || "";
    }
  }, [latex, inline]);

    return (
        <div
          ref={ref}
          className="math-block"
          style={{
            textAlign: "left",
            whiteSpace: "normal",
            overflowX: "auto",  // chống tràn khi biểu thức quá rộng
            maxWidth: "100%",
          }}
        />
      );
}
