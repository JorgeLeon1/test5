// src/app/routes/batchAllocApi.js
import { Router } from "express";
import axios from "axios";
import { getPool, sql } from "../services/db/mssql.js";
import { authHeaders } from "../services/extensivClient.js";

const r = Router();

/* ----------------------- small helpers ----------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const s = (v, max = 255) => (v == null ? "" : String(v).normalize("NFC").slice(0, max));
const ro = (o) => o?.readOnly || o?.ReadOnly || {};

/** Normalize a variety of Extensiv/3PL payload shapes to a first-level array */
function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.ResourceList)) return obj.ResourceList;
  if (Array.isArray(obj?._embedded?.["http://api.3plCentral.com/rels/orders/order"])) {
    return obj._embedded["http://api.3plCentral.com/rels/orders/order"];
  }
  if (Array.isArray(obj?.data)) return obj.data;
  for (const v of Object.values(obj || {})) if (Array.isArray(v)) return v;
  return [];
}

/** Return items/lines from a single order record across shapes */
function itemsFromOrder(ord) {
  const em = ord?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

async function getExistingCols(pool) {
  const q = await pool
    .request()
    .query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')");
  return new Set(q.recordset.map((r) => r.name));
}

/** Upsert a subset of columns if they exist in dbo.OrderDetails */
async function upsertOrderDetail(pool, cols, rec) {
  if (!rec.OrderItemID) return;

  const req = pool.request();
  req.input("OrderItemID", sql.Int, rec.OrderItemID);

  // IMPORTANT:
  // - Keep SKU as string
  // - Make ItemID numeric to match Inventory.ItemID join later
  const defs = [
    ["OrderID", "OrderID", sql.Int, toInt(rec.OrderID, 0)],
    ["CustomerID", "CustomerID", sql.Int, toInt(rec.CustomerID, 0)],
    ["CustomerName", "CustomerName", sql.VarChar(200), s(rec.CustomerName, 200)],
    ["SKU", "SKU", sql.VarChar(150), s(rec.SKU, 150)],
    ["ItemID", "ItemID", sql.Int, toInt(rec.ItemID, 0)],
    ["Qualifier", "Qualifier", sql.VarChar(80), s(rec.Qualifier, 80)],
    ["OrderedQTY", "OrderedQTY", sql.Int, toInt(rec.OrderedQTY, 0)],
    ["UnitID", "UnitID", sql.Int, toInt(rec.UnitID, 0)],
    ["UnitName", "UnitName", sql.VarChar(80), s(rec.UnitName, 80)],
    ["ReferenceNum", "ReferenceNum", sql.VarChar(120), s(rec.ReferenceNum, 120)],
  ];

  const active = defs.filter(([c]) => cols.has(c));
  active.forEach(([c, p, type, val]) => req.input(p, type, val));

  const setClause = active.map(([c, p]) => `${c}=@${p}`).join(", ");
  const insertCols = ["OrderItemID", ...active.map(([c]) => c)].join(", ");
  const insertVals = ["@OrderItemID", ...active.map(([, p]) => `@${p}`)].join(", ");

  const sqlText = `
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails SET ${setClause} WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails (${insertCols}) VALUES (${insertVals});
`;
  await req.query(sqlText);
}

/* ----------------------- GET /api/batch/search -----------------------
Query params (all optional):
  - status=AWAITINGPICK|OPEN|...  (string; mapped to 3PL status codes below; if unknown, skipped)
  - modifiedSince=YYYY-MM-DD (OPTIONAL; only used if explicitly provided)
  - customerId=79
  - referenceLike=PO123   (referenceNum contains)
  - pageSize=100&maxPages=5
NOTE: By default we DO NOT filter by time.
--------------------------------------------------------------------- */
r.get("/search", async (req, res) => {
  try {
    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
    );
    const headers = await authHeaders();

    const pageSize = Math.min(toInt(req.query.pageSize, 100), 500);
    const maxPages = Math.min(toInt(req.query.maxPages, 5), 20);

    // Build RQL (Extensiv RQL syntax)
    const rql = [];
    rql.push("readOnly.fullyAllocated==false"); // only open/unfinished by default

    if (req.query.status) {
      const statusMap = {
        AWAITINGPICK: 0,
        OPEN: 0,
        CLOSED: 9,
        CANCELLED: 5,
      };
      const code = statusMap[String(req.query.status).toUpperCase()];
      if (Number.isFinite(code)) rql.push(`readOnly.status==${code}`);
    }

    if (req.query.customerId) rql.push(`customerIdentifier.id==${toInt(req.query.customerId, 0)}`);
    if (req.query.referenceLike) rql.push(`referenceNum==*${req.query.referenceLike}*`);
    if (req.query.modifiedSince) {
      rql.push(`readOnly.modifiedDateTime>=${encodeURIComponent(req.query.modifiedSince)}`);
    }

    let importedHeaders = 0;
    let upsertedLines = 0;
    const foundOrders = [];

    const pool = await getPool();
    const cols = await getExistingCols(pool);

    for (let pg = 1; pg <= maxPages; pg++) {
      const { data } = await axios.get(`${base}/orders`, {
        headers,
        params: {
          pgsiz: pageSize,
          pgnum: pg,
          detail: "OrderItems",
          itemdetail: "All",
          rql: rql.join(";"),
        },
        timeout: 30000,
        validateStatus: () => true,
      });

      if (!(Array.isArray(data) || data?._embedded || data?.ResourceList)) {
        return res.status(502).json({ ok: false, message: "Unexpected orders payload", data });
      }

      const orders = firstArray(data);
      if (!orders.length) break;
      importedHeaders += orders.length;

      for (const ord of orders) {
        const R = ro(ord);
        const orderId = toInt(R.orderId ?? ord.orderId ?? R.OrderId ?? ord.OrderId, 0);
        const customerId = toInt(ord?.customerIdentifier?.id, 0);
        const customerName = s(ord?.customerIdentifier?.name, 200);
        const referenceNum = s(ord?.referenceNum, 120);

        const lines = itemsFromOrder(ord);
        const lineObjs = [];

        for (const it of lines) {
          const IR = ro(it);
          const orderItemId = toInt(
            IR.orderItemId ?? it.orderItemId ?? IR.OrderItemId ?? it.OrderItemId,
            0
          );
          if (!orderItemId) continue;

          const itemId = toInt(it?.itemIdentifier?.id ?? it?.ItemID ?? 0, 0);
          const sku = s(it?.itemIdentifier?.sku ?? it?.sku ?? it?.SKU ?? "", 150);
          const unitId = toInt(IR?.unitIdentifier?.id, 0);
          const unitName = s(IR?.unitIdentifier?.name ?? "", 80);
          const qualifier = s(it?.qualifier ?? "", 80);
          const qty = toInt(it?.qty ?? it?.orderedQty ?? it?.Qty ?? it?.OrderedQty ?? 0, 0);

          await upsertOrderDetail(pool, cols, {
            OrderItemID: orderItemId,
            OrderID: orderId,
            CustomerID: customerId,
            CustomerName: customerName,
            SKU: sku,
            ItemID: itemId, // numeric to match Inventory.ItemID
            Qualifier: qualifier,
            OrderedQTY: qty,
            UnitID: unitId,
            UnitName: unitName,
            ReferenceNum: referenceNum,
          });
          upsertedLines++;

          lineObjs.push({
            orderItemId,
            itemId,
            sku,
            qty,
            unitId,
            unitName,
            qualifier,
          });
        }

        foundOrders.push({
          orderId,
          customerId,
          customerName,
          referenceNum,
          lineCount: lineObjs.length,
          lines: lineObjs,
        });
      }

      if (orders.length < pageSize) break;
    }

    res.json({ ok: true, importedHeaders, upsertedLines, orders: foundOrders });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ ok: false, message: e.message, data: e.response?.data || null });
  }
});

