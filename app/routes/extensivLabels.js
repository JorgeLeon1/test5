// src/app/routes/extensivLabels.js
import { Router } from "express";
import axios from "axios";
import * as extMod from "../services/extensivClient.js";

const ext = extMod?.default ?? extMod;
const r = Router();
const trimBase = (u) => (u || "").replace(/\/+$/, "");

/* -------------------------- pdf-parse lazy loader -------------------------- */
let __pdfParse;
async function getPdfParse() {
  if (!__pdfParse) {
    const m = await import("pdf-parse/lib/pdf-parse.js");
    __pdfParse = m.default || m;
  }
  return __pdfParse;
}

/* --------------------------------- auth ---------------------------------- */
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
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
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

/* ------------------------------ UPC helpers ------------------------------- */
function upcCandidatesFromText(text) {
  const hits = new Set();
  const m = text.match(/\b\d{12}\b/g) || [];
  m.forEach((raw) => {
    const d = raw.split("").map((c) => +c);
    const sum = (d[0] + d[2] + d[4] + d[6] + d[8] + d[10]) * 3 + (d[1] + d[3] + d[5] + d[7] + d[9]);
    const check = (10 - (sum % 10)) % 10;
    if (check === d[11]) hits.add(raw);
  });
  return [...hits];
}

/* ---------------------- GET attachments for an order ---------------------- */
/** GET /extensiv-labels/orders/:orderId/attachments
 * Tries:
 *   1) /orders/{id}/{segment}  (segment from EXT_ATTACH_SEGMENT or 'attachments'|'documents')
 *   2) HAL discovery on /orders/{id} -> _links that include 'attach' or 'document'
 */
r.get("/orders/:orderId/attachments", async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
    const headers = await authHeadersSafe();

    const segEnv = (process.env.EXT_ATTACH_SEGMENT || "").trim().toLowerCase();
    const segments = segEnv ? [segEnv] : ["attachments", "documents"];

    // 1) Try direct segments without throwing on 404
    for (const seg of segments) {
      const url = `${base}/orders/${encodeURIComponent(orderId)}/${seg}`;
      const resp = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
      if (resp.status >= 200 && resp.status < 300) {
        return res.json({ ok: true, via: "direct", segmentTried: seg, status: resp.status, attachments: resp.data });
      }
      if (resp.status === 401 || resp.status === 403) {
        return res.status(resp.status).json({ ok: false, via: "direct", segmentTried: seg, message: "Unauthorized to view attachments." });
      }
    }

    // 2) HAL discovery on /orders/{id}
    const ordUrl = `${base}/orders/${encodeURIComponent(orderId)}`;
    const ordResp = await axios.get(ordUrl, { headers, timeout: 20000, validateStatus: () => true });
    if (ordResp.status < 200 || ordResp.status >= 300) {
      return res.status(ordResp.status).json({ ok: false, via: "hal-order", message: "Order fetch failed", data: ordResp.data });
    }

    const links = ordResp.data?._links || {};
    // Look for any links whose key or href suggests attachments/documents
    const candKeys = Object.keys(links).filter(
      (k) => /attach|docu/i.test(k) || /attach|docu/i.test(String(links[k]?.href || ""))
    );
    for (const k of candKeys) {
      const href = links[k]?.href;
      if (!href) continue;
      const url = href.startsWith("http") ? href : `${base}/${href.replace(/^\/+/, "")}`;
      const aResp = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
      if (aResp.status >= 200 && aResp.status < 300) {
        return res.json({ ok: true, via: "hal-link", linkKey: k, status: aResp.status, attachments: aResp.data });
      }
    }

    // Nothing worked
    res.status(404).json({
      ok: false,
      message: "No attachments endpoint found for this tenant/order.",
      triedSegments: segments,
      halKeysSeen: Object.keys(links),
    });
  } catch (e) {
    next(e);
  }
});

/* --------------- Fetch a specific attachment and extract UPCs --------------- */
/** GET /extensiv-labels/orders/:orderId/attachments/:attId/upcs */
r.get("/orders/:orderId/attachments/:attId/upcs", async (req, res, next) => {
  try {
    const { orderId, attId } = req.params;
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
    const headers = await authHeadersSafe();

    // Try direct segments first
    const segEnv = (process.env.EXT_ATTACH_SEGMENT || "").trim().toLowerCase();
    const segments = segEnv ? [segEnv] : ["attachments", "documents"];
    let got;

    for (const seg of segments) {
      const url = `${base}/orders/${encodeURIComponent(orderId)}/${seg}/${encodeURIComponent(attId)}`;
      const resp = await axios.get(url, {
        headers: { ...headers, Accept: "application/pdf" },
        responseType: "arraybuffer",
        timeout: 30000,
        validateStatus: () => true,
      });
      if (resp.status >= 200 && resp.status < 300) {
        got = resp;
        break;
      }
      if (resp.status === 401 || resp.status === 403) {
        return res.status(resp.status).json({ ok: false, message: "Unauthorized for attachment.", segmentTried: seg });
      }
    }

    // HAL follow if needed
    if (!got) {
      const ordUrl = `${base}/orders/${encodeURIComponent(orderId)}`;
      const ordResp = await axios.get(ordUrl, { headers, timeout: 20000, validateStatus: () => true });
      if (ordResp.status < 200 || ordResp.status >= 300) {
        return res.status(ordResp.status).json({ ok: false, message: "Order fetch failed", data: ordResp.data });
      }
      const links = ordResp.data?._links || {};
      const candidates = Object.values(links)
        .map((l) => l?.href)
        .filter((h) => /attach|docu/i.test(String(h || "")));

      for (const href of candidates) {
        // Many attachment collections list items; this assumes attId can be appended
        const baseHref = href.startsWith("http") ? href : `${base}/${href.replace(/^\/+/, "")}`;
        const url = `${baseHref.replace(/\/+$/, "")}/${encodeURIComponent(attId)}`;
        const resp = await axios.get(url, {
          headers: { ...headers, Accept: "application/pdf" },
          responseType: "arraybuffer",
          timeout: 30000,
          validateStatus: () => true,
        });
        if (resp.status >= 200 && resp.status < 300) {
          got = resp;
          break;
        }
      }
    }

    if (!got) {
      return res.status(404).json({ ok: false, message: "Attachment not found on any discovered endpoint." });
    }

    const pdfParse = await getPdfParse();
    const parsed = await pdfParse(Buffer.from(got.data));
    const upcs = upcCandidatesFromText(parsed?.text || "");

    res.json({
      ok: true,
      pages: parsed?.numpages ?? null,
      count: upcs.length,
      upcs,
    });
  } catch (e) {
    next(e);
  }
});

/* ---------------------------- Simple ZPL echo ---------------------------- */
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
