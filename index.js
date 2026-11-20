import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";

import { applications, tuitions, users } from "./db.js";
import {
  verifyStudent,
  verifyToken,
  verifyAdmin,
  verifyTutor,
} from "./middleware/auth.js";
import { parseTuitionsQuery } from "./lib/tuitions-query.js";
import { validateTuitionApproval } from "./lib/admin-tuition-validation.js";
import { validateNewApplication } from "./lib/application-validation.js";
import {
  getTutorPostUsage,
  validateNewTuition,
} from "./lib/tuition-validation.js";

const app = express();
const PORT = process.env.PORT || 5000;

function toObjectId(value) {
  if (value instanceof ObjectId) {
    return value;
  }

  if (typeof value !== "string" || !ObjectId.isValid(value)) {
    return null;
  }

  return new ObjectId(value);
}

// middleware
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("MentorLagbe API is running");
});

app.get("/api/health", (req, res) => {
  res.send({ status: "ok" });
});

app.get(
  "/api/applications/mine",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    try {
      const applicationRows = await applications
        .find(
          { studentId: req.user._id },
          {
            projection: {
              _id: 1,
              tuitionId: 1,
              status: 1,
              phone: 1,
              preferredSchedule: 1,
              note: 1,
              createdAt: 1,
            },
          },
        )
        .sort({ createdAt: -1, _id: -1 })
        .toArray();
      const tuitionIds = [
        ...new Map(
          applicationRows
            .map((application) => toObjectId(application.tuitionId))
            .filter(Boolean)
            .map((id) => [id.toString(), id]),
        ).values(),
      ];
      const tuitionRows = tuitionIds.length
        ? await tuitions
            .find(
              { _id: { $in: tuitionIds } },
              {
                projection: {
                  _id: 1,
                  title: 1,
                  subject: 1,
                  classLevel: 1,
                  monthlyFee: 1,
                  tutorId: 1,
                  approvalStatus: 1,
                  isActive: 1,
                },
              },
            )
            .toArray()
        : [];
      const tutorIds = tuitionRows
        .map((tuition) => toObjectId(tuition.tutorId))
        .filter(Boolean);
      const tutorRows = tutorIds.length
        ? await users
            .find(
              { _id: { $in: tutorIds }, role: "tutor" },
              { projection: { _id: 1, name: 1, image: 1 } },
            )
            .toArray()
        : [];
      const tutorsById = new Map(
        tutorRows.map((tutor) => [tutor._id.toString(), tutor]),
      );
      const tuitionsById = new Map(
        tuitionRows.map((tuition) => {
          const tutorId = toObjectId(tuition.tutorId)?.toString();
          const tutor = tutorId ? tutorsById.get(tutorId) : undefined;

          return [
            tuition._id.toString(),
            {
              id: tuition._id.toString(),
              title: tuition.title,
              subject: tuition.subject,
              classLevel: tuition.classLevel,
              monthlyFee: tuition.monthlyFee,
              isPublic:
                tuition.approvalStatus === "approved" && tuition.isActive,
              tutor: tutor
                ? { name: tutor.name, image: tutor.image ?? null }
                : null,
            },
          ];
        }),
      );

      return res.send({
        applications: applicationRows.map((application) => {
          const tuitionId = toObjectId(application.tuitionId)?.toString();
          const createdAt = new Date(application.createdAt);

          return {
            id: application._id.toString(),
            status: application.status,
            phone: application.phone,
            preferredSchedule: application.preferredSchedule,
            note: application.note ?? "",
            createdAt: createdAt.toISOString(),
            tuition: tuitionId ? (tuitionsById.get(tuitionId) ?? null) : null,
          };
        }),
      });
    } catch (error) {
      console.error("Failed to fetch student applications:", error);
      return res
        .status(500)
        .send({ message: "Unable to load your applications." });
    }
  },
);

app.delete(
  "/api/applications/:id",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).send({ message: "Invalid application ID." });
    }

    const applicationId = new ObjectId(req.params.id);

    try {
      const result = await applications.deleteOne({
        _id: applicationId,
        studentId: req.user._id,
        status: "pending",
      });

      if (result.deletedCount === 0) {
        const application = await applications.findOne(
          { _id: applicationId, studentId: req.user._id },
          { projection: { status: 1 } },
        );

        if (!application) {
          return res.status(404).send({ message: "Application not found." });
        }

        return res.status(409).send({
          message: "Only pending applications can be cancelled.",
        });
      }

      return res.send({ id: req.params.id, cancelled: true });
    } catch (error) {
      console.error("Failed to cancel student application:", error);
      return res
        .status(500)
        .send({ message: "Unable to cancel this application." });
    }
  },
);

