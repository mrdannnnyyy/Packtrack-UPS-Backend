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
   FIREBASE CONFIG (unchanged)
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
   UPS CONFIG
----------------------------------------------*/
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;

const UPS_OAUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const UPS_TRACKING_URL = "https://onlinetools.ups.com/api/track/v1/details/";

let UPS_TOKEN = null;
let UPS_TOKEN_EXPIRES = 0;

// UPS TOKEN
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
    return UPS_TOKEN;
  } catch (err) {
    console.error("UPS OAuth Error:", err.message);
    return null;
  }
}

/* ---------------------------------------------
   UPS TRACKING
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
  if (!token) return { status: "UPS Auth Error", error: true };

  try {
    const res = await axios.get(
      `${UPS_TRACKING_URL}${encodeURIComponent(trackingNumber)}?locale=en_US`,
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

    const formatted = {
      status: act?.status?.description || "Unknown",
      delivered: (act?.status?.description || "").toLowerCase().includes("delivered"),
      location: [
        act?.location?.address?.city,
        act?.location?.address?.stateProvince,
      ]
        .filter(Boolean)
        .join(", "),
      expectedDelivery: pkg?.deliveryDate?.[0]?.date || "--",
      lastUpdated: Date.now(),
      trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
    };

    trackingCache.set(trackingNumber, { timestamp: Date.now(), data: formatted });
    return formatted;
  } catch {
    return {
      status: "Pending Update",
      delivered: false,
      expectedDelivery: "--",
      location: "",
      trackingUrl: "",
      error: true,
    };
  }
}

/* ---------------------------------------------
   SHIPSTATION — FIXED LOOKUP
----------------------------------------------*/
const SS_KEY = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;
const SS_AUTH = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");

// Correct way: ShipStation stores tracking inside shipments endpoint
async function fetchShipmentByTracking(trackingNumber) {
  try {
    const res = await axios.get(
      `https://ssapi.shipstation.com/shipments?trackingNumber=${trackingNumber}`,
      {
        headers: { Authorization: `Basic ${SS_AUTH}` },
        timeout: 10000,
      }
    );

    return res.data.shipments?.[0] || null;
  } catch (err) {
    console.error("ShipStation Shipment Error:", err.message);
    return null;
  }
}

/* ---------------------------------------------
   MAIN ENDPOINT (FIXED MAPPING)
----------------------------------------------*/
app.get("/orders/with-tracking", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;

    // Firestore logs
    const snap = await getDocs(collection(db, "packtrack_logs"));
    const logs = snap.docs.map((d) => d.data());

    const logMap = new Map();
    logs.forEach((l) => l.trackingId && logMap.set(l.trackingId, l));

    // Orders page
    const listRes = await axios.get(
      `https://ssapi.shipstation.com/orders?page=${page}&pageSize=${limit}&sortBy=orderDate&sortDir=DESC`,
      {
        headers: { Authorization: `Basic ${SS_AUTH}` },
        timeout: 10000,
      }
    );

    const ssOrders = listRes.data.orders || [];
    const total = listRes.data.total || 0;
    const pages = listRes.data.pages || 1;

    const enriched = await Promise.all(
      ssOrders.map(async (order) => {
        let tn = null;

        // FIXED: ShipStation orders often have no tracking — must fetch shipments
        if (order.shipments?.length > 0) {
          tn = order.shipments[0].trackingNumber;
        }

        // If still no tracking → check ShipStation shipment API
        if (!tn && order.orderId) {
          try {
            const sRes = await axios.get(
              `https://ssapi.shipstation.com/shipments?orderId=${order.orderId}`,
              { headers: { Authorization: `Basic ${SS_AUTH}` } }
            );

            tn = sRes.data.shipments?.[0]?.trackingNumber || null;
          } catch {}
        }

        // UPS data
        const ups = tn ? await trackUPS(tn) : { status: "No Tracking" };

        // Shipment API for extra info
        const ssShipment = tn ? await fetchShipmentByTracking(tn) : null;

        return {
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          customerName: order.billTo?.name || "Unknown",
          customerEmail: order.customerEmail || "",
          items: order.items?.map((i) => `${i.quantity}x ${i.name}`).join(", "),
          shipDate: order.shipDate?.split("T")[0] || "--",
          trackingNumber: tn || "No Tracking",
          carrierCode: ssShipment?.carrierCode || order.carrierCode || "UPS",
          logDate: logMap.get(tn)?.dateStr || null,
          ...ups,
        };
      })
    );

    res.json({
      data: enriched,
      page,
      total,
      totalPages: pages,
    });
  } catch (err) {
    console.error("API Error:", err);
    res.status(500).json({ error: "Backend Error" });
  }
});

/* ---------------------------------------------
   QUICK UPS TRACK ENDPOINT
----------------------------------------------*/
app.post("/track", async (req, res) => {
  const { trackingNumber } = req.body;
  const result = await trackUPS(trackingNumber);
  res.json(result);
});

app.listen(PORT, () => console.log(`BACKEND RUNNING on ${PORT}`));
