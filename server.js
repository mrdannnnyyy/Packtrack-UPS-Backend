// server.js
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
const UPS_CLIENT_ID = "9qBB9J4GXk4ex6kqVIkrfqqgQCmj4UIYo5cxmz4UamZtxS1T";
const UPS_CLIENT_SECRET = "JUhoZG0360GgSYdW8bAhLX4mzB2mYA1sIG2GIiyPnLeWdNoIecJ0LoN9wo9jOxGp";

const UPS_OAUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const UPS_TRACKING_URL = "https://onlinetools.ups.com/api/track/v1/details/";

let UPS_TOKEN = null;
let UPS_TOKEN_EXPIRES = 0;

/* ---------------------------------------------
   UPS TOKEN (CACHED + BACKOFF)
----------------------------------------------*/
async function getUPSToken() {
  // If UPS creds aren't set, don't hammer UPS
  if (!UPS_CLIENT_ID || !UPS_CLIENT_SECRET) {
    console.error("UPS CLIENT ID / SECRET missing in environment variables.");
    // Back off for 10 minutes
    UPS_TOKEN = null;
    UPS_TOKEN_EXPIRES = Date.now() + 10 * 60 * 1000;
    return null;
  }

  // Use cached token if still valid
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
        timeout: 8000,
      }
    );

    UPS_TOKEN = res.data.access_token;
    // Valid for ~50 minutes
    UPS_TOKEN_EXPIRES = Date.now() + 50 * 60 * 1000;

    console.log("✅ UPS OAuth token fetched successfully");
    return UPS_TOKEN;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;

    console.error("UPS OAuth Error:", err.message, "status:", status);
    if (data) {
      console.error("UPS OAuth Response:", JSON.stringify(data));
    }

    // Back off for 5 minutes to avoid hammering UPS if creds are bad or rate limited
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

  const token = await getUPSToken();
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
      delivered: (act?.status?.description || "")
        .toLowerCase()
        .includes("delivered"),
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
    const status = err.response?.status;
    if (status === 429) {
      console.error("UPS Tracking 429 (rate limited) for", trackingNumber);
    } else {
      console.error(
        "UPS Tracking Error for",
        trackingNumber,
        "status:",
        status,
        "message:",
        err.message
      );
    }

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
const SS_KEY = "310e27d626ab425fa808c8696486cdcf";
const SS_SECRET = "7e5657c37bcd42e087062343ea1edc0f";

async function fetchAllShipStation() {
  if (!SS_KEY || !SS_SECRET) {
    console.error("ShipStation API key/secret missing in environment variables.");
    return [];
  }

  const auth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");

  let page = 1;
  let pages = 1;
  const orders = [];

  try {
    do {
      // You can add &orderStatus=shipped if you want only shipped orders
      const res = await axios.get(
        `https://ssapi.shipstation.com/orders?page=${page}&pageSize=500`,
        {
          headers: { Authorization: `Basic ${auth}` },
          timeout: 15000,
        }
      );

      pages = res.data.pages || 1;
      orders.push(...res.data.orders);

      console.log(`ShipStation Page ${page}/${pages}`);
      page++;
    } while (page <= pages);

    console.log("Total ShipStation orders fetched:", orders.length);
    return orders;
  } catch (err) {
    console.error("ShipStation Error:", err.message);
    if (err.response) {
      console.error(
        "ShipStation Response:",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    }
    return [];
  }
}

/* ---------------------------------------------
   HEALTH CHECK
----------------------------------------------*/
app.get("/", (req, res) => {
  res.json({ ok: true, service: "PackTrack UPS Backend" });
});

/* ---------------------------------------------
   SINGLE TRACKING ENDPOINT (used by trackUPSPackage)
----------------------------------------------*/
app.post("/track", async (req, res) => {
  try {
    const { trackingNumber } = req.body || {};
    if (!trackingNumber) {
      return res
        .status(400)
        .json({ error: "trackingNumber is required in body" });
    }

    const ups = await trackUPS(trackingNumber);

    return res.json({
      status: ups.status,
      delivered: ups.delivered,
      location: ups.location,
      expectedDelivery: ups.expectedDelivery,
      trackingUrl: ups.trackingUrl,
      date: ups.expectedDelivery || "--",
      error: ups.error || null,
    });
  } catch (err) {
    console.error("Error in /track:", err);
    return res.status(500).json({ error: "Tracking endpoint error" });
  }
});

/* ---------------------------------------------
   MAIN ENRICHED ORDERS ENDPOINT
----------------------------------------------*/

app.get("/orders/with-tracking", async (req, res) => {
  try {
    // 1. Firestore Logs
    const snap = await getDocs(collection(db, "packtrack_logs"));
    const logs = snap.docs.map((d) => d.data()).filter((l) => l.trackingId);

    console.log("Logs from Firestore:", logs.length);

    // 2. ShipStation Orders
    const ssOrders = await fetchAllShipStation();
    const ssMap = new Map();

    // Build map of trackingNumber -> ShipStation order
    ssOrders.forEach((o) => {
      let tn =
        o.shipments?.[0]?.trackingNumber ||
        o.trackingNumber ||
        o.tracking_number;

      // Fulfillments[] are the most reliable source of tracking numbers
      if (!tn && Array.isArray(o.fulfillments)) {
        for (const f of o.fulfillments) {
          if (f.trackingNumber) {
            tn = f.trackingNumber;
            break;
          }
        }
      }

      // Rarely: advancedOptions.trackingNumber
      if (!tn && o.advancedOptions?.trackingNumber) {
        tn = o.advancedOptions.trackingNumber;
      }

      if (tn) {
        ssMap.set(String(tn).trim(), o);
      }
    });

    console.log("ShipStation orders with tracking:", ssMap.size);

    // 3. Merge Firestore logs + UPS + ShipStation
    const enriched = await Promise.all(
      logs.map(async (log) => {
        const trackingId = String(log.trackingId).trim();
        const ss = ssMap.get(trackingId);
        const ups = await trackUPS(trackingId);

        const base = {
          trackingNumber: trackingId,
          logDate: log.dateStr,
          status: ups.status,
          delivered: ups.delivered,
          location: ups.location,
          expectedDelivery: ups.expectedDelivery,
          lastUpdated: ups.lastUpdated,
          trackingUrl: ups.trackingUrl,
        };

        if (ss) {
          return {
            ...base,
            orderId: ss.orderId,
            orderNumber: ss.orderNumber,
            customerName: ss.billTo?.name || "Unknown",
            customerEmail: ss.customerEmail || ss.billTo?.email || "",
            items: ss.items
              ?.map((i) => `${i.quantity}x ${i.name}`)
              .join(", "),
            shipDate: ss.shipDate,
            carrierCode:
              ss.carrierCode ||
              ss.providerCode ||
              (ss.advancedOptions && ss.advancedOptions.carrierId) ||
              "UPS",
          };
        } else {
          // No ShipStation match → manual scan / non-SS label
          return {
            ...base,
            orderId: null,
            orderNumber: "Not Found",
            customerName: "Manual Scan",
            customerEmail: "",
            items: "",
            shipDate: log.dateStr,
            carrierCode: "UPS",
          };
        }
      })
    );

    // Sort by most recently updated UPS activity
    enriched.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

    res.json(enriched);
  } catch (err) {
    console.error("API Error in /orders/with-tracking:", err);
    res.status(500).json({ error: "Backend Error" });
  }
});

/* ---------------------------------------------*/

app.listen(PORT, () => console.log(`BACKEND RUNNING on ${PORT}`));