/* ----------------------- POST /api/batch/search-by-batchid -----------------------
body: { batchId: number, pageSize?: number, maxPages?: number }
Tries multiple RQL field paths for Batch ID and returns diagnostics.
--------------------------------------------------------------------- */
r.post("/search-by-batchid", async (req, res) => {
  try {
    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
    );
    const headers = await authHeaders();

    const batchId = toInt(req.body?.batchId, 0);
    if (!batchId) return res.status(400).json({ ok:false, message:"batchId (number) required" });

    const pageSize = Math.min(toInt(req.body?.pageSize, 250), 500);
    const maxPages = Math.min(toInt(req.body?.maxPages, 10), 20);

    const rqlCandidates = [
      `batchId==${batchId}`,
      `readOnly.batchId==${batchId}`,
      `batchIdentifier.id==${batchId}`,
      `batchIdentifier.batchId==${batchId}`,
      `readOnly.batchIdentifier.id==${batchId}`,
      `readOnly.batchIdentifier.batchId==${batchId}`,
      `batchNumber==${batchId}`,
      `readOnly.batchNumber==${batchId}`,
      `batch.id==${batchId}`,
      `readOnly.batch.id==${batchId}`,
      `readOnly.batchIdentifier.number==${batchId}`,
      `batchIdentifier.number==${batchId}`,
    ];

    const pool = await getPool();
    const cols = await getExistingCols(pool);

    const tried = [];
    let usedRql = null;
    let importedHeaders = 0;
    let upsertedLines = 0;
    const foundOrders = [];

    async function ingestOrders(orders) {
      for (const ord of orders) {
        const R = ro(ord);
        const orderId     = toInt(R.orderId ?? ord.orderId ?? R.OrderId ?? ord.OrderId, 0);
        const customerId  = toInt(ord?.customerIdentifier?.id, 0);
        const customerName= s(ord?.customerIdentifier?.name, 200);
        const referenceNum= s(ord?.referenceNum, 120);

        const lines = itemsFromOrder(ord) || [];
        const lineObjs = [];

        for (const it of lines) {
          const IR = ro(it);
          const orderItemId = toInt(IR.orderItemId ?? it.orderItemId ?? IR.OrderItemId ?? it.OrderItemId, 0);
          if (!orderItemId) continue;

          const itemId   = toInt(it?.itemIdentifier?.id ?? it?.ItemID ?? 0, 0);
          const sku      = s(it?.itemIdentifier?.sku ?? it?.sku ?? it?.SKU ?? "", 150);
          const unitId   = toInt(IR?.unitIdentifier?.id, 0);
          const unitName = s(IR?.unitIdentifier?.name ?? "", 80);
          const qualifier= s(it?.qualifier ?? "", 80);
          const qty      = toInt(it?.qty ?? it?.orderedQty ?? it?.Qty ?? it?.OrderedQty ?? 0, 0);

          await upsertOrderDetail(pool, cols, {
            OrderItemID: orderItemId,
            OrderID: orderId,
            CustomerID: customerId,
            CustomerName: customerName,
            SKU: sku,
            ItemID: itemId,
            Qualifier: qualifier,
            OrderedQTY: qty,
            UnitID: unitId,
            UnitName: unitName,
            ReferenceNum: referenceNum,
          });
          upsertedLines++;

          lineObjs.push({ orderItemId, itemId, sku, qty, unitId, unitName, qualifier });
        }

        foundOrders.push({
          orderId, customerId, customerName, referenceNum,
          lineCount: lineObjs.length,
          lines: lineObjs,
        });
      }
    }

    for (const rql of rqlCandidates) {
      let gotAny = false;
      let lastStatus = 0;

      for (let pg = 1; pg <= maxPages; pg++) {
        const { data, status } = await axios.get(`${base}/orders`, {
          headers,
          params: { pgsiz: pageSize, pgnum: pg, detail: "OrderItems", itemdetail: "All", rql },
          timeout: 30000,
          validateStatus: () => true,
        });
        lastStatus = status;

        if (!tried.length || tried[tried.length - 1].rql !== rql) {
          const sampleKeys = data && typeof data === "object" ? Object.keys(data).slice(0, 10) : [];
          tried.push({ rql, status: lastStatus, sampleKeys });
        }

        if (!(status >= 200 && status < 300)) break;

        const orders = firstArray(data);
        if (!orders.length) break;

        if (!usedRql) usedRql = rql;
        gotAny = true;
        importedHeaders += orders.length;
        await ingestOrders(orders);

        if (orders.length < pageSize) break; // last page for this RQL
      }

      if (gotAny) break;  // stop after the first working RQL
    }

    return res.json({
      ok: true,
      usedRql,
      importedHeaders,
      upsertedLines,
      orders: foundOrders,
      diagnostics: { tried }
    });
  } catch (e) {
    return res
      .status(e.status || 500)
      .json({ ok:false, message: e.message, data: e.response?.data || null });
  }
});

