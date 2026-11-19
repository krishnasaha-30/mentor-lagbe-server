import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";

import { tuitions, users } from "./db.js";
import { verifyToken } from "./middleware/auth.js";
import { parseTuitionsQuery } from "./lib/tuitions-query.js";

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

// Public listings only include approved, active tuitions.
app.get("/api/tuitions", async (req, res) => {
  const parsedQuery = parseTuitionsQuery(req.query);

  if (parsedQuery.error) {
    return res.status(400).send({ message: parsedQuery.error });
  }

  try {
    const totalItems = await tuitions.countDocuments(parsedQuery.filter);
    const totalPages = Math.ceil(totalItems / parsedQuery.pageSize);
    const currentPage =
      totalPages === 0 ? 1 : Math.min(parsedQuery.page, totalPages);
    const skip =
      currentPage === parsedQuery.page
        ? parsedQuery.skip
        : (currentPage - 1) * parsedQuery.pageSize;

    const tuitionRows = await tuitions
      .find(parsedQuery.filter, {
        projection: {
          _id: 1,
          title: 1,
          subject: 1,
          classLevel: 1,
          mode: 1,
          location: 1,
          monthlyFee: 1,
          daysPerWeek: 1,
          bannerImage: 1,
          tutorId: 1,
          createdAt: 1,
        },
      })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(parsedQuery.pageSize)
      .toArray();

    const tutorIds = tuitionRows
      .map((tuition) => {
        if (tuition.tutorId instanceof ObjectId) {
          return tuition.tutorId;
        }

        if (
          typeof tuition.tutorId === "string" &&
          ObjectId.isValid(tuition.tutorId)
        ) {
          return new ObjectId(tuition.tutorId);
        }

        return null;
      })
      .filter(Boolean);

    const tutors = tutorIds.length
      ? await users
          .find(
            { _id: { $in: tutorIds }, role: "tutor" },
            { projection: { _id: 1, name: 1, image: 1, plan: 1 } },
          )
          .toArray()
      : [];
    const tutorsById = new Map(
      tutors.map((tutor) => [tutor._id.toString(), tutor]),
    );

    return res.send({
      tuitions: tuitionRows.map((tuition) => {
        const tutorId =
          tuition.tutorId instanceof ObjectId
            ? tuition.tutorId.toString()
            : tuition.tutorId;
        const tutor =
          typeof tutorId === "string" ? tutorsById.get(tutorId) : undefined;

        return {
          id: tuition._id.toString(),
          title: tuition.title,
          subject: tuition.subject,
          classLevel: tuition.classLevel,
          mode: tuition.mode,
          location: tuition.location,
          monthlyFee: tuition.monthlyFee,
          daysPerWeek: tuition.daysPerWeek,
          bannerImage: tuition.bannerImage ?? null,
          createdAt: tuition.createdAt,
          tutor: tutor
            ? {
                name: tutor.name,
                image: tutor.image ?? null,
                plan: tutor.plan,
              }
            : null,
        };
      }),
      pagination: {
        currentPage,
        pageSize: parsedQuery.pageSize,
        totalItems,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Failed to fetch public tuitions:", error);
    return res.status(500).send({ message: "Unable to load public tuitions." });
  }
});

// Shared: the signed-in user's own profile.
app.get("/api/me", verifyToken, (req, res) => {
  const { _id, name, email, role, plan, image } = req.user;
  res.send({ _id, name, email, role, plan, image });
});

app.listen(PORT, () => {
  console.log(`MentorLagbe API is running on http://localhost:${PORT}`);
});
