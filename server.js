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
// Basic Auth String for ShipStation (only if keys are present)
const SS_AUTH = SS_API_KEY && SS_API_SECRET
    ? Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString('base64')
    : null;

const PAGE_SIZE = 50;
const MAX_PAGES = 5; // safety valve to avoid infinite loops
const CACHE_TTL_MS = 180000; // avoid hammering ShipStation; adjust if needed
const PAGE_DELAY_MS = 500; // pause between pages to reduce 429s

let ordersCache = {
    fetchedAt: 0,
    data: []
};

let inFlightOrders = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- HELPER: Fetch a single page from ShipStation ---
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
    const orders = Array.isArray(response.data?.orders) ? response.data.orders : [];
    return orders;
}

// --- HELPER: Fetch all pages from ShipStation ---
async function fetchRealOrders() {
    const now = Date.now();
    if (ordersCache.fetchedAt && now - ordersCache.fetchedAt < CACHE_TTL_MS) {
        return ordersCache.data;
    }

    // Reuse ongoing fetch to avoid concurrent hammering
    if (inFlightOrders) {
        return inFlightOrders;
    }

    inFlightOrders = (async () => {
        if (!SS_AUTH) {
            console.error("API keys missing. Please set SS_API_KEY and SS_API_SECRET.");
            return [];
        }

        try {
            console.log("Fetching live orders from ShipStation (all pages)...");
            let page = 1;
            const allOrders = [];

            while (page <= MAX_PAGES) {
                const pageOrders = await fetchShipStationPage(page);
                if (!pageOrders.length) {
                    break; // no more orders returned
                }

                allOrders.push(...pageOrders);
                if (pageOrders.length < PAGE_SIZE) {
                    break; // last page reached
                }
                page += 1;
                await sleep(PAGE_DELAY_MS); // small pause to be gentle with rate limits
            }

            console.log(`Success! Found ${allOrders.length} orders across ${page} page(s).`);

            const mapped = allOrders.map(o => {
                // Prefer shipment tracking number, then fall back to top-level trackingNumber
                const finalTracking = o.shipments && o.shipments.length > 0 && o.shipments[0].trackingNumber
                    ? o.shipments[0].trackingNumber
                    : (o.trackingNumber || "No Tracking");

                return {
                    orderId: String(o.orderId),
                    orderNumber: o.orderNumber,
                    shipDate: o.shipDate ? o.shipDate.split('T')[0] : "N/A",
                    customerName: o.billTo ? o.billTo.name : "Unknown",
                    items: o.items ? o.items.map(i => i.name).join(", ") : "",
                    trackingNumber: finalTracking,
                    carrierCode: o.carrierCode || (o.shipments && o.shipments[0] && o.shipments[0].carrierCode) || "ups",
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
            if (error.response?.status === 429) {
                console.error("ShipStation Error: Too Many Requests. Using last cached data if available.");
                if (ordersCache.data.length) return ordersCache.data;
            }
            const details = error.response ? error.response.data : error.message;
            console.error("ShipStation Error:", details);
            return [];
        } finally {
            // Clear in-flight marker
            inFlightOrders = null;
        }
    })();

    return inFlightOrders;
}

// 1. Health Check
app.get('/', (req, res) => res.status(200).send('PackTrack DIRECT Backend Running'));

// 2. GET ORDERS (For the Table)
app.get('/orders', async (req, res) => {
    const orders = await fetchRealOrders();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || orders.length || 1;
    const start = (page - 1) * limit;
    const paged = orders.slice(start, start + limit);
    const totalPages = Math.max(1, Math.ceil(orders.length / limit));
    res.json({
        data: paged,
        total: orders.length,
        page,
        totalPages,
        lastSync: Date.now()
    });
});

// 3. GET TRACKING (For the Table)
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
    const limit = parseInt(req.query.limit, 10) || trackable.length || 1;
    const start = (page - 1) * limit;
    const paged = trackable.slice(start, start + limit);
    const totalPages = Math.max(1, Math.ceil(trackable.length / limit));

    res.json({
        data: paged,
        total: trackable.length,
        page,
        totalPages
    });
});

// 4. SYNC
app.post('/sync/orders', async (req, res) => {
    const orders = await fetchRealOrders();
    if (orders.length > 0) {
        res.json({ success: true, count: orders.length, message: "Sync Successful" });
    } else {
        res.status(500).json({ success: false, message: "Sync Failed" });
    }
});

// 5. LINK FIX (Prevents 404 Error when clicking tracking links)
app.get('/:trackingId/list', (req, res) => {
    // This dummy response stops the 404 error so the page can load
    res.json({ id: req.params.trackingId, status: "Unknown", location: "Lookup Pending" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server v5 (Direct Mode + Fix) running on port ${PORT}`);
});
