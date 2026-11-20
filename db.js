import "dotenv/config";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

// Fail fast: if the database is unreachable the server should not pretend
// to be healthy.
await client.connect();
console.log("Connected to MongoDB");

export const database = client.db("mentor-lagbe-app");

// BetterAuth collections. They are created automatically on first sign-up.
export const users = database.collection("user");
export const sessions = database.collection("session");
export const tuitions = database.collection("tuitions");
export const applications = database.collection("applications");
export const stripeEvents = database.collection("stripeEvents");
export const payments = database.collection("payments");
await stripeEvents.createIndex(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);
await payments.createIndex({ status: 1, createdAt: -1 });
