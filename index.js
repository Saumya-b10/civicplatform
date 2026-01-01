/*************************************************
 * IMPORTS
 *************************************************/
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const vision = require("@google-cloud/vision");
const express = require("express");
const cors = require("cors"); // ✅ ADDED

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
 * ADVANCED PRIORITY SCORING (UNCHANGED)
 *************************************************/
async function calculateAdvancedPriority({
  garbageConfidence,
  garbageObjectCount,
  location,
}) {
  let score = 0;

  // 🔹 Object detection contribution
  score += Math.min(garbageObjectCount * 15, 45);
  if (garbageObjectCount >= 3) score += 15;

  // 🔥 AI confidence weight
  score += garbageConfidence * 80;

  // 🔹 Nearby repeat complaints
  const oneWeekAgo = admin.firestore.Timestamp.fromMillis(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  );

  const nearbySnap = await db
    .collection("complaints")
    .where("createdAt", ">=", oneWeekAgo)
    .get();

  let repeatComplaintsNearby = 0;

  nearbySnap.forEach((doc) => {
    const d = doc.data();
    if (
      d.location &&
      Math.abs(d.location.lat - location.lat) < 0.005 &&
      Math.abs(d.location.lng - location.lng) < 0.005
    ) {
      repeatComplaintsNearby++;
    }
  });

  score += Math.min(repeatComplaintsNearby * 5, 20);

  // 🔹 Conditional severity floor
  if (garbageConfidence < 0.25 && score < 20) {
    score = 20;
  } else if (score < 40) {
    score = 40;
  }

  // 🔹 Clamp to 0–100
  score = Math.min(Math.round(score), 100);

  // ============================
  // 🔒 ADD THIS BLOCK RIGHT HERE
  // ============================
  // Prevent false HIGH / CRITICAL
  if (score >= 60) {
    // Require strong evidence for HIGH
    if (garbageObjectCount < 2 && garbageConfidence < 0.6) {
      score = Math.min(score, 55); // force MEDIUM
    }
  }
  // ============================

  // 🔹 Priority mapping
  let priority = "LOW";
  if (score >= 80) priority = "CRITICAL";
  else if (score >= 60) priority = "HIGH";
  else if (score >= 40) priority = "MEDIUM";
  else priority = "LOW";

  return { priority, severityScore: score };
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

    const visionClient = new vision.ImageAnnotatorClient();
    const gcsUri = `gs://civicplatform-df911.appspot.com/${imagePath}`;

    const [labelResult] = await visionClient.labelDetection(gcsUri);
    const [objectResult] = await visionClient.objectLocalization(gcsUri);

 let garbageConfidence = 0;
let garbageObjectCount = 0;
let personDetected = false;

// 🔹 Garbage-related keywords
const garbageKeywords = [
  "garbage",
  "trash",
  "waste",
  "dump",
  "dumping",
  "litter",
  "plastic",
  "pollution",
  "rubbish",
  "refuse",
  "landfill",
  "junk",
  "scrap",
  "debris"
];

// 1️⃣ Label-based signals
(labelResult.labelAnnotations || []).forEach(label => {
  const desc = label.description.toLowerCase();

  if (garbageKeywords.some(k => desc.includes(k))) {
    garbageConfidence = Math.max(garbageConfidence, label.score);
  }

  if (desc.includes("person") || desc.includes("face")) {
    personDetected = true;
  }
});

// 2️⃣ Object-based signals
(objectResult.localizedObjectAnnotations || []).forEach(object => {
  const name = object.name.toLowerCase();

  if (
    name.includes("plastic") ||
    name.includes("bag") ||
    name.includes("bottle") ||
    name.includes("waste") ||
    name.includes("container")
  ) {
    garbageObjectCount++;
  }

  if (name.includes("person")) {
    personDetected = true;
  }
});

// 3️⃣ 🔥 SMART FALLBACK (KEY FIX)
// Apply baseline ONLY if:
// - no person detected
// - AND scene is likely outdoor garbage context
if (
  garbageConfidence === 0 &&
  garbageObjectCount === 0 &&
  !personDetected
) {
  garbageConfidence = 0.3; // LOW baseline, not 0.5
}

// 4️⃣ Strong garbage signal
if (garbageObjectCount >= 3) {
  garbageConfidence = Math.max(garbageConfidence, 0.8);
}


    const { priority, severityScore } =
      await calculateAdvancedPriority({
        garbageConfidence,
        garbageObjectCount,
        location
      });

    // ✅ Generate public image URL
   

    const docRef = await db.collection("complaints").add({
  description,
  location: {
    ...location,
    address,
  },
  imagePath, // ✅ ONLY store path
  createdBy: userId,
  status: "OPEN",
  priority,
  severityScore,
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
exports.api = functions.https.onRequest(app);
