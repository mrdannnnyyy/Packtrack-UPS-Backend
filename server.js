const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- CREDENTIALS ---
// UPS
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID || '9qBB9J4GXk4ex6kqVIkrfqqgQCmj4UIYo5cxmz4UamZtxS1T';
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET || 'JUhoZG0360GgSYdW8bAhLX4mzB2mYA1sIG2GIiyPnLeWdNoIecJ0LoN9wo9jOxGp';
const UPS_OAUTH_URL = 'https://onlinetools.ups.com/security/v1/oauth/token';
const UPS_TRACKING_BASE_URL = 'https://onlinetools.ups.com/api/track/v1/details/';

// SHIPSTATION (REPLACE THESE WITH YOUR ACTUAL KEYS)
const SS_API_KEY = process.env.SS_API_KEY || '310e27d626ab425fa808c8696486cdcf';
const SS_API_SECRET = process.env.SS_API_SECRET || '7e5657c37bcd42e087062343ea1edc0f';

// --- IN-MEMORY CACHE ---
// key: trackingNumber, value: { data: object, timestamp: number }
const trackingCache = new Map();
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 Minutes

// --- HELPERS ---

// 1. Get UPS Token
async function getUPSToken() {
  const credentials = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString('base64');
  try {
    const response = await axios.post(UPS_OAUTH_URL, 
      'grant_type=client_credentials', 
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        }
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error("UPS Auth Error:", error.response?.data || error.message);
    throw new Error("Failed to authenticate with UPS");
  }
}

// 2. Track Single Package (Internal Function)
async function trackPackageInternal(trackingNumber) {
  // A. Check Cache
  if (trackingCache.has(trackingNumber)) {
    const cached = trackingCache.get(trackingNumber);
    const age = Date.now() - cached.timestamp;
    if (age < CACHE_DURATION_MS) {
      // console.log(`Returning cached data for ${trackingNumber}`);
      return cached.data;
    }
  }

  // B. Call API
  try {
    const token = await getUPSToken();
    const queryParams = "locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false";
    const url = `${UPS_TRACKING_BASE_URL}${encodeURIComponent(trackingNumber)}?${queryParams}`;

    const upsResponse = await axios.get(url, {
      headers: {
        'transId': `trans-${Date.now()}`,
        'transactionSrc': 'PackTrackPro',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10s timeout
    });

    const data = upsResponse.data;
    const shipment = data.trackResponse?.shipment?.[0];
    const packageData = shipment?.package?.[0];
    const activity = packageData?.activity?.[0];

    const formatDate = (raw) => {
      if (!raw || raw.length !== 8) return "--";
      return `${raw.substring(4, 6)}/${raw.substring(6, 8)}/${raw.substring(0, 4)}`;
    };

    const status = activity?.status?.description || "Unknown Status";
    const result = {
      status,
      carrier: "UPS",
      date: formatDate(activity?.date),
      location: [activity?.location?.address?.city, activity?.location?.address?.stateProvince].filter(Boolean).join(", "),
      delivered: status.toLowerCase().includes("delivered"),
      trackingUrl: `https://www.ups.com/track?loc=null&tracknum=${trackingNumber}&requester=WT/trackdetails`,
      expectedDelivery: formatDate(packageData?.deliveryDate?.[0]?.date),
      lastUpdated: Date.now()
    };

    // C. Update Cache
    trackingCache.set(trackingNumber, { data: result, timestamp: Date.now() });
    
    return result;

  } catch (error) {
    console.error(`Error tracking ${trackingNumber}:`, error.message);
    // Return error object but don't crash
    return {
      status: "Pending Update",
      carrier: "UPS",
      error: true,
      delivered: false,
      lastUpdated: Date.now()
    };
  }
}

// --- ENDPOINTS ---

// Existing Endpoint (kept for compatibility)
app.post('/track', async (req, res) => {
  const { trackingNumber } = req.body;
  if (!trackingNumber) return res.status(400).json({ error: "No ID" });
  const result = await trackPackageInternal(trackingNumber);
  res.json(result);
});

// NEW ENDPOINT: Get Orders + Tracking
app.get('/orders/with-tracking', async (req, res) => {
  try {
    // 1. Fetch Shipped Orders from ShipStation
    const auth = Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString('base64');
    
    // Fetch last 100 shipped orders
    const ssResponse = await axios.get('https://ssapi.shipstation.com/orders?orderStatus=shipped&pageSize=50&page=1', {
      headers: { 'Authorization': `Basic ${auth}` }
    });

    const orders = ssResponse.data.orders || [];

    // 2. Enrich with Tracking Data (Parallel Requests)
    const enrichedOrders = await Promise.all(orders.map(async (order) => {
      // Find valid tracking number
      const shipment = order.shipments ? order.shipments[0] : null;
      const trackingNumber = order.userId || shipment?.trackingNumber || null; // Fallback logic
      
      let trackingData = {
        status: "Not Shipped",
        location: "",
        expectedDelivery: "--",
        lastChecked: Date.now(),
        trackingUrl: "",
        delivered: false
      };

      if (trackingNumber) {
        // Only track if it looks like UPS (starts with 1Z) or just try all for now
        // Simple filter: length > 5
        if (trackingNumber.length > 5) {
           trackingData = await trackPackageInternal(trackingNumber);
        }
      }

      return {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        customerName: order.billTo.name,
        customerEmail: order.customerEmail,
        items: order.items.map(i => `${i.quantity}x ${i.name}`).join(', '),
        shipDate: order.shipDate ? order.shipDate.split('T')[0] : '--',
        trackingNumber: trackingNumber || 'No Tracking',
        carrierCode: order.carrierCode || 'Unknown',
        ...trackingData
      };
    }));

    res.json(enrichedOrders);

  } catch (error) {
    console.error("ShipStation Error:", error.response?.data || error.message);
    res.status(500).json({ 
      error: "Failed to fetch orders", 
      details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
});