app.get(
  "/api/tutor/dashboard",
  verifyToken,
  verifyTutor,
  async (req, res) => {
    try {
      const tuitionRows = await tuitions
        .find(
          { tutorId: req.user._id },
          {
            projection: {
              _id: 1,
              title: 1,
              approvalStatus: 1,
              isActive: 1,
            },
          },
        )
        .toArray();
      const tuitionIds = tuitionRows.map((tuition) => tuition._id);
      const applicantsCount = tuitionIds.length
        ? await applications.countDocuments({
            tuitionId: { $in: tuitionIds },
          })
        : 0;
      const latestApplications = tuitionIds.length
        ? await applications
            .find(
              { tuitionId: { $in: tuitionIds } },
              {
                projection: {
                  _id: 1,
                  studentId: 1,
                  tuitionId: 1,
                  status: 1,
                },
              },
            )
            .sort({ createdAt: -1, _id: -1 })
            .limit(3)
            .toArray()
        : [];
      const studentIds = latestApplications
        .map((application) => toObjectId(application.studentId))
        .filter(Boolean);
      const students = studentIds.length
        ? await users
            .find(
              { _id: { $in: studentIds }, role: "student" },
              { projection: { _id: 1, name: 1, image: 1 } },
            )
            .toArray()
        : [];
      const studentsById = new Map(
        students.map((student) => [student._id.toString(), student]),
      );
      const tuitionsById = new Map(
        tuitionRows.map((tuition) => [tuition._id.toString(), tuition]),
      );

      return res.send({
        tuitionsPosted: tuitionRows.length,
        activeApproved: tuitionRows.filter(
          (tuition) =>
            tuition.approvalStatus === "approved" && tuition.isActive === true,
        ).length,
        applicantsCount,
        latestApplicants: latestApplications.map((application) => {
          const studentId = toObjectId(application.studentId)?.toString();
          const student = studentId
            ? studentsById.get(studentId)
            : undefined;
          const tuitionId = toObjectId(application.tuitionId)?.toString();
          const tuition = tuitionId
            ? tuitionsById.get(tuitionId)
            : undefined;

          return {
            id: application._id.toString(),
            student: student
              ? { name: student.name, image: student.image ?? null }
              : null,
            tuitionTitle: tuition?.title ?? "Tuition unavailable",
            status: application.status,
          };
        }),
      });
    } catch (error) {
      console.error("Failed to fetch tutor dashboard summary:", error);
      return res
        .status(500)
        .send({ message: "Unable to load your tutor dashboard." });
    }
  },
);

app.get(
  "/api/tuitions/mine/usage",
  verifyToken,
  verifyTutor,
  async (req, res) => {
    try {
      const postsUsed = await tuitions.countDocuments({
        tutorId: req.user._id,
      });

      return res.send(getTutorPostUsage(req.user.plan, postsUsed));
    } catch (error) {
      console.error("Failed to get tutor tuition usage:", error);
      return res
        .status(500)
        .send({ message: "Unable to load your tuition posting limit." });
    }
  },
);

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
      .map((tuition) => toObjectId(tuition.tutorId))
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
          toObjectId(tuition.tutorId)?.toString() ?? tuition.tutorId;
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

