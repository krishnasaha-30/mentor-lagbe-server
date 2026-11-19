import express from "express";
import cors from "cors";

import "./db.js";
import { verifyToken } from "./middleware/auth.js";

const app = express();
const PORT = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("MentorLagbe API is running");
});

app.get("/api/health", (req, res) => {
  res.send({ status: "ok" });
});

// Shared: the signed-in user's own profile.
app.get("/api/me", verifyToken, (req, res) => {
  const { _id, name, email, role, plan, image } = req.user;
  res.send({ _id, name, email, role, plan, image });
});

app.listen(PORT, () => {
  console.log(`MentorLagbe API is running on http://localhost:${PORT}`);
});
