// ================================
// PACKTRACK BACKEND v3 (FIXED)
// ================================

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { initializeApp } = require("firebase/app");
const { getFirestore, collection, getDocs } = require("firebase/firestore");

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------------------------
// MIDDLEWARE
// ---------------------------------
app.use(cors());
app.use(express.json());

// ---------------------------------
// FIREBASE CONFIG
// ---------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyAKbvODxE_ULiag9XBXHnAJO4b-tGWSq0w",
  authDomain: "time-tracking-67712.firebaseapp.com",
  projectId: "time-tracking-67712",
  storageBucket: "time-tracking-67712.firebasestorage.app",
  messagingSenderId: "829274875816",
  appId: "1:829274875816:web:ee9e8046d22a115e42df9d"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ---------------------------------
// UPS CREDENTIALS
// ---------------------------------
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;
const UPS_OAUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const UPS_TRACKING_URL = "https://onlinetools.ups.com/api/track/v1/details/";

// ---------------------------------
// SHIPSTATION CREDENTIALS
// ---------------------------------
const SS_API_KEY = process.env.SS_API_KEY;
const SS_API_SECRET = process.env.SS_API_SECRET;

// ---------------------------------
// UPS TOKEN CACHE
// ---------------------------------
let upsToken = null;
let upsTokenExpires = 0;

async function getUPSToken() {
  const now = Date.now();
  if (upsToken && now < upsTokenExpires) return upsToken;

  const auth = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString("base64");

  try {
    const res = await axios.post(
      UPS_OAUTH_URL,
      "grant_type=client_credentials",
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${auth}`
        }
      }
    );

    upsToken = res.data.access_token;
    upsTokenExpires = now + 55 * 60 * 1000; // 55 min
    console.log("✅ UPS token refreshed");

    return upsToken;
  } catch (err) {
    console.error("❌ UPS AUTH ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ---------------------------------
// UPS TRACKING CACHE
// ---------------------------------
const trackingCache = new Map();
const CACHE_MS = 30 * 60 * 1000;

// UPS TRACK LOOKUP
async function trackUPS(trackingNumber) {
  const cached = trackingCache.get(trackingNumber);
  if (cached && Date.now() - cached.timestamp < CACHE_MS) return cached.data;

  try {
    const token = await getUPSToken();

    const url = `${UPS_TRACKING_URL}${encodeURIComponent(trackingNumber)}?locale=en_US&returnSignature=false`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        transId: `trans-${Date.now()}`,
        transactionSrc: "PackTrackPro"
      },
      timeout: 8000
    });

    const pkg = res.data?.trackResponse?.shipment?.[0]?.package?.[0];
    const activity = pkg?.activity?.[0];

    const result = {
      status: activity?.status?.description || "Unknown",
      location:
        [activity?.location?.address?.city, activity?.location?.address?.stateProvince]
          .filter(Boolean)
          .join(", "),
      delivered: (activity?.status?.description || "").toLowerCase().includes("delivered"),
      expectedDelivery: pkg?.deliveryDate?.[0]?.date || "--",
      lastUpdated: Date.now(),
      trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`
    };

    trackingCache.set(trackingNumber, { data: result, timestamp: Date.now() });
    return result;
  } catch (err) {
    return {
      status: "Pending Update",
      location: "",
      delivered: false,
      expectedDelivery: "--",
      trackingUrl: "",
      lastUpdated: Date.now(),
      error: true
    };
  }
}

// ---------------------------------
// SHIPSTATION LOOKUP BY TRACKING #
// ---------------------------------
async function getShipStationShipmentByTracking(trackingNumber) {
  const auth = Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString("base64");

  try {
    const url = `https://ssapi.shipstation.com/shipments?trackingNumber=${trackingNumber}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` }
    });

    if (res.data.shipments?.length > 0) {
      return res.data.shipments[0];
    }
    return null;
  } catch (err) {
    console.error("❌ ShipStation Lookup Failed:", err.message);
    return null;
  }
}

// ---------------------------------
// MAIN API: MERGED UPS + SHIPSTATION + FIRESTORE
// ---------------------------------
app.get("/orders/with-tracking", async (req, res) => {
  try {
    // Load all logs
    const logsSnap = await getDocs(collection(db, "packtrack_logs"));
    const logs = logsSnap.docs.map(d => d.data());
    const entries = logs.filter(l => l.trackingId && l.trackingId.length > 5);

    console.log(`📦 Firestore logs found: ${entries.length}`);

    const results = await Promise.all(
      entries.map(async (log) => {
        const tracking = log.trackingId;

        // 1. UPS lookup
        const ups = await trackUPS(tracking);

        // 2. ShipStation lookup by tracking #
        const ss = await getShipStationShipmentByTracking(tracking);

        if (ss) {
          return {
            orderId: ss.orderId,
            orderNumber: ss.orderNumber,
            customerName: ss.shipTo?.name || "Unknown",
            customerEmail: ss.customerEmail || "",
            shipDate: ss.shipDate || "--",
            trackingNumber: tracking,
            carrierCode: ss.carrierCode,
            items: "", // ShipStation shipments don’t include items unless expanded
            ...ups
          };
        }

        // Fallback — Firestore only
        return {
          orderId: 0,
          orderNumber: "Manual Log",
          customerName: "Unknown (Manual Scan)",
          customerEmail: "",
          shipDate: log.dateStr || "--",
          trackingNumber: tracking,
          carrierCode: "ups",
          ...ups
        };
      })
    );

    results.sort((a, b) => b.lastUpdated - a.lastUpdated);
    res.json(results);

  } catch (error) {
    console.error("🔥 API ERROR:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ---------------------------------
// START SERVER
// ---------------------------------
app.listen(PORT, () => {
  console.log(`🚀 PACKTRACK BACKEND RUNNING on ${PORT}`);
});
