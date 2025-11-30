import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --------------------------------------------
// UPS CONSTANTS
// --------------------------------------------
const UPS_AUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const UPS_TRACK_URL = "https://onlinetools.ups.com/api/track/v1/details/";


// =====================================================
// 🔐 1. GET UPS OAUTH TOKEN
// =====================================================
async function getUPSToken() {
  try {
    const creds = Buffer.from(
      `${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`
    ).toString("base64");

    const res = await axios.post(
      UPS_AUTH_URL,
      "grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    return res.data.access_token;

  } catch (err) {
    console.error("UPS AUTH ERROR:", err.response?.data || err.toString());
    throw new Error("Failed to authenticate with UPS.");
  }
}



// =====================================================
// 📦 2. PARSE UPS RESPONSE INTO CLEAN FORMAT
// =====================================================
function parseUPSResponse(upsRaw, trackingNumber) {
  try {
    const shipment = upsRaw?.trackResponse?.shipment?.[0];
    const pkg = shipment?.package?.[0];
    const activity = pkg?.activity?.[0];

    // STATUS
    const status = activity?.status?.description || "Unknown";

    // DATE
    const dateRaw = activity?.date || null;
    let date = "--";
    if (dateRaw && dateRaw.length === 8) {
      date = `${dateRaw.substring(4, 6)}/${dateRaw.substring(6, 8)}/${dateRaw.substring(0, 4)}`;
    }

    // LOCATION
    const addr = activity?.location?.address || {};
    const location = `${addr.city || ""} ${addr.stateProvince || ""} ${addr.country || ""}`.trim();

    // DELIVERED
    const delivered = status.toLowerCase().includes("delivered");

    // EXPECTED DELIVERY
    const expected = pkg?.deliveryDate?.[0]?.date || null;
    let expectedDelivery = "--";
    if (expected && expected.length === 8) {
      expectedDelivery = `${expected.substring(4, 6)}/${expected.substring(6, 8)}/${expected.substring(0, 4)}`;
    }

    return {
      trackingNumber,
      status,
      date,
      location,
      delivered,
      expectedDelivery,
      trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
      error: null,
    };

  } catch (err) {
    console.error("PARSE ERROR:", err);
    return {
      trackingNumber,
      status: "Unknown",
      date: "--",
      location: "",
      delivered: false,
      expectedDelivery: "--",
      trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
      error: "Parse error",
    };
  }
}



// =====================================================
// 🛣️ 3. MAIN /track ENDPOINT
// =====================================================
app.post("/track", async (req, res) => {
  const { trackingNumber } = req.body;

  if (!trackingNumber) {
    return res.status(400).json({
      error: "Tracking number is required.",
    });
  }

  try {
    // GET TOKEN
    const token = await getUPSToken();

    // REQUEST UPS API
    const upsRes = await axios.get(
      `${UPS_TRACK_URL}${trackingNumber}?locale=en_US`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          transId: `tx-${Date.now()}`,
          transactionSrc: "PackTrackPro",
        },
      }
    );

    // FORMAT RESPONSE
    const parsed = parseUPSResponse(upsRes.data, trackingNumber);

    return res.json(parsed);

  } catch (err) {
    console.error("UPS TRACK ERROR:", err.response?.data || err.toString());

    return res.status(500).json({
      trackingNumber,
      status: "Unknown",
      date: "--",
      location: "",
      delivered: false,
      expectedDelivery: "--",
      trackingUrl: `https://www.ups.com/track?tracknum=${trackingNumber}`,
      error: err.response?.data || err.toString(),
    });
  }
});



// =====================================================
// 🚀 4. START SERVER
// =====================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`UPS backend running on port ${PORT}`);
});
