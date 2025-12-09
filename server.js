const express = require("express");
const axios = require("axios");
const cors = require("cors");

const { initializeApp } = require("firebase/app");
const { getFirestore, collection, getDocs } = require("firebase/firestore");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ---------------------------------------------
   FIREBASE CONFIGURATION
----------------------------------------------*/
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

/* ---------------------------------------------
   UPS CONFIGURATION
----------------------------------------------*/
const UPS_CLIENT_ID ="9qBB9J4GXk4ex6kqVIkrfqqgQCmj4UIYo5cxmz4UamZtxS1T";
const UPS_CLIENT_SECRET ="JUhoZG0360GgSYdW8bAhLX4mzB2mYA1sIG2GIiyPnLeWdNoIecJ0LoN9wo9jOxGp";

const UPS_OAUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const UPS_TRACKING_URL = "https://onlinetools.ups.com/api/track/v1/details/";

let UPS_TOKEN = null;
let UPS_TOKEN_EXPIRES = 0;

/* ---------------------------------------------
   UPS TOKEN (CACHED)
----------------------------------------------*/
async function getUPSToken() {
  if (UPS_TOKEN && Date.now() < UPS_TOKEN_EXPIRES) return UPS_TOKEN;

  try {
    const credentials = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString("base64");

    const res = await axios.post(
      UPS_OAUTH_URL,
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
    UPS_TOKEN_EXPIRES = Date.now() + 50 * 60 * 1000;

    console.log("UPS OAuth Token Fetched ✓");
    return UPS_TOKEN;

  } catch (err) {
    console.error("UPS OAuth Error:", err.response?.data || err.message);
    UPS_TOKEN = null;
    UPS_TOKEN_EXPIRES = Date.now() + 5 * 60 * 1000;
    return null;
  }
}

/* ---------------------------------------------
   UPS TRACKING CACHE (30 MIN)
----------------------------------------------*/
const trackingCache = new Map();
const CACHE_MS = 30 * 60 * 1000;

async function trackUPS(trackingNumber) {
  if (!trackingNumber) return null;

  if (trackingCache.has(trackingNumber)) {
    const cached = trackingCache.get(trackingNumber);
    if (Date.now() - cached.timestamp < CACHE_MS) return cached.data;
  }

  const token = await getUPSToken();
  if (!token) {
    return { status: "UPS Auth Error", delivered: false, expectedDelivery: "--", location: "", error: true };
  }

  try {
    const res = await axios.get(
      `${UPS_TRACKING_URL}${encodeURIComponent(trackingNumber)}?locale=en_US`,
      {
        headers: { Authorization: `Bearer ${token}`, transId: `t-${Date.now()}`, transactionSrc: "PackTrack" },
        timeout: 8000,
      }
    );

    const pkg = res.data.trackResponse?.shipment?.[0]?.package?.[0];
    const act = pkg?.activity?.[0];

    const formatted = {
      status: act?.status?.description || "Unknown",
      delivered: (act?.status?.description || "").toLowerCase().includes("delivered"),
      location: [
        act?.location?.address?.city,
        act?.location?.address?.stateProvince,
      ].filter(Boolean).join(", "),
      expectedDelivery: pkg?.deliveryDate?.[0]?.date || "--",
      lastUpdated: Date.now(),
      trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
    };

    trackingCache.set(trackingNumber, { timestamp: Date.now(), data: formatted });
    return formatted;

  } catch (err) {
    console.error("UPS Tracking Error:", err.response?.data || err.message);
    return { status: "Pending Update", delivered: false, expectedDelivery: "--", location: "", error: true };
  }
}

/* ---------------------------------------------
   SHIPSTATION SHIPMENT LOOKUP (BY TRACKING)
----------------------------------------------*/

const SS_KEY ="310e27d626ab425fa808c8696486cdcf";
const SS_SECRET ="7e5657c37bcd42e087062343ea1edc0f";

async function getShipStationShipment(trackingNumber) {
  if (!trackingNumber) return null;

  const auth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");

  try {
    const url = `https://ssapi.shipstation.com/shipments?trackingNumber=${trackingNumber}&includeShipmentItems=true`;

    const res = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 8000,
    });

    const shipment = res?.data?.shipments?.[0] || null;
    return shipment;

  } catch (err) {
    console.error("ShipStation Lookup Error:", trackingNumber, err.response?.data || err.message);
    return null;
  }
}

/* ---------------------------------------------
   MAIN API: /orders/with-tracking
----------------------------------------------*/

app.get("/orders/with-tracking", async (req, res) => {
  try {
    const snap = await getDocs(collection(db, "packtrack_logs"));
    const logs = snap.docs.map(d => d.data()).filter(l => l.trackingId);

    console.log("Firestore Logs Loaded:", logs.length);

    const enriched = await Promise.all(
      logs.map(async log => {
        const tracking = log.trackingId;

        const ups = await trackUPS(tracking);
        const ss = await getShipStationShipment(tracking);

        const base = {
          trackingNumber: tracking,
          logDate: log.dateStr,
          ...ups,
        };

        if (!ss) {
          return {
            ...base,
            orderId: null,
            orderNumber: "Not Found",
            customerName: "Manual Scan",
            items: "",
            shipDate: log.dateStr,
          };
        }

        return {
          ...base,
          orderId: ss.orderId,
          orderNumber: ss.orderKey || ss.orderNumber,
          customerName: ss.shipTo?.name || "Unknown",
          items: ss.shipmentItems?.map(i => `${i.quantity}x ${i.name}`).join(", "),
          shipDate: ss.shipDate,
        };
      })
    );

    enriched.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

    res.json(enriched);

  } catch (err) {
    console.error("API Error:", err);
    res.status(500).json({ error: "Backend Error" });
  }
});

/* ---------------------------------------------*/

app.listen(PORT, () => console.log(`BACKEND RUNNING on ${PORT}`));

