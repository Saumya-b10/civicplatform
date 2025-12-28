// -------------------- IMPORTS --------------------
import "./App.css";

import { useState, useEffect, useRef } from "react";
import { auth, storage } from "./firebase";
import {
  signInWithEmailAndPassword,
  signInAnonymously
} from "firebase/auth";
import { ref, uploadBytes } from "firebase/storage";

// -------------------- APP ROOT --------------------
function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(null);
  const [error, setError] = useState("");

  // ---------- ADMIN LOGIN ----------
  const adminLogin = async () => {
    try {
      setError("");

      const userCred = await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

      // 🔁 force refresh token to get latest custom claims
      const tokenResult = await userCred.user.getIdTokenResult(true);

      console.log("ADMIN CLAIMS:", tokenResult.claims);

      setRole(tokenResult.claims.role); // should be "admin"
    } catch (err) {
      console.error(err);
      setError(err.message);
    }
  };

  // ---------- CITIZEN LOGIN ----------
  const citizenLogin = async () => {
    try {
      setError("");
      await signInAnonymously(auth);
      setRole("citizen");
    } catch (err) {
      console.error(err);
      setError(err.message);
    }
  };

  // ---------- ROLE BASED RENDER ----------
  if (role === "admin") return <AdminPanel />;
  if (role === "citizen") return <CitizenPanel />;

  // ---------- LOGIN UI ----------
  return (
  <div className="home-container">
    <div className="home-card">

      <h1>Clean City Reporting Platform</h1>

      <p className="subtitle">
        Report uncleaned garbage and overflowing bins in your locality.
        Help municipalities respond faster with visual proof.
      </p>

      {/* ---- PRIMARY CTA: CITIZEN ---- */}
      <button
        onClick={citizenLogin}
        className="primary-btn"
        style={{ marginTop: "20px", marginBottom: "30px" }}
      >
        Report Garbage Issue
      </button>

      <div className="divider">
        
      </div>

      {/* ---- ADMIN LOGIN ---- */}
      <div className="login-section">
        <h3>Municipal Admin Login</h3>

        <input
          placeholder="Admin Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          type="password"
          placeholder="Admin Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button onClick={adminLogin} className="secondary-btn">
          Admin Login
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
    </div>
  </div>
);

}

// -------------------- CITIZEN PANEL --------------------
function CitizenPanel() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("");
  const [description, setDescription] = useState("");

  const fileInputRef = useRef();

  const clearFile = () => {
    setFile(null);
    setStatus("");
    fileInputRef.current.value = "";
  };

  const submitComplaint = async () => {
    try {
      if (!file) {
        setStatus("Please upload a single image only");
        return;
      }

      const user = auth.currentUser;

      const imageRef = ref(
        storage,
        `uploads/${user.uid}/${Date.now()}_${file.name}`
      );

      setStatus("Uploading image...");
      await uploadBytes(imageRef, file);
      console.log("UPLOADED TO:", imageRef.fullPath);
      const token = await user.getIdToken();

      await fetch(
  "https://us-central1-civicplatform-df911.cloudfunctions.net/api/registerComplaint",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            description: "Garbage issue reported",
            location: { lat: 19.12, lng: 72.89 },
            imagePath: imageRef.fullPath
          })
        }
      );

      setStatus("Complaint submitted successfully");
      clearFile();
    } catch (err) {
      console.error(err);
      setStatus("Error submitting complaint");
    }
  };

return (
  <div className="citizen-container">
    <h2>Report Uncleaned and Overflowing Garbage</h2>

    <div className="upload-box">
      <input
        type="file"
        ref={fileInputRef}
        onChange={(e) => setFile(e.target.files[0])}
      />

      {file && (
        <div className="file-preview">
          <span>{file.name}</span>
          <button onClick={clearFile}>Remove</button>
        </div>
      )}
    </div>
  <textarea
  className="desc-input"
  placeholder="Describe the issue (optional)"
  value={description}
  onChange={(e) => setDescription(e.target.value)}
/>

    <button
      className="submit-btn"
      onClick={submitComplaint}
      disabled={status === "Uploading image..."}
    >
      {status === "Uploading image..."
        ? "Submitting..."
        : "Submit Complaint"}
    </button>

    {status && <p className="status-msg">{status}</p>}
  </div>
);

}

