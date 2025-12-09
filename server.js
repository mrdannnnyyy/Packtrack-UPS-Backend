// ==========================
// PackTrack Backend (Rate Limited / UPS Token Cached / ShipStation Batch Safe)
// ==========================

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { initializeApp } = require("firebase/app");
const { getFirestore, collection, getDocs } = require("firebase/firestore");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================
// FIREBASE CONFIG
// ==========================
const firebaseConfig = {
  apiKey: "AIzaSyAKbvODxE_ULiag9XBXHnAJO4b-tGWSq0w",
  authDomain: "time-tracking-67712.firebaseapp.com",
  projectId: "time-tracking-67712",
  storageBucket: "time-tracking-67712.firebasestorage.app",
  messagingSenderId: "829274875816",
  appId: "1:829274875816:web:ee9e8046d22a115e42df9d",
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ==========================
// ENVIRONMENT CREDENTIALS
// ==========================
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;

const SS_API_KEY = process.env.SS_API_KEY;
const SS_API_SECRET = process.env.SS_API_SECRET;

const UPS_OAUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const UPS_TRACKING_BASE_URL = "https://onlinetools.ups.com/api/track/v1/details/";

// ==========================
// UPS TOKEN CACHE
// ==========================
let upsToken = null;
let upsTokenExpires = 0;

async function getUPSToken() {
  const now = Date.now();
  if (upsToken && now < upsTokenExpires) {
    return upsToken; // reuse existing token for 60 minutes
  }

  console.log("🔑 Fetching NEW UPS token...");

  const credentials = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString("base64");

  const response = await axios.post(
    UPS_OAUTH_URL,
    "grant_type=client_credentials",
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
    }
  );

  upsToken = response.data.access_token;
  upsTokenExpires = now + 60 * 60 * 1000; // 1 hour lifetime

  console.log("✅ UPS token refreshed");
  return upsToken;
}

// ==========================
// RATE LIMIT QUEUES
// ==========================
function createQueue(delayMs) {
  let queue = Promise.resolve();

  return function enqueue(task) {
    queue = queue.then(() => new Promise((resolve) => {
      setTimeout(async () => resolve(await task()), delayMs);
    }));
    return queue;
  };
}

// 1 request per second to UPS
const upsQueue = createQueue(1000);

// 1 request per second to ShipStation
const ssQueue = createQueue(1000);

// ==========================
// UPS TRACKING (SAFE)
// ==========================
async function trackUPS(trackingNumber) {
  return upsQueue(async () => {
    try {
      const token = await getUPSToken();

      const url =
        `${UPS_TRACKING_BASE_URL}${trackingNumber}?locale=en_US&returnSignature=false`;

      const res = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          transId: `id-${Date.now()}`,
          transactionSrc: "PackTrackPro",
        },
        timeout: 10000,
      });

      const pkg = res.data.trackResponse?.shipment?.[0]?.package?.[0];
      const activity = pkg?.activity?.[0];

      const formatDate = (raw) =>
        raw && raw.length === 8
          ? `${raw.substring(4, 6)}/${raw.substring(6, 8)}/${raw.substring(0, 4)}`
          : "--";

      return {
        status: activity?.status?.description || "Unknown",
        location:
          [activity?.location?.address?.city, activity?.location?.address?.stateProvince]
            .filter(Boolean)
            .join(", "),
        expectedDelivery: formatDate(pkg?.deliveryDate?.[0]?.date),
        delivered: (activity?.status?.description || "").toLowerCase().includes("delivered"),
        lastUpdated: Date.now(),
        trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
      };
    } catch (err) {
      return {
        status: "Pending Update",
        expectedDelivery: "--",
        delivered: false,
        location: "",
        lastUpdated: Date.now(),
        error: true,
      };
    }
  });
}

// ==========================
// SHIPSTATION ORDER LOOKUP (SHIPMENTS ENDPOINT)
// ==========================
async function getShipStationByTracking(trackingNumber) {
  return ssQueue(async () => {
    try {
      const auth = Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString("base64");

      const res = await axios.get(
        `https://ssapi.shipstation.com/shipments?trackingNumber=${trackingNumber}`,
        {
          headers: { Authorization: `Basic ${auth}` },
          timeout: 10000,
        }
      );

      return res.data.shipments?.[0] || null;
    } catch (err) {
      console.log("ShipStation lookup error:", err.message);
      return null;
    }
  });
}

// ==========================
// MAIN ENDPOINT
// ==========================
app.get("/orders/with-tracking", async (req, res) => {
  try {
    console.log("🔄 Syncing Firestore + ShipStation + UPS...");

    // Load Firestore logs
    const logsSnap = await getDocs(collection(db, "packtrack_logs"));
    const logs = logsSnap.docs.map((d) => d.data());
    const validLogs = logs.filter((l) => l.trackingId?.length > 5);

    console.log(`📦 Found ${validLogs.length} tracking logs.`);

    // Process each entry
    const enriched = [];

    for (const log of validLogs) {
      const tracking = log.trackingId;

      const [ssOrder, upsData] = await Promise.all([
        getShipStationByTracking(tracking),
        trackUPS(tracking),
      ]);

      if (ssOrder) {
        enriched.push({
          orderId: ssOrder.orderId,
          orderNumber: ssOrder.orderNumber,
          customerName: ssOrder.shipTo?.name || "",
          customerEmail: ssOrder.customerEmail || "",
          items: "Unknown (ShipStation does not return items in shipments endpoint)",
          shipDate: ssOrder.shipDate || "--",
          trackingNumber: tracking,
          carrierCode: ssOrder.carrierCode || "ups",
          ...upsData,
        });
      } else {
        enriched.push({
          orderId: 0,
          orderNumber: "Manual Log",
          customerName: "Unknown (Manual)",
          items: "Manual Entry",
          shipDate: log.dateStr || "--",
          trackingNumber: tracking,
          ...upsData,
        });
      }
    }

    res.json(enriched);
  } catch (error) {
    console.error("SERVER ERROR:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================
// START SERVER
// ==========================
app.listen(PORT, () => console.log(`🚀 Backend running on ${PORT}`));
