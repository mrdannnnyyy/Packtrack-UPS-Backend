/* ------------------------------------------------------------------
   PACKTRACK UPS BACKEND - HIGH PERFORMANCE CACHED API
   - Uses firebase-admin (server SDK) for Firestore
   - Designed for Google Cloud Run (PORT env)
   ------------------------------------------------------------------ */

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

/* ------------------------------------------------------------------
   FIREBASE ADMIN INITIALIZATION
   ------------------------------------------------------------------ */
/**
 * For Cloud Run:
 *   - Attach a service account with Firestore access
 *   - Cloud Run will provide Application Default Credentials
 */
if (!admin.apps.length) {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    // Optional: support for environments where you pass the key as an env var
    const serviceAccount = JSON.parse(
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    );
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    // Default path for Cloud Run (ADC)
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
}

const db = admin.firestore();
const ORDERS_COL = "shipstation_orders";

/* ------------------------------------------------------------------
   CREDENTIALS (UPS + SHIPSTATION)
   ------------------------------------------------------------------ */
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;
const SS_KEY = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;

if (!UPS_CLIENT_ID || !UPS_CLIENT_SECRET) {
  console.warn("⚠ UPS credentials missing in environment variables.");
}
if (!SS_KEY || !SS_SECRET) {
  console.warn("⚠ ShipStation credentials missing in environment variables.");
}

const SS_AUTH =
  SS_KEY && SS_SECRET
    ? Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64")
    : "";

/* ------------------------------------------------------------------
   IN-MEMORY CACHE
   ------------------------------------------------------------------ */
let ORDERS_CACHE = [];
let LAST_SYNC = 0;

/* ------------------------------------------------------------------
   HYDRATE CACHE FROM FIRESTORE ON STARTUP
   ------------------------------------------------------------------ */
async function hydrateCache() {
  console.log("🔁 Hydrating cache from Firestore...");

  try {
    const snapshot = await db
      .collection(ORDERS_COL)
      .orderBy("shipDate", "desc")
      .limit(2000)
      .get();

    ORDERS_CACHE = snapshot.docs.map((doc) => doc.data());
    console.log(`✅ Cache hydrated: ${ORDERS_CACHE.length} orders loaded.`);
  } catch (err) {
    console.error("❌ Cache hydration failed:", err.message);
  }
}

// Kick off once at startup (non-blocking)
hydrateCache();

/* ------------------------------------------------------------------
   UPS TOKEN + TRACKING HELPERS
   ------------------------------------------------------------------ */
let UPS_TOKEN = null;
let UPS_TOKEN_EXPIRES = 0;

async function getUPSToken() {
  if (UPS_TOKEN && Date.now() < UPS_TOKEN_EXPIRES) return UPS_TOKEN;

  try {
    const credentials = Buffer.from(
      `${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`
    ).toString("base64");

    const res = await axios.post(
      "https://onlinetools.ups.com/security/v1/oauth/token",
      "grant_type=client_credentials",
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        timeout: 8000,
      }
    );

    UPS_TOKEN = res.data.access_token;
    UPS_TOKEN_EXPIRES = Date.now() + 50 * 60 * 1000; // 50 minutes
    return UPS_TOKEN;
  } catch (err) {
    console.error("❌ UPS OAuth Error:", err.message);
    return null;
  }
}

async function fetchLiveUPS(trackingNumber) {
  const token = await getUPSToken();
  if (!token) {
    throw new Error("UPS Auth Failed");
  }

  const res = await axios.get(
    `https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(
      trackingNumber
    )}?locale=en_US`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        transId: `t-${Date.now()}`,
        transactionSrc: "PackTrack",
      },
      timeout: 8000,
    }
  );

  const pkg = res.data.trackResponse?.shipment?.[0]?.package?.[0];
  const act = pkg?.activity?.[0];

  const formatDate = (r) =>
    r && r.length === 8
      ? `${r.substring(4, 6)}/${r.substring(6, 8)}/${r.substring(0, 4)}`
      : "--";

  return {
    status: act?.status?.description || "Unknown",
    delivered: (act?.status?.description || "")
      .toLowerCase()
      .includes("delivered"),
    location: [
      act?.location?.address?.city,
      act?.location?.address?.stateProvince,
    ]
      .filter(Boolean)
      .join(", "),
    expectedDelivery: formatDate(pkg?.deliveryDate?.[0]?.date),
    lastUpdated: Date.now(),
    trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
    isError: false,
  };
}

/* ==================================================================
   ENDPOINT 1: SYNC ORDERS FROM SHIPSTATION → FIRESTORE → CACHE
   ================================================================== */
