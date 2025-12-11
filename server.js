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

// --- HELPER: Fetch a single page ---
async function fetchShipStationPage(page = 1) {
    const response = await axios.get(
        `https://ssapi.shipstation.com/orders?orderStatus=shipped&page=${page}&pageSize=${PAGE_SIZE}&sortBy=OrderDate&sortDir=DESC`,
        {
            headers: {
                Authorization: `Basic ${SS_AUTH}`,
                "Content-Type": "application/json"
            }
        }
    );
    return Array.isArray(response.data?.orders) ? response.data.orders : [];
}

// --- HELPER: Fetch ALL pages ---
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
            console.log("🔌 Connecting to ShipStation (Reading all pages)...");
            let page = 1;
            const allOrders = [];

            while (page <= MAX_PAGES) {
                const pageOrders = await fetchShipStationPage(page);
                if (!pageOrders.length) break;
                
                // --- DEBUG: LOG THE FIRST ORDER TO SEE STRUCTURE ---
                // This is the CRITICAL part you are missing in v5
                if (page === 1 && pageOrders.length > 0) {
                    console.log("🔍 [DEBUG] RAW ORDER DATA:", JSON.stringify(pageOrders[0], null, 2));
                }
                
                allOrders.push(...pageOrders);
                if (pageOrders.length < PAGE_SIZE) break;
                page++;
                await sleep(PAGE_DELAY_MS);
            }

            console.log(`✅ Success! Loaded ${allOrders.length} total orders.`);

            const mapped = allOrders.map(o => {
                // ROBUST TRACKING FINDER
                let finalTracking = "No Tracking";
                
                if (o.shipments && o.shipments.length > 0) {
                    finalTracking = o.shipments[0].trackingNumber || "No Tracking";
                } 
                else if (o.trackingNumber) {
                    finalTracking = o.trackingNumber;
                }

                return {
                    orderId: String(o.orderId),
                    orderNumber: o.orderNumber,
                    shipDate: o.shipDate ? o.shipDate.split('T')[0] : "N/A",
                    customerName: o.billTo ? o.billTo.name : "Unknown",
                    items: o.items ? o.items.map(i => i.name).join(", ") : "",
                    trackingNumber: finalTracking,
                    carrierCode: o.carrierCode || "ups",
                    orderTotal: String(o.orderTotal),
                    orderStatus: o.orderStatus,
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
app.get('/', (req, res) => res.status(200).send('PackTrack DEBUG Backend Running'));

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
    // THIS LINE IS HOW WE KNOW IF IT WORKED
    console.log(`🚀 Server v8 (Debug Mode) running on port ${PORT}`);
});
