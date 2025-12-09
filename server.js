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
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;

const UPS_OAUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const UPS_TRACKING_URL = "https://onlinetools.ups.com/api/track/v1/details/";

let UPS_TOKEN = null;
let UPS_TOKEN_EXPIRES = 0;

/* ---------------------------------------------
   UPS TOKEN (CACHED FOR 50 MINUTES)
----------------------------------------------*/
async function getUPSToken() {
  if (UPS_TOKEN && Date.now() < UPS_TOKEN_EXPIRES) {
    return UPS_TOKEN;
  }
  try {
    const credentials = Buffer.from(
      `${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`
    ).toString("base64");

    const res = await axios.post(
      UPS_OAUTH_URL,
      "grant_type=client_credentials",
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
      }
    );

    UPS_TOKEN = res.data.access_token;
    UPS_TOKEN_EXPIRES = Date.now() + 50 * 60 * 1000; // Valid for 50 minutes

    return UPS_TOKEN;
  } catch (err) {
    console.error("UPS OAuth Error:", err.message);
    return null;
  }
}

/* ---------------------------------------------
   UPS TRACKING CACHE (30 MIN)
----------------------------------------------*/
const trackingCache = new Map();
const CACHE_MS = 30 * 60 * 1000;

/* ---------------------------------------------
   UPS TRACKING WITH RATE LIMIT PROTECTION
----------------------------------------------*/
async function trackUPS(trackingNumber) {
  if (!trackingNumber) return null;

  // Cache hit
  if (trackingCache.has(trackingNumber)) {
    const cached = trackingCache.get(trackingNumber);
    if (Date.now() - cached.timestamp < CACHE_MS) return cached.data;
  }

  let token = await getUPSToken();
  if (!token) {
    return {
      status: "UPS Auth Error",
      delivered: false,
      expectedDelivery: "--",
      location: "",
      trackingUrl: "",
      error: true,
    };
  }

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

    trackingCache.set(trackingNumber, {
      timestamp: Date.now(),
      data: formatted,
    });

    return formatted;
  } catch (err) {
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
   SHIPSTATION ORDER FETCHING
----------------------------------------------*/
const SS_KEY = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;

async function fetchAllShipStation() {
  const auth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");

  let page = 1;
  let pages = 1;
  const orders = [];

  try {
    do {
      const res = await axios.get(
        `https://ssapi.shipstation.com/orders?page=${page}&pageSize=500&orderStatus=shipped`,
        { headers: { Authorization: `Basic ${auth}` } }
      );

      pages = res.data.pages || 1;
      orders.push(...res.data.orders);

      console.log(`ShipStation Page ${page}/${pages}`);
      page++;
    } while (page <= pages);

    return orders;
  } catch (err) {
    console.error("ShipStation Error:", err.message);
    return [];
  }
}

/* ---------------------------------------------
   MAIN ENDPOINT
----------------------------------------------*/

app.get("/orders/with-tracking", async (req, res) => {
  try {
    // 1. Firestore Logs
    const snap = await getDocs(collection(db, "packtrack_logs"));
    const logs = snap.docs.map((d) => d.data()).filter((l) => l.trackingId);

    console.log("Logs:", logs.length);

    // 2. ShipStation Orders
    const ssOrders = await fetchAllShipStation();
    const ssMap = new Map();

    ssOrders.forEach((o) => {
      const tn =
        o.shipments?.[0]?.trackingNumber ||
        o.trackingNumber ||
        o.tracking_number;
      if (tn) ssMap.set(tn, o);
    });

    // 3. Merge
    const enriched = await Promise.all(
      logs.map(async (log) => {
        const ss = ssMap.get(log.trackingId);
        const ups = await trackUPS(log.trackingId);

        return {
          trackingNumber: log.trackingId,
          logDate: log.dateStr,
          ...ups,
          ...(ss
            ? {
                orderId: ss.orderId,
                orderNumber: ss.orderNumber,
                customerName: ss.billTo?.name || "Unknown",
                items: ss.items
                  ?.map((i) => `${i.quantity}x ${i.name}`)
                  .join(", "),
                shipDate: ss.shipDate,
              }
            : {
                orderId: null,
                orderNumber: "Not Found",
                customerName: "Manual Scan",
                items: "",
                shipDate: log.dateStr,
              }),
        };
      })
    );

    enriched.sort((a, b) => b.lastUpdated - a.lastUpdated);

    res.json(enriched);
  } catch (err) {
    console.error("API Error:", err);
    res.status(500).json({ error: "Backend Error" });
  }
});

/* ---------------------------------------------*/

app.listen(PORT, () => console.log(`BACKEND RUNNING on ${PORT}`));
