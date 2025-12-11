/* ------------------------------------------------------------------
   SERVER.JS - HIGH PERFORMANCE CACHED BACKEND (Cloud Run Ready)
   ------------------------------------------------------------------ */

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { initializeApp } = require("firebase/app");
const { 
  getFirestore, collection, getDocs, doc, setDoc, updateDoc, query, orderBy, limit 
} = require("firebase/firestore");
require('dotenv').config(); // Load local .env if present

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

/* --- FIREBASE CONFIGURATION --- */
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyAKbvODxE_ULiag9XBXHnAJO4b-tGWSq0w",
  authDomain: "time-tracking-67712.firebaseapp.com",
  projectId: "time-tracking-67712",
  storageBucket: "time-tracking-67712.firebasestorage.app",
  messagingSenderId: "829274875816",
  appId: "1:829274875816:web:ee9e8046d22a115e42df9d",
};

initializeApp(firebaseConfig);
const db = getFirestore();
const ORDERS_COL = "shipstation_orders";

/* --- CREDENTIALS --- */
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;
const SS_KEY = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;
const SS_AUTH = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");

/* --- IN-MEMORY CACHE --- */
let ORDERS_CACHE = [];
let LAST_SYNC = 0;

/* --- INITIALIZATION: Hydrate Cache from Firestore --- */
async function hydrateCache() {
  console.log("Hydrating Cache from Firestore...");
  try {
    // Orders by shipDate descending
    const q = query(collection(db, ORDERS_COL), orderBy("shipDate", "desc"), limit(2000));
    const snap = await getDocs(q);
    ORDERS_CACHE = snap.docs.map(d => d.data());
    console.log(`Cache Hydrated: ${ORDERS_CACHE.length} orders loaded.`);
  } catch (e) {
    console.error("Cache Hydration Failed:", e.message);
  }
}
// Run on startup
hydrateCache();

/* --- HELPERS: UPS --- */
let UPS_TOKEN = null;
let UPS_TOKEN_EXPIRES = 0;

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

async function fetchLiveUPS(trackingNumber) {
  const token = await getUPSToken();
  if (!token) throw new Error("UPS Auth Failed");

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
    const formatDate = (r) => r && r.length === 8 ? `${r.substring(4,6)}/${r.substring(6,8)}/${r.substring(0,4)}` : "--";

    return {
      status: act?.status?.description || "Unknown",
      delivered: (act?.status?.description || "").toLowerCase().includes("delivered"),
      location: [act?.location?.address?.city, act?.location?.address?.stateProvince].filter(Boolean).join(", "),
      expectedDelivery: formatDate(pkg?.deliveryDate?.[0]?.date),
      lastUpdated: Date.now(),
      trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
      isError: false
    };
  } catch (err) {
    return {
      status: "Error",
      delivered: false,
      location: "",
      expectedDelivery: "--",
      lastUpdated: Date.now(),
      trackingUrl: "",
      isError: true
    };
  }
}

/* ==================================================================
   ENDPOINT 0: HEALTH CHECK
   ================================================================== */
app.get('/', (req, res) => {
    res.status(200).send('PackTrack Backend v4 (Fixed SortBy) is Running!');
});

/* ==================================================================
   ENDPOINT 1: SYNC JOB (Background Task)
   ================================================================== */
