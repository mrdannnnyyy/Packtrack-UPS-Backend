const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- Middleware ---
// CORS allows your React app to talk to this server
app.use(cors());
app.use(express.json());

// --- Routes ---

// 1. Health Check (Important for Cloud Run)
app.get('/', (req, res) => {
    res.status(200).send('Packtrack Backend is Running!');
});

// 2. Orders Route (Fixes "Cannot GET /orders/basic")
app.get('/orders/basic', async (req, res) => {
    try {
        // TODO: Replace this mock data with actual ShipStation API calls later
        
        const mockData = {
            totalOrders: 120,
            pendingOrders: 15,
            shippedOrders: 105,
            awaitingPayment: 0,
            onHold: 0
        };
        
        console.log('Fetching orders/basic...');
        res.json(mockData);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// 3. Tracking Route (Fixes "Cannot GET /tracking/list")
app.get('/tracking/list', async (req, res) => {
    try {
        // TODO: Replace this with actual UPS/Tracking API logic
        
        const mockTracking = [
            { id: "1Z999999999", carrier: "UPS", status: "In Transit", location: "New York, NY" },
            { id: "1Z888888888", carrier: "UPS", status: "Delivered", location: "Los Angeles, CA" },
            { id: "94001000000", carrier: "USPS", status: "Out for Delivery", location: "Chicago, IL" }
        ];

        console.log('Fetching tracking/list...');
        res.json(mockTracking);
    } catch (error) {
        console.error('Error fetching tracking:', error);
        res.status(500).json({ error: 'Failed to fetch tracking list' });
    }
});

// --- Server Start (The Critical Cloud Run Fix) ---
const PORT = process.env.PORT || 8080;

// listening on '0.0.0.0' is required for Cloud Run
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
