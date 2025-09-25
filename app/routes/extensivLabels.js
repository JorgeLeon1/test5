// src/app/routes/extensivLabels.js
import { Router } from "express";
import axios from "axios";
import * as extMod from "../services/extensivClient.js";

// normalize imports (support named or default)
const ext = extMod?.default ?? extMod;

const r = Router();
const trimBase = (u) => (u || "").replace(/\/+$/, "");

/* --------------------------- pdf-parse safe loader --------------------------- */
// Avoid importing package root (some versions read a test PDF at import time).
let __pdfParse;
async function getPdfParse() {
  if (!__pdfParse) {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    __pdfParse = mod.default || mod;
  }
  return __pdfParse;
}

/* --------------------------------- helpers --------------------------------- */
async function authHeadersSafe() {
  if (typeof ext.authHeaders === "function") return await ext.authHeaders();

  const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
  if (b64) {
    return {
      Authorization: `Basic ${b64}`,
      Accept: "application/hal+json, application/json",
      "Content-Type": "application/hal+json; charset=utf-8",
    };
  }
  const tokenUrl = process.env.EXT_TOKEN_URL;
  if (tokenUrl) {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    if (process.env.EXT_USER_LOGIN) form.set("user_login", process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID) form.set("user_login_id", process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID) form.set("tplguid", process.env.EXT_TPL_GUID);

    const basic = process.env.EXT_BASIC_AUTH_B64 ? `Basic ${process.env.EXT_BASIC_AUTH_B64}` : "";
    const resp = await axios.post(tokenUrl, form, {
      headers: {
        Authorization: basic,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (resp.status >= 200 && resp.status < 300 && resp.data?.access_token) {
      return {
        Authorization: `Bearer ${resp.data.access_token}`,
        Accept: "application/hal+json, application/json",
        "Content-Type": "application/hal+json; charset=utf-8",
      };
    }
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

/* ---------------------- attachments list for an order ---------------------- */
// GET /extensiv-labels/orders/:orderId/attachments
r.get("/orders/:orderId/attachments", async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
    );
    const headers = await authHeadersSafe();

    // Try common attachment paths; fall back to HAL discover
    const candidates = [
      `${base}/orders/${encodeURIComponent(orderId)}/attachments`,
      `${base}/orders/${encodeURIComponent(orderId)}/documents`,
    ];

    let resp, lastErr;
    for (const url of candidates) {
      try {
        resp = await axios.get(url, { headers, timeout: 20000, validateStatus: s => s >= 200 && s < 300 });
        if (resp) break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!resp) {
      // discover via order GET (HAL) if available
      const ord = await axios.get(`${base}/orders`, {
        headers,
        params: { pgsiz: 1, pgnum: 1, rql: `readOnly.orderId==${encodeURIComponent(orderId)}` },
        timeout: 20000,
        validateStatus: () => true,
      });
      const embedded = ord.data?._embedded || {};
      const list =
        embedded["http://api.3plCentral.com/rels/orders/order"] ||
        embedded.orders ||
        ord.data?.ResourceList ||
        [];
      const one = Array.isArray(list) ? list[0] : null;
      const links = one?._links || {};
      const attHref =
        links.attachments?.href ||
        links.documents?.href ||
        null;

      if (!attHref) throw lastErr || new Error("Attachments endpoint not found for this tenant.");
      resp = await axios.get(attHref, { headers, timeout: 20000 });
    }

    res.json({ ok: true, status: resp.status, attachments: resp.data });
  } catch (e) {
    next(e);
  }
});

/* -------------------- fetch one attachment and extract UPCs -------------------- */
// GET /extensiv-labels/orders/:orderId/attachments/:attId/upcs
r.get("/orders/:orderId/attachments/:attId/upcs", async (req, res, next) => {
  try {
    const { orderId, attId } = req.params;
    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
    );
    const headers = await authHeadersSafe();

    const url = `${base}/orders/${encodeURIComponent(orderId)}/attachments/${encodeURIComponent(attId)}`;

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
      });
    }

    const pdf = await getPdfParse();
    const parsed = await pdf(Buffer.from(resp.data)); // vector text only (no OCR)
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

/* ------------------------ quick ZPL generator route ------------------------ */
// POST /extensiv-labels/print/zpl  { upc, copies? }
r.post("/print/zpl", async (req, res) => {
  const { upc, copies = 1 } = req.body || {};
  if (!upc) return res.status(400).json({ ok: false, message: "upc required" });

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
