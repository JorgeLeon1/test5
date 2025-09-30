// src/app/routes/batchAllocApi.js
import { Router } from "express";
import axios from "axios";
import { getPool, sql } from "../services/db/mssql.js";
import { authHeaders } from "../services/extensivClient.js";

const r = Router();

/* ─────────────────────────── helpers ─────────────────────────── */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const s = (v, max = 255) => (v == null ? "" : String(v).normalize("NFC").slice(0, max));
const ro = (o) => o?.readOnly || o?.ReadOnly || {};

async function getBaseAndAuth() {
  const base = trimBase(
    process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
  );
  const headers = await authHeaders();
  headers["Accept"] = headers["Accept"] || "application/json";
  return { base, headers };
}

// Normalize any list-ish payload into an array of orders
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

function itemsFromOrder(ord) {
  const em = ord?._embedded;
  if (Array.isArray(em?.["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

function extractItemIdAndSku(it) {
  const idNum = toInt(
    it?.itemIdentifier?.id ??
      it?.ItemIdentifier?.Id ??
      it?.itemIdentifierId ??
      it?.ItemId,
    0
  );
  const itemId = idNum ? String(idNum) : "";

  const sku = s(
    it?.itemIdentifier?.sku ??
      it?.ItemIdentifier?.Sku ??
      it?.sku ??
      it?.SKU ??
      it?.itemIdentifier?.nameKey?.name ??
      it?.itemIdentifier?.name ??
      "",
    150
  );

  return { itemId, sku };
}

async function getExistingCols(pool) {
  const q = await pool
    .request()
    .query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')");
  return new Set(q.recordset.map((r) => r.name));
}

async function upsertOrderDetail(pool, cols, rec) {
  if (!rec.OrderItemID) return;

  const req = pool.request();
  req.input("OrderItemID", sql.Int, rec.OrderItemID);

  const defs = [
    ["OrderID", "OrderID", sql.Int, toInt(rec.OrderID, 0)],
    ["CustomerID", "CustomerID", sql.Int, toInt(rec.CustomerID, 0)],
    ["CustomerName", "CustomerName", sql.VarChar(200), s(rec.CustomerName, 200)],
    ["SKU", "SKU", sql.VarChar(150), s(rec.SKU, 150)],
    // ItemID as VARCHAR (not int)
    ["ItemID", "ItemID", sql.VarChar(150), s(rec.ItemID, 150)],
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

  await req.query(`
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails SET ${setClause} WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails (${insertCols}) VALUES (${insertVals});
  `);
}

async function fetchOrderById(orderId) {
  const { base, headers } = await getBaseAndAuth();
  const { data, status } = await axios.get(`${base}/orders/${orderId}`, {
    headers,
    params: { detail: "OrderItems", itemdetail: "All" },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (status >= 200 && status < 300) return data;
  const msg = (data && (data.message || data.error)) || `Extensiv returned ${status}`;
  const e = new Error(msg);
  e.status = status;
  e.data = data;
  throw e;
}

async function ingestOrdersIntoDB(orders) {
  const pool = await getPool();
  const cols = await getExistingCols(pool);

  let upsertedLines = 0;
  const foundOrders = [];

  for (const ord of orders) {
    const R = ro(ord);
    const orderId = toInt(R.orderId ?? ord.orderId ?? R.OrderId ?? ord.OrderId, 0);
    const customerId = toInt(ord?.customerIdentifier?.id, 0);
    const customerName = s(ord?.customerIdentifier?.name, 200);
    const referenceNum = s(ord?.referenceNum, 120);

    const lineObjs = [];
    for (const it of itemsFromOrder(ord)) {
      const IR = ro(it);
      const orderItemId = toInt(
        IR.orderItemId ?? it.orderItemId ?? IR.OrderItemId ?? it.OrderItemId ?? it.id,
        0
      );
      if (!orderItemId) continue;

      const { itemId, sku } = extractItemIdAndSku(it);
      const unitId = toInt(IR?.unitIdentifier?.id ?? IR?.UnitIdentifier?.Id, 0);
      const unitName = s(IR?.unitIdentifier?.name ?? IR?.UnitIdentifier?.Name ?? "", 80);
      const qualifier = s(it?.qualifier ?? it?.Qualifier ?? "", 80);
      const qty = toInt(it?.qty ?? it?.orderedQty ?? it?.Qty ?? it?.OrderedQty ?? 0, 0);

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
      orderId,
      customerId,
      customerName,
      referenceNum,
      lineCount: lineObjs.length,
      lines: lineObjs,
    });
  }

  return { upsertedLines, orders: foundOrders };
}

/* ─────────────────────────── routes ─────────────────────────── */

// health
r.get("/ping", (_req, res) => res.json({ ok: true, where: "batch-alloc" }));

/**
 * POST /api/batch-alloc/search-by-batchid
 * body: { batchId: number, pageSize?: number, maxPages?: number }
 */
r.post("/search-by-batchid", async (req, res) => {
  try {
    const batchId = toInt(req.body?.batchId, 0);
    if (!batchId) return res.status(400).json({ ok: false, message: "batchId required" });

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

    const { base, headers } = await getBaseAndAuth();

    let importedHeaders = 0;
    let upsertedLines = 0;
    const foundOrders = [];
    const tried = [];
    let usedRql = null;

    for (const rql of rqlCandidates) {
      let gotAny = false;

      for (let pg = 1; pg <= maxPages; pg++) {
        const { data, status } = await axios.get(`${base}/orders`, {
          headers,
          params: { pgsiz: pageSize, pgnum: pg, detail: "OrderItems", itemdetail: "All", rql },
          timeout: 30000,
          validateStatus: () => true,
        });

        if (!tried.length || tried[tried.length - 1].rql !== rql) {
          const sampleKeys = data && typeof data === "object" ? Object.keys(data).slice(0, 10) : [];
          tried.push({ rql, status, sampleKeys });
        }
        if (!(status >= 200 && status < 300)) break;

        const orders = firstArray(data);
        if (!orders.length) break;

        if (!usedRql) usedRql = rql;
        gotAny = true;
        importedHeaders += orders.length;

        const ing = await ingestOrdersIntoDB(orders);
        upsertedLines += ing.upsertedLines;
        foundOrders.push(...ing.orders);

        if (orders.length < pageSize) break;
      }

      if (gotAny) break;
    }

    res.json({ ok: true, usedRql, importedHeaders, upsertedLines, orders: foundOrders, diagnostics: { tried } });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, message: e.message, data: e.response?.data || null });
  }
});

/**
 * POST /api/batch-alloc/search-by-ids
 * body: { orderIds: number[] }
 * (Lightweight: reads existing lines from DB)
 */
r.post("/search-by-ids", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    if (!orderIds.length) return res.status(400).json({ ok: false, message: "orderIds required" });

    const pool = await getPool();
    const rows = await pool.request().query(`
      SELECT OrderID, OrderItemID, SKU, CustomerName, ReferenceNum
      FROM OrderDetails
      WHERE OrderID IN (${orderIds.join(",")});
    `);

    const grouped = new Map();
    for (const r of rows.recordset) {
      if (!grouped.has(r.OrderID)) {
        grouped.set(r.OrderID, {
          orderId: r.OrderID,
          customerName: r.CustomerName,
          referenceNum: r.ReferenceNum,
          lineCount: 0,
          lines: [],
        });
      }
      const g = grouped.get(r.OrderID);
      g.lines.push({ OrderItemID: r.OrderItemID, SKU: r.SKU });
      g.lineCount++;
    }

    res.json({ ok: true, orders: Array.from(grouped.values()) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/batch-alloc/allocate
 * body: { orderIds: number[], scope?: "selected"|"global", autoIngest?: boolean }
 * - Greedy allocator with tiers:
 *   T1a: numeric ItemID + Qual
 *   T1b: string  ItemID + Qual
 *   T2 : SKU + Qual
 *   T3 : SKU only (if T1/T2 had no options)
 * - If autoIngest is true and no lines exist, fetch each order live and ingest.
 */
r.post("/allocate", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    if (!orderIds.length) return res.status(400).json({ ok: false, message: "orderIds required" });

    const scope = String(req.body?.scope || "selected").toLowerCase() === "global" ? "global" : "selected";
    const autoIngest = Boolean(req.body?.autoIngest);

    const pool = await getPool();

    // ensure lines are present if requested
    const pre = await pool.request().query(`
      SELECT TOP 1 1 FROM OrderDetails WHERE OrderID IN (${orderIds.join(",")});
    `);
    if (autoIngest && pre.recordset.length === 0) {
      const fetched = [];
      for (const oid of orderIds) {
        try { fetched.push(await fetchOrderById(oid)); } catch {}
      }
      const ing = await ingestOrdersIntoDB(fetched);
      // proceed regardless; allocator will no-op if still empty
    }

    const sel = await pool.request().query(`
      SELECT OrderItemID
      FROM OrderDetails
      WHERE OrderID IN (${orderIds.join(",")});
    `);
    const lineIds = sel.recordset.map((r) => r.OrderItemID);
    if (!lineIds.length) return res.json({ ok: true, scope, allocated: 0, summary: [] });

    await pool.request().query(`DELETE SuggAlloc WHERE OrderItemID IN (${lineIds.join(",")});`);
    const lineIdCsv = lineIds.join(",");

    await pool.request().batch(`
DECLARE @iters INT = 0;
DECLARE @maxIters INT = 20000;

WHILE (1=1)
BEGIN
  ;WITH
  sa_recv AS (
    SELECT ReceiveItemID, SUM(ISNULL(SuggAllocQty,0)) AS AllocOnReceive
    FROM SuggAlloc
    ${scope === "global" ? "" : `WHERE OrderItemID IN (${lineIdCsv})`}
    GROUP BY ReceiveItemID
  ),
  odx AS (
    SELECT
      od.OrderItemID,
      od.OrderedQTY,
      UPPER(LTRIM(RTRIM(od.SKU)))                          AS SKU_N,
      NULLIF(UPPER(LTRIM(RTRIM(od.Qualifier))),'')         AS Qual_N,
      UPPER(LTRIM(RTRIM(CAST(od.ItemID AS VARCHAR(128))))) AS ItemIDStr,
      TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(CAST(od.ItemID AS VARCHAR(64)))), '')) AS ItemIDNum
    FROM OrderDetails od
    WHERE od.OrderItemID IN (${lineIdCsv})
  ),
  x AS (
    SELECT
      o.OrderItemID,
      o.OrderedQTY,
      o.SKU_N,
      o.Qual_N,
      o.ItemIDStr,
      o.ItemIDNum,
      ISNULL(sa.SumSuggAllocQty,0) AS SumSuggAllocQty,
      (o.OrderedQTY - ISNULL(sa.SumSuggAllocQty,0)) AS RemainingOpenQty
    FROM odx o
    LEFT JOIN (
      SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc GROUP BY OrderItemID
    ) sa ON sa.OrderItemID = o.OrderItemID
  ),
  invx AS (
    SELECT
      inv.receiveItemID,
      UPPER(LTRIM(RTRIM(CAST(inv.ItemID AS VARCHAR(128))))) AS ItemIDStr,
      TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(CAST(inv.ItemID AS VARCHAR(64)))), '')) AS ItemIDNum,
      UPPER(LTRIM(RTRIM(inv.SKU)))                          AS SKU_N,
      NULLIF(UPPER(LTRIM(RTRIM(inv.Qualifier))),'')         AS Qual_N,
      inv.LocationName,
      inv.ReceivedQty,
      inv.AvailableQTY,
      (inv.AvailableQTY - ISNULL(sr.AllocOnReceive,0)) AS RemainingAvailable
    FROM Inventory inv
    LEFT JOIN sa_recv sr ON sr.ReceiveItemID = inv.ReceiveItemID
  ),

  cand_t1a AS (
    SELECT x.OrderItemID, x.RemainingOpenQty, ivx.ReceiveItemID, ivx.RemainingAvailable, 1 AS Priority
    FROM x JOIN invx ivx
      ON ivx.ItemIDNum IS NOT NULL AND x.ItemIDNum IS NOT NULL
     AND ivx.ItemIDNum = x.ItemIDNum
     AND ((ivx.Qual_N = x.Qual_N) OR (ivx.Qual_N IS NULL AND x.Qual_N IS NULL))
    WHERE x.RemainingOpenQty > 0 AND ISNULL(ivx.RemainingAvailable,0) > 0
  ),

  cand_t1b AS (
    SELECT x.OrderItemID, x.RemainingOpenQty, ivx.ReceiveItemID, ivx.RemainingAvailable, 1 AS Priority
    FROM x JOIN invx ivx
      ON (x.ItemIDNum IS NULL OR ivx.ItemIDNum IS NULL)
     AND x.ItemIDStr IS NOT NULL AND x.ItemIDStr <> ''
     AND ivx.ItemIDStr = x.ItemIDStr
     AND ((ivx.Qual_N = x.Qual_N) OR (ivx.Qual_N IS NULL AND x.Qual_N IS NULL))
    WHERE x.RemainingOpenQty > 0 AND ISNULL(ivx.RemainingAvailable,0) > 0
  ),

  cand_t2 AS (
    SELECT x.OrderItemID, x.RemainingOpenQty, ivx.ReceiveItemID, ivx.RemainingAvailable, 2 AS Priority
    FROM x JOIN invx ivx
      ON ivx.SKU_N = x.SKU_N
     AND ((ivx.Qual_N = x.Qual_N) OR (ivx.Qual_N IS NULL AND x.Qual_N IS NULL))
    WHERE x.RemainingOpenQty > 0 AND ISNULL(ivx.RemainingAvailable,0) > 0
  ),

  cand_t3 AS (
    SELECT x.OrderItemID, x.RemainingOpenQty, ivx.ReceiveItemID, ivx.RemainingAvailable, 3 AS Priority
    FROM x JOIN invx ivx
      ON ivx.SKU_N = x.SKU_N
    WHERE x.RemainingOpenQty > 0
      AND ISNULL(ivx.RemainingAvailable,0) > 0
      AND NOT EXISTS (SELECT 1 FROM cand_t1a t WHERE t.OrderItemID = x.OrderItemID)
      AND NOT EXISTS (SELECT 1 FROM cand_t1b t WHERE t.OrderItemID = x.OrderItemID)
      AND NOT EXISTS (SELECT 1 FROM cand_t2  t WHERE t.OrderItemID = x.OrderItemID)
  ),

  cand AS (
    SELECT * FROM cand_t1a
    UNION ALL SELECT * FROM cand_t1b
    UNION ALL SELECT * FROM cand_t2
    UNION ALL SELECT * FROM cand_t3
  ),

  pick AS (
    SELECT TOP (1)
      c.OrderItemID,
      c.ReceiveItemID,
      CASE WHEN c.RemainingOpenQty >= c.RemainingAvailable
           THEN c.RemainingAvailable ELSE c.RemainingOpenQty END AS AllocQty,
      c.Priority
    FROM cand c
    ORDER BY c.OrderItemID, c.Priority ASC, c.RemainingAvailable DESC
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
  ) BREAK;
END;
    `);

    const summary = await pool.request().query(`
      SELECT od.OrderID, od.OrderItemID, od.SKU, od.OrderedQTY,
             ISNULL(x.Alloc,0) AS Allocated,
             (od.OrderedQTY - ISNULL(x.Alloc,0)) AS Remaining
      FROM OrderDetails od
      LEFT JOIN (
        SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS Alloc
        FROM SuggAlloc GROUP BY OrderItemID
      ) x ON x.OrderItemID = od.OrderItemID
      WHERE od.OrderItemID IN (${lineIdCsv})
      ORDER BY od.OrderID, od.OrderItemID;
    `);

    res.json({ ok: true, scope, allocated: summary.recordset.length, summary: summary.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/batch-alloc/inventory-debug
 * body: { orderIds: number[] }
 */
r.post("/inventory-debug", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    if (!orderIds.length) return res.status(400).json({ ok: false, message: "orderIds required" });

    const pool = await getPool();
    const data = await pool.request().query(`
      ;WITH odx AS (
        SELECT
          od.OrderID,
          od.OrderItemID,
          od.OrderedQTY,
          UPPER(LTRIM(RTRIM(od.SKU))) AS SKU_N,
          NULLIF(UPPER(LTRIM(RTRIM(od.Qualifier))),'') AS Qual_N,
          UPPER(LTRIM(RTRIM(CAST(od.ItemID AS VARCHAR(128))))) AS ItemIDStr,
          TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(CAST(od.ItemID AS VARCHAR(64)))), '')) AS ItemIDNum
        FROM OrderDetails od
        WHERE od.OrderID IN (${orderIds.join(",")})
      ),
      invx AS (
        SELECT
          inv.ReceiveItemID,
          UPPER(LTRIM(RTRIM(CAST(inv.ItemID AS VARCHAR(128))))) AS ItemIDStr,
          TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(CAST(inv.ItemID AS VARCHAR(64)))), '')) AS ItemIDNum,
          UPPER(LTRIM(RTRIM(inv.SKU))) AS SKU_N,
          NULLIF(UPPER(LTRIM(RTRIM(inv.Qualifier))),'') AS Qual_N,
          inv.AvailableQTY,
          (inv.AvailableQTY - ISNULL(sa.AllocOnReceive,0)) AS RemainingAvailable
        FROM Inventory inv
        LEFT JOIN (
          SELECT ReceiveItemID, SUM(ISNULL(SuggAllocQty,0)) AS AllocOnReceive
          FROM SuggAlloc GROUP BY ReceiveItemID
        ) sa ON sa.ReceiveItemID = inv.ReceiveItemID
      )
      SELECT
        o.OrderID,
        o.OrderItemID,
        o.SKU_N,
        o.Qual_N,
        o.OrderedQTY,
        (SELECT COUNT(*) FROM invx i WHERE i.ItemIDNum = o.ItemIDNum AND ((i.Qual_N = o.Qual_N) OR (i.Qual_N IS NULL AND o.Qual_N IS NULL)) AND ISNULL(i.RemainingAvailable,0) > 0) AS T1a_NumItem_Qual,
        (SELECT COUNT(*) FROM invx i WHERE i.ItemIDStr = o.ItemIDStr AND ((i.Qual_N = o.Qual_N) OR (i.Qual_N IS NULL AND o.Qual_N IS NULL)) AND ISNULL(i.RemainingAvailable,0) > 0) AS T1b_StrItem_Qual,
        (SELECT COUNT(*) FROM invx i WHERE i.SKU_N    = o.SKU_N   AND ((i.Qual_N = o.Qual_N) OR (i.Qual_N IS NULL AND o.Qual_N IS NULL)) AND ISNULL(i.RemainingAvailable,0) > 0) AS T2_Sku_Qual,
        (SELECT COUNT(*) FROM invx i WHERE i.SKU_N    = o.SKU_N   AND ISNULL(i.RemainingAvailable,0) > 0) AS T3_Sku_AnyQual
      FROM odx o
      ORDER BY o.OrderID, o.OrderItemID;
    `);

    res.json({ ok: true, lines: data.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/batch-alloc/push
 * body: { orderIds: number[], forceMethod?: "auto"|"put"|"post" }
 * - PUT with If-Match ETag; fallback to POST if needed (404/405/501).
 */
r.post("/push", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    if (!orderIds.length) return res.status(400).json({ ok: false, message: "orderIds required" });

    const forceMethod = String(req.body?.forceMethod || "auto").toLowerCase();
    const isValidMethod = (m) => m === "auto" || m === "put" || m === "post";

    const { base, headers } = await getBaseAndAuth();
    headers["Content-Type"] = headers["Content-Type"] || "application/json";

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
            AND ISNULL(SuggAllocQty,0) > 0;
        `);

      const payload = {
        allocations: allocs.recordset.map((a) => ({
          orderItemId: a.OrderItemID,
          receiveItemId: a.ReceiveItemID,
          qty: a.SuggAllocQty,
        })),
      };

      if (payload.allocations.length === 0) {
        results.push({ orderId: oid, ok: false, status: 204, reason: "No allocations to push", sentAllocations: 0 });
        continue;
      }

      // get ETag
      const pre = await axios.get(`${base}/orders/${oid}`, {
        headers,
        timeout: 20000,
        validateStatus: () => true,
      });
      const etag = pre.headers?.etag || pre.headers?.ETag;
      const pushHeaders = { ...headers };
      if (etag) pushHeaders["If-Match"] = etag;

      const sendAllocator = async (method) => {
        const resp = await axios({
          url: `${base}/orders/${oid}/allocator`,
          method,
          headers: pushHeaders,
          data: payload,
          timeout: 30000,
          validateStatus: () => true,
        });
        let summary = "";
        const body = resp.data;
        if (body && typeof body === "object") {
          const keys = Object.keys(body).slice(0, 6).join(", ");
          summary = `keys: ${keys}`;
          if (Array.isArray(body.errors) && body.errors.length) summary += `; errors: ${body.errors.length}`;
          if (Array.isArray(body.warnings) && body.warnings.length) summary += `; warnings: ${body.warnings.length}`;
        } else if (typeof body === "string") {
          summary = body.slice(0, 140);
        }
        return { status: resp.status, summary };
      };

      let attempt;
      if (isValidMethod(forceMethod) && forceMethod !== "auto") {
        attempt = await sendAllocator(forceMethod);
      } else {
        attempt = await sendAllocator("put");
        if ([404, 405, 501].includes(attempt.status)) {
          const fb = await sendAllocator("post");
          if (fb.status >= 200 && fb.status < 300) {
            attempt = { ...fb, triedFallback: true, primaryStatus: attempt.status };
          } else {
            attempt = { ...attempt, fallbackStatus: fb.status, fallbackSummary: fb.summary };
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
        forcedMethod: forceMethod !== "auto" ? forceMethod : undefined,
        sentAllocations: payload.allocations.length,
        responseSummary: attempt.summary,
      });
    }

    const anyReal = results.some((r) => r.ok);
    const hint = anyReal ? null : "No effective changes detected. Check SuggAlloc rows and method (PUT vs POST).";

    res.json({ ok: true, results, hint });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message, data: e.response?.data || null });
  }
});

export default r;
