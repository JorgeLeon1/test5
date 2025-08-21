// src/app/routes/batchAllocApi.js
import { Router } from "express";
import axios from "axios";
import { getPool, sql } from "../services/db/mssql.js";
import { authHeaders } from "../services/extensivClient.js";

const r = Router();

/* ----------------------- local helpers ----------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const s = (v, max = 255) => (v == null ? "" : String(v).normalize("NFC").slice(0, max));

const ro = (o) => o?.readOnly || o?.ReadOnly || {};

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
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

async function getExistingCols(pool) {
  const q = await pool.request().query(
    "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')"
  );
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
    ["ItemID", "ItemID", sql.VarChar(150), s(rec.SKU, 150)], // mirror SKU if present
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

/* ----------------------- Extensiv list query ----------------------- */
/**
 * GET /api/batch/search
 * Query params (all optional):
 *   status=AWAITINGPICK|OPEN|...  (maps to readOnly.status or code you use)
 *   modifiedSince=YYYY-MM-DD
 *   customerId=79
 *   referenceLike=PO123     (matches referenceNum contains)
 *   pageSize=100&maxPages=5
 */
r.get("/search", async (req, res) => {
  try {
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
    const headers = await authHeaders();

    const pageSize = Math.min(toInt(req.query.pageSize, 100), 500);
    const maxPages = Math.min(toInt(req.query.maxPages, 5), 20);

    // Build RQL
    const rql = [];
    // Common: open and not fully allocated (tweak as you need)
    if (req.query.status) {
      // If you map status strings to numbers, do that here
      // Example: AWAITINGPICK -> 0 (Open). Adjust as needed.
      rql.push("readOnly.status==0");
    }
    rql.push("readOnly.fullyAllocated==false");
    if (req.query.customerId) rql.push(`customerIdentifier.id==${toInt(req.query.customerId, 0)}`);
    if (req.query.referenceLike) rql.push(`referenceNum==*${req.query.referenceLike}*`);
    if (req.query.modifiedSince) rql.push(`readOnly.modifiedDateTime>=${encodeURIComponent(req.query.modifiedSince)}`);

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
          const orderItemId = toInt(IR.orderItemId ?? it.orderItemId ?? IR.OrderItemId ?? it.OrderItemId, 0);
          const sku = s(it?.itemIdentifier?.sku ?? it?.sku ?? it?.SKU ?? "", 150);
          const unitId = toInt(IR?.unitIdentifier?.id, 0);
          const unitName = s(IR?.unitIdentifier?.name ?? "", 80);
          const qualifier = s(it?.qualifier ?? "", 80);
          const qty = toInt(it?.qty ?? it?.orderedQty ?? it?.Qty ?? it?.OrderedQty ?? 0, 0);

          if (!orderItemId) continue;

          await upsertOrderDetail(pool, cols, {
            OrderItemID: orderItemId,
            OrderID: orderId,
            CustomerID: customerId,
            CustomerName: customerName,
            SKU: sku,
            Qualifier: qualifier,
            OrderedQTY: qty,
            UnitID: unitId,
            UnitName: unitName,
            ReferenceNum: referenceNum,
          });
          upsertedLines++;

          lineObjs.push({
            orderItemId,
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
    res.status(e.status || 500).json({ ok: false, message: e.message, data: e.response?.data });
  }
});

/**
 * POST /api/batch/allocate
 * body: { orderIds: number[] }
 * -> runs your allocator for all lines belonging to the orders
 */
r.post("/allocate", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds.map(n => toInt(n)).filter(Boolean) : [];
    if (!orderIds.length) return res.status(400).json({ ok:false, message:"orderIds required" });

    const pool = await getPool();

    // Resolve line IDs for those orders
    const idQuery = await pool.request().query(`
      SELECT OrderItemID
      FROM OrderDetails
      WHERE OrderID IN (${orderIds.join(",")})
    `);
    const lineIds = idQuery.recordset.map(r => r.OrderItemID);
    if (!lineIds.length) return res.json({ ok: true, allocated: 0, summary: [] });

    // Clear existing SuggAlloc for these lines (optional)
    await pool.request().query(`DELETE SuggAlloc WHERE OrderItemID IN (${lineIds.join(",")});`);

    // Allocation loop (same as your stabilized single-alloc logic)
    await pool.request().batch(`
DECLARE @iters INT = 0;
DECLARE @maxIters INT = 20000;

WHILE (1=1)
BEGIN
  ;WITH x AS (
    SELECT
      od.OrderItemID,
      od.OrderedQTY,
      ISNULL(sa.SumSuggAllocQty,0) AS SumSuggAllocQty,
      (od.OrderedQTY - ISNULL(sa.SumSuggAllocQty,0)) AS RemainingOpenQty
    FROM OrderDetails od
    LEFT JOIN (
      SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc GROUP BY OrderItemID
    ) sa ON sa.OrderItemID = od.OrderItemID
    WHERE od.OrderItemID IN (${lineIds.join(",")})
  ),
  cand AS (
    SELECT
      x.OrderItemID,
      x.OrderedQTY,
      x.SumSuggAllocQty,
      x.RemainingOpenQty,
      inv.ReceiveItemID,
      inv.AvailableQTY,
      inv.ReceivedQty,
      inv.LocationName,
      CASE
        WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)='A'  AND x.RemainingOpenQty = inv.AvailableQTY THEN 1
        WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)<>'A' AND x.RemainingOpenQty = inv.AvailableQTY THEN 2
        WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)<>'A' AND x.RemainingOpenQty >  inv.AvailableQTY THEN 3
        WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)='A'  AND x.RemainingOpenQty >  inv.AvailableQTY THEN 4
        WHEN inv.ReceivedQty >  inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)='A'  AND x.RemainingOpenQty >= inv.AvailableQTY THEN 5
        WHEN inv.ReceivedQty >  inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)<>'A' AND x.RemainingOpenQty >= inv.AvailableQTY THEN 6
        WHEN SUBSTRING(inv.LocationName,4,1)='A'  AND x.RemainingOpenQty <= inv.AvailableQTY THEN 7
        WHEN SUBSTRING(inv.LocationName,4,1)<>'A' AND x.RemainingOpenQty <= inv.AvailableQTY THEN 8
      END AS Seq
    FROM x
    JOIN OrderDetails od ON od.OrderItemID = x.OrderItemID
    JOIN Inventory inv
      ON inv.ItemID = od.ItemID
     AND inv.Qualifier = od.Qualifier
    WHERE
      x.RemainingOpenQty > 0
      AND inv.AvailableQTY > 0
      AND inv.ReceiveItemID NOT IN (SELECT DISTINCT ReceiveItemID FROM SuggAlloc)
  ),
  pick AS (
    SELECT TOP (1)
      c.OrderItemID,
      c.ReceiveItemID,
      CASE WHEN c.RemainingOpenQty >= c.AvailableQTY THEN c.AvailableQTY ELSE c.RemainingOpenQty END AS AllocQty,
      c.Seq,
      c.AvailableQTY
    FROM cand c
    ORDER BY c.OrderItemID, c.Seq ASC,
      CASE WHEN c.Seq IN (1,2,3,4,5,6) THEN c.AvailableQTY+0
           WHEN c.Seq IN (7,9)        THEN 999999-c.AvailableQTY
      END DESC
  )
  INSERT INTO SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT OrderItemID, ReceiveItemID, AllocQty FROM pick;

  IF @@ROWCOUNT = 0 BREAK;

  SET @iters += 1;
  IF @iters >= @maxIters BREAK;

  IF NOT EXISTS (
    SELECT 1
    FROM OrderDetails od
    OUTER APPLY (
      SELECT SUM(ISNULL(sa.SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc sa WHERE sa.OrderItemID = od.OrderItemID
    ) z
    WHERE od.OrderItemID IN (${lineIds.join(",")})
      AND (od.OrderedQTY - ISNULL(z.SumSuggAllocQty,0)) > 0
  )
    BREAK;
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
      WHERE od.OrderItemID IN (${lineIds.join(",")})
      ORDER BY od.OrderID, od.OrderItemID;
    `);

    res.json({ ok: true, allocated: summary.recordset.length, summary: summary.recordset });
  } catch (e) {
    res.status(500).json({ ok:false, message: e.message });
  }
});

