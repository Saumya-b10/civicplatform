/*************************************************
 * IMPORTS
 *************************************************/
const { defineSecret } = require("firebase-functions/params");
const OpenAI = require("openai");
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

const functions = require("firebase-functions");
const admin = require("firebase-admin");

const express = require("express");
const cors = require("cors"); // ✅ ADDED
const fetch = (...args) =>
import("node-fetch").then(({ default: fetch }) => fetch(...args));


async function downloadImageFromGCSAsBase64(imagePath) {
  const bucket = admin
    .storage()
    .bucket("civicplatform-df911.firebasestorage.app");

  console.log("🪣 USING BUCKET:", bucket.name);
  console.log("📦 RAW IMAGE PATH:", imagePath);

  const file = bucket.file(imagePath);
  const [buffer] = await file.download();

  return buffer.toString("base64");
}

function normalizeImagePath(imagePath) {
  // gs://civicplatform-df911.firebasestorage.app/uploads/...
  if (imagePath.startsWith("gs://")) {
    return imagePath.replace(
      "gs://civicplatform-df911.firebasestorage.app/",
      ""
    );
  }

  // https://firebasestorage.googleapis.com/v0/b/.../o/uploads%2F...
  if (imagePath.startsWith("https://")) {
    const decoded = decodeURIComponent(imagePath);
    return decoded.split("/o/")[1].split("?")[0];
  }

  // uploads/...
  return imagePath;
}