/* ----------------------- POST /api/batch/allocate -----------------------
body: { orderIds: number[] }
----------------------------------------------------------------------- */
r.post("/allocate", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    if (!orderIds.length) {
      return res.status(400).json({ ok: false, message: "orderIds required" });
    }

    const pool = await getPool();

    // Resolve line IDs
    const idQuery = await pool.request().query(`
      SELECT OrderItemID
      FROM OrderDetails
      WHERE OrderID IN (${orderIds.join(",")})
    `);
    const lineIds = idQuery.recordset.map(r => r.OrderItemID);
    if (!lineIds.length) {
      return res.json({ ok: true, allocated: 0, summary: [] });
    }

    // Clear existing allocations
    await pool.request().query(`
      DELETE SuggAlloc WHERE OrderItemID IN (${lineIds.join(",")});
    `);

    // Allocation loop with safe TRY_CONVERT
    await pool.request().batch(`
DECLARE @iters INT = 0;
DECLARE @maxIters INT = 20000;

WHILE (1=1)
BEGIN
  ;WITH odx AS (
    SELECT
      od.OrderItemID,
      od.OrderedQTY,
      od.SKU,
      od.Qualifier,
      TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(CAST(od.ItemID AS VARCHAR(64)))), '')) AS ItemIDNum
    FROM OrderDetails od
    WHERE od.OrderItemID IN (${lineIds.join(",")})
  ),
  x AS (
    SELECT
      o.OrderItemID,
      o.OrderedQTY,
      ISNULL(sa.SumSuggAllocQty,0) AS SumSuggAllocQty,
      (o.OrderedQTY - ISNULL(sa.SumSuggAllocQty,0)) AS RemainingOpenQty,
      o.SKU,
      o.Qualifier,
      o.ItemIDNum
    FROM odx o
    LEFT JOIN (
      SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc GROUP BY OrderItemID
    ) sa ON sa.OrderItemID = o.OrderItemID
  ),
  cand_itemid AS (
    SELECT
      x.OrderItemID,
      x.OrderedQTY,
      x.RemainingOpenQty,
      inv.ReceiveItemID,
      inv.AvailableQTY,
      inv.ReceivedQty,
      inv.LocationName,
      1 AS Priority
    FROM x
    JOIN Inventory inv
      ON inv.ItemID = x.ItemIDNum
     AND (inv.Qualifier = x.Qualifier OR (inv.Qualifier IS NULL AND x.Qualifier IS NULL))
    WHERE x.RemainingOpenQty > 0
      AND x.ItemIDNum IS NOT NULL
      AND inv.AvailableQTY > 0
  ),
  cand_sku AS (
    SELECT
      x.OrderItemID,
      x.OrderedQTY,
      x.RemainingOpenQty,
      inv.ReceiveItemID,
      inv.AvailableQTY,
      inv.ReceivedQty,
      inv.LocationName,
      2 AS Priority
    FROM x
    JOIN Inventory inv
      ON inv.SKU = x.SKU
     AND (inv.Qualifier = x.Qualifier OR (inv.Qualifier IS NULL AND x.Qualifier IS NULL))
    WHERE x.RemainingOpenQty > 0
      AND x.ItemIDNum IS NULL
      AND inv.AvailableQTY > 0
  ),
  cand AS (
    SELECT * FROM cand_itemid
    UNION ALL
    SELECT * FROM cand_sku
  ),
  pick AS (
    SELECT TOP (1)
      c.OrderItemID,
      c.ReceiveItemID,
      CASE WHEN c.RemainingOpenQty >= c.AvailableQTY THEN c.AvailableQTY ELSE c.RemainingOpenQty END AS AllocQty,
      c.Priority
    FROM cand c
    ORDER BY c.OrderItemID, c.Priority ASC
  )
  INSERT INTO SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT OrderItemID, ReceiveItemID, AllocQty FROM pick;

  IF @@ROWCOUNT = 0 BREAK;
  SET @iters += 1;
  IF @iters >= @maxIters BREAK;

  IF NOT EXISTS (
    SELECT 1
    FROM x
    OUTER APPLY (
      SELECT SUM(ISNULL(sa.SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc sa WHERE sa.OrderItemID = x.OrderItemID
    ) z
    WHERE (x.OrderedQTY - ISNULL(z.SumSuggAllocQty,0)) > 0
  )
    BREAK;
END;
    `);

    // Summarize
    const summary = await pool.request().query(`
      SELECT od.OrderID, od.OrderItemID, od.SKU, od.OrderedQTY,
             ISNULL(x.Alloc,0) AS Allocated,
             (od.OrderedQTY - ISNULL(x.Alloc,0)) AS Remaining
      FROM OrderDetails od
      LEFT JOIN (
        SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS Alloc
        FROM SuggAlloc GROUP BY OrderItemID
      ) x ON x.OrderItemID = od.OrderItemID
      WHERE od.OrderItemID IN (${lineIds.join(",")})
      ORDER BY od.OrderID, od.OrderItemID;
    `);

    res.json({ ok: true, allocated: summary.recordset.length, summary: summary.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});



/* ----------------------- POST /api/batch/push -----------------------
body: { orderIds: number[], forceMethod?: "auto"|"put"|"post" }
Pushes SuggAlloc per order to Extensiv /orders/{id}/allocator, with PUT/POST control.
------------------------------------------------------------------- */
r.post("/push", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    if (!orderIds.length) {
      return res.status(400).json({ ok: false, message: "orderIds required" });
    }

    // NEW: optional forceMethod from client: 'auto' | 'put' | 'post'
    const forceMethod = String(req.body?.forceMethod || "auto").toLowerCase();
    const isValidMethod = (m) => m === "auto" || m === "put" || m === "post";

    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
    );
    const headers = await authHeaders();
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    headers["Accept"] = headers["Accept"] || "application/json";

    const pool = await getPool();
    const results = [];

    for (const oid of orderIds) {
      const allocs = await pool
        .request()
        .input("OrderID", sql.Int, oid)
        .query(`
          SELECT OrderItemID, ReceiveItemID, SuggAllocQty
          FROM SuggAlloc
          WHERE OrderItemID IN (SELECT OrderItemID FROM OrderDetails WHERE OrderID=@OrderID)
            AND ISNULL(SuggAllocQty,0) > 0
        `);

      const payload = {
        allocations: allocs.recordset.map((a) => ({
          orderItemId: a.OrderItemID,
          receiveItemId: a.ReceiveItemID,
          qty: a.SuggAllocQty,
        })),
      };

      if (payload.allocations.length === 0) {
        results.push({
          orderId: oid,
          ok: false,
          status: 204,
          reason: "No allocations to push (SuggAlloc empty)",
          sentAllocations: 0,
        });
        continue;
      }

      const sendAllocator = async (method) => {
        const url = `${base}/orders/${oid}/allocator`;
        const resp = await axios({
          url,
          method,
          headers,
          data: payload,
          timeout: 30000,
          validateStatus: () => true,
        });
        let body = resp.data;
        let summary = "";
        if (body && typeof body === "object") {
          const keys = Object.keys(body).slice(0, 6).join(", ");
          summary = `keys: ${keys}`;
          if (Array.isArray(body.errors) && body.errors.length) {
            summary += `; errors: ${body.errors.length}`;
          }
          if (Array.isArray(body.warnings) && body.warnings.length) {
            summary += `; warnings: ${body.warnings.length}`;
          }
        } else if (typeof body === "string") {
          summary = body.slice(0, 140);
        }
        return { status: resp.status, summary, raw: body };
      };

      let attempt;
      if (isValidMethod(forceMethod) && forceMethod !== "auto") {
        // Force single method
        attempt = await sendAllocator(forceMethod);
      } else {
        // Auto: try PUT → fallback POST on method mismatch
        attempt = await sendAllocator("put");
        if ([404, 405, 501].includes(attempt.status)) {
          const fallback = await sendAllocator("post");
          if (fallback.status >= 200 && fallback.status < 300) {
            attempt = { ...fallback, triedFallback: true, primaryStatus: attempt.status };
          } else {
            attempt = { ...attempt, fallbackStatus: fallback.status, fallbackSummary: fallback.summary };
          }
        }
      }

      const ok = attempt.status >= 200 && attempt.status < 300;
      const noOp =
        ok &&
        (attempt.status === 204 ||
          attempt.summary === "" ||
          attempt.summary?.toLowerCase?.().includes("no change") ||
          attempt.summary?.toLowerCase?.().includes("no allocations"));

      results.push({
        orderId: oid,
        ok: ok && !noOp,
        status: attempt.status,
        triedFallback: attempt.triedFallback || false,
        primaryStatus: attempt.primaryStatus,
        forcedMethod: (forceMethod !== "auto") ? forceMethod : undefined,
        sentAllocations: payload.allocations.length,
        responseSummary: attempt.summary,
        // responseBody: attempt.raw, // uncomment if you want the full payload
      });
    }

    const anyReal = results.some(r => r.ok === true);
    const hint = anyReal ? null : "No effective changes detected. Check SuggAlloc rows and method (PUT vs POST) for your tenant.";

    res.json({ ok: true, results, hint });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message,
      data: e.response?.data || null,
    });
  }
});

export default r;
