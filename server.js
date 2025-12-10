/* ------------------------------------------------------------------
   SERVER.JS - PACKTRACK PRO BACKEND (With Deep Tracking Lookup)
   ------------------------------------------------------------------ */

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { initializeApp } = require("firebase/app");
const { getFirestore } = require("firebase/firestore");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* --- CONFIGURATION --- */
const firebaseConfig = {
  apiKey: "AIzaSyAKbvODxE_ULiag9XBXHnAJO4b-tGWSq0w",
  authDomain: "time-tracking-67712.firebaseapp.com",
  projectId: "time-tracking-67712",
  storageBucket: "time-tracking-67712.firebasestorage.app",
  messagingSenderId: "829274875816",
  appId: "1:829274875816:web:ee9e8046d22a115e42df9d",
};

initializeApp(firebaseConfig);
const db = getFirestore();

const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;
const SS_KEY = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;
const SS_AUTH = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");

/* --- CACHING & TOKENS --- */
let UPS_TOKEN = null;
let UPS_TOKEN_EXPIRES = 0;
const trackingCache = new Map();
const CACHE_MS = 30 * 60 * 1000; // 30 Min Cache

/* --- HELPERS --- */

async function getUPSToken() {
  if (UPS_TOKEN && Date.now() < UPS_TOKEN_EXPIRES) return UPS_TOKEN;
  try {
    const credentials = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString("base64");
    const res = await axios.post("https://onlinetools.ups.com/security/v1/oauth/token", "grant_type=client_credentials", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
      timeout: 8000,
    });
    UPS_TOKEN = res.data.access_token;
    UPS_TOKEN_EXPIRES = Date.now() + 50 * 60 * 1000;
    return UPS_TOKEN;
  } catch (err) {
    console.error("UPS Auth Error:", err.message);
    return null;
  }
}

async function trackUPS(trackingNumber) {
  if (!trackingNumber || trackingNumber === "No Tracking") return createSafeUPSObject("Not Shipped", false);

  if (trackingCache.has(trackingNumber)) {
    const cached = trackingCache.get(trackingNumber);
    if (Date.now() - cached.timestamp < CACHE_MS) return cached.data;
  }

  const token = await getUPSToken();
  if (!token) return createSafeUPSObject("UPS Auth Error", false, true);

  try {
    const res = await axios.get(
      `https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US`,
      {
        headers: { Authorization: `Bearer ${token}`, transId: `t-${Date.now()}`, transactionSrc: "PackTrack" },
        timeout: 8000,
      }
    );

    const pkg = res.data.trackResponse?.shipment?.[0]?.package?.[0];
    const act = pkg?.activity?.[0];

    const safeData = {
      status: act?.status?.description || "Unknown",
      delivered: (act?.status?.description || "").toLowerCase().includes("delivered"),
      location: [act?.location?.address?.city, act?.location?.address?.stateProvince].filter(Boolean).join(", ") || "",
      expectedDelivery: pkg?.deliveryDate?.[0]?.date 
        ? `${pkg.deliveryDate[0].date.substring(4,6)}/${pkg.deliveryDate[0].date.substring(6,8)}` 
        : "--",
      lastUpdated: Date.now(),
      trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
      isError: false
    };

    trackingCache.set(trackingNumber, { timestamp: Date.now(), data: safeData });
    return safeData;

  } catch (err) {
    return createSafeUPSObject("Pending Update", false, true);
  }
}

function createSafeUPSObject(status, delivered, isError = false) {
  return {
    status: status || "Unknown",
    delivered: !!delivered,
    location: "",
    expectedDelivery: "--",
    lastUpdated: Date.now(),
    trackingUrl: "",
    isError
  };
}

async function fetchShipStationPage(page = 1, pageSize = 25) {
  try {
    const res = await axios.get(
      `https://ssapi.shipstation.com/orders?page=${page}&pageSize=${pageSize}&sortBy=orderDate&sortDir=DESC`,
      { headers: { Authorization: `Basic ${SS_AUTH}` }, timeout: 10000 }
    );
    return {
      orders: res.data.orders || [],
      total: res.data.total || 0,
      pages: res.data.pages || 0,
    };
  } catch (err) {
    console.error("ShipStation Error:", err.message);
    return { orders: [], total: 0, pages: 0 };
  }
}

