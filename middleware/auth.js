import { ObjectId } from "mongodb";

import { sessions, users } from "../db.js";

/**
 * Reads `Authorization: Bearer <token>`, finds the BetterAuth session in
 * MongoDB and attaches the matching user to `req.user`.
 *
 * The token BetterAuth puts in the session cookie is the same value the
 * client helpers send as the bearer token, so both sides always agree.
 */
export async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const session = await sessions.findOne({ token });
    if (!session) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
      return res.status(401).send({ message: "Session expired" });
    }

    const user = await users.findOne({ _id: new ObjectId(session.userId) });
    if (!user) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    req.user = user;
    req.session = session;
    next();
  } catch {
    // A malformed session.userId (bad ObjectId) also lands here.
    res.status(401).send({ message: "Unauthorized" });
  }
}

/** Must be used after verifyToken. */
export function verifyStudent(req, res, next) {
  if (req.user?.role !== "student") {
    return res.status(403).send({ message: "Forbidden" });
  }
  next();
}

/** Must be used after verifyToken. */
export function verifyTutor(req, res, next) {
  if (req.user?.role !== "tutor") {
    return res.status(403).send({ message: "Forbidden" });
  }
  next();
}

/** Must be used after verifyToken. */
export function verifyAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).send({ message: "Forbidden" });
  }
  next();
}
