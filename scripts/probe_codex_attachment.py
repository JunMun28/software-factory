#!/usr/bin/env python3
"""Manual probe for ADR 0022 — NOT part of `make verify` (needs codex auth).

Proves codex, in a read-only sandbox, will read a text file in its working dir
and run pdftotext on a PDF placed beside it. Run:  python scripts/probe_codex_attachment.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    wd = Path(tempfile.mkdtemp(prefix="codex-probe-"))
    (wd / "error.log").write_text("FATAL: NullReferenceException at ExportService.run line 88\n")
    # a tiny valid one-page PDF containing the word CANARY-PDF-OK
    (wd / "doc.pdf").write_bytes(_minimal_pdf("CANARY-PDF-OK"))
    prompt = (
        "Two files are in your working directory: error.log and doc.pdf. "
        "Read error.log and extract the PDF's text (pdftotext doc.pdf - works). "
        "Reply with ONLY the exception class name from the log and the single "
        "all-caps token inside the PDF, space-separated."
    )
    last = wd / "_last.md"
    cmd = ["codex", "exec", "--skip-git-repo-check", "--color", "never",
           "--sandbox", "read-only", "--output-last-message", str(last), prompt]
    print("running:", " ".join(cmd[:-1]), "<prompt>")
    proc = subprocess.run(cmd, cwd=str(wd), capture_output=True, text=True, timeout=180)
    out = last.read_text().strip() if last.exists() else proc.stdout
    print("\n--- codex reply ---\n", out)
    ok = "NullReferenceException" in out and "CANARY-PDF-OK" in out
    print("\nRESULT:", "PASS ✅ (codex read both files in read-only cwd)" if ok
          else "FAIL ❌ — see ADR 0022 fallback (pre-extract sidecars)")
    return 0 if ok else 1


def _minimal_pdf(text: str) -> bytes:
    body = (
        b"%PDF-1.1\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]"
        b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
        b"4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 100 Td (" + text.encode() + b") Tj ET\nendstream endobj\n"
        b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF"
    )
    return body


if __name__ == "__main__":
    sys.exit(main())