async function fetchShipmentByOrder(orderId) {
  try {
    const res = await axios.get(
      `https://ssapi.shipstation.com/shipments?orderId=${orderId}`,
      { headers: { Authorization: `Basic ${SS_AUTH}` }, timeout: 5000 }
    );
    return res.data.shipments?.[0]?.trackingNumber || null;
  } catch (err) {
    return null;
  }
}

/* ==================================================================
   ENDPOINT GROUP 1: ORDERS (Basic Info Only, No Tracking Logic)
   ================================================================== */
app.get("/orders/basic", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;

    const ssData = await fetchShipStationPage(page, limit);

    // Use Promise.all to handle potential async fallbacks
    const normalized = await Promise.all(ssData.orders.map(async (o) => {
      // 1. Try resolving tracking from top level or shipments array
      let tn = o.shipments?.[0]?.trackingNumber || o.trackingNumber || null;

      // 2. FALLBACK: If no tracking, try fetching from shipments endpoint
      if (!tn && o.orderId) {
         tn = await fetchShipmentByOrder(o.orderId);
      }

      return {
        orderId: String(o.orderId || ""),
        orderNumber: String(o.orderNumber || "Unknown"),
        shipDate: o.shipDate ? o.shipDate.split("T")[0] : "--",
        customerName: o.billTo?.name || "Unknown",
        customerEmail: o.customerEmail || "",
        items: o.items?.map(i => `${i.quantity}x ${i.name}`).join(", ") || "",
        trackingNumber: String(tn || "No Tracking"),
        carrierCode: o.carrierCode || "UPS",
        orderTotal: String(o.orderTotal || "0.00"),
        orderStatus: o.orderStatus || "unknown"
      };
    }));

    res.json({
      data: normalized,
      total: ssData.total,
      page: page,
      totalPages: ssData.pages
    });

  } catch (err) {
    console.error("Basic Orders Error:", err.message);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* ==================================================================
   ENDPOINT GROUP 2: TRACKING (UPS Focus)
   ================================================================== */
app.get("/tracking/list", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;

    const ssData = await fetchShipStationPage(page, limit);

    const enriched = await Promise.all(ssData.orders.map(async (o) => {
      let tn = o.shipments?.[0]?.trackingNumber || o.trackingNumber || null;
      if (!tn && o.orderId) tn = await fetchShipmentByOrder(o.orderId);
      
      const ups = tn ? await trackUPS(tn) : createSafeUPSObject("No Tracking", false);

      return {
        orderNumber: String(o.orderNumber || "Unknown"),
        trackingNumber: String(tn || "No Tracking"),
        upsStatus: ups.status,
        location: ups.location,
        delivered: ups.delivered,
        expectedDelivery: ups.expectedDelivery,
        lastUpdated: ups.lastUpdated,
        trackingUrl: ups.trackingUrl,
        isError: ups.isError
      };
    }));

    res.json({
      data: enriched,
      total: ssData.total,
      page: page,
      totalPages: ssData.pages
    });

  } catch (err) {
    console.error("Tracking List Error:", err.message);
    res.status(500).json({ error: "Failed to fetch tracking" });
  }
});

/* --- SINGLE TRACKING REFRESH --- */
app.post("/tracking/single", async (req, res) => {
  const { trackingNumber } = req.body;
  if(trackingCache.has(trackingNumber)) trackingCache.delete(trackingNumber);
  const result = await trackUPS(trackingNumber);
  res.json({
    upsStatus: result.status,
    location: result.location,
    delivered: result.delivered,
    expectedDelivery: result.expectedDelivery,
    lastUpdated: result.lastUpdated,
    trackingUrl: result.trackingUrl
  });
});

app.listen(PORT, () => console.log(`BACKEND RUNNING on ${PORT}`));
