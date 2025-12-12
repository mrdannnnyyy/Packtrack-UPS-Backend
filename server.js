const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. FIREBASE SETUP ---
let db = null;
function initializeFirebase() {
    const key = process.env.FIREBASE_KEY;
    if (!key) { console.warn("⚠️ SKIPPING DB: FIREBASE_KEY empty."); return null; }
    const cleanKey = key.trim();
    if (!cleanKey.startsWith('{')) {
        console.error(`❌ KEY ERROR: Starts with '${cleanKey.substring(0, 5)}...'. Must start with '{'.`);
        return null;
    }
    try {
        const formattedKey = cleanKey.replace(/\\n/g, '\n');
        const serviceAccount = JSON.parse(formattedKey);
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("🔥 Firebase Connected!");
        return admin.firestore();
    } catch (e) {
        console.error("❌ FIREBASE CRASH:", e.message);
        return null;
    }
}
db = initializeFirebase();

// --- 2. CONFIG ---
const SS_API_KEY = process.env.SS_API_KEY;
const SS_API_SECRET = process.env.SS_API_SECRET;
const SS_AUTH = SS_API_KEY && SS_API_SECRET
    ? Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString('base64')
    : null;

const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;

// Max pages to sync (5 pages * 50 orders = 250 orders)
const MAX_PAGES = 5; 

// --- 3. UPS HELPERS ---
let upsToken = null;
let upsTokenExpiry = 0;

async function getUPSToken() {
    if (upsToken && Date.now() < upsTokenExpiry) return upsToken;
    if (!UPS_CLIENT_ID || !UPS_CLIENT_SECRET) return null;
    try {
        const credentials = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString('base64');
        const response = await axios.post(
            'https://onlinetools.ups.com/security/v1/oauth/token',
            'grant_type=client_credentials',
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` } }
        );
        upsToken = response.data.access_token;
        upsTokenExpiry = Date.now() + (3500 * 1000); 
        return upsToken;
    } catch (error) { return null; }
}

async function trackWithUPS(trackingNumber) {
    if (!trackingNumber.startsWith('1Z')) return { status: "Label Created", location: "Pre-Transit", eta: "Pending Scan" };
    try {
        const token = await getUPSToken();
        if (!token) throw new Error("No Token");
        
        const url = `https://onlinetools.ups.com/api/track/v1/details/${trackingNumber}?locale=en_US`;
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}`, 'transId': `sync-${Date.now()}`, 'transactionSrc': 'PackTrackPro' },
            timeout: 5000
        });

        const pkg = response.data.trackResponse?.shipment?.[0]?.package?.[0];
        const activity = pkg?.activity?.[0];

        let status = activity?.status?.description || "Label Created";
        let location = activity?.location?.address?.city 
            ? `${activity.location.address.city}, ${activity.location.address.stateProvince}` 
            : "Pre-Transit";
        
        let rawDate = pkg?.deliveryDate?.[0]?.date || pkg?.date;
        let eta = "Pending Scan";
        if (rawDate && rawDate.length === 8) {
             eta = `${rawDate.substr(4,2)}/${rawDate.substr(6,2)}/${rawDate.substr(0,4)}`;
        }
        return { status, location, eta };
    } catch (e) {
        return { status: "Label Created", location: "Pre-Transit", eta: "Pending Scan" };
    }
}

// --- 4. DATA MODES ---

// MODE A: Live Fetch (Fallback)
async function fetchLiveOrders(page = 1) {
    if (!SS_AUTH) return { data: [], total: 0, pages: 0 };
    try {
        const ssRes = await axios.get(
            `https://ssapi.shipstation.com/shipments?includeShipmentItems=true&page=${page}&pageSize=50&sortBy=ShipDate&sortDir=DESC`,
            { headers: { Authorization: `Basic ${SS_AUTH}` } }
        );
        const shipments = ssRes.data.shipments || [];
        const enriched = await Promise.all(shipments.map(async (s) => {
            const trackingNumber = s.trackingNumber || "No Tracking";
            let upsData = { status: "Label Created", location: "Pre-Transit", eta: "Pending Scan" };
            if (trackingNumber !== "No Tracking") upsData = await trackWithUPS(trackingNumber);
            return {
                orderId: String(s.orderId),
                orderNumber: s.orderNumber,
                shipDate: s.shipDate ? s.shipDate.split('T')[0] : "N/A",
                customerName: s.shipTo ? s.shipTo.name : "Unknown",
                items: s.shipmentItems ? s.shipmentItems.map(i => i.name).join(", ") : "",
                trackingNumber: trackingNumber,
                carrierCode: s.carrierCode || "ups",
                status: upsData.status, location: upsData.location, eta: upsData.eta,
                upsStatus: upsData.status, upsLocation: upsData.location, upsEta: upsData.eta,
                expectedDelivery: upsData.eta,
                orderStatus: "shipped"
            };
        }));
        return { data: enriched, total: ssRes.data.total, pages: ssRes.data.pages };
    } catch (e) { return { data: [], total: 0, pages: 0 }; }
}

