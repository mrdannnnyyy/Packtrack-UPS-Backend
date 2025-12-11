const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- AUTHENTICATION ---
const SS_API_KEY = process.env.SS_API_KEY;
const SS_API_SECRET = process.env.SS_API_SECRET;
const SS_AUTH = SS_API_KEY && SS_API_SECRET
    ? Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString('base64')
    : null;

const PAGE_SIZE = 50;
const MAX_PAGES = 5; 
const CACHE_TTL_MS = 60000; 
const PAGE_DELAY_MS = 200; 

let ordersCache = { fetchedAt: 0, data: [] };
let inFlightOrders = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- HELPER: Fetch Shipments (Instead of Orders) ---
async function fetchShipStationPage(page = 1) {
    const response = await axios.get(
        // SWITCHED ENDPOINT TO /shipments
        // includeShipmentItems=true ensures we see what is inside the box
        `https://ssapi.shipstation.com/shipments?includeShipmentItems=true&page=${page}&pageSize=${PAGE_SIZE}&sortBy=ShipDate&sortDir=DESC`,
        {
            headers: {
                Authorization: `Basic ${SS_AUTH}`,
                "Content-Type": "application/json"
            }
        }
    );
    // The shipments endpoint returns "shipments", not "orders"
    return Array.isArray(response.data?.shipments) ? response.data.shipments : [];
}

async function fetchRealOrders() {
    const now = Date.now();
    if (ordersCache.fetchedAt && now - ordersCache.fetchedAt < CACHE_TTL_MS) {
        return ordersCache.data;
    }

    if (inFlightOrders) return inFlightOrders;

    inFlightOrders = (async () => {
        if (!SS_AUTH) {
            console.error("❌ API keys missing.");
            return [];
        }

        try {
            console.log("🔌 Connecting to ShipStation (Shipments API)...");
            let page = 1;
            const allShipments = [];

            while (page <= MAX_PAGES) {
                const pageShipments = await fetchShipStationPage(page);
                if (!pageShipments.length) break;
                
                // Debug: Print first shipment to confirm we see tracking
                if (page === 1 && pageShipments.length > 0) {
                     const s = pageShipments[0];
                     console.log("🔍 [DEBUG] SHIPMENT DATA:", s.trackingNumber);
                }

                allShipments.push(...pageShipments);
                if (pageShipments.length < PAGE_SIZE) break;
                page++;
                await sleep(PAGE_DELAY_MS);
            }

            console.log(`✅ Loaded ${allShipments.length} shipments.`);

            const mapped = allShipments.map(s => {
                // Shipments endpoint puts the name in 'shipTo', not 'billTo'
                const customerName = s.shipTo ? s.shipTo.name : "Unknown";
                
                // Items mapping
                const itemsStr = s.shipmentItems 
                    ? s.shipmentItems.map(i => i.name).join(", ") 
                    : "";

                return {
                    orderId: String(s.orderId),
                    orderNumber: s.orderNumber,
                    shipDate: s.shipDate ? s.shipDate.split('T')[0] : "N/A",
                    customerName: customerName,
                    items: itemsStr,
                    trackingNumber: s.trackingNumber || "No Tracking", // Guaranteed here
                    carrierCode: s.carrierCode || "ups",
                    orderTotal: "0.00", // Shipments don't always have order totals
                    orderStatus: "shipped",
                    upsStatus: "Shipped",
                    upsLocation: "Carrier Facility",
                    upsEta: "Pending"
                };
            });

            ordersCache = { fetchedAt: Date.now(), data: mapped };
            return mapped;

        } catch (error) {
            console.error("❌ Sync Error:", error.message);
            return [];
        } finally {
            inFlightOrders = null;
        }
    })();

    return inFlightOrders;
}

// 1. Health Check
app.get('/', (req, res) => res.status(200).send('PackTrack V11 (Shipments API) Running'));

// 2. GET ORDERS
app.get('/orders', async (req, res) => {
    const orders = await fetchRealOrders();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    
    const start = (page - 1) * limit;
    const paged = orders.slice(start, start + limit);
    const totalPages = Math.ceil(orders.length / limit) || 1;

    res.json({
        data: paged,
        total: orders.length,
        page,
        totalPages,
        lastSync: Date.now()
    });
});

// 3. GET TRACKING
app.get('/tracking', async (req, res) => {
    const orders = await fetchRealOrders();
    const trackable = orders
        .filter(o => o.trackingNumber !== "No Tracking")
        .map(o => ({
            orderNumber: o.orderNumber,
            trackingNumber: o.trackingNumber,
            upsStatus: o.upsStatus,
            location: o.upsLocation,
            delivered: false,
            expectedDelivery: o.upsEta,
            lastUpdated: Date.now(),
            trackingUrl: `https://www.ups.com/track?tracknum=${o.trackingNumber}`,
            isError: false
        }));

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const start = (page - 1) * limit;
    const paged = trackable.slice(start, start + limit);
    const totalPages = Math.ceil(trackable.length / limit) || 1;

    res.json({ data: paged, total: trackable.length, page, totalPages });
});

// 4. SYNC
app.post('/sync/orders', async (req, res) => {
    ordersCache = { fetchedAt: 0, data: [] };
    const orders = await fetchRealOrders();
    if (orders.length > 0) res.json({ success: true, count: orders.length });
    else res.status(500).json({ success: false });
});

// 5. LINK FIX
app.get('/:trackingId/list', (req, res) => {
    res.json({ id: req.params.trackingId, status: "Unknown", location: "Lookup Pending" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server v11 (Shipments API) running on port ${PORT}`);
});