async function analyzeGarbageWithAI(imagePath) {
  const openai = new OpenAI({
    apiKey: OPENAI_API_KEY.value(),
  });

  const cleanPath = normalizeImagePath(imagePath);
const base64Image = await downloadImageFromGCSAsBase64(cleanPath);


  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,

    messages: [
      {
        role: "system",
        content: "You are a municipal sanitation inspector in India.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `
Respond ONLY in valid JSON.

Schema:
{
  "isPublicGarbage": true | false,
  "confidence": 0.0-1.0,
  "severity": "LOW" | "MEDIUM" | "HIGH",
  "reason": "short civic explanation"
}
Does this image show uncollected PUBLIC garbage?
            `,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content);
}


/*************************************************
 * FIREBASE INIT
 *************************************************/
admin.initializeApp({
  storageBucket: "civicplatform-df911.appspot.com",
});

const db = admin.firestore();
//GPS 


/**
 * Reverse geocode using OpenStreetMap (Nominatim)
 * Converts lat/lng → human-readable address
 */
async function reverseGeocode(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?format=jsonv2&lat=${lat}&lon=${lng}`;

  const res = await fetch(url, {
    headers: {
      // REQUIRED by OpenStreetMap usage policy
      "User-Agent": "CleanCityApp/1.0 (educational project)",
    },
  });

  if (!res.ok) {
    throw new Error("Reverse geocoding request failed");
  }

  const data = await res.json();

  // display_name is the most readable address
  return data.display_name || null;
}

/*************************************************
 * EXPRESS APP
 *************************************************/
const app = express();

/*************************************************
 * ✅ CORS FIX (CRITICAL – DO NOT MOVE)
 * This MUST be before auth & routes
 *************************************************/
app.use(cors({ origin: true }));
app.options("*", cors());

/*************************************************
 * AUTH MIDDLEWARE
 *************************************************/
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "Missing or invalid Authorization header",
    });
  }

  try {
    const idToken = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      role: decoded.role || "citizen",
    };

    next();
  } catch (err) {
    console.error("❌ TOKEN VERIFY ERROR:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

/*************************************************
 * ROLE GUARDS (UNCHANGED – AS REQUESTED)
 *************************************************/
function requireAdmin(req, res) {
  if (req.user.role !== "admin") {
    res.status(403).json({ message: "Admin access only" });
    return false;
  }
  return true;
}

function requireWorkerOrAdmin(req, res) {
  if (!["admin", "worker"].includes(req.user.role)) {
    res.status(403).json({ message: "Worker or admin access only" });
    return false;
  }
  return true;
}


/*************************************************
 * EXISTING CLOUD FUNCTIONS (UNCHANGED)
 *************************************************/

/*************************************************
 * REGISTER COMPLAINT (PUBLIC)
 *************************************************/
app.post("/registerComplaint", authenticate, async (req, res) => {
  try {
    const { description, location, imagePath } = req.body;
    let address = null;

try {
  address = await reverseGeocode(location.lat, location.lng);
} catch (err) {
  console.error("⚠️ Reverse geocode failed:", err.message);
  // We DO NOT fail the complaint if address lookup fails
}

    if (!description || !location || !imagePath) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const userId = req.user.uid;



// 🔥 GEMINI ANALYSIS
let ai;
try {
ai = await analyzeGarbageWithAI(imagePath);



  console.log("🧠 OPEN AI:", ai);
} catch (err) {
  console.error("❌ OPEN AI FAILED:", err.message);
  ai = null;
}
/*************************************************
 * 🧮 DETERMINISTIC SEVERITY (SOURCE OF TRUTH)
 *************************************************/
let severityScore = 40; // civic baseline
let priority = "MEDIUM";

if (ai) {
  if (ai.isPublicGarbage && ai.confidence >= 0.75) {
    severityScore += 20;
  }

  if (!ai.isPublicGarbage && ai.confidence >= 0.75) {
    severityScore -= 15;
  }

  if (ai.severity === "HIGH") severityScore += 10;
  if (ai.severity === "LOW") severityScore -= 10;
}

// Clamp score
severityScore = Math.max(20, Math.min(100, severityScore));

// Map to priority
if (severityScore >= 80) priority = "CRITICAL";
else if (severityScore >= 60) priority = "HIGH";
else if (severityScore >= 40) priority = "MEDIUM";
else priority = "LOW";


  const docRef = await db.collection("complaints").add({
  description,
  location: {
    ...location,
    address,
  },
  imagePath,
  createdBy: userId,
  status: "OPEN",
  priority,
  severityScore,

  // 🧠 AI EXPLANATION (FOR ADMINS & JUDGES)
  aiAnalysis: ai
    ? {
        model: "gpt-4o-mini",
        isPublicGarbage: ai.isPublicGarbage,
        confidence: ai.confidence,
        severity: ai.severity,
        reason: ai.reason,
      }
    : null,

  createdAt: admin.firestore.FieldValue.serverTimestamp(),
});


    return res.json({
      success: true,
      complaintId: docRef.id,
      priority,
      severityScore,
    });
  } catch (err) {
    console.error("❌ REGISTER ERROR:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


/*************************************************
 * GET ADMIN COMPLAINTS
 *************************************************/

/*************************************************
 * ASSIGN COMPLAINT
 *************************************************/
exports.assignComplaint = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  await authenticate(req, res, async () => {
    if (!requireAdmin(req, res)) return;

    const { complaintId, assignedTo } = req.body;
    if (!complaintId || !assignedTo) {
      return res.status(400).send("complaintId and assignedTo required");
    }

    await db.collection("complaints").doc(complaintId).update({
      assignedTo: assignedTo,              // WORKER UID
      assignedBy: req.user.uid,             // ADMIN UID ✅
      status: "ASSIGNED",
      assignedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: "Complaint assigned" });
  });
});

/*************************************************
 * UPDATE STATUS
 *************************************************/
exports.updateComplaintStatus = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  await authenticate(req, res, async () => {
    const { complaintId, status } = req.body;
    if (!complaintId || !status) {
      return res.status(400).send("complaintId and status required");
    }

    const ref = db.collection("complaints").doc(complaintId);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Complaint not found" });
    }

    const complaint = snap.data();

    // ✅ WORKER CLEAN LOGIC
    if (status === "CLEANED") {
      if (req.user.role !== "worker") {
        return res.status(403).json({ error: "Worker only" });
      }

      if (complaint.assignedTo !== req.user.uid) {
        return res.status(403).json({ error: "Not your assignment" });
      }

      if (complaint.status !== "ASSIGNED") {
        return res.status(400).json({ error: "Invalid state" });
      }
    }

    await ref.update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: "Status updated" });
  });
});

/*************************************************
 * ASSIGN USER ROLE
 *************************************************/