app.post("/sync/orders", async (req, res) => {
  console.log("🚚 Starting ShipStation sync...");

  if (!SS_AUTH) {
    return res
      .status(500)
      .json({ error: "ShipStation credentials are not configured." });
  }

  try {
    let page = 1;
    let keepFetching = true;
    let newOrders = [];

    while (keepFetching) {
      const ssRes = await axios.get(
        `https://ssapi.shipstation.com/orders?orderStatus=shipped&page=${page}&pageSize=500&sortBy=shipDate&sortDir=DESC`,
        {
          headers: { Authorization: `Basic ${SS_AUTH}` },
          timeout: 15000,
        }
      );

      const pageOrders = ssRes.data.orders || [];
      newOrders = newOrders.concat(pageOrders);

      const totalPages = ssRes.data.pages || 0;
      if (page >= totalPages || page >= 5) {
        keepFetching = false; // safety limit (max 2500 orders per sync)
      } else {
        page++;
      }
    }

    console.log(`📦 ShipStation returned ${newOrders.length} orders.`);

    // Normalize orders and write to Firestore
    const writePromises = newOrders.map(async (o) => {
      const orderId = String(o.orderId);

      const trackingNumber =
        o.shipments?.[0]?.trackingNumber || o.trackingNumber || null;

      const normalized = {
        orderId,
        orderNumber: String(o.orderNumber),
        shipDate: o.shipDate ? o.shipDate.split("T")[0] : "--",
        customerName: o.billTo?.name || "Unknown",
        customerEmail: o.customerEmail || "",
        items:
          o.items?.map((i) => `${i.quantity}x ${i.name}`).join(", ") || "",
        trackingNumber: String(trackingNumber || "No Tracking"),
        carrierCode: o.carrierCode || "UPS",
        orderTotal: String(o.orderTotal || "0.00"),
        orderStatus: o.orderStatus || "",
      };

      // Preserve UPS data if already in cache
      const existing = ORDERS_CACHE.find((c) => c.orderId === orderId);

      const finalDoc = {
        ...normalized,
        upsStatus: existing?.upsStatus || "Pending",
        upsLocation: existing?.upsLocation || "",
        upsDelivered: existing?.upsDelivered || false,
        upsEta: existing?.upsEta || "--",
        upsUpdated: existing?.upsUpdated || 0,
      };

      const ref = db.collection(ORDERS_COL).doc(orderId);
      await ref.set(finalDoc, { merge: true });

      return finalDoc;
    });

    await Promise.all(writePromises);

    // Refresh cache after sync
    await hydrateCache();
    LAST_SYNC = Date.now();

    console.log("✅ ShipStation sync complete.");
    res.json({
      success: true,
      count: newOrders.length,
      message: "Sync complete",
      lastSync: LAST_SYNC,
    });
  } catch (err) {
    console.error("❌ Sync failed:", err.message);
    res.status(500).json({ error: "Sync failed", details: err.message });
  }
});

/* ==================================================================
   ENDPOINT 2: READ ORDERS (CACHE ONLY, SUPER FAST)
   ================================================================== */
app.get("/orders", (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 25;

  const start = (page - 1) * limit;
  const end = start + limit;

  const slice = ORDERS_CACHE.slice(start, end);

  res.json({
    data: slice,
    total: ORDERS_CACHE.length,
    page,
    totalPages: Math.ceil(ORDERS_CACHE.length / limit) || 1,
    lastSync: LAST_SYNC,
  });
});

/* ==================================================================
   ENDPOINT 3: READ TRACKING SUMMARY (CACHE ONLY)
   ================================================================== */
app.get("/tracking", (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 25;

  const trackable = ORDERS_CACHE.filter(
    (o) => o.trackingNumber && o.trackingNumber !== "No Tracking"
  );

  const start = (page - 1) * limit;
  const end = start + limit;
  const slice = trackable.slice(start, end);

  const formatted = slice.map((o) => ({
    orderId: o.orderId,
    orderNumber: o.orderNumber,
    trackingNumber: o.trackingNumber,
    upsStatus: o.upsStatus,
    location: o.upsLocation,
    delivered: o.upsDelivered,
    expectedDelivery: o.upsEta,
    lastUpdated: o.upsUpdated,
    trackingUrl: `https://www.ups.com/track?tracknum=${o.trackingNumber}`,
    isError: false,
  }));

  res.json({
    data: formatted,
    total: trackable.length,
    page,
    totalPages: Math.ceil(trackable.length / limit) || 1,
  });
});

/* ==================================================================
   ENDPOINT 4: SINGLE TRACKING UPDATE (LIVE UPS CALL)
   ================================================================== */
app.post("/tracking/single", async (req, res) => {
  const { trackingNumber } = req.body || {};

  if (!trackingNumber) {
    return res.status(400).json({ error: "trackingNumber is required" });
  }

  const index = ORDERS_CACHE.findIndex(
    (o) => o.trackingNumber === trackingNumber
  );
  if (index === -1) {
    return res.status(404).json({ error: "Order not found for tracking" });
  }

  try {
    const upsData = await fetchLiveUPS(trackingNumber);

    const updated = {
      ...ORDERS_CACHE[index],
      upsStatus: upsData.status,
      upsLocation: upsData.location,
      upsDelivered: upsData.delivered,
      upsEta: upsData.expectedDelivery,
      upsUpdated: upsData.lastUpdated,
    };

    ORDERS_CACHE[index] = updated;

    const ref = db.collection(ORDERS_COL).doc(updated.orderId);
    await ref.update({
      upsStatus: upsData.status,
      upsLocation: upsData.location,
      upsDelivered: upsData.delivered,
      upsEta: upsData.expectedDelivery,
      upsUpdated: upsData.lastUpdated,
    });

    res.json(upsData);
  } catch (err) {
    console.error("❌ UPS single tracking update failed:", err.message);
    res.status(500).json({ error: "UPS update failed", details: err.message });
  }
});

/* ------------------------------------------------------------------
   HEALTH CHECK / ROOT
   ------------------------------------------------------------------ */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "PackTrack UPS Backend",
    cacheSize: ORDERS_CACHE.length,
    lastSync: LAST_SYNC,
  });
});

/* ------------------------------------------------------------------
   START SERVER
   ------------------------------------------------------------------ */
app.listen(PORT, () => {
  console.log(`🚀 BACKEND RUNNING on port ${PORT}`);
});