/**
 * POST /api/batch/push
 * body: { orderIds: number[] }
 * -> pushes SuggAlloc for each order to Extensiv /orders/{id}/allocator
 */
r.post("/push", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds.map(n => toInt(n)).filter(Boolean) : [];
    if (!orderIds.length) return res.status(400).json({ ok:false, message:"orderIds required" });

    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
    const headers = await authHeaders();
    const pool = await getPool();

    const results = [];
    for (const oid of orderIds) {
      const allocs = await pool.request().input("OrderID", sql.Int, oid).query(`
        SELECT OrderItemID, ReceiveItemID, SuggAllocQty
        FROM SuggAlloc
        WHERE OrderItemID IN (SELECT OrderItemID FROM OrderDetails WHERE OrderID=@OrderID)
          AND ISNULL(SuggAllocQty,0) > 0
      `);

      const payload = {
        allocations: allocs.recordset.map(a => ({
          orderItemId: a.OrderItemID,
          receiveItemId: a.ReceiveItemID,
          qty: a.SuggAllocQty
        }))
      };

      if (payload.allocations.length === 0) {
        results.push({ orderId: oid, ok:false, status: 204, message: "No allocations" });
        continue;
      }

      const resp = await axios.put(`${base}/orders/${oid}/allocator`, payload, {
        headers, timeout: 30000, validateStatus: () => true
      });

      results.push({
        orderId: oid,
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        data: resp.data
      });
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok:false, message: e.message, data: e.response?.data });
  }
});

export default r;