exports.assignUserRole = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const user = await authenticate(req, res);
  if (!user) return;
  if (!requireAdmin(req, res)) return;

  const { targetUid, role } = req.body;

  const allowedRoles = ["admin", "worker", "citizen"];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ message: "Invalid role" });
  }

  await admin.auth().setCustomUserClaims(targetUid, { role });

  res.json({ message: "Role assigned", targetUid, role });
});
/*************************************************
 * WORKER MARK CLEANED (STATUS ONLY – A3)
 *************************************************/
app.post(
  "/api/complaints/:complaintId/status",
  authenticate,
  async (req, res) => {
    try {
      if (req.user.role !== "worker") {
        return res.status(403).json({ error: "Worker only" });
      }

      const { status } = req.body;
      const { complaintId } = req.params;

      if (status !== "CLEANED") {
        return res.status(400).json({ error: "Only CLEANED allowed" });
      }

      const ref = db.collection("complaints").doc(complaintId);
      const snap = await ref.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Complaint not found" });
      }

      const complaint = snap.data();

      if (complaint.assignedTo !== req.user.uid) {
        return res.status(403).json({ error: "Not your assignment" });
      }

      if (complaint.status !== "ASSIGNED") {
        return res
          .status(400)
          .json({ error: "Only ASSIGNED complaints can be cleaned" });
      }

      await ref.update({
        status: "CLEANED",
        cleanedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ message: "Complaint marked as CLEANED" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update status" });
    }
  }
);

/*************************************************
 * 🔥 FIXED WORKER CLEANUP API (RAW BINARY)
 *************************************************/
app.post("/worker/cleanup/:complaintId", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "worker") {
      return res.status(403).json({ error: "Worker access only" });
    }

    const { complaintId } = req.params;
    const workerId = req.user.uid;

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const buffer = Buffer.concat(chunks);

      if (!buffer.length) {
        return res.status(400).json({ error: "Empty request body" });
      }

      const ref = db.collection("complaints").doc(complaintId);
      const snap = await ref.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Complaint not found" });
      }

      const complaint = snap.data();
      if (complaint.assignedTo !== workerId) {
        return res.status(403).json({ error: "Not assigned to you" });
      }

      if (complaint.status !== "ASSIGNED") {
        return res.status(400).json({ error: "Invalid complaint state" });
      }

      const bucket = admin.storage().bucket();
      const file = bucket.file(
        `cleanup/${complaintId}_${Date.now()}.jpg`
      );

      await file.save(buffer, {
        metadata: { contentType: "image/jpeg" },
      });

      const [imageUrl] = await file.getSignedUrl({
        action: "read",
        expires: "03-01-2030",
      });

      await ref.update({
        afterImageUrl: imageUrl,
        afterUploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        cleanedBy: workerId,
        status: "CLEANED",
      });

      return res.json({ success: true, imageUrl });
    });
  } catch (err) {
    console.error("❌ CLEANUP ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});
/*************************************************
 * GET ADMIN COMPLAINTS (EXPRESS)
 *************************************************/
app.get("/getAdminComplaints", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access only" });
    }

    const snap = await db
      .collection("complaints")
      
      .limit(50)
      .get();

    const complaints = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.json({
      count: complaints.length,
      complaints
    });
  } catch (err) {
    console.error("❌ getAdminComplaints error:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});


/*************************************************
 * ADMIN ROUTES (UNCHANGED)
 *************************************************/
const adminRoutes = require("./routes/admin");
app.use("/admin", adminRoutes);
//worker fetching assigned complainnts
app.get(
  "/api/worker/complaints",
  authenticate,
  async (req, res) => {
    try {
      if (req.user.role !== "worker") {
        return res.status(403).json({ error: "Worker access only" });
      }

      const snapshot = await db
        .collection("complaints")
        .where("assignedTo", "==", req.user.uid)
        .get();

      const complaints = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));

      res.json({
        count: complaints.length,
        complaints,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch worker complaints" });
    }
  }
);

/*************************************************
 * EXPORT EXPRESS APP
 *************************************************/
exports.api = functions.https.onRequest(
  { secrets: [OPENAI_API_KEY] },
  app
);