// MODE B: Sync (The Robot) - NOW MULTI-PAGE
async function performSystemSync() {
    if (!db) throw new Error("Database not connected");
    console.log("🤖 Multi-Page Sync Started...");
    
    let page = 1;
    let totalSynced = 0;

    // Loop through pages 1 to 5
    while (page <= MAX_PAGES) {
        try {
            console.log(`   ... Fetching Page ${page}`);
            const ssRes = await axios.get(
                `https://ssapi.shipstation.com/shipments?includeShipmentItems=true&page=${page}&pageSize=50&sortBy=ShipDate&sortDir=DESC`,
                { headers: { Authorization: `Basic ${SS_AUTH}` } }
            );
            const shipments = ssRes.data.shipments || [];
            if (shipments.length === 0) break; // Stop if no more orders

            const batch = db.batch();
            
            // Process this page in parallel (Fast!)
            await Promise.all(shipments.map(async (s) => {
                const trackingNumber = s.trackingNumber || "No Tracking";
                let upsData = { status: "Label Created", location: "Pre-Transit", eta: "Pending Scan" };
                if (trackingNumber !== "No Tracking") upsData = await trackWithUPS(trackingNumber);
                
                const orderRef = db.collection('orders').doc(String(s.orderId));
                batch.set(orderRef, {
                    orderId: String(s.orderId),
                    orderNumber: s.orderNumber,
                    shipDate: s.shipDate ? s.shipDate.split('T')[0] : "N/A",
                    customerName: s.shipTo ? s.shipTo.name : "Unknown",
                    items: s.shipmentItems ? s.shipmentItems.map(i => i.name).join(", ") : "",
                    trackingNumber: trackingNumber,
                    carrierCode: s.carrierCode || "ups",
                    status: upsData.status, location: upsData.location, eta: upsData.eta,
                    upsStatus: upsData.status, upsLocation: upsData.location, upsEta: upsData.eta,
                    expectedDelivery: upsData.eta,
                    lastUpdated: Date.now()
                }, { merge: true });
            }));

            await batch.commit();
            totalSynced += shipments.length;
            
            // Stop if we reached the last page of data
            if (shipments.length < 50) break;
            page++;
            
            // Tiny pause to be nice to APIs
            await new Promise(r => setTimeout(r, 200));

        } catch (e) {
            console.error(`❌ Page ${page} failed:`, e.message);
            break; 
        }
    }
    console.log(`✅ Sync Complete. Total: ${totalSynced}`);
    return totalSynced;
}

// --- 5. ENDPOINTS ---
app.get('/orders', async (req, res) => {
    if (db) {
        try {
            const snapshot = await db.collection('orders').orderBy('shipDate', 'desc').limit(250).get();
            const orders = snapshot.docs.map(doc => doc.data());
            if (orders.length > 0) return res.json({ data: orders, total: orders.length, page: 1, totalPages: 1, source: "Database" });
        } catch (e) {}
    }
    const live = await fetchLiveOrders(1);
    res.json({ ...live, source: "Live (Fallback)" });
});

app.get('/tracking', async (req, res) => {
    if (db) {
        try {
            const snapshot = await db.collection('orders').orderBy('shipDate', 'desc').limit(250).get();
            const orders = snapshot.docs.map(doc => doc.data());
            const trackable = orders.filter(o => o.trackingNumber !== "No Tracking");
            if (trackable.length > 0) return res.json({ data: trackable, total: trackable.length, page: 1, totalPages: 1 });
        } catch (e) {}
    }
    const live = await fetchLiveOrders(1);
    const trackable = live.data.filter(o => o.trackingNumber !== "No Tracking");
    res.json({ data: trackable, total: trackable.length, page: 1, totalPages: live.pages });
});

app.post('/sync/system', async (req, res) => {
    if (!db) return res.status(503).json({ success: false, error: "DB Error" });
    try {
        const count = await performSystemSync();
        res.json({ success: true, updated: count });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/sync/orders', async (req, res) => {
    if (db) {
        try {
            const count = await performSystemSync();
            return res.json({ success: true, count });
        } catch (e) {}
    }
    const live = await fetchLiveOrders(1);
    res.json({ success: true, count: live.data.length });
});

app.get('/:id', (req, res) => {
    const id = req.params.id;
    if (id.startsWith('1Z')) res.redirect(`https://www.ups.com/track?tracknum=${id}`);
    else res.json({ id, status: "Unknown" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server v22 (Multi-Page Workhorse) running on port ${PORT}`);
});
