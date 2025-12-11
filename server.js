const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- CREDENTIALS ---
const SS_API_KEY = process.env.SS_API_KEY;
const SS_API_SECRET = process.env.SS_API_SECRET;
const SS_AUTH = SS_API_KEY && SS_API_SECRET
    ? Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString('base64')
    : null;

const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;

// --- CONFIG ---
const PAGE_SIZE = 50; 
const TRACKING_CACHE_MS = 15 * 60 * 1000; // 15 mins

// --- IN-MEMORY CACHE ---
const trackingCache = new Map();

// UPS Token Storage
let upsToken = null;
let upsTokenExpiry = 0;

// --- HELPER: Get UPS Access Token ---
async function getUPSToken() {
    if (upsToken && Date.now() < upsTokenExpiry) return upsToken;

    if (!UPS_CLIENT_ID || !UPS_CLIENT_SECRET) return null;

    try {
        const credentials = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString('base64');
        const response = await axios.post(
            'https://onlinetools.ups.com/security/v1/oauth/token',
            'grant_type=client_credentials',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${credentials}`
                }
            }
        );
        
        upsToken = response.data.access_token;
        upsTokenExpiry = Date.now() + (3500 * 1000); 
        return upsToken;
    } catch (error) {
        console.error("❌ UPS Auth Error:", error.response?.data || error.message);
        return null;
    }
}

// --- HELPER: Track Single Package ---
async function trackWithUPS(trackingNumber) {
    if (trackingCache.has(trackingNumber)) {
        const cached = trackingCache.get(trackingNumber);
        if (Date.now() - cached.timestamp < TRACKING_CACHE_MS) return cached.data;
    }

    const fallback = { status: "Shipped", location: "ShipStation Label", eta: "Pending" };
    if (!trackingNumber.startsWith('1Z')) return fallback;

    try {
        const token = await getUPSToken();
        if (!token) return fallback;

        const url = `https://onlinetools.ups.com/api/track/v1/details/${trackingNumber}?locale=en_US`;
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'transId': `req-${Date.now()}`,
                'transactionSrc': 'PackTrackPro'
            },
            timeout: 5000 
        });

        const pkg = response.data.trackResponse?.shipment?.[0]?.package?.[0];
        const activity = pkg?.activity?.[0];
        const formatUPSDate = (d) => d && d.length === 8 ? `${d.substr(4,2)}/${d.substr(6,2)}/${d.substr(0,4)}` : "Pending";

        const result = {
            status: activity?.status?.description || "In Transit",
            location: activity?.location?.address?.city 
                ? `${activity.location.address.city}, ${activity.location.address.stateProvince}` 
                : "In Transit",
            eta: formatUPSDate(pkg?.deliveryDate?.[0]?.date)
        };

        trackingCache.set(trackingNumber, { data: result, timestamp: Date.now() });
        return result;

    } catch (error) {
        return fallback;
    }
}

// --- MAIN: Fetch Shipments + Enrich ---
async function fetchRealOrders(page = 1) {
    if (!SS_AUTH) return [];

    try {
        console.log(`🔌 Fetching Shipments Page ${page}...`);
        const ssRes = await axios.get(
            `https://ssapi.shipstation.com/shipments?includeShipmentItems=true&page=${page}&pageSize=${PAGE_SIZE}&sortBy=ShipDate&sortDir=DESC`,
            { headers: { Authorization: `Basic ${SS_AUTH}` } }
        );
        
        const shipments = Array.isArray(ssRes.data?.shipments) ? ssRes.data.shipments : [];
        
        const enriched = await Promise.all(shipments.map(async (s) => {
            const trackingNumber = s.trackingNumber || "No Tracking";
            let upsData = { status: "Shipped", location: "Label Created", eta: "Pending" };
            
            if (trackingNumber !== "No Tracking") {
                upsData = await trackWithUPS(trackingNumber);
            }

            return {
                orderId: String(s.orderId),
                orderNumber: s.orderNumber,
                shipDate: s.shipDate ? s.shipDate.split('T')[0] : "N/A",
                customerName: s.shipTo ? s.shipTo.name : "Unknown",
                items: s.shipmentItems ? s.shipmentItems.map(i => i.name).join(", ") : "",
                trackingNumber: trackingNumber,
                carrierCode: s.carrierCode || "ups",
                upsStatus: upsData.status,
                upsLocation: upsData.location,
                upsEta: upsData.eta,
                orderStatus: "shipped",
                orderTotal: "0.00"
            };
        }));

        return { data: enriched, total: ssRes.data.total, pages: ssRes.data.pages };

    } catch (error) {
        console.error("❌ Sync Error:", error.message);
        return { data: [], total: 0, pages: 0 };
    }
}

// --- ROUTES ---

app.get('/', (req, res) => res.status(200).send('PackTrack v13 (Smart Redirect) Running'));

app.get('/orders', async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const result = await fetchRealOrders(page);
    res.json({
        data: result.data,
        total: result.total,
        page: page,
        totalPages: result.pages,
        lastSync: Date.now()
    });
});

app.get('/tracking', async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const result = await fetchRealOrders(page);
    const trackable = result.data.filter(o => o.trackingNumber !== "No Tracking");
    res.json({
        data: trackable,
        total: trackable.length,
        page: page,
        totalPages: result.pages
    });
});

app.post('/sync/orders', async (req, res) => {
    trackingCache.clear();
    const result = await fetchRealOrders(1);
    if (result.data.length > 0) res.json({ success: true, count: result.data.length });
    else res.status(500).json({ success: false });
});

// --- NEW FEATURE: SMART REDIRECT ---
// If you visit /1Z... it redirects to UPS automatically!
app.get('/:id', (req, res) => {
    const id = req.params.id;
    if (id.startsWith('1Z')) {
        res.redirect(`https://www.ups.com/track?tracknum=${id}`);
    } else {
        res.json({ id: id, status: "Unknown Endpoint" });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server v13 (Smart Redirect) running on port ${PORT}`);
});