// -------------------- ADMIN PANEL --------------------
function AdminPanel() {
 const [locationFilter, setLocationFilter] = useState("");
const [minSeverity, setMinSeverity] = useState("");
const [statusFilter, setStatusFilter] = useState("ALL");
const [cursor, setCursor] = useState(null);
const [hasMore, setHasMore] = useState(true);
const [loadingMore, setLoadingMore] = useState(false);

const [complaints, setComplaints] = useState([]);
  const [status, setStatus] = useState("Loading complaints...");

  useEffect(() => {
    const loadComplaints = async () => {
      try {
        const token = await auth.currentUser.getIdToken(true);

        const res = await fetch(
          "https://us-central1-civicplatform-df911.cloudfunctions.net/api/getAdminComplaints",
          {
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        if (!res.ok) throw new Error("Unauthorized");

        const data = await res.json();
        setComplaints(data.complaints || []);
        setStatus("");
      } catch (err) {
        console.error(err);
        setStatus("Failed to load complaints");
      }
    };

    loadComplaints();
  }, []);
const total = complaints.length;
const openCount = complaints.filter(c => c.status === "OPEN").length;
const assignedCount = complaints.filter(c => c.status === "ASSIGNED").length;
const filteredComplaints = complaints.filter(c => {
  // ---- LOCATION FILTER ----
  const locationText = c.location
    ? `${c.location.lat}, ${c.location.lng}`.toLowerCase()
    : "";

  if (
    locationFilter &&
    !locationText.includes(locationFilter.toLowerCase())
  ) {
    return false;
  }

  // ---- STATUS FILTER ----
  if (statusFilter !== "ALL" && c.status !== statusFilter) {
    return false;
  }

  // ---- SEVERITY FILTER ----
  if (
    minSeverity &&
    (c.severityScore == null || c.severityScore < Number(minSeverity))
  ) {
    return false;
  }

  return true;
});

  return (
    <><h1 className="title">Admin Panel</h1>
<div className="summary">
  <span>Total: {total}</span>
  <span>Open: {openCount}</span>
  <span>Assigned: {assignedCount}</span>
</div>
<div className="filters-wrapper">
  <div className="filters-left">
    <div className="filter-item">
      <label>📍 Location</label>
      <input
        type="text"
        placeholder="Lat, Lng or area"
        value={locationFilter}
        onChange={(e) => setLocationFilter(e.target.value)}
      />
    </div>

    <div className="filter-item">
      <label>⚠️ Min Severity</label>
      <input
        type="number"
        placeholder="e.g. 30"
        value={minSeverity}
        onChange={(e) => setMinSeverity(e.target.value)}
      />
    </div>

    <div className="filter-item">
      <label>📌 Status</label>
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
      >
        <option value="ALL">All</option>
        <option value="OPEN">OPEN</option>
        <option value="ASSIGNED">ASSIGNED</option>
         <option value="CLOSED">CLOSED</option>
      </select>
    </div>
  </div>
</div>


<table className="complaints-table">
  <thead>
    <tr>
      <th>Image</th>
      <th>Description</th>
      <th>Location</th>
      <th>Severity</th>
      <th>Priority</th>
      <th>Status</th>
      <th>Action</th>
    </tr>
  </thead>

  <tbody>
    {filteredComplaints.map(c => (
      <tr key={c.id}>
        <td>
          {c.imageUrl ? (
            <img src={c.imageUrl} alt="complaint" />
          ) : (
            "—"
          )}
        </td>

        <td>{c.description}</td>

        <td>
          {c.location
            ? `${c.location.lat}, ${c.location.lng}`
            : "Unknown"}
        </td>

        <td>{c.severityScore ?? "N/A"}</td>

        <td>{c.priority ?? "N/A"}</td>

        <td>
          <span className={`status ${c.status?.toLowerCase()}`}>
            {c.status}
          </span>
        </td>

        <td>
  <button
    className="assign-btn"
    disabled={c.status !== "OPEN"}
  >
    {c.status === "OPEN" ? "Assign" : "Assigned"}
  </button>
</td>

      </tr>
    ))}
  </tbody>
</table>

</>
  
  );
}

export default App;
