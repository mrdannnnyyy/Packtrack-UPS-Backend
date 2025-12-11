const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. FIREBASE SETUP ---
// We read the JSON key from an Environment Variable for security
if (process.env.FIREBASE_KEY) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("🔥 Firebase Connected!");
    } catch (e) {
        console.error("❌ Firebase Key Error:", e.message);
    }
} else {
    console.error("⚠️ FATAL: FIREBASE_KEY is missing in Cloud Run variables.");
}

const db = admin.firestore();

// --- 2. CREDENTIALS ---
const SS_API_KEY = process.env.SS_API_KEY;
const SS_API_SECRET = process.env.SS_API_SECRET;
const SS_AUTH = SS_API_KEY && SS_API_SECRET
    ? Buffer.from(`${SS_API_KEY}:${SS_API_SECRET}`).toString('base64')
    : null;

const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID;
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;

// Global UPS Token
let upsToken = null;
let upsTokenExpiry = 0;

// --- 3. HELPER FUNCTIONS ---

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
    // Skip if not UPS
    if (!trackingNumber.startsWith('1Z')) return { status: "Label Created", location: "Pre-Transit", eta: "Pending Scan" };

    try {
        const token = await getUPSToken();
        if (!token) throw new Error("No Token");

        const url = `https://onlinetools.ups.com/api/track/v1/details/${trackingNumber}?locale=en_US`;
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}`, 'transId': `sync-${Date.now()}`, 'transactionSrc': 'PackTrackPro' }
        });

        const pkg = response.data.trackResponse?.shipment?.[0]?.package?.[0];
        const activity = pkg?.activity?.[0];

        // Strict Logic
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

// --- 4. THE BACKGROUND SYNC ROBOT ---
// This function runs every 15 minutes
async function performSystemSync() {
    console.log("🤖 Background Sync Started...");
    
    // A. Fetch recent 50 shipments from ShipStation
    const ssRes = await axios.get(
        `https://ssapi.shipstation.com/shipments?includeShipmentItems=true&page=1&pageSize=50&sortBy=ShipDate&sortDir=DESC`,
        { headers: { Authorization: `Basic ${SS_AUTH}` } }
    );
    
    const shipments = ssRes.data.shipments || [];
    console.log(`📦 Analyzing ${shipments.length} shipments...`);

    const batch = db.batch();
    let count = 0;

    // B. Process each order
    for (const s of shipments) {
        const trackingNumber = s.trackingNumber || "No Tracking";
        
        // C. Track with UPS (Only if we have a number)
        let upsData = { status: "Label Created", location: "Pre-Transit", eta: "Pending Scan" };
        if (trackingNumber !== "No Tracking") {
            upsData = await trackWithUPS(trackingNumber);
        }

        // D. Prepare data for Firebase
        const orderRef = db.collection('orders').doc(String(s.orderId));
        const orderData = {
            orderId: String(s.orderId),
            orderNumber: s.orderNumber,
            shipDate: s.shipDate ? s.shipDate.split('T')[0] : "N/A",
            customerName: s.shipTo ? s.shipTo.name : "Unknown",
            items: s.shipmentItems ? s.shipmentItems.map(i => i.name).join(", ") : "",
            trackingNumber: trackingNumber,
            carrierCode: s.carrierCode || "ups",
            
            // Unified Status Fields
            status: upsData.status,
            location: upsData.location,
            eta: upsData.eta,
            expectedDelivery: upsData.eta,
            
            lastUpdated: Date.now()
        };

        // E. Add to Batch (Save to DB)
        batch.set(orderRef, orderData, { merge: true });
        count++;
    }

    // F. Commit all changes
    await batch.commit();
    console.log(`✅ Sync Complete. Updated ${count} orders in Database.`);
    return count;
}

// --- 5. ENDPOINTS ---

// INSTANT LOAD: Reads from Firebase (Super Fast)
app.get('/orders', async (req, res) => {
    try {
        const snapshot = await db.collection('orders')
            .orderBy('shipDate', 'desc')
            .limit(50)
            .get();
            
        const orders = snapshot.docs.map(doc => doc.data());
        
        res.json({
            data: orders,
            total: orders.length,
            page: 1,
            totalPages: 1,
            lastSync: Date.now() // Tells frontend "This is fresh from DB"
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Same logic for tracking page
app.get('/tracking', async (req, res) => {
    try {
        const snapshot = await db.collection('orders')
            .orderBy('shipDate', 'desc')
            .limit(50)
            .get();
        const orders = snapshot.docs.map(doc => doc.data());
        const trackable = orders.filter(o => o.trackingNumber !== "No Tracking");
        
        res.json({ data: trackable, total: trackable.length, page: 1, totalPages: 1 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// BACKGROUND TRIGGER (Cloud Scheduler hits this)
app.post('/sync/system', async (req, res) => {
    try {
        const count = await performSystemSync();
        res.json({ success: true, updated: count });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Manual Sync Button
app.post('/sync/orders', async (req, res) => {
    try {
        const count = await performSystemSync();
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Redirect Link
app.get('/:id', (req, res) => {
    const id = req.params.id;
    if (id.startsWith('1Z')) res.redirect(`https://www.ups.com/track?tracknum=${id}`);
    else res.json({ id, status: "Unknown" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server v19 (Firebase DB) running on port ${PORT}`);
});