app.post("/sync/orders", async (req, res) => {
  console.log("Starting ShipStation Sync...");
  try {
    let page = 1;
    let keepFetching = true;
    let newOrders = [];

    // Fetch up to 5 pages (2500 orders)
    while (keepFetching) {
      // FIXED: Changed sortBy=shipDate to sortBy=OrderDate to prevent API Crash
      const ssRes = await axios.get(
        `https://ssapi.shipstation.com/orders?orderStatus=shipped&page=${page}&pageSize=500&sortBy=OrderDate&sortDir=DESC`,
        { headers: { Authorization: `Basic ${SS_AUTH}` } }
      );
      
      const pageOrders = ssRes.data.orders || [];
      newOrders = [...newOrders, ...pageOrders];
      
      if (page >= (ssRes.data.pages || 0) || page >= 5) keepFetching = false;
      page++;
    }

    // Save to Firestore & Update Cache
    const batchPromises = newOrders.map(async (o) => {
      const orderId = String(o.orderId);
      
      // Resolve Tracking
      let tn = o.shipments?.[0]?.trackingNumber || o.trackingNumber || "No Tracking";
      
      const normalized = {
        orderId,
        orderNumber: String(o.orderNumber),
        shipDate: o.shipDate ? o.shipDate.split("T")[0] : "--",
        customerName: o.billTo?.name || "Unknown",
        customerEmail: o.customerEmail || "",
        items: o.items?.map(i => `${i.quantity}x ${i.name}`).join(", ") || "",
        trackingNumber: String(tn),
        carrierCode: o.carrierCode || "UPS",
        orderTotal: String(o.orderTotal || "0.00"),
        orderStatus: o.orderStatus
      };

      // Preserve existing UPS data from cache
      const existing = ORDERS_CACHE.find(c => c.orderId === orderId);
      
      const finalDoc = {
        ...normalized,
        upsStatus: existing?.upsStatus || "Pending",
        upsLocation: existing?.upsLocation || "",
        upsDelivered: existing?.upsDelivered || false,
        upsEta: existing?.upsEta || "--",
        upsUpdated: existing?.upsUpdated || 0
      };

      await setDoc(doc(db, ORDERS_COL, orderId), finalDoc, { merge: true });
      return finalDoc;
    });

    await Promise.all(batchPromises);
    await hydrateCache(); // Refresh memory
    LAST_SYNC = Date.now();

    res.json({ success: true, count: newOrders.length, message: "Sync Complete" });

  } catch (err) {
    console.error("Sync Failed:", err.message);
    res.status(500).json({ error: "Sync Failed" });
  }
});

/* ==================================================================
   ENDPOINT 2: GET ORDERS (Instant Read from Cache)
   ================================================================== */
app.get("/orders", (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 25;
  
  const start = (page - 1) * limit;
  const end = start + limit;
  const sliced = ORDERS_CACHE.slice(start, end);

  res.json({
    data: sliced,
    total: ORDERS_CACHE.length,
    page,
    totalPages: Math.ceil(ORDERS_CACHE.length / limit),
    lastSync: LAST_SYNC
  });
});

/* ==================================================================
   ENDPOINT 3: GET TRACKING (Instant Read from Cache)
   ================================================================== */
app.get("/tracking", (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 25;

  const trackable = ORDERS_CACHE.filter(o => o.trackingNumber && o.trackingNumber !== "No Tracking");
  
  const start = (page - 1) * limit;
  const end = start + limit;
  const sliced = trackable.slice(start, end);

  const formatted = sliced.map(o => ({
    orderNumber: o.orderNumber,
    trackingNumber: o.trackingNumber,
    upsStatus: o.upsStatus,
    location: o.upsLocation,
    delivered: o.upsDelivered,
    expectedDelivery: o.upsEta,
    lastUpdated: o.upsUpdated,
    trackingUrl: `https://www.ups.com/track?tracknum=${o.trackingNumber}`,
    isError: false
  }));

  res.json({
    data: formatted,
    total: trackable.length,
    page,
    totalPages: Math.ceil(trackable.length / limit)
  });
});

/* ==================================================================
   ENDPOINT 4: SINGLE TRACKING UPDATE (Calls UPS)
   ================================================================== */
app.post("/tracking/single", async (req, res) => {
  const { trackingNumber } = req.body;
  
  const orderIndex = ORDERS_CACHE.findIndex(o => o.trackingNumber === trackingNumber);
  
  try {
    // Call UPS
    const upsData = await fetchLiveUPS(trackingNumber);

    // Update Cache if order exists
    if (orderIndex !== -1) {
      const updatedOrder = {
        ...ORDERS_CACHE[orderIndex],
        upsStatus: upsData.status,
        upsLocation: upsData.location,
        upsDelivered: upsData.delivered,
        upsEta: upsData.expectedDelivery,
        upsUpdated: upsData.lastUpdated
      };
      ORDERS_CACHE[orderIndex] = updatedOrder;

      // Update Firestore
      await updateDoc(doc(db, ORDERS_COL, updatedOrder.orderId), {
        upsStatus: upsData.status,
        upsLocation: upsData.location,
        upsDelivered: upsData.delivered,
        upsEta: upsData.expectedDelivery,
        upsUpdated: upsData.lastUpdated
      });
    }

    res.json(upsData);

  } catch (err) {
    console.error("Tracking Update Failed:", err.message);
    res.status(500).json({ error: "UPS Update Failed" });
  }
});

// Link Fix: Prevent 404 on click
app.get('/:trackingId/list', (req, res) => {
    res.json({ id: req.params.trackingId, status: "Unknown", location: "Lookup Pending" });
});

app.listen(PORT, () => console.log(`BACKEND RUNNING on ${PORT}`));
