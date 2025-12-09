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
   FIREBASE CONFIG
----------------------------------------------*/
initializeApp({
  apiKey: process.env.FB_KEY,
  authDomain: process.env.FB_DOMAIN,
  projectId: process.env.FB_PROJECT,
});
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

// ===================== UPS TOKEN ======================
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

// ===================== UPS TRACKING ======================
async function trackUPS(trackingNumber) {
  try {
    const token = await getUPSToken();
    if (!token) return { status: "UPS Auth Error", error: true };

    const res = await axios.get(
      `${UPS_TRACKING_URL}${encodeURIComponent(trackingNumber)}?locale=en_US`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          transId: `t-${Date.now()}`,
          transactionSrc: "PackTrack",
        },
      }
    );

    const pkg = res.data.trackResponse?.shipment?.[0]?.package?.[0];
    const act = pkg?.activity?.[0];

    return {
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
   SHIPSTATION — ALWAYS LOOKUP SHIPMENTS
----------------------------------------------*/
const SS_KEY = process.env.SS_API_KEY;
const SS_SECRET = process.env.SS_API_SECRET;

async function fetchShipment(trackingNumber) {
  try {
    const auth = Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString("base64");

    const res = await axios.get(
      `https://ssapi.shipstation.com/shipments?trackingNumber=${trackingNumber}`,
      {
        headers: { Authorization: `Basic ${auth}` },
      }
    );

    return res.data.shipments?.[0] || null;
  } catch (err) {
    console.error("ShipStation Shipment Error:", err.message);
    return null;
  }
}

/* ---------------------------------------------
   MAIN ENDPOINT — FIRESTORE + SS + UPS
----------------------------------------------*/
app.get("/orders/with-tracking", async (req, res) => {
  try {
    const snap = await getDocs(collection(db, "packtrack_logs"));
    const logs = snap.docs.map((d) => d.data());

    const results = await Promise.all(
      logs
        .filter(l => l.trackingId)
        .map(async log => {

          const shipment = await fetchShipment(log.trackingId);
          const ups = await trackUPS(log.trackingId);

          return {
            orderId: shipment?.orderId || null,
            orderNumber: shipment?.orderNumber || null,
            customerName: shipment?.shipTo?.name || "Unknown",
            customerEmail: shipment?.customerEmail || "",
            items: shipment?.shipmentItems?.map(i => `${i.quantity}x ${i.name}`).join(", ") || "",
            shipDate: shipment?.shipDate || "--",
            trackingNumber: log.trackingId,
            carrierCode: shipment?.carrierCode || "UPS",
            ...ups,
          };
        })
    );

    res.json(results);
  } catch (err) {
    console.error("API Error:", err);
    res.status(500).json({ error: "Backend Error" });
  }
});

app.listen(PORT, () => console.log(`BACKEND RUNNING on ${PORT}`));
