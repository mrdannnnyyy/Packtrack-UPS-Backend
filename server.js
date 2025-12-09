const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs } = require('firebase/firestore');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---

// 1. FIREBASE CONFIG (Copied from your frontend)
const firebaseConfig = {
  apiKey: "AIzaSyAKbvODxE_ULiag9XBXHnAJO4b-tGWSq0w",
  authDomain: "time-tracking-67712.firebaseapp.com",
  projectId: "time-tracking-67712",
  storageBucket: "time-tracking-67712.firebasestorage.app",
  messagingSenderId: "829274875816",
  appId: "1:829274875816:web:ee9e8046d22a115e42df9d"
};

// Initialize Firebase Server-Side
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// 2. UPS CREDENTIALS
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID || '9qBB9J4GXk4ex6kqVIkrfqqgQCmj4UIYo5cxmz4UamZtxS1T';
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET || 'JUhoZG0360GgSYdW8bAhLX4mzB2mYA1sIG2GIiyPnLeWdNoIecJ0LoN9wo9jOxGp';
const UPS_OAUTH_URL = 'https://onlinetools.ups.com/security/v1/oauth/token';
const UPS_TRACKING_BASE_URL = 'https://onlinetools.ups.com/api/track/v1/details/';

// 3. SHIPSTATION CREDENTIALS (REPLACE WITH YOURS)
const SS_API_KEY = process.env.SS_API_KEY || '310e27d626ab425fa808c8696486cdcf';
const SS_API_SECRET = process.env.SS_API_SECRET || '7e5657c37bcd42e087062343ea1edc0f';

// --- IN-MEMORY CACHE ---
const trackingCache = new Map();
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 Minutes

// --- HELPERS ---

async function getUPSToken() {
  const credentials = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString('base64');
  try {
    const response = await axios.post(UPS_OAUTH_URL, 'grant_type=client_credentials', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      }
    });
    return response.data.access_token;
  } catch (error) {
    console.error("UPS Auth Error:", error.message);
    throw new Error("UPS Auth Failed");
  }
}

async function trackUPS(trackingNumber) {
  // 1. Check Cache
  if (trackingCache.has(trackingNumber)) {
    const cached = trackingCache.get(trackingNumber);
    if (Date.now() - cached.timestamp < CACHE_DURATION_MS) {
      return cached.data;
    }
  }

  // 2. Fetch Fresh
  try {
    const token = await getUPSToken();
    const query = "locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false";
    const url = `${UPS_TRACKING_BASE_URL}${encodeURIComponent(trackingNumber)}?${query}`;

    const res = await axios.get(url, {
      headers: {
        'transId': `trans-${Date.now()}`,
        'transactionSrc': 'PackTrackPro',
        'Authorization': `Bearer ${token}`
      },
      timeout: 8000
    });

    const pkg = res.data.trackResponse?.shipment?.[0]?.package?.[0];
    const activity = pkg?.activity?.[0];
    
    const formatDate = (raw) => raw && raw.length === 8 ? `${raw.substring(4,6)}/${raw.substring(6,8)}/${raw.substring(0,4)}` : "--";
    
    const status = activity?.status?.description || "Unknown";
    const result = {
      status,
      location: [activity?.location?.address?.city, activity?.location?.address?.stateProvince].filter(Boolean).join(", "),
      expectedDelivery: formatDate(pkg?.deliveryDate?.[0]?.date),
      delivered: status.toLowerCase().includes("delivered"),
      lastUpdated: Date.now(),
      trackingUrl: `https://www.ups.com/track?loc=null&tracknum=${trackingNumber}&requester=WT/trackdetails`
    };

    trackingCache.set(trackingNumber, { data: result, timestamp: Date.now() });
    return result;

  } catch (e) {
    // Return safe fallback
    return {
      status: "Pending Update",
      location: "",
      expectedDelivery: "--",
      delivered: false,
      lastUpdated: Date.now(),
      trackingUrl: "",
      error: true
    };
  }
}

async function getAllShipStationOrders() {
  const auth = Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString('base64');
  let allOrders = [];
  let page = 1;
  let totalPages = 1;
  const pageSize = 500; // Max allowed by SS

  console.log("Fetching ShipStation Orders...");

  try {
    do {
      const res = await axios.get(`https://ssapi.shipstation.com/orders?orderStatus=shipped&pageSize=${pageSize}&page=${page}`, {
        headers: { 'Authorization': `Basic ${auth}` }
      });
      
      const orders = res.data.orders || [];
      allOrders = allOrders.concat(orders);
      totalPages = res.data.pages || 1;
      
      console.log(`Fetched Page ${page}/${totalPages} (${orders.length} orders)`);
      page++;
    } while (page <= totalPages);
    
    return allOrders;
  } catch (e) {
    console.error("ShipStation Fetch Error:", e.message);
    return []; // Return empty on error to not crash entire flow
  }
}

// --- MAIN ENDPOINT ---

app.get('/orders/with-tracking', async (req, res) => {
  try {
    // 1. Fetch Source of Truth: Firestore Logs
    const logsSnap = await getDocs(collection(db, 'packtrack_logs'));
    const logs = logsSnap.docs.map(d => d.data());
    
    // Filter to only logs that have a tracking ID
    const validLogs = logs.filter(l => l.trackingId && l.trackingId.length > 5);
    console.log(`Found ${validLogs.length} Firestore logs.`);

    // 2. Fetch All ShipStation Orders
    const ssOrders = await getAllShipStationOrders();
    
    // Create Map for O(1) Lookup
    const ssMap = new Map();
    ssOrders.forEach(o => {
      // Check shipment tracking
      const tracking = o.shipments?.[0]?.trackingNumber || o.trackingNumber;
      if (tracking) ssMap.set(tracking, o);
    });

    // 3. Merge & Enrich
    // We iterate through FIRESTORE logs as the primary list
    const enrichedPromises = validLogs.map(async (log) => {
      const trackingId = log.trackingId;
      const order = ssMap.get(trackingId);

      // A. Fetch UPS Data (Cached)
      const upsData = await trackUPS(trackingId);

      // B. Construct Final Object
      if (order) {
        return {
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          customerName: order.billTo?.name || "Unknown",
          customerEmail: order.customerEmail || "",
          items: order.items?.map(i => `${i.quantity}x ${i.name}`).join(', ') || "",
          shipDate: order.shipDate ? order.shipDate.split('T')[0] : "--",
          trackingNumber: trackingId,
          carrierCode: order.carrierCode || "ups",
          ...upsData // Spread UPS status/loc/etc
        };
      } else {
        // Log exists in Firestore but not found in ShipStation
        return {
          orderId: 0,
          orderNumber: "Manual Log",
          customerName: "Unknown (Manual Scan)",
          customerEmail: "",
          items: "Manual Entry",
          shipDate: log.dateStr || "--",
          trackingNumber: trackingId,
          carrierCode: "ups",
          ...upsData
        };
      }
    });

    const results = await Promise.all(enrichedPromises);
    
    // Sort by Date (Newest First)
    results.sort((a, b) => b.lastUpdated - a.lastUpdated);

    res.json(results);

  } catch (error) {
    console.error("Endpoint Error:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
