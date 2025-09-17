// src/app/routes/extensivLabels.js
import { Router } from "express";
import axios from "axios";
import * as extMod from "../services/extensivClient.js"; // reuse your token/header logic
const ext = extMod?.default ?? extMod;

const r = Router();
const trimBase = (u) => (u || "").replace(/\/+$/, "");

// --- small helpers ---
async function authHeadersSafe() {
  if (typeof ext.authHeaders === "function") return await ext.authHeaders();
  // fallback to your existing logic:
  const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
  if (b64) {
    return {
      Authorization: `Basic ${b64}`,
      Accept: "application/hal+json, application/json",
    };
  }
  throw new Error("No Extensiv auth configured.");
}

function upcCandidatesFromText(text) {
  // Grab 12-digit sequences and validate UPC-A checksum
  const hits = new Set();
  const m = text.match(/\b\d{12}\b/g) || [];
  m.forEach((raw) => {
    const d = raw.split("").map((c) => +c);
    const sum =
      (d[0] + d[2] + d[4] + d[6] + d[8] + d[10]) * 3 +
      (d[1] + d[3] + d[5] + d[7] + d[9]);
    const check = (10 - (sum % 10)) % 10;
    if (check === d[11]) hits.add(raw);
  });
  return [...hits];
}

// Simple PDF text extractor (vector text). For image-only PDFs you’ll need OCR.
import pdfParse from "pdf-parse"; // npm i pdf-parse

// --- API: list order attachments (shipping label expected among them) ---
r.get("/orders/:orderId/attachments", async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const base =
      trimBase(
        process.env.EXT_API_BASE ||
          process.env.EXT_BASE_URL ||
          "https://secure-wms.com"
      ) || "https://secure-wms.com";

    const headers = await authHeadersSafe();

    // NOTE: Exact rel/route names can vary by tenant/version.
    // Many tenants expose HAL links under /orders/{id}/attachments or /documents
    // If your env differs, adjust just this URL:
    const url = `${base}/orders/${encodeURIComponent(orderId)}/attachments`;

    const { data, status } = await axios.get(url, { headers, timeout: 20000 });
    res.json({ ok: true, status, attachments: data });
  } catch (e) {
    next(e);
  }
});

// --- API: fetch a specific attachment (PDF), extract UPCs ---
r.get("/orders/:orderId/attachments/:attId/upcs", async (req, res, next) => {
  try {
    const { orderId, attId } = req.params;
    const base =
      trimBase(
        process.env.EXT_API_BASE ||
          process.env.EXT_BASE_URL ||
          "https://secure-wms.com"
      ) || "https://secure-wms.com";
    const headers = await authHeadersSafe();

    // Again, adjust the path if your tenant uses a different attachments route:
    const url = `${base}/orders/${encodeURIComponent(
      orderId
    )}/attachments/${encodeURIComponent(attId)}`;

    const resp = await axios.get(url, {
      headers: { ...headers, Accept: "application/pdf" },
      responseType: "arraybuffer",
      timeout: 30000,
      validateStatus: () => true,
    });
    if (resp.status < 200 || resp.status >= 300) {
      return res.status(resp.status).json({
        ok: false,
        status: resp.status,
        message: "Failed to fetch attachment PDF",
        data: resp.data?.toString?.() || null,
      });
    }

    const pdfBuffer = Buffer.from(resp.data);
    const parsed = await pdfParse(pdfBuffer); // vector text only
    const text = parsed?.text || "";
    const upcs = upcCandidatesFromText(text);

    res.json({
      ok: true,
      count: upcs.length,
      upcs,
      metadata: { pages: parsed?.numpages ?? null },
    });
  } catch (e) {
    next(e);
  }
});

// --- API: direct print to ZPL (BrowserPrint/Zebra) via portal device ---
// This route returns ZPL built from a UPC (simple 1D barcode). The handheld
// uses BrowserPrint or Zebra Enterprise Browser to send raw ZPL to a printer.
r.post("/print/zpl", async (req, res) => {
  const { upc, copies = 1 } = req.body || {};
  if (!upc) return res.status(400).json({ ok: false, message: "upc required" });

  // Very simple ZPL (Code128). Replace with your shipping label ZPL as needed.
  const zpl = `^XA
^PW600
^FO50,40^A0N,40,40^FDUPC:^FS
^FO50,100^BCN,120,Y,N,N
^FD${upc}^FS
^FO50,240^A0N,30,30^FD${upc}^FS
^XZ`;

  res.json({ ok: true, zpl, copies: Math.max(1, +copies || 1) });
});

export default r;
