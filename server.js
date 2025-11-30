import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const UPS_AUTH_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const UPS_TRACK_URL = "https://onlinetools.ups.com/api/track/v1/details/";

// Get UPS OAuth token
async function getUPSToken() {
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
}

app.post("/track", async (req, res) => {
  try {
    const { trackingNumber } = req.body;

    if (!trackingNumber) {
      return res.status(400).json({ error: "Tracking number required" });
    }

    const token = await getUPSToken();

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

    res.json(upsRes.data);
  } catch (err) {
    console.error("UPS Error:", err.response?.data || err.toString());
    res.status(500).json({
      error: "UPS API failed",
      detail: err.response?.data || err.toString(),
    });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("UPS backend running on", PORT));