app.get("/api/tuitions/:id", async (req, res) => {
  const tuitionId = toObjectId(req.params.id);

  if (!tuitionId || !/^[a-f\d]{24}$/i.test(req.params.id)) {
    return res.status(404).send({ message: "Tuition not found." });
  }

  try {
    const tuition = await tuitions.findOne({
      _id: tuitionId,
      approvalStatus: "approved",
      isActive: true,
    });

    if (!tuition) {
      return res.status(404).send({ message: "Tuition not found." });
    }

    const tutorId = toObjectId(tuition.tutorId);
    const tutor = tutorId
      ? await users.findOne(
          { _id: tutorId, role: "tutor" },
          { projection: { _id: 1, name: 1, image: 1, plan: 1 } },
        )
      : null;

    return res.send({
      id: tuition._id.toString(),
      title: tuition.title,
      subject: tuition.subject,
      classLevel: tuition.classLevel,
      mode: tuition.mode,
      location: tuition.location,
      monthlyFee: tuition.monthlyFee,
      daysPerWeek: tuition.daysPerWeek,
      description: tuition.description,
      bannerImage: tuition.bannerImage ?? null,
      createdAt: tuition.createdAt,
      tutor: tutor
        ? {
            name: tutor.name,
            image: tutor.image ?? null,
            plan: tutor.plan === "pro" ? "pro" : "free",
          }
        : null,
    });
  } catch (error) {
    console.error("Failed to fetch tuition details:", error);
    return res.status(500).send({ message: "Unable to load tuition details." });
  }
});

app.post(
  "/api/tuitions/:id/applications",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    const { data, error } = validateNewApplication(req.params.id, req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    try {
      const tuitionId = new ObjectId(data.tuitionId);
      const tuition = await tuitions.findOne({
        _id: tuitionId,
        approvalStatus: "approved",
        isActive: true,
      });

      if (!tuition) {
        return res.status(404).send({ message: "Tuition not found." });
      }

      const existingApplication = await applications.findOne({
        tuitionId,
        studentId: req.user._id,
      });

      if (existingApplication) {
        return res
          .status(409)
          .send({ message: "You have already applied to this tuition." });
      }

      const now = new Date();
      const application = {
        ...data,
        tuitionId,
        studentId: req.user._id,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      const result = await applications.insertOne(application);

      return res.status(201).send({
        id: result.insertedId.toString(),
        tuitionId: tuitionId.toString(),
        status: application.status,
        createdAt: now,
      });
    } catch (error) {
      console.error("Failed to submit tuition application:", error);
      return res
        .status(500)
        .send({ message: "Unable to submit your application." });
    }
  },
);

app.get(
  "/api/admin/tuitions/pending",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const tuitionRows = await tuitions
        .find(
          { approvalStatus: "pending" },
          {
            projection: {
              _id: 1,
              title: 1,
              subject: 1,
              classLevel: 1,
              mode: 1,
              location: 1,
              monthlyFee: 1,
              daysPerWeek: 1,
              description: 1,
              bannerImage: 1,
              tutorId: 1,
              createdAt: 1,
            },
          },
        )
        .sort({ createdAt: 1, _id: 1 })
        .toArray();

      const tutorIds = tuitionRows
        .map((tuition) => toObjectId(tuition.tutorId))
        .filter(Boolean);
      const tutors = tutorIds.length
        ? await users
            .find(
              { _id: { $in: tutorIds }, role: "tutor" },
              { projection: { _id: 1, name: 1, email: 1, image: 1 } },
            )
            .toArray()
        : [];
      const tutorsById = new Map(
        tutors.map((tutor) => [tutor._id.toString(), tutor]),
      );

      return res.send({
        tuitions: tuitionRows.map((tuition) => {
          const tutorId = toObjectId(tuition.tutorId)?.toString();
          const tutor = tutorId ? tutorsById.get(tutorId) : undefined;

          return {
            id: tuition._id.toString(),
            title: tuition.title,
            subject: tuition.subject,
            classLevel: tuition.classLevel,
            mode: tuition.mode,
            location: tuition.location,
            monthlyFee: tuition.monthlyFee,
            daysPerWeek: tuition.daysPerWeek,
            description: tuition.description,
            bannerImage: tuition.bannerImage ?? null,
            createdAt: tuition.createdAt,
            tutor: tutor
              ? {
                  name: tutor.name,
                  email: tutor.email,
                  image: tutor.image ?? null,
                }
              : null,
          };
        }),
      });
    } catch (error) {
      console.error("Failed to fetch pending tuition approvals:", error);
      return res
        .status(500)
        .send({ message: "Unable to load pending tuition approvals." });
    }
  },
);

