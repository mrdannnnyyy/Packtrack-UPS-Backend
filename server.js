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
const MAX_PAGES = 100; // safety valve to avoid infinite loops

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
        }

        console.log(`Success! Found ${allOrders.length} orders across ${page} page(s).`);

        return allOrders.map(o => ({
            orderId: String(o.orderId),
            orderNumber: o.orderNumber,
            shipDate: o.shipDate ? o.shipDate.split('T')[0] : "N/A",
            customerName: o.billTo ? o.billTo.name : "Unknown",
            items: o.items ? o.items.map(i => i.name).join(", ") : "",
            trackingNumber: o.shipments && o.shipments[0] ? o.shipments[0].trackingNumber : "No Tracking",
            carrierCode: o.carrierCode || "ups",
            orderTotal: String(o.orderTotal),
            orderStatus: o.orderStatus,
            upsStatus: "Shipped",
            upsLocation: "Carrier Facility",
            upsEta: "Pending"
        }));

    } catch (error) {
        const details = error.response ? error.response.data : error.message;
        console.error("ShipStation Error:", details);
        return [];
    }
}

// 1. Health Check
app.get('/', (req, res) => res.status(200).send('PackTrack DIRECT Backend Running'));

// 2. GET ORDERS (For the Table)
app.get('/orders', async (req, res) => {
    const orders = await fetchRealOrders();
    res.json({
        data: orders,
        total: orders.length,
        page: 1,
        totalPages: 1,
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
    
    res.json({
        data: trackable,
        total: trackable.length,
        page: 1,
        totalPages: 1
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