app.patch(
  "/api/admin/tuitions/:id/approval",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { data, error } = validateTuitionApproval(req.params.id, req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    try {
      const result = await tuitions.updateOne(
        { _id: new ObjectId(data.id), approvalStatus: "pending" },
        {
          $set: {
            approvalStatus: data.approvalStatus,
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        const tuition = await tuitions.findOne(
          { _id: new ObjectId(data.id) },
          { projection: { approvalStatus: 1 } },
        );

        if (!tuition) {
          return res.status(404).send({ message: "Tuition not found." });
        }

        return res
          .status(409)
          .send({ message: "This tuition has already been reviewed." });
      }

      return res.send({
        id: data.id,
        approvalStatus: data.approvalStatus,
      });
    } catch (error) {
      console.error("Failed to update tuition approval:", error);
      return res
        .status(500)
        .send({ message: "Unable to update this tuition approval." });
    }
  },
);

const parseBannerImage = express.raw({
  type: ["image/png", "image/jpeg"],
  limit: "2mb",
});

function handleBannerImageBody(req, res, next) {
  parseBannerImage(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error.type === "entity.too.large") {
      return res.status(413).send({ message: "Image must be 2 MB or smaller." });
    }

    return res.status(400).send({ message: "Invalid image upload." });
  });
}

function hasValidImageSignature(buffer, contentType) {
  if (contentType === "image/png") {
    return buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }

  return (
    contentType === "image/jpeg" &&
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  );
}

app.post(
  "/api/tuitions/banner",
  verifyToken,
  verifyTutor,
  handleBannerImageBody,
  async (req, res) => {
    const apiKey = process.env.IMGBB_API_KEY;

    if (!apiKey) {
      return res
        .status(503)
        .send({ message: "Image uploads are not configured on the server." });
    }

    const contentType = req.headers["content-type"]?.split(";")[0];

    if (
      !Buffer.isBuffer(req.body) ||
      req.body.length === 0 ||
      !hasValidImageSignature(req.body, contentType)
    ) {
      return res
        .status(400)
        .send({ message: "Choose a valid JPG or PNG image." });
    }

    let postsUsed;

    try {
      postsUsed = await tuitions.countDocuments({
        tutorId: req.user._id,
      });
    } catch (error) {
      console.error("Failed to check tutor tuition usage:", error);
      return res
        .status(500)
        .send({ message: "Unable to check your tuition posting limit." });
    }

    if (!getTutorPostUsage(req.user.plan, postsUsed).canCreate) {
      return res.status(403).send({
        message:
          "Free tutors can post up to 2 tuitions. Upgrade to Pro to post more.",
      });
    }

    const fileExtension = contentType === "image/png" ? "png" : "jpg";
    const imageForm = new FormData();
    imageForm.set(
      "image",
      new Blob([req.body], { type: contentType }),
      `tuition-banner.${fileExtension}`,
    );

    try {
      const url = new URL("https://api.imgbb.com/1/upload");
      url.searchParams.set("key", apiKey);

      const uploadResponse = await fetch(url, {
        method: "POST",
        body: imageForm,
      });

      const uploadResult = await uploadResponse.json();

      if (
        !uploadResponse.ok ||
        uploadResult.success !== true ||
        typeof uploadResult.data?.url !== "string"
      ) {
        return res
          .status(502)
          .send({ message: "The image service could not upload this file." });
      }

      return res.send({ url: uploadResult.data.url });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.replace(apiKey, "[redacted]")
          : "Unknown error";
      console.error("ImgBB upload failed:", message);
      return res
        .status(502)
        .send({ message: "The image service could not upload this file." });
    }
  },
);

app.post("/api/tuitions", verifyToken, verifyTutor, async (req, res) => {
  const { data, error } = validateNewTuition(req.body);

  if (error) {
    return res.status(400).send({ message: error });
  }

  try {
    const postsUsed = await tuitions.countDocuments({
      tutorId: req.user._id,
    });
    const usage = getTutorPostUsage(req.user.plan, postsUsed);

    if (!usage.canCreate) {
      return res.status(403).send({
        message:
          "Free tutors can post up to 2 tuitions. Upgrade to Pro to post more.",
        usage,
      });
    }

    const now = new Date();
    const tuition = {
      ...data,
      tutorId: req.user._id,
      approvalStatus: "pending",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    const result = await tuitions.insertOne(tuition);

    return res.status(201).send({
      id: result.insertedId.toString(),
      ...tuition,
      tutorId: req.user._id.toString(),
      usage: getTutorPostUsage(req.user.plan, postsUsed + 1),
    });
  } catch (error) {
    console.error("Failed to create tuition:", error);
    return res.status(500).send({ message: "Unable to submit this tuition." });
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
