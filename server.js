import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuid } from "uuid";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import OpenAI from "openai";
import Razorpay from "razorpay";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import admin from "firebase-admin";
import fs from "fs";





const connection = new IORedis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null
});

// ✅ SAME connection everywhere
const syllabusQueue = new Queue("syllabus-generation", {
  connection
});



dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());


const PLANS = {
  TEST: {
    amount: 100,           // ₹1 = 100 paise
    durationMinutes: 5     // 👈 sirf test ke liye
  },
  MONTHLY: {
    amount: 19900,
    durationDays: 30
  },
  SIX_MONTH: {
    amount: 99900,
    durationDays: 180
  },
  YEARLY: {
    amount: 299900,
    durationDays: 365
  }
};

/* ================= FIREBASE INIT ================= */

const serviceAccount = JSON.parse(
  fs.readFileSync("./serviceAccountKey.json", "utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


/* ================= SUPABASE CLIENTS ================= */



// ✅ Anon client (JWT verify ke liye)
const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Admin client (ONLY for auth.admin)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// User client factory (RLS enforced)
const getUserClient = (jwt) =>
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
    }
  );


function safeParseJSON(text) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("AI returned invalid JSON");
    }
  }
  
/* ================= AI HELPER ================= */



const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY // naam kuch bhi ho
});

const callOpenAi = async (prompt) => {
  console.log("CALLING OPENAI...");

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: prompt
      },
      {
        role: "system",
        content: "Return raw JSON only. No markdown. No formatting."
      }
    ],
  });
  

  console.log("RAW RESPONSE:", JSON.stringify(response, null, 2));

  return response.output_text || "";
};



const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});






// Safe JSON extractor
const extractJSON = (text) => {
  const match = text.match(/\[.*\]/s);
  if (!match) return [{ raw: text }];
  try {
    return JSON.parse(match[0]);
  } catch {
    return [{ raw: text }];
  }
};






/* ================= AUTH MIDDLEWARE ================= */


const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.replace("Bearer ", "");

    // 🔐 JWT verify
    const {
      data: { user },
      error,
    } = await supabaseAnon.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // 🔒 RLS-enabled client
    const supabase = getUserClient(token);

    // 👤 Fetch profile
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: "Profile not found" });
    }

    /* =======================================================
       ⏳ AUTO PLAN EXPIRY CHECK
    ======================================================= */

    let updatedProfile = profile;

    if (
      profile.plan === "PAID" &&
      profile.plan_expiry &&
      new Date(profile.plan_expiry) < new Date()
    ) {
      console.log("⏳ Plan expired — starting downgrade");

      // 🔻 Downgrade to FREE
      const { data: downgraded, error: downgradeError } = await supabase
        .from("profiles")
        .update({
          plan: "FREE",
          plan_type: null,
          plan_expiry: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", user.id)
        .select()
        .single();

      if (!downgradeError && downgraded) {
        updatedProfile = downgraded;
        console.log("🔻 Plan expired → downgraded to FREE");

        /* ================= 🔔 PLAN EXPIRED PUSH ================= */

        try {
          const { data: profileData } = await supabaseAdmin
            .from("profiles")
            .select("device_tokens")
            .eq("id", user.id)
            .single();

          if (profileData?.device_tokens?.length) {

            await supabaseAdmin.from("notifications").insert({
              user_id: user.id,
              title: "Plan Expired ⚠️",
              body: "Your plan has expired. Upgrade to continue.",
              type: "PLAN_EXPIRED"
            });
            

            await sendPush(
              profileData.device_tokens,
              "Plan Expired ⚠️",
              "Your plan has expired. Upgrade to continue.",
              { type: "PLAN_EXPIRED", screen: "pricing" }
            );

            console.log("✅ Expiry push sent");
          }

        } catch (pushError) {
          console.error("Push error:", pushError);
        }

        /* ======================================================== */
      }
    }

    /* ======================================================= */

    // ✅ Attach to request
    req.user = user;
    req.profile = updatedProfile;
    req.supabase = supabase;

    next();

  } catch (err) {
    console.error("Protect error:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
};



/* ================= AUTH ================= */

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) return res.status(400).json({ error: error.message });

    const userId = data.user.id;

    await supabaseAdmin.from("profiles").insert({
      id: userId,
      first_name: firstName,
      last_name: lastName,
      plan: "FREE",
    });

    // 🔑 LOGIN USER TO GET TOKEN
    const { data: loginData, error: loginError } =
      await supabaseAnon.auth.signInWithPassword({
        email,
        password,
      });

    if (loginError) {
      return res.status(400).json({ error: loginError.message });
    }

    res.json({
      success: true,
      userId,
      token: loginData.session.access_token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});



app.put("/api/profile/academic", protect, async (req, res) => {
  try {
    const {
      institution_type,

      institution_name, board, class_level,
      degree, semester, university,
      exam_type, exam_year, target_score
    } = req.body;

    if (!institution_type) {
      return res.status(400).json({ error: "institution_type required" });
    }

    let profileData = { institution_type };

    if (institution_type === "SCHOOL") {
      Object.assign(profileData, {
        institution_name,
        board,
        class_level
      });
    }

    if (institution_type === "COLLEGE") {
      Object.assign(profileData, {
        degree,
        semester,
        university
      });
    }

    if (institution_type === "COMPETITIVE") {
      Object.assign(profileData, {
        exam_type,
        exam_year,
        target_score: target_score ?? null
      });
    }

    const { data, error } = await req.supabase
    .from("profiles")
    .update({
      ...profileData,
      profile_completed: true
    })
    .eq("id", req.user.id)
    .select()
    .single();
  
  if (error) {
    return res.status(400).json({ error: error.message });
  }
  
  res.json({
    success: true,
    profile: data
  });
  
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Academic info update failed" });
  }
});




app.post("/api/syllabus/generate", async (req, res) => {
  try {
    const p = req.body;

    if (!p || !p.institution_type) {
      return res.status(400).json({ error: "Invalid request data" });
    }

    let prompt = "";

    /* ================= SCHOOL ================= */
    if (p.institution_type === "SCHOOL") {
      prompt = `
    You are generating subjects for an Indian school syllabus.
    
    Board: ${p.board}
    Class: ${p.class_level}
    
    STRICT RULES (NO EXCEPTIONS):
    - Follow ONLY the OFFICIAL ${p.board} syllabus
    - Include ONLY compulsory core subjects
    - DO NOT include electives, optional subjects, or vocational subjects
    - Subject count MUST be fixed and standard for this board and class
    - DO NOT invent or add extra subjects
    - Output MUST be IDENTICAL every time for the same board + class
    - Return ONLY a valid JSON array
    - NO explanations
    - NO extra text
    
    Example format:
    ["Mathematics","Science","English","Social Science","Hindi"]
    `;
    }
    

    /* ================= COLLEGE ================= */
    if (p.institution_type === "COLLEGE") {
      prompt = `
Generate subjects for Indian college.

University: ${p.university}
Degree: ${p.degree}
Semester: ${p.semester}

Rules:
- Follow official university syllabus
- Return ONLY a valid JSON array of strings
`;
    }

    /* ================= COMPETITIVE ================= */
    if (p.institution_type === "COMPETITIVE") {
      prompt = `
Generate subjects for Indian competitive exam preparation.

Exam: ${p.exam_type}

Rules:
- Follow official ${p.exam_type} syllabus
- Return ONLY a valid JSON array of strings

Examples:
JEE → ["Physics","Chemistry","Mathematics"]
NEET → ["Physics","Chemistry","Biology"]
`;
    }

    const aiText = await callOpenAi(prompt);

    let syllabus;
    try {
      syllabus = JSON.parse(aiText);
    } catch {
      return res.status(500).json({ error: "AI returned invalid JSON" });
    }

    res.json({ success: true, syllabus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Syllabus generation failed" });
  }
});



app.post("/api/syllabus/confirm", async (req, res) => {
  try {
    const { subjects, institutionType, academicInfo } = req.body;

    if (!Array.isArray(subjects) || subjects.length === 0) {
      return res.status(400).json({ error: "Subjects required" });
    }

    if (!institutionType || !academicInfo) {
      return res.status(400).json({ error: "Invalid data" });
    }

    const p = {
      institution_type: institutionType,
      board: academicInfo.board,
      class_level: academicInfo.class_level,
      university: academicInfo.university,
      degree: academicInfo.degree,
      semester: academicInfo.semester,
      exam_type: academicInfo.exam_type
    };

    const syllabusMap = {};

    for (const subject of subjects) {
      let prompt = "";

      if (p.institution_type === "SCHOOL") {
        prompt = `
Generate chapter names for Indian school.

Board: ${p.board}
Class: ${p.class_level}
Subject: ${subject}

Rules:
- Follow official ${p.board} syllabus
- Return ONLY a valid JSON array of strings
`;
      }

      if (p.institution_type === "COLLEGE") {
        prompt = `
Generate units/modules for Indian college.

University: ${p.university}
Degree: ${p.degree}
Semester: ${p.semester}
Subject: ${subject}

Rules:
- Follow official university syllabus
- Return ONLY a valid JSON array of strings
`;
      }

      if (p.institution_type === "COMPETITIVE") {
        prompt = `
Generate topic list for ${p.exam_type} exam preparation.

Subject: ${subject}

Rules:
- Follow official ${p.exam_type} syllabus
- Return ONLY a valid JSON array of strings
`;
      }

      const aiText = await callOpenAi(prompt);

      let parsed;
      try {
        parsed = JSON.parse(aiText);
      } catch {
        return res.status(500).json({
          error: "AI returned invalid JSON",
          subject
        });
      }

      syllabusMap[subject] = parsed;
    }

    res.json({
      success: true,
      content: syllabusMap
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Syllabus confirmation failed" });
  }
});



app.post("/api/syllabus/save", protect, async (req, res) => {
  try {
    const { institutionType, syllabusMap } = req.body;

    console.log("SAVE SYLLABUS PAYLOAD:", req.body);

    if (!institutionType || !syllabusMap) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const rows = Object.entries(syllabusMap).map(
      ([subject, chapters]) => ({
        user_id: req.user.id,
        institution_type: institutionType,
        subject,
        chapters
      })
    );

    console.log("ROWS TO INSERT:", rows);

    await req.supabase
      .from("user_syllabus")
      .delete()
      .eq("user_id", req.user.id);

    const { data, error } = await req.supabase
      .from("user_syllabus")
      .insert(rows)
      .select();

    console.log("INSERT RESULT:", { data, error });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, inserted: data.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save syllabus" });
  }
});








app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    res.json({
      token: data.session.access_token,
      user: data.user,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});




/* ================= AI CHAT ================= */

// app.post("/api/ai/ask", protect, async (req, res) => {
//   try {
//     const { question } = req.body;

//     const prompt = `
// Answer ONLY in plain text.
// No JSON.
// No explanation.

// Question: ${question}
// `;

//     const raw = await callOpenAi(prompt);

//     let answer = raw;

//     // 🛡️ safety: agar AI JSON de de
//     try {
//       const parsed = JSON.parse(raw);
//       answer =
//         parsed.answer ||
//         parsed.response ||
//         parsed.explanation ||
//         Object.values(parsed)[0];
//     } catch {}

//     answer = String(answer).replace(/[{}"]/g, "").trim();

//     // ✅ ai_chats
//     await req.supabase.from("ai_chats").insert({
//       id: uuid(),
//       user_id: req.user.id,
//       question,
//       answer,
//       context: {}
//     });

//     // ✅ history (YAHI MISS THA)
//     await req.supabase.from("history").insert({
//       id: uuid(),
//       user_id: req.user.id,
//       type: "AI",
//       title: "Asked AI",
//       description: question
//     });

//     res.json({ answer });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "AI failed" });
//   }
// });

app.post("/api/ai/ask", protect, async (req, res) => {
  try {
    const { question, context } = req.body;

    /*
      Expected context format from frontend:

      context: {
        class: "8",
        subject: "Maths",
        chapter: "Algebraic Expressions",
        board: "CBSE"
      }
    */

    // 🔹 Build context text for prompt
    let contextText = "";

    if (context) {
      contextText = `
Student Context:
Class: ${context.class || ""}
Subject: ${context.subject || ""}
Chapter: ${context.chapter || ""}
Board: ${context.board || ""}
`;
    }

    const prompt = `
Answer ONLY in plain text.
No JSON.
No explanation outside the answer.

${contextText}

Question: ${question}
`;

    const raw = await callOpenAi(prompt);

    let answer = raw;

    // 🛡️ Safety: if AI returns JSON accidentally
    try {
      const parsed = JSON.parse(raw);
      answer =
        parsed.answer ||
        parsed.response ||
        parsed.explanation ||
        Object.values(parsed)[0];
    } catch {}

    answer = String(answer).replace(/[{}"]/g, "").trim();

    // ✅ Save to ai_chats
    await req.supabase.from("ai_chats").insert({
      id: uuid(),
      user_id: req.user.id,
      question,
      answer,
      context: context || {}
    });

    // ✅ Save to history with context included
    await req.supabase.from("history").insert({
      id: uuid(),
      user_id: req.user.id,
      type: "AI",
      title: "Asked AI",
      description: `${question} (${context?.class || ""} ${context?.subject || ""})`
    });

    res.json({ answer });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI failed" });
  }
});




function getPromptByType({
  type,
  subject,
  chapter,
  difficulty,
  questionCount,
  classLevel,
  specificTopics // 👈 NEW
}) {
  const topicInstruction = specificTopics
    ? `IMPORTANT: Focus ONLY on these topics: ${specificTopics}`
    : `Cover the chapter broadly.`;

  switch (type) {

    case "MCQs (Quiz)":
      return `
Generate EXACTLY ${questionCount} questions of type "${type}".

STRICT RULES:
- Return ONE valid JSON ARRAY only
- Do NOT wrap in markdown
- Do NOT add extra text

Each object MUST contain:
- "question": string
- "options": array of strings
- "answer": string

Class: ${classLevel}
Subject: ${subject}
Chapter: ${chapter}
Difficulty: ${difficulty}

${topicInstruction}

NOW RETURN ONLY THE JSON ARRAY:
`;

    case "Practice Questions":
      return `
Generate EXACTLY ${questionCount} Practice Questions.

STRICT RULES:
- Return ONE valid JSON ARRAY only
- Do NOT explain anything

Each object MUST contain:
- "question": string
- "answer": string

Class: ${classLevel}
Subject: ${subject}
Chapter: ${chapter}
Difficulty: ${difficulty}

${topicInstruction}

RETURN ONLY JSON ARRAY:
`;

    case "Drag And Drop":
      return `
Generate ${questionCount} SIMPLE drag and drop algebra questions.

Class: ${classLevel}
Subject: ${subject}
Chapter: ${chapter}
Difficulty: ${difficulty}

${topicInstruction}

RULES:
- Only simple algebra
- No roots, fractions, symbols
- Expression simplification only

Return ONLY valid JSON array.

Each object:
{
  "question": "Simplify ...",
  "dragItems": ["x","2x","-x"],
  "correctExpression": "x"
}
`;

    case "Matching":
      return `
Generate ${questionCount} matching questions.

Class: ${classLevel}
Subject: ${subject}
Chapter: ${chapter}
Difficulty: ${difficulty}

${topicInstruction}

Return ONLY valid JSON array.
`;

    case "Flashcards":
      return `
Generate ${questionCount} flashcards.

Class: ${classLevel}
Subject: ${subject}
Chapter: ${chapter}
Difficulty: ${difficulty}

${topicInstruction}

Return ONLY valid JSON array.
`;

    case "Word Search":
      return `
Generate ${questionCount} word search questions.

Class: ${classLevel}
Subject: ${subject}
Chapter: ${chapter}
Difficulty: ${difficulty}

${topicInstruction}

Return ONLY valid JSON array.
`;

    case "Fill in Blanks":
      return `
Generate ${questionCount} fill in the blanks questions.

Class: ${classLevel}
Subject: ${subject}
Chapter: ${chapter}
Difficulty: ${difficulty}

${topicInstruction}

Return ONLY valid JSON array.
`;

    case "Crossword":
      return `
Generate ${questionCount} crossword questions.

Class: ${classLevel}
Subject: ${subject}
Chapter: ${chapter}
Difficulty: ${difficulty}

${topicInstruction}

Return ONLY valid JSON array.
`;

    default:
      throw new Error("Unsupported exercise type");
  }
}


app.post("/api/exercise/generate", protect, async (req, res) => {
  try {
    const {
      subject,
      chapter,
      type,
      difficulty = "medium",
      questionCount,
      context
    } = req.body;

    const prompt = getPromptByType({
      type,
      subject,
      chapter,
      difficulty,
      questionCount,
      classLevel: req.profile?.class_level || "General",
      specificTopics: context?.topics || null // 👈 HERE
    });

    const aiText = await callOpenAi(prompt);
    const extracted = extractJSON(aiText);

    if (!Array.isArray(extracted)) {
      throw new Error("AI did not return an array");
    }

    const { data, error } = await req.supabase
      .from("exercises")
      .insert({
        id: uuid(),
        user_id: req.user.id,
        subject,
        chapter,
        type,
        difficulty,
        topics: context?.topics || null, // optional DB save
        questions: extracted
      })
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("Exercise generation error:", err);
    res.status(500).json({ error: "Exercise generation failed" });
  }
});



app.post("/api/exercise/submit", protect, async (req, res) => {
  try {
    const { exercise_id, answers } = req.body;


    if (!exercise_id || !Array.isArray(answers)) {
      return res.status(400).json({ error: "exercise_id and answers are required" });
    }

    // Fetch the exercise from Supabase
    const { data: exercise, error: fetchError } = await req.supabase
      .from("exercises")
      .select("*")
      .eq("id", exercise_id)
      .single();

    if (fetchError || !exercise) {
      return res.status(404).json({ error: "Exercise not found" });
    }

    const questions = exercise.questions;


    const details = answers.map(a => {
      const q = questions.find(q => q.id === a.question_id);
      return {
        question: a.question,
        selected: a.selected,
        correct: q?.answer === a.selected,
        correctAnswer: q?.answer  // ✅ include the correct answer
      };
    });

    // Calculate score
    const score = details.filter(d => d.correct).length;
    const total = questions.length;

    // Save attempt in Supabase
    await req.supabase.from("exercise_attempts").insert({
      id: uuid(),
      user_id: req.user.id,
      exercise_id,
      score,
      total,
      details
    });

    // Also save in history
    await req.supabase.from("history").insert({
      id: uuid(),
      user_id: req.user.id,
      type: "EXERCISE",
      title: `${exercise.type} • ${exercise.subject}`,
      description: `
    Subject: ${exercise.subject}
    Chapter: ${exercise.chapter}
    Type: ${exercise.type}
    Score: ${score}/${total}
      `.trim(),
      meta: {
        exercise_id,
        subject: exercise.subject,
        chapter: exercise.chapter,
        exercise_type: exercise.type,
        score,
        total
      }
    });
    

    res.json({ success: true, score, total, details });
  } catch (err) {
    console.error("Exercise submit error:", err.message);
    res.status(500).json({ error: "Exercise submission failed" });
  }
});


const usedQuestions = {
  mcq: [],
  short: [],
  long: []
};


// ===================== CREATE EXAM =====================
app.post("/api/exams", protect, async (req, res) => {
  try {
    const {
      exam_name,
      subjects,
      duration,
      total_marks,
      question_type,
      difficulty,
      status,
      institution_type,
      academic_context,
      exam_details   // <-- ADD THIS
    } = req.body;
    
    const exam = {
      id: uuid(),
      user_id: req.user.id,
      exam_name,
      subjects,
      duration,
      total_marks,
      question_type,
      difficulty,
      institution_type,
      academic_context,
      exam_details,    // <-- SAVE IT
      status: status ?? "CREATED"
    };
    

    const { data, error } = await req.supabase
      .from("exams")
      .insert(exam)
      .select()
      .single();

    if (error) throw error;

    console.log("✅ EXAM SAVED:", {
      exam_id: data.id,
      institution_type: data.institution_type,
      academic_context: data.academic_context
    });
    

    res.json({ examId: data.id });
  } catch (err) {
    console.error("❌ Exam insert failed:", err);
    res.status(400).json({ error: err.message });
  }
});



// ===================== GENERATE EXAM =====================
app.post("/api/exams/:id/generate", protect, async (req, res) => {
  try {
    const { id } = req.params;

    // 1️⃣ Fetch exam
    const { data: exam, error: examError } = await req.supabase
      .from("exams")
      .select("*")
      .eq("id", id)
      .single();

    if (examError || !exam)
      return res.status(404).json({ error: "Exam not found" });

    const blueprint = getExamBlueprint(exam.duration);
    const sections = [];
    let sectionNo = 1;

    const usedQuestions = { mcq: [], "short-answer": [], "long-answer": [] };

    // 2️⃣ Academic context extraction
    const institutionType = exam.institution_type ?? "UNKNOWN";
    const academicContext = exam.academic_context ?? {};

    let academicContextText = "";

    if (institutionType === "COMPETITIVE") {
      academicContextText = `Competitive Exam: ${academicContext.exam_type ?? "Unknown"} (${academicContext.exam_year ?? "Unknown Year"})`;
    } else if (institutionType === "SCHOOL") {
      academicContextText = `School: Class ${academicContext.class_level ?? "Unknown"}, Board: ${academicContext.board ?? "Unknown"}, School: ${academicContext.school ?? "Unknown"}`;
    } else if (institutionType === "COLLEGE") {
      academicContextText = `College: ${academicContext.degree ?? "Unknown Degree"}, Semester: ${academicContext.semester ?? "Unknown"}, University: ${academicContext.university ?? "Unknown"}`;
    } else {
      academicContextText = "Unknown academic context";
    }

    // 3️⃣ Syllabus info (chapter/topic)
    const chapter = exam.exam_details?.chapter ?? exam.chapter ?? "Full Syllabus";

    console.log("🎯 GENERATE EXAM CONTEXT:", {
      institutionType,
      academicContext,
      academicContextText,
      chapter
    });

    // 4️⃣ Loop through sections
    for (const block of blueprint) {
      let title = "";
      let promptBuilder;

      if (block.type === "mcq") {
        title = "Multiple Choice Questions";
        promptBuilder = (e, i, used) => mcqPrompt(e, i, used, academicContextText, chapter);
      } else if (block.type === "short-answer") {
        title = "Short Answer Questions";
        promptBuilder = (e, i, used) => shortPrompt(e, i, used, academicContextText, chapter);
      } else if (block.type === "long-answer") {
        title = "Long Answer Questions";
        promptBuilder = (e, i, used) => longPrompt(e, i, used, academicContextText, chapter);
      }

      const section = {
        number: sectionNo++,
        title,
        description: `${block.count} Questions • ${block.count * block.marks_per_question} Marks`,
        type: block.type,
        marks_per_question: block.marks_per_question,
        questions: []
      };

      for (let i = 0; i < block.count; i++) {
        let questionData = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const aiText = await callAIWithTimeout(
              promptBuilder(exam, i + 1, usedQuestions[block.type])
            );
            questionData = JSON.parse(aiText);

            if (!questionData.question)
              throw new Error("Missing question");
            if (block.type === "mcq" && !Array.isArray(questionData.options))
              throw new Error("MCQ options missing");

            usedQuestions[block.type].push(questionData.question);
            break;
          } catch (err) {
            console.warn("⚠️ AI parse failed:", err.message);
            questionData = null;
          }
        }
        if (!questionData) continue;

        section.questions.push(
          block.type === "mcq"
            ? { 
                id: crypto.randomUUID(), 
                text: questionData.question, 
                options: questionData.options, 
                selected: null,
              }
            : { 
                id: crypto.randomUUID(), 
                text: questionData.question, 
                answer: "",
              }
        );
      }

      sections.push(section);
    }

    const instructions = buildInstructions(exam, sections);

    // 5️⃣ Save generated exam
    const { error: updateError } = await req.supabase
      .from("exams")
      .update({ sections: JSON.stringify(sections), instructions, status: "GENERATED" })
      .eq("id", id);

    if (updateError) throw updateError;

    res.json({
      title: exam.exam_name,
      subjects: exam.subjects,
      chapter,
      difficulty: exam.difficulty,
      duration: exam.duration,
      total_marks: exam.total_marks,
      institution_type: exam.institution_type,
      academic_context: exam.academic_context,
      instructions,
      sections,
      currentSection: 0
    });

  } catch (err) {
    console.error("🔥 GENERATE FAILED:", err);
    res.status(500).json({ error: "Exam generation failed" });
  }
});


// ===================== SUBMIT EXAM (AI-EVALUATED + Scaled Score) =====================
app.post("/api/exams/submit", protect, async (req, res) => {
  try {
    const { exam_id, answers } = req.body;
    const userId = req.user.id;

    // ===================== GET EXAM =====================
    const { data: exam } = await req.supabase
      .from("exams")
      .select("*")
      .eq("id", exam_id)
      .single();

    if (!exam) {
      return res.status(404).json({ error: "Exam not found" });
    }

    const sections =
      typeof exam.sections === "string"
        ? JSON.parse(exam.sections)
        : exam.sections;

    if (!Array.isArray(sections)) {
      return res.status(500).json({ error: "Invalid exam structure" });
    }

    // ===================== SUBJECT / CHAPTER =====================
    const subject = Array.isArray(exam.subjects)
      ? exam.subjects.join(", ")
      : exam.subjects ?? "Unknown Subject";

    const chapter = exam.exam_details?.chapter ?? "Full Syllabus";

    // ===================== PREPARE QUESTIONS =====================
    const allQuestions = sections.flatMap(section =>
      section.questions.map(q => ({
        id: q.id,
        text: q.text,
        options: section.type === "mcq" ? q.options : undefined,
        type: section.type,
        marks: section.marks_per_question,
      }))
    );

    const studentAnswers = answers.map(a => ({
      question_id: a.question_id,
      answer: a.answer,
    }));

    // ===================== AI EVALUATION =====================
    const aiPrompt = `
You are a strict examiner.

Return ONLY valid JSON:
{
  "total_score": number,
  "feedback": [
    {
      "question_id": "",
      "correct_answer": "",
      "student_answer": "",
      "explanation": ""
    }
  ]
}

Questions:
${JSON.stringify(allQuestions)}

Student answers:
${JSON.stringify(studentAnswers)}
`;

    let aiText = await callOpenAi(aiPrompt);
    let rawScore = 0;
    let feedback = [];

    try {
      const parsed = JSON.parse(aiText);
      rawScore = parsed.total_score || 0;
      feedback = parsed.feedback || [];
    } catch (err) {
      console.error("AI JSON error:", aiText);
      feedback = studentAnswers.map(ans => ({
        question_id: ans.question_id,
        correct_answer: "",
        student_answer: ans.answer,
        explanation: "AI evaluation failed",
      }));
    }

    // ===================== SCALE SCORE =====================
    const totalExamMarks = exam.total_marks ?? 100;

    const maxRawScore = allQuestions.reduce(
      (sum, q) => sum + (q.marks ?? 1),
      0
    );

    const finalScore = Math.round(
      (rawScore / maxRawScore) * totalExamMarks
    );

    // ===================== SAVE EXAM ATTEMPT =====================
    await req.supabase.from("exam_attempts").insert({
      id: uuid(),
      user_id: userId,
      exam_id,
      score: finalScore,
      total: totalExamMarks,
      details: feedback,
      attempted: answers.length,
    });

    // ===================== UPDATE DAILY ACTIVITY (STREAK + SCORE) =====================


    // ===================== SAVE HISTORY =====================
    await req.supabase.from("history").insert({
      id: uuid(),
      user_id: userId,
      type: "EXAM",
      title: exam.exam_name,
      description: `
Subject: ${subject}
Chapter: ${chapter}
Score: ${finalScore}/${totalExamMarks}
      `.trim(),
      meta: {
        exam_id,
        exam_name: exam.exam_name,
        subject,
        chapter,
        score: finalScore,
        total: totalExamMarks,
      },
    });

    // ===================== RESPONSE =====================
    res.json({
      success: true,
      exam_info: {
        title: exam.exam_name,
        subject,
        chapter,
        difficulty: exam.difficulty,
        total_marks: totalExamMarks,
        duration: exam.duration,
      },
      score: finalScore,
      total: totalExamMarks,
      feedback,
    });

  } catch (err) {
    console.error("Exam submit error:", err);
    res.status(500).json({ error: "Exam evaluation failed" });
  }
});

// ===================== HELPERS =====================

function getExamBlueprint(duration) {
  if (duration <= 30) {
    return [
      { type: "mcq", count: 15, marks_per_question: 1 },
      { type: "short-answer", count: 3, marks_per_question: 2 },
      { type: "long-answer", count: 1, marks_per_question: 5 }
    ];
  }

  if (duration <= 60) {
    return [
      { type: "mcq", count: 30, marks_per_question: 1 },
      { type: "short-answer", count: 6, marks_per_question: 2 },
      { type: "long-answer", count: 2, marks_per_question: 5 }
    ];
  }

  return [
    { type: "mcq", count: 60, marks_per_question: 1 },
    { type: "short-answer", count: 10, marks_per_question: 2 },
    { type: "long-answer", count: 4, marks_per_question: 5 }
  ];
}


function buildInstructions(exam, sections) {
  return `Answer all questions. Total ${exam.total_marks} marks.`;
}


function mcqPrompt(exam, index, used, academicContextText, chapter) {
  return `
Generate ONE exam-standard MCQ strictly aligned with the following academic context:

Academic Context:
${academicContextText}

Syllabus Topic:
${chapter}

CRITICAL INSTRUCTIONS:
- Question must be DIRECTLY DERIVED from the officially prescribed syllabus and textbooks
- Use the SAME core concept, SAME framing logic, SAME command words,
  SAME difficulty level, and SAME distractor logic as real exam MCQs
- Question should feel IDENTICAL to a textbook or previous-year exam question
- DO NOT copy any copyrighted text word-for-word
- Avoid creativity, opinions, or real-world storytelling
- If a teacher reads it, it should feel: "This question is straight from the exam"

EXAM RULES:
- Question number: ${index}
- Do NOT repeat or rephrase previously asked questions
- Test a DIFFERENT syllabus concept each time
- Difficulty must exactly match: ${exam.difficulty}
- Framing must match the exam defined in Academic Context

Previously asked questions:
${used.length > 0 ? used.join("\n") : "None"}

OUTPUT FORMAT (STRICT):
Return ONLY valid JSON. No explanations. No markdown.

{
  "question": "string",
  "options": [
    "A) ...",
    "B) ...",
    "C) ...",
    "D) ..."
  ]
}

Subject: ${exam.subjects[0] || "Subject"}
Chapter: ${chapter}
ONLY generate questions from this chapter.
Do NOT include anything outside this chapter.
Difficulty: ${exam.difficulty}
`;

}


function shortPrompt(exam, index, used, academicContextText, chapter) {
  return ` Generate ONE exam-standard Short ANSWER question (2–3 lines expected in answer) strictly aligned with the following academic context:

Academic Context:
${academicContextText}

Syllabus Topic:
${chapter}

CRITICAL INSTRUCTION:
- Question must be DIRECTLY DERIVED from the prescribed textbooks
- Use the SAME core concept, SAME command words (Explain/Why/How),
  SAME depth, and SAME marks-expectation as real exam questions
- Question should feel IDENTICAL to a textbook or previous-year exam question,
  but must NOT copy any copyrighted text word-for-word
- Avoid creative or opinion-based framing; keep it exam-focused and precise

Rules:
- Question #${index}
- Must test conceptual clarity or reasoning
- Answer length expectation: 2–3 lines (as per exam norms)
- Must NOT repeat or closely rephrase previous questions
- Difficulty must exactly match: ${exam.difficulty}
- Framing must match the exam defined in Academic Context

Previously asked questions:
${used.length > 0 ? used.join("\n") : "None"}

Return ONLY JSON:
{
  "question": ""
}

Subject: ${exam.subjects[0] || "Subject"}
Chapter: ${chapter}
ONLY generate questions from this chapter.
Do NOT include anything outside this chapter.
Difficulty: ${exam.difficulty}
`;
}


function longPrompt(exam, index, used, academicContextText, chapter) {
  return ` Generate ONE exam-standard Short ANSWER question (2–3 lines expected in answer) strictly aligned with the following academic context:

  Academic Context:
  ${academicContextText}
  
  Syllabus Topic:
  ${chapter} 

CRITICAL INSTRUCTION:
- Question must be DIRECTLY DERIVED from the prescribed textbooks
- Follow the SAME structure, SAME command verbs (Describe, Explain, Compare, Justify),
  SAME marks-weightage logic, and SAME level of detail as real board exam questions
- Question should feel like it is taken straight from a textbook or board paper,
  but must NOT copy any copyrighted text word-for-word
- Avoid creativity; focus on structured, exam-scoring answers

Exam Expectations:
- Requires step-wise explanation, reasoning, or comparison
- May include diagram-based instruction where relevant
- Should clearly indicate what a high-scoring answer must include

Rules:
- Question #${index}
- Must require detailed explanation or analysis
- Can be case-based, reasoning-based, or comparative (as per textbook norms)
- Must NOT repeat or closely resemble earlier questions
- Difficulty must exactly match: ${exam.difficulty}
- Framing must match the exam defined in Academic Context

Previously asked questions:
${used.length > 0 ? used.join("\n") : "None"}

Return ONLY JSON:
{
  "question": ""
}

Subject: ${exam.subjects[0] || "Subject"}
Chapter: ${chapter}
ONLY generate questions from this chapter.
Do NOT include anything outside this chapter.
Difficulty: ${exam.difficulty}
`;
}


async function callAIWithTimeout(prompt, timeout = 40000) {
  return Promise.race([
    callOpenAi(prompt),
    new Promise((_, reject) => setTimeout(() => reject(new Error("AI timeout")), timeout))
  ]);
}

/* ================= CHAPTERS ================= */

app.post("/api/chapters/generate", protect, async (req, res) => {
  try {
    const { subject } = req.body;

    // profile se automatically lo
    const board = req.profile.board;
    const class_level = req.profile.class_level;

    if (!subject || !board || !class_level) {
      return res.status(400).json({
        success: false,
        error: "subject, board and class_level are required"
      });
    }

    const prompt = buildChapterPrompt({
      board,
      class_level,
      subject
    });

    const aiText = await callOpenAi(prompt);

    let chapters;
    try {
      chapters = JSON.parse(aiText);
    } catch (err) {
      console.error("Invalid chapter JSON:", aiText);
      return res.status(500).json({
        success: false,
        error: "AI returned invalid chapters format"
      });
    }

    res.json({
      success: true,
      subject,
      board,
      class_level,
      chapters
    });

  } catch (err) {
    console.error("Chapter generation error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to generate chapters"
    });
  }
});

function buildChapterPrompt({ board, class_level, subject }) {
  return `
You are an Indian school syllabus expert.

Generate chapter or topic names for:
Board: ${board}
Class: ${class_level}
Subject: ${subject}

Rules:
- Follow NCERT / CBSE style syllabus
- Simple chapter names
- Return ONLY a valid JSON array of strings
- No explanation, no markdown

Example:
["Chapter 1: Numbers", "Chapter 2: Addition"]
`;
}


/* ================= HISTORY & PROGRESS ================= */

app.get("/api/history", protect, async (req, res) => {
  const { data } = await req.supabase
  .from("history")
  .select("*")
  .eq("user_id", req.user.id)
  .order("created_at", { ascending: false });
  

  res.json(data);
});

/* ================= TODAY STUDY PLAN ================= */



// helper: streak calculation
function calculateStreak(attempts) {
  const days = Array.from(
    new Set(attempts.map(a => new Date(a.created_at).toDateString()))
  )
    .map(d => new Date(d))
    .sort((a, b) => b - a);

  let streak = 0;
  for (let i = 0; i < days.length; i++) {
    if (i === 0) streak = 1;
    else {
      const diff =
        (days[i - 1] - days[i]) / (1000 * 60 * 60 * 24);
      if (diff === 1) streak++;
      else break;
    }
  }
  return streak;
}

app.get("/api/progress", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = req.profile;

    /* ================= FETCH DATA ================= */

    const { data: exerciseAttempts = [] } = await req.supabase
      .from("exercise_attempts")
      .select("score,total,created_at,exercises(subject)");

    const { data: examAttempts = [] } = await req.supabase
      .from("exam_attempts")
      .select("score,total,created_at,exam_id");

    const { data: exams = [] } = await req.supabase
      .from("exams")
      .select("id, subject");

    /* ================= PROFILE SUBJECTS ================= */

    // profile.subjects = "maths,english,hindi,science,physics,chemistry"
    const rawSubjects = (profile.subjects || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 6); // hard limit: max 6 subjects

    const SUBJECT_LABEL_MAP = {
      maths: "Mathematics",
      math: "Mathematics",
      english: "English",
      science: "Science",
      hindi: "Hindi",
      physics: "Physics",
      chemistry: "Chemistry",
      biology: "Biology",
      history: "History",
      geography: "Geography"
    };

    const COLOR_PALETTE = [
      "#6366f1", // indigo
      "#8b5cf6", // violet
      "#3b82f6", // blue
      "#22c55e", // green
      "#f59e0b", // amber
      "#ef4444"  // red
    ];

    const SUBJECT_KEY_TO_LABEL = {};
    const SUBJECT_LABEL_TO_COLOR = {};

    rawSubjects.forEach((key, index) => {
      const label =
        SUBJECT_LABEL_MAP[key] ||
        key.charAt(0).toUpperCase() + key.slice(1);

      SUBJECT_KEY_TO_LABEL[key] = label;
      SUBJECT_LABEL_TO_COLOR[label] =
        COLOR_PALETTE[index % COLOR_PALETTE.length];
    });

    /* ================= USER ================= */

    const user = {
      id: userId,
      name: `${profile.first_name} ${profile.last_name}`,
      class: String(profile.class_level ?? ""),
      board: profile.board ?? ""
    };

    /* ================= STATS ================= */

    const allAttempts = [...exerciseAttempts, ...examAttempts];

    const totalScore = allAttempts.reduce((s, a) => s + (a.score ?? 0), 0);
    const totalMax = allAttempts.reduce((s, a) => s + (a.total ?? 0), 0);

    const averageScore =
      totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;

    const learningMinutes =
      exerciseAttempts.length * 5 + examAttempts.length * 15;

    const learningHours = Number((learningMinutes / 60).toFixed(2));

    const uniqueDays = new Set(
      allAttempts.map(a => new Date(a.created_at).toDateString())
    ).size;

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const stats = {
      average_score: averageScore,
      exams_taken: examAttempts.length,
      exercises_done: exerciseAttempts.length,
      learning_hours: learningHours,
      weekly_exams: examAttempts.filter(
        e => new Date(e.created_at) >= oneWeekAgo
      ).length,
      streak_days: calculateStreak(allAttempts),
      daily_hours:
        uniqueDays > 0
          ? Number((learningHours / uniqueDays).toFixed(2))
          : 0
    };

    /* ================= SUBJECTS ================= */

    const subjects = {};

    const pushTrend = (label, percent) => {
      subjects[label] ??= {
        average_score: 0,
        exercises: 0,
        exams: 0,
        trend: []
      };
      subjects[label].trend.push(percent);
    };

    exerciseAttempts.forEach(a => {
      const raw = a.exercises?.subject?.toLowerCase();
      const label = SUBJECT_KEY_TO_LABEL[raw];
      if (!label) return;

      subjects[label] ??= {
        average_score: 0,
        exercises: 0,
        exams: 0,
        trend: []
      };

      subjects[label].exercises++;
      pushTrend(label, Math.round((a.score / a.total) * 100));
    });

    const examSubjectMap = {};
    exams.forEach(e => {
      const raw = e.subject?.toLowerCase();
      if (SUBJECT_KEY_TO_LABEL[raw]) {
        examSubjectMap[e.id] = SUBJECT_KEY_TO_LABEL[raw];
      }
    });

    examAttempts.forEach(a => {
      const label = examSubjectMap[a.exam_id];
      if (!label) return;

      subjects[label] ??= {
        average_score: 0,
        exercises: 0,
        exams: 0,
        trend: []
      };

      subjects[label].exams++;
      pushTrend(label, Math.round((a.score / a.total) * 100));
    });

    Object.keys(subjects).forEach(label => {
      const t = subjects[label].trend;
      subjects[label].average_score =
        t.length > 0
          ? Math.round(t.reduce((a, b) => a + b, 0) / t.length)
          : 0;
    });

    /* ================= ACHIEVEMENTS ================= */

    const achievements = [];

    if (stats.streak_days >= 7) {
      achievements.push({
        title: "7-Day Streak",
        description: "Practiced consistently for 7 days",
        icon: "zap",
        color: "green"
      });
    }

    if (stats.average_score >= 85) {
      achievements.push({
        title: "Top Performer",
        description: "Excellent overall performance",
        icon: "star",
        color: "purple"
      });
    }

    /* ================= PERFORMANCE GRAPH ================= */

    const maxLen = Math.max(
      ...Object.values(subjects).map(s => s.trend.length),
      0
    );

    const performance_data = {
      labels: Array.from({ length: maxLen }, (_, i) => `Attempt ${i + 1}`),
      datasets: Object.keys(subjects).map(label => ({
        subject: label,
        data: subjects[label].trend,
        color: SUBJECT_LABEL_TO_COLOR[label]
      }))
    };

    /* ================= FINAL ================= */

    res.json({
      user,
      stats,
      subjects,
      achievements,
      performance_data
    });

  } catch (err) {
    console.error("Progress error:", err);
    res.status(500).json({ error: "Failed to load progress" });
  }
});



// ================= PROFILE =================

// Get logged-in user's profile
app.get("/api/profile", protect, async (req, res) => {
  try {
    res.json({
      success: true,
      profile: req.profile
    });
  } catch (err) {
    console.error("Get profile error:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Update logged-in user's profile (onboarding)
app.put("/api/profile", protect, async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      institution_name,
      class_level,
      board,
      subjects
    } = req.body;

    const updateData = {};

    if (first_name !== undefined) updateData.first_name = first_name;
    if (last_name !== undefined) updateData.last_name = last_name;
    if (institution_name !== undefined) updateData.institution_name = institution_name;
    if (class_level !== undefined) updateData.class_level = class_level;
    if (board !== undefined) updateData.board = board;
    if (subjects !== undefined) updateData.subjects = subjects;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const { error } = await req.supabase
      .from("profiles")
      .update(updateData)
      .eq("id", req.user.id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ error: "Profile update failed" });
  }
});


app.put("/api/profile/update", protect, async (req, res) => {
  try {
    const { first_name, last_name, email, password} = req.body;

    /* ================= NAME UPDATE ================= */
    if (first_name !== undefined || last_name !== undefined) {
      const updateProfile = {};
      if (first_name !== undefined) updateProfile.first_name = first_name;
      if (last_name !== undefined) updateProfile.last_name = last_name;

      const { error: profileError } = await req.supabase
        .from("profiles")
        .update(updateProfile)
        .eq("id", req.user.id);

      if (profileError) throw profileError;
    }

    /* ================= AUTH UPDATE ================= */
    // email / password change
    if (email || password) {
      const authPayload = {};
      if (email) authPayload.email = email;
      if (password) authPayload.password = password;

      const { error: authError } = await supabaseAnon.auth.updateUser(
        authPayload,
        {
          accessToken: req.headers.authorization.replace("Bearer ", "")
        }
      );

      if (authError) {
        return res.status(400).json({ error: authError.message });
      }
    }

    res.json({
      success: true,
      message: "Profile updated successfully"
    });

  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ error: "Profile update failed" });
  }
});



// ================= PLAN UPGRADE =================




app.post("/api/plan/upgrade", protect, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!plan || !PLANS[plan]) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    // If already paid, block upgrade
    if (req.profile.plan === "PAID") {
      return res.status(400).json({ error: "Already on PAID plan" });
    }

    // Upgrade only after payment verified
    return res.status(400).json({
      error:
        "Use /api/payment/create-order and /api/payment/verify to upgrade plan"
    });

  } catch (err) {
    console.error("Plan upgrade error:", err);
    res.status(500).json({ error: "Plan upgrade failed" });
  }
});

app.post("/api/plan/upgrade-amount", protect, async (req, res) => {
  try {
    const { newPlan } = req.body;

    if (!PLANS[newPlan]) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const currentPlan = req.profile.plan; // FREE or PAID
    const expiry = req.profile.plan_expiry;

    if (currentPlan !== "PAID" || !expiry) {
      return res.json({
        success: true,
        payableAmount: PLANS[newPlan].amount,
        discount: 0,
        message: "No active plan. Pay full amount."
      });
    }

    // remaining days
    const now = new Date();
    const exp = new Date(expiry);
    const remainingMs = exp - now;

    if (remainingMs <= 0) {
      return res.json({
        success: true,
        payableAmount: PLANS[newPlan].amount,
        discount: 0,
        message: "Current plan expired. Pay full amount."
      });
    }

    const remainingDays = remainingMs / (1000 * 60 * 60 * 24);

    // monthly price
    const monthlyPrice = PLANS.MONTHLY.amount;

    // unused amount = monthlyPrice * (remainingDays / 30)
    const unusedAmount = Math.round(monthlyPrice * (remainingDays / 30));

    const discount = unusedAmount;
    const payableAmount = PLANS[newPlan].amount - discount;

    res.json({
      success: true,
      payableAmount,
      discount,
      remainingDays: Math.round(remainingDays),
      message: "Prorated upgrade amount calculated."
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to calculate upgrade amount" });
  }
});


app.post("/api/payment/create-order", protect, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!PLANS[plan]) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    // calculate discount if user already PAID
    let finalAmount = PLANS[plan].amount;

    if (req.profile.plan === "PAID" && req.profile.plan_expiry) {
      const now = new Date();
      const exp = new Date(req.profile.plan_expiry);
      const remainingMs = exp - now;

      if (remainingMs > 0) {
        const remainingDays = remainingMs / (1000 * 60 * 60 * 24);
        const unused = Math.round(PLANS.MONTHLY.amount * (remainingDays / 30));
        finalAmount = Math.max(0, PLANS[plan].amount - unused);
      }
    }

    const receiptId = `rcpt_${uuid().slice(0, 10)}`;

    const order = await razorpay.orders.create({
      amount: finalAmount,
      currency: "INR",
      receipt: receiptId,
      notes: { user_id: req.user.id, plan }
    });

    res.json({
      success: true,
      order_id: order.id,
      key: process.env.RAZORPAY_KEY_ID,
      receipt: receiptId,
      amount: finalAmount
    });

  } catch (err) {
    console.error("Razorpay create-order error:", err);
    return res.status(400).json({
      error: "Razorpay order creation failed",
      details: err?.message || err
    });
  }
});



app.post("/api/payment/verify", protect, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !plan) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!PLANS[plan]) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    // 🔐 Idempotency check
    const { data: existing } = await req.supabase
      .from("payments")
      .select("id")
      .eq("razorpay_payment_id", razorpay_payment_id)
      .maybeSingle();

    if (existing) {
      return res.json({
        success: true,
        message: "Payment already verified"
      });
    }

    const expiry = new Date();

    if (PLANS[plan].durationMinutes) {
      expiry.setMinutes(expiry.getMinutes() + PLANS[plan].durationMinutes);
    } else {
      expiry.setDate(expiry.getDate() + PLANS[plan].durationDays);
    }

    // ✅ Update profile
    await req.supabase
      .from("profiles")
      .update({
        plan: "PAID",
        plan_type: plan,
        plan_expiry: expiry.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", req.user.id);

    // ✅ Insert history
    await req.supabase.from("history").insert({
      id: uuid(),
      user_id: req.user.id,
      type: "PLAN",
      title: "Plan Activated",
      description: `
Plan: ${plan}
Amount Paid: ₹${PLANS[plan].amount / 100}
Valid Till: ${expiry.toDateString()}
      `.trim(),
      meta: {
        plan,
        amount: PLANS[plan].amount / 100,
        expiry: expiry.toISOString(),
        action:
          req.profile.plan === "PAID" && req.profile.plan_expiry
            ? "UPGRADE"
            : "PURCHASE"
      }
    });

    // ✅ Insert payment
    await req.supabase.from("payments").insert({
      id: uuid(),
      user_id: req.user.id,
      razorpay_order_id,
      razorpay_payment_id,
      plan,
      amount: PLANS[plan].amount / 100,
      status: "SUCCESS"
    });

    /* ================= 🔔 SEND PUSH ================= */

    const { data: profileData } = await req.supabase
      .from("profiles")
      .select("device_tokens")
      .eq("id", req.user.id)
      .single();

   // 1️⃣ Save in DB
await req.supabase.from("notifications").insert({
  user_id: req.user.id,
  title: "Plan Activated 🎉",
  body: `Your ${plan} plan is now active!`,
  type: "PLAN"
});

// 2️⃣ Send push
await sendPush(
  profileData?.device_tokens,
  "Plan Activated 🎉",
  `Your ${plan} plan is now active!`,
  { type: "PLAN", screen: "dashboard" }
);


    /* ================================================= */

    res.json({ success: true, expires_on: expiry });

  } catch (err) {
    console.error("Payment verify error:", err);
    res.status(500).json({ error: "Payment verification failed" });
  }
});


/* ================= PUSH FUNCTION ================= */

async function sendPush(tokens, title, body, data = {}) {
  try {
    if (!tokens || tokens.length === 0) return;

    const message = {
      notification: {
        title,
        body
      },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      tokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log("Push result:", response.successCount, "sent");

    return response;

  } catch (err) {
    console.error("Push failed:", err);
  }
}


/* ================= SAVE DEVICE TOKEN ================= */

app.post("/api/device-token", protect, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token required" });
    }

    const { data: profile } = await req.supabase
      .from("profiles")
      .select("device_tokens")
      .eq("id", req.user.id)
      .single();

    const tokens = profile.device_tokens || [];

    if (!tokens.includes(token)) {
      tokens.push(token);
    }

    await req.supabase
      .from("profiles")
      .update({ device_tokens: tokens })
      .eq("id", req.user.id);

    res.json({ success: true });

  } catch (err) {
    console.error("Save token error:", err);
    res.status(500).json({ error: "Failed to save token" });
  }
});

/* ================= SAVE DEVICE TOKEN ================= */

app.post("/api/save-token", protect, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token required" });
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("device_tokens")
      .eq("id", req.user.id)
      .single();

    let tokens = profile?.device_tokens || [];

    if (!tokens.includes(token)) {
      tokens.push(token);

      await supabaseAdmin
        .from("profiles")
        .update({ device_tokens: tokens })
        .eq("id", req.user.id);
    }

    res.json({ success: true });

  } catch (err) {
    console.error("Save token error:", err);
    res.status(500).json({ error: "Failed to save token" });
  }
});


/* ================= STUDY REMINDER ================= */

app.post("/api/reminder/test", protect, async (req, res) => {

  const { data: profileData } = await supabaseAdmin
    .from("profiles")
    .select("device_tokens")
    .eq("id", req.user.id)
    .single();

  // 1️⃣ Save in DB
  await req.supabase.from("notifications").insert({
    user_id: req.user.id,
    title: "Study Reminder 📚",
    body: "You missed your study today!",
    type: "REMINDER"
  });

  // 2️⃣ Send push only if token exists
  if (profileData?.device_tokens?.length > 0) {
    await sendPush(
      profileData.device_tokens,
      "Study Reminder 📚",
      "You missed your study today!",
      { type: "REMINDER", screen: "study" }
    );
  }

  res.json({ success: true });
});


app.post("/api/notifications/save", protect, async (req, res) => {
  try {
    const { title, body, type } = req.body;

    const { error } = await req.supabase
      .from("notifications")
      .insert({
        user_id: req.user.id,
        title,
        body,
        type
      });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });

  } catch (err) {
    console.error("Save notification error:", err);
    res.status(500).json({ error: "Server error" });
  }
});



app.get("/api/notifications", protect, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from("notifications")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      notifications: data
    });

  } catch (err) {
    console.error("Notifications fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/api/notifications/:id/read", protect, async (req, res) => {
  const { id } = req.params;

  await req.supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("id", id)
    .eq("user_id", req.user.id);

  res.json({ success: true });
});

app.put("/api/notifications/read-all", protect, async (req, res) => {
  await req.supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("user_id", req.user.id)
    .eq("is_read", false);

  res.json({ success: true });
});






// ================= AVATAR API =================

app.get("/api/avatars/toonhead", async (req, res) => {
  try {
    const {
      category = "all", // girl | boy | all
      count = 20
    } = req.query;

    const validCategories = ["girl", "boy", "all"];

    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    const avatars = [];

    const generate = (type, limit) => {
      for (let i = 1; i <= limit; i++) {
        const seed = `${type}${i}`;
        avatars.push({
          id: seed,
          gender: type,
          url: `https://api.dicebear.com/9.x/toon-head/svg?seed=${seed}&backgroundColor=transparent&beardProbability=0&scale=90`
        });
      }
    };

    if (category === "all") {
      const half = Math.floor(count / 2);
      generate("girl", half);
      generate("boy", count - half);
    } else {
      generate(category, Number(count));
    }

    res.json({
      success: true,
      category,
      total: avatars.length,
      avatars
    });

  } catch (err) {
    console.error("Avatar API error:", err);
    res.status(500).json({ error: "Failed to generate avatars" });
  }
});

app.put("/api/profile/avatar", protect, async (req, res) => {
  try {

    // 🔐 STRICT PAYLOAD VALIDATION (ADD HERE)
    const allowedKeys = ["avatar_url"];
    const incomingKeys = Object.keys(req.body);

    if (!incomingKeys.every(k => allowedKeys.includes(k))) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const { avatar_url } = req.body;

    if (!avatar_url) {
      return res.status(400).json({ error: "Avatar URL required" });
    }

    const { error } = await req.supabase
      .from("profiles")
      .update({ avatar_url })
      .eq("id", req.user.id);

    if (error) throw error;

    res.json({
      success: true,
      message: "Avatar updated successfully"
    });

  } catch (err) {
    console.error("Avatar update error:", err);
    res.status(500).json({ error: "Avatar update failed" });
  }
});





app.get("/api/syllabus/my", protect, async (req, res) => {
  const { data, error } = await req.supabase
    .from("user_syllabus")
    .select("subject, chapters")
    .eq("user_id", req.user.id);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.json({ success: true, syllabus: data });
});


function buildTopicPrompt({ board, class_level, subject, chapter }) {
  return `
You are an academic content planner.

Generate a list of topic names for the chapter.

Board: ${board}
Class: ${class_level}
Subject: ${subject}
Chapter: ${chapter}

Rules:
- Return ONLY valid JSON
- Do NOT include explanations
- Do NOT include extra text
- Only return topic names

Format:
{
  "topics": [
    "Topic 1",
    "Topic 2",
    "Topic 3"
  ]
}
`;
}


app.post("/api/chapter/content/generate", protect, async (req, res) => {
  try {
    const { subject, chapter } = req.body;

    // 🔍 Check existing first
    const { data: existing, error: fetchError } = await req.supabase
      .from("chapter_content")
      .select("content")
      .eq("user_id", req.user.id)
      .eq("subject", subject)
      .eq("chapter", chapter)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      throw fetchError;
    }

    if (existing) {
      return res.json({
        success: true,
        generated: false,
        content: existing.content
      });
    }

    // 🚀 Generate if not exists
    const prompt = buildTopicPrompt({
      board: req.profile.board,
      class_level: req.profile.class_level,
      subject,
      chapter
    });

    const aiText = await callOpenAi(prompt);

    let content;
    try {
      content = JSON.parse(aiText);
    } catch {
      return res.status(500).json({ error: "Invalid AI content" });
    }

    const { data } = await req.supabase
      .from("chapter_content")
      .insert({
        id: uuid(),
        user_id: req.user.id,
        subject,
        chapter,
        content
      })
      .select()
      .single();

    res.json({
      success: true,
      generated: true,
      content: data.content
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to generate chapter topics" });
  }
});



app.get("/api/chapter/content", protect, async (req, res) => {
  const { subject, chapter } = req.query;

  const { data, error } = await req.supabase
    .from("chapter_content")
    .select("content")
    .eq("user_id", req.user.id)
    .eq("subject", subject)
    .eq("chapter", chapter)
    .single();

  if (error) {
    return res.status(404).json({ error: "Content not found" });
  }

  res.json({ success: true, content: data.content });
});


app.post("/api/chapter/complete", protect, async (req, res) => {
  const { subject, chapter } = req.body;

  await req.supabase
    .from("chapter_progress")
    .upsert({
      id: uuid(),
      user_id: req.user.id,
      subject,
      chapter,
      completed: true,
      last_seen: new Date().toISOString()
    });

  res.json({ success: true });
});



function buildTopicLearningPrompt({
  board,
  class_level,
  subject,
  chapter,
  topic
}) {
  return `
You are an expert Indian teacher.

Generate DETAILED, exam-ready learning content.

Board: ${board}
Class: ${class_level}
Subject: ${subject}
Chapter: ${chapter}
Topic: ${topic}

STRICT RULES:
- Follow NCERT / Board syllabus
- Do NOT copy textbook text
- Use simple student-friendly language
- Explain step-by-step
- Be highly exam-oriented
- Include numericals where applicable

CONTENT REQUIREMENTS (MANDATORY):
- At least 2–3 clear definitions
- At least 2 formulas (if applicable)
- Detailed explanation in multiple paragraphs
- At least 2 solved examples (1 numerical compulsory)
- At least 4 exam-oriented points
- At least 3 common mistakes

ADDITIONAL REQUIREMENTS:
- Include special cases:
  - When distance = displacement
  - When displacement = 0
- Include at least 3 solved examples
- Add 3 short conceptual questions with answers
- Add 2 assertion–reason type exam hints


IMPORTANT OUTPUT RULES:
- Return ONLY pure JSON
- No markdown
- No quotes around JSON
- No extra text
- JSON must start with { and end with }

Return JSON in EXACT structure:

{
  "topic_overview": "Brief introduction of the topic",
  "definitions": [
    {
      "term": "Term name",
      "definition": "Clear and simple definition"
    }
  ],
  "formulas": [
    {
      "formula": "Formula",
      "explanation": "Explanation"
    }
  ],
  "detailed_explanation": "Detailed explanation in paragraphs",
  "solved_examples": [
    {
      "question": "Question",
      "solution": "Step-by-step solution",
      "final_answer": "Final answer"
    }
  ],
  "exam_oriented_points": [
    "Exam-focused point"
  ],
  "common_mistakes": [
    "Common student mistake"
  ]
}
`;
}


app.post("/api/topic/content/generate", protect, async (req, res) => {
  try {
    const { subject, chapter, topic } = req.body;

    // 🔍 STEP 1: Check if content already exists
    const { data: existingContent, error: fetchError } = await req.supabase
      .from("topic_content")
      .select("*")
      .eq("user_id", req.user.id)
      .eq("subject", subject)
      .eq("chapter", chapter)
      .eq("topic", topic)
      .single();

    // If DB error other than "no rows found"
    if (fetchError && fetchError.code !== "PGRST116") {
      throw fetchError;
    }

    // ✅ If already exists → return it
    if (existingContent) {
      console.log("Returning existing topic content from DB...");
      return res.json({ success: true, content: existingContent.content });
    }

    // 🚀 STEP 2: Generate only if not exists
    console.log("Generating new topic content...");
    
    const prompt = buildTopicLearningPrompt({
      board: req.profile.board,
      class_level: req.profile.class_level,
      subject,
      chapter,
      topic
    });

    const aiText = await callOpenAi(prompt);

    let content;
    try {
      content = JSON.parse(aiText);
    } catch {
      return res.status(500).json({ error: "Invalid AI topic content" });
    }

    const { data, error } = await req.supabase
      .from("topic_content")
      .insert({
        id: uuid(),
        user_id: req.user.id,
        subject,
        chapter,
        topic,
        content
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, content: data.content });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate topic content" });
  }
});






app.get("/api/chapter/topic", protect, async (req, res) => {
  try {
    const { subject, chapter, topic } = req.query;

    if (!subject || !chapter || !topic) {
      return res.status(400).json({
        error: "subject, chapter and topic are required"
      });
    }

    // ===============================
    // STEP 1: Check existing content
    // ===============================
    const { data: existing, error: fetchError } =
      await req.supabase
        .from("topic_content")
        .select("content")
        .eq("user_id", req.user.id)
        .eq("subject", subject)
        .eq("chapter", chapter)
        .eq("topic", topic)
        .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      throw fetchError;
    }

    // ✅ If exists → return immediately
    if (existing) {
      console.log("Returning existing topic content...");
      return res.json({
        success: true,
        generated: false,
        content: existing.content
      });
    }

    // ===============================
    // STEP 2: Generate if not exists
    // ===============================
    console.log("Generating new topic content...");

    const prompt = buildTopicLearningPrompt({
      board: req.profile.board,
      class_level: req.profile.class_level,
      subject,
      chapter,
      topic
    });

    const aiText = await callOpenAi(prompt);

    let content;
    try {
      content = JSON.parse(aiText);
    } catch {
      return res.status(500).json({
        error: "Invalid AI topic content"
      });
    }

    const { data, error } = await req.supabase
      .from("topic_content")
      .insert({
        id: uuid(),
        user_id: req.user.id,
        subject,
        chapter,
        topic,
        content
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      generated: true,
      content: data.content
    });

  } catch (err) {
    console.error("TOPIC FETCH ERROR:", err);
    res.status(500).json({
      error: "Failed to fetch topic content"
    });
  }
});


function buildTopicMcqPrompt({
  board,
  class_level,
  subject,
  chapter,
  topic
}) {
  return `
You are an expert Indian teacher.

Generate EXAM-ORIENTED MCQs.

Board: ${board}
Class: ${class_level}
Subject: ${subject}
Chapter: ${chapter}
Topic: ${topic}

STRICT RULES:
- Follow NCERT / Board exam pattern
- Do NOT copy textbook lines
- Questions must test concepts
- Mix difficulty: easy, medium, hard
- No extra text, no markdown

CONTENT REQUIREMENTS:
- Exactly 10 MCQs
- Each MCQ must have 4 options
- Clearly mark correct answer
- Add short explanation for answer

Return ONLY valid JSON:

{
  "mcqs": [
    {
      "question": "Question text",
      "options": {
        "A": "Option A",
        "B": "Option B",
        "C": "Option C",
        "D": "Option D"
      },
      "correct_answer": "A",
      "explanation": "Why this option is correct"
    }
  ]
}
`;
}

app.post("/api/topic/mcqs/generate", protect, async (req, res) => {
  try {
    const { subject, chapter, topic } = req.body;

    const { data: existing } = await req.supabase
      .from("topic_mcqs")
      .select("content")
      .eq("user_id", req.user.id)
      .eq("subject", subject)
      .eq("chapter", chapter)
      .eq("topic", topic)
      .single();

    if (existing) {
      return res.json({
        success: true,
        generated: false,
        content: existing.content
      });
    }

    const prompt = buildTopicMcqPrompt({
      board: req.profile.board,
      class_level: req.profile.class_level,
      subject,
      chapter,
      topic
    });

    const aiText = await callOpenAi(prompt);
    const content = JSON.parse(aiText);

    const { data } = await req.supabase
      .from("topic_mcqs")
      .insert({
        id: uuid(),
        user_id: req.user.id,
        subject,
        chapter,
        topic,
        content
      })
      .select()
      .single();

    res.json({
      success: true,
      generated: true,
      content: data.content
    });

  } catch {
    res.status(500).json({ error: "Failed to generate MCQs" });
  }
});


function buildTopicNumericalPrompt({
  board,
  class_level,
  subject,
  chapter,
  topic
}) {
  return `
You are an expert Indian physics/maths teacher.

Generate NUMERICAL PRACTICE QUESTIONS.

Board: ${board}
Class: ${class_level}
Subject: ${subject}
Chapter: ${chapter}
Topic: ${topic}

STRICT RULES:
- Follow NCERT exam pattern
- Step-by-step solutions
- Use proper units
- Avoid textbook copying
- No extra text or markdown

CONTENT REQUIREMENTS:
- Exactly 5 numericals
- Difficulty: easy → medium → hard
- Clearly show formulas used

Return ONLY valid JSON:

{
  "numericals": [
    {
      "question": "Numerical question",
      "given": "Given values",
      "formula_used": "Formula",
      "solution_steps": "Step-by-step solution",
      "final_answer": "Answer with unit"
    }
  ]
}
`;
}




app.post("/api/topic/numericals/generate", protect, async (req, res) => {
  try {
    const { subject, chapter, topic } = req.body;

    // 🔍 Check existing first
    const { data: existing, error: fetchError } = await req.supabase
      .from("topic_numericals")
      .select("content")
      .eq("user_id", req.user.id)
      .eq("subject", subject)
      .eq("chapter", chapter)
      .eq("topic", topic)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      throw fetchError;
    }

    if (existing) {
      return res.json({
        success: true,
        generated: false,
        content: existing.content
      });
    }

    // 🚀 Generate only if missing
    const prompt = buildTopicNumericalPrompt({
      board: req.profile.board,
      class_level: req.profile.class_level,
      subject,
      chapter,
      topic
    });

    const aiText = await callOpenAi(prompt);
    const content = JSON.parse(aiText);

    const { data } = await req.supabase
      .from("topic_numericals")
      .insert({
        id: uuid(),
        user_id: req.user.id,
        subject,
        chapter,
        topic,
        content
      })
      .select()
      .single();

    res.json({
      success: true,
      generated: true,
      content: data.content
    });

  } catch {
    res.status(500).json({ error: "Failed to generate numericals" });
  }
});



app.get("/api/chapter/progress", protect, async (req, res) => {
  const { subject } = req.query;

  const { data, error } = await req.supabase
    .from("chapter_progress")
    .select("chapter, completed")
    .eq("user_id", req.user.id)
    .eq("subject", subject);

  if (error) {
    return res.status(500).json({ error: "Failed to fetch progress" });
  }

  res.json({ success: true, progress: data });
});


app.get("/api/topic/mcqs", protect, async (req, res) => {
  try {
    const { subject, chapter, topic } = req.query;

    const { data, error } = await req.supabase
      .from("topic_mcqs")
      .select("content")
      .eq("user_id", req.user.id)
      .eq("subject", subject)
      .eq("chapter", chapter)
      .eq("topic", topic)
      .single();

    if (error) {
      return res.status(404).json({ error: "MCQs not found" });
    }

    res.json({
      success: true,
      content: data.content
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch MCQs" });
  }
});

app.get("/api/topic/numericals", protect, async (req, res) => {
  try {
    const { subject, chapter, topic } = req.query;

    const { data, error } = await req.supabase
      .from("topic_numericals")
      .select("content")
      .eq("user_id", req.user.id)
      .eq("subject", subject)
      .eq("chapter", chapter)
      .eq("topic", topic)
      .single();

    if (error) {
      return res.status(404).json({ error: "Numericals not found" });
    }

    res.json({
      success: true,
      content: data.content
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch numericals" });
  }
});


app.get("/api/study/today", protect, async (req, res) => {
  try {
    const userId = req.user.id;

    /* ===============================
       STEP 1: Get User Syllabus
    =============================== */
    const { data: syllabus, error: syllabusError } = await req.supabase
      .from("user_syllabus")
      .select("subject, chapters")
      .eq("user_id", userId);

    if (syllabusError) throw syllabusError;

    if (!syllabus || syllabus.length === 0) {
      return res.json({
        success: false,
        message: "No syllabus found"
      });
    }

    /* ===============================
       STEP 2: Get Completed Chapters
    =============================== */
    const { data: progress, error: progressError } = await req.supabase
      .from("chapter_progress")
      .select("subject, chapter, completed")
      .eq("user_id", userId)
      .eq("completed", true);

    if (progressError) throw progressError;

    const completedSet = new Set(
      (progress || []).map(p => `${p.subject}__${p.chapter}`)
    );

    /* ===============================
       STEP 3: Find Next Chapter
    =============================== */
    for (const subjectData of syllabus) {
      const subject = subjectData.subject;
      const chapters = subjectData.chapters || [];

      for (const chapter of chapters) {
        const key = `${subject}__${chapter}`;

        if (!completedSet.has(key)) {
          return res.json({
            success: true,
            today: {
              subject,
              chapter,
              tasks: [
                "Read topic content",
                "Practice MCQs",
                "Solve numericals"
              ],
              recommended_time: "30-40 mins"
            }
          });
        }
      }
    }

    /* ===============================
       STEP 4: All Completed
    =============================== */
    res.json({
      success: true,
      completed_all: true,
      message: "All chapters completed 🎉",
      today: null
    });

  } catch (err) {
    console.error("Today plan error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to generate today plan"
    });
  }
});

// =============================
// 🚀 FULL SYLLABUS GENERATOR
// =============================


// ================================
// LOG HELPERS
// ================================
function logStart(label, data = "") {
  console.log(`\n🟡 START: ${label}`, data);
}

function logSuccess(label, data = "") {
  console.log(`🟢 SUCCESS: ${label}`, data);
}

function logError(label, err) {
  console.error(`🔴 ERROR: ${label}`, err?.message || err);
}

function logTopicComplete(subject, chapter, topic) {
  console.log(
    `🎯 Topic Complete → ${subject} > ${chapter} > ${topic}`
  );
}

async function saveTopicStatus({
  user_id,
  subject,
  chapter,
  topic,
  status
}) {
  await supabaseAdmin
    .from("topic_generation_status")
    .upsert({
      id: uuid(),
      user_id,
      subject,
      chapter,
      topic,
      status
    });
}

app.post("/api/syllabus/full-generate", protect, async (req, res) => {
  try {
    const user_id = req.user.id;
    const board = req.profile.board;
    const class_level = req.profile.class_level;

    const active = await syllabusQueue.getActive();
    const alreadyRunning = active.find(
      job => job.data.user_id === user_id
    );

    if (alreadyRunning) {
      return res.status(400).json({
        error: "Syllabus generation already running"
      });
    }

    const job = await syllabusQueue.add("generate", {
      user_id,
      board,
      class_level
    });

    res.json({
      success: true,
      message: "Generation started",
      jobId: job.id
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to start generation" });
  }
});


app.get("/api/syllabus/progress", protect, async (req, res) => {
  try {
    const user_id = req.user.id;

    // 1️⃣ Get all chapters with topics
    const { data: chapters } = await supabaseAdmin
      .from("chapter_content")
      .select("subject, chapter, content")
      .eq("user_id", user_id);

    if (!chapters?.length) {
      return res.json({
        total: 0,
        completed: 0,
        percentage: 0,
        subjects: []
      });
    }

    // 2️⃣ Get generated topics
    const { data: generatedTopics } = await supabaseAdmin
      .from("topic_content")
      .select("subject, chapter, topic")
      .eq("user_id", user_id);

    let totalTopics = 0;
    let completedTopics = 0;

    const subjectMap = {};

    for (const row of chapters) {
      const subject = row.subject;
      const chapter = row.chapter;
      const topics = row.content?.topics || [];

      if (!subjectMap[subject]) {
        subjectMap[subject] = {
          subject,
          total: 0,
          completed: 0,
          percentage: 0,
          chapters: []
        };
      }

      let chapterCompleted = 0;

      for (const topic of topics) {
        totalTopics++;
        subjectMap[subject].total++;

        const exists = generatedTopics?.find(
          t =>
            t.subject === subject &&
            t.chapter === chapter &&
            t.topic === topic
        );

        if (exists) {
          completedTopics++;
          subjectMap[subject].completed++;
          chapterCompleted++;
        }
      }

      const chapterTotal = topics.length;

      subjectMap[subject].chapters.push({
        chapter,
        total: chapterTotal,
        completed: chapterCompleted,
        percentage:
          chapterTotal === 0
            ? 0
            : Math.round((chapterCompleted / chapterTotal) * 100)
      });
    }

    // Calculate subject percentages
    for (const subject of Object.values(subjectMap)) {
      subject.percentage =
        subject.total === 0
          ? 0
          : Math.round((subject.completed / subject.total) * 100);
    }

    const overallPercentage =
      totalTopics === 0
        ? 0
        : Math.round((completedTopics / totalTopics) * 100);

    res.json({
      total: totalTopics,
      completed: completedTopics,
      percentage: overallPercentage,
      subjects: Object.values(subjectMap)
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Progress error" });
  }
});





app.post("/api/syllabus/stop-all", protect, async (req, res) => {
  try {
    const user_id = req.user.id;

    const waiting = await syllabusQueue.getWaiting();
    const active = await syllabusQueue.getActive();

    const allJobs = [...waiting, ...active];

    let stoppedCount = 0;

    for (const job of allJobs) {
      if (job.data.user_id === user_id) {
        try {
          await job.remove();
          stoppedCount++;
        } catch {
          try {
            await job.moveToFailed(
              new Error("Stopped by user"),
              "stopped"
            );
            stoppedCount++;
          } catch {}
        }
      }
    }

    res.json({
      success: true,
      message: `${stoppedCount} job(s) stopped`
    });

  } catch (err) {
    console.error("STOP ALL ERROR:", err);
    res.status(500).json({ error: "Failed to stop jobs" });
  }
});


new Worker(
  "syllabus-generation",
  async (job) => {
    const { user_id, board, class_level } = job.data;

    console.log(`\n🚀 JOB STARTED for user: ${user_id}`);

    // =================================
    // 1️⃣ FETCH USER SYLLABUS
    // =================================
    const { data: syllabusData, error } = await supabaseAdmin
      .from("user_syllabus")
      .select("subject, chapters")
      .eq("user_id", user_id);

    if (error) throw error;
    if (!syllabusData?.length) return;

    // =================================
    // 2️⃣ ENSURE CHAPTER TOPICS EXIST
    // =================================
    for (const subjectItem of syllabusData) {
      const subject = subjectItem.subject;

      for (const chapter of subjectItem.chapters || []) {
        const { data: existingChapter } = await supabaseAdmin
          .from("chapter_content")
          .select("id")
          .eq("user_id", user_id)
          .eq("subject", subject)
          .eq("chapter", chapter)
          .single();

        if (!existingChapter) {
          logStart("Generating chapter topics", `${subject} > ${chapter}`);

          try {
            const topicText = await callOpenAi(
              buildTopicPrompt({
                board,
                class_level,
                subject,
                chapter
              })
            );

            const parsed = JSON.parse(topicText);

            await supabaseAdmin.from("chapter_content").insert({
              id: uuid(),
              user_id,
              subject,
              chapter,
              content: parsed
            });

            logSuccess("Chapter topics saved", chapter);
          } catch (err) {
            logError("Chapter topic generation failed", err);
          }
        }
      }
    }

    // =================================
    // 3️⃣ CALCULATE TOTAL TOPICS
    // =================================
    const { data: allChapters } = await supabaseAdmin
      .from("chapter_content")
      .select("content")
      .eq("user_id", user_id);

    let totalTopics = 0;
    for (const row of allChapters || []) {
      totalTopics += row.content?.topics?.length || 0;
    }

    await supabaseAdmin.from("syllabus_progress").upsert({
      user_id,
      total: totalTopics,
      completed: 0,
      percentage: 0
    });

    console.log(`📊 Total Topics: ${totalTopics}`);

    // =================================
    // 4️⃣ GENERATE CONTENT (MAIN LOOP)
    // =================================
    for (const subjectItem of syllabusData) {
      const subject = subjectItem.subject;
      logStart("Subject", subject);

      for (const chapter of subjectItem.chapters || []) {
        logStart("Chapter", chapter);

        const { data: chapterRow } = await supabaseAdmin
          .from("chapter_content")
          .select("content")
          .eq("user_id", user_id)
          .eq("subject", subject)
          .eq("chapter", chapter)
          .single();

        const topics = chapterRow?.content?.topics || [];

        for (const topic of topics) {
          console.log("\n━━━━━━━━━━━━━━━━━━━━━━");
          console.log(`📘 ${subject} > ${chapter} > ${topic}`);

          try {
            await saveTopicStatus({
              user_id,
              subject,
              chapter,
              topic,
              status: "processing"
            });

            // ===== Topic Content =====
            const { data: existingTopic } = await supabaseAdmin
              .from("topic_content")
              .select("id")
              .eq("user_id", user_id)
              .eq("subject", subject)
              .eq("chapter", chapter)
              .eq("topic", topic)
              .single();

            if (!existingTopic) {
              logStart("Topic content");

              const content = JSON.parse(
                await callOpenAi(
                  buildTopicLearningPrompt({
                    board,
                    class_level,
                    subject,
                    chapter,
                    topic
                  })
                )
              );

              await supabaseAdmin.from("topic_content").insert({
                id: uuid(),
                user_id,
                subject,
                chapter,
                topic,
                content
              });

              logSuccess("Topic content saved");
            }

            // ===== MCQs =====
            const { data: existingMcq } = await supabaseAdmin
              .from("topic_mcqs")
              .select("id")
              .eq("user_id", user_id)
              .eq("subject", subject)
              .eq("chapter", chapter)
              .eq("topic", topic)
              .single();

            if (!existingMcq) {
              logStart("MCQs");

              const mcqs = JSON.parse(
                await callOpenAi(
                  buildTopicMcqPrompt({
                    board,
                    class_level,
                    subject,
                    chapter,
                    topic
                  })
                )
              );

              await supabaseAdmin.from("topic_mcqs").insert({
                id: uuid(),
                user_id,
                subject,
                chapter,
                topic,
                content: mcqs
              });

              logSuccess("MCQs saved");
            }

            // ===== Numericals =====
            const { data: existingNum } = await supabaseAdmin
              .from("topic_numericals")
              .select("id")
              .eq("user_id", user_id)
              .eq("subject", subject)
              .eq("chapter", chapter)
              .eq("topic", topic)
              .single();

            if (!existingNum) {
              logStart("Numericals");

              const nums = JSON.parse(
                await callOpenAi(
                  buildTopicNumericalPrompt({
                    board,
                    class_level,
                    subject,
                    chapter,
                    topic
                  })
                )
              );

              await supabaseAdmin.from("topic_numericals").insert({
                id: uuid(),
                user_id,
                subject,
                chapter,
                topic,
                content: nums
              });

              logSuccess("Numericals saved");
            }

            // ===== COMPLETE =====
            await saveTopicStatus({
              user_id,
              subject,
              chapter,
              topic,
              status: "completed"
            });

            await supabaseAdmin.rpc("increment_progress", {
              uid: user_id
            });

            logTopicComplete(subject, chapter, topic);

          } catch (err) {
            logError(`Topic failed: ${topic}`, err);

            await saveTopicStatus({
              user_id,
              subject,
              chapter,
              topic,
              status: "failed"
            });
          }
        }
      }
    }

    console.log("\n🎉 FULL SYLLABUS GENERATION COMPLETED");
  },
  { connection }
);








app.get("/api/study/daily-plan", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().split("T")[0];

    /* =================================================
       STEP 0: CHECK EXISTING PLAN
    ================================================= */
    const { data: existingPlan } = await req.supabase
      .from("daily_plans")
      .select("*")
      .eq("user_id", userId)
      .eq("plan_date", today)
      .single();

    if (existingPlan) {
      return res.json({
        success: true,
        today_plan: {
          subject: existingPlan.subject,
          chapter: existingPlan.chapter,
          topics: existingPlan.topics,
          test_exam_id: existingPlan.exam_id,
          study_time: "30–40 mins",
          practice: "MCQs + Numericals",
          reused: true
        }
      });
    }

    /* =================================================
       STEP 1: CHECK IF ALREADY STUDIED TODAY
    ================================================= */
    const { data: todayActivity } = await req.supabase
      .from("study_activity")
      .select("*")
      .eq("user_id", userId)
      .eq("activity_date", today)
      .single();

    if (todayActivity?.exams_done > 0) {
      return res.json({
        success: true,
        completed_today: true,
        message: "Today's study already completed"
      });
    }

    /* =================================================
       STEP 2: GET SYLLABUS
    ================================================= */
    const { data: syllabus } = await req.supabase
      .from("user_syllabus")
      .select("subject, chapters")
      .eq("user_id", userId);

    if (!syllabus?.length) {
      return res.json({ success: false, message: "No syllabus found" });
    }

    /* =================================================
       STEP 3: WEAK SUBJECT PRIORITY
    ================================================= */
    const { data: attempts } = await req.supabase
      .from("exam_attempts")
      .select("score,total,exams(subject)")
      .eq("user_id", userId);

    const performance = {};

    (attempts || []).forEach(a => {
      const subject = a.exams?.subject;
      if (!subject) return;

      performance[subject] ??= { score: 0, total: 0 };
      performance[subject].score += a.score;
      performance[subject].total += a.total;
    });

    const weakOrder = Object.keys(performance).sort((a, b) => {
      const pa = performance[a].score / performance[a].total;
      const pb = performance[b].score / performance[b].total;
      return pa - pb;
    });

    const orderedSyllabus = syllabus.sort((a, b) => {
      const ai = weakOrder.indexOf(a.subject);
      const bi = weakOrder.indexOf(b.subject);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    /* =================================================
       STEP 4: FIND NEXT CHAPTER
    ================================================= */
    let selectedSubject = null;
    let selectedChapter = null;

    for (const s of orderedSyllabus) {
      const { data: progress } = await req.supabase
        .from("chapter_progress")
        .select("chapter, completed")
        .eq("user_id", userId)
        .eq("subject", s.subject);

      const completed = new Set(
        (progress || []).filter(p => p.completed).map(p => p.chapter)
      );

      for (const ch of s.chapters) {
        if (!completed.has(ch)) {
          selectedSubject = s.subject;
          selectedChapter = ch;
          break;
        }
      }
      if (selectedChapter) break;
    }

    if (!selectedChapter) {
      return res.json({ success: true, completed_all: true });
    }

    /* =================================================
       STEP 5: GET / GENERATE TOPICS
    ================================================= */
    let { data: chapterContent } = await req.supabase
      .from("chapter_content")
      .select("content")
      .eq("user_id", userId)
      .eq("subject", selectedSubject)
      .eq("chapter", selectedChapter)
      .single();

    if (!chapterContent) {
      const aiText = await callOpenAi(
        buildTopicPrompt({
          board: req.profile.board,
          class_level: req.profile.class_level,
          subject: selectedSubject,
          chapter: selectedChapter
        })
      );

      const content = JSON.parse(aiText);

      const { data } = await req.supabase
        .from("chapter_content")
        .insert({
          id: uuid(),
          user_id: userId,
          subject: selectedSubject,
          chapter: selectedChapter,
          content
        })
        .select()
        .single();

      chapterContent = data;
    }

    const allTopics = chapterContent.content.topics || [];

    /* =================================================
       STEP 6: REMOVE COMPLETED TOPICS
    ================================================= */
    const { data: topicProgress } = await req.supabase
      .from("topic_progress")
      .select("topic")
      .eq("user_id", userId)
      .eq("subject", selectedSubject)
      .eq("chapter", selectedChapter)
      .eq("completed", true);

    const completedTopics = new Set(
      (topicProgress || []).map(t => t.topic)
    );

    const pendingTopics = allTopics.filter(t => !completedTopics.has(t));

    if (!pendingTopics.length) {
      await req.supabase.from("chapter_progress").upsert({
        id: uuid(),
        user_id: userId,
        subject: selectedSubject,
        chapter: selectedChapter,
        completed: true
      });

      return res.json({ success: true, message: "Chapter completed" });
    }

    /* =================================================
       STEP 7: ADAPTIVE TOPIC COUNT
    ================================================= */
    const { data: activity } = await req.supabase
      .from("study_activity")
      .select("total_score,total_marks")
      .eq("user_id", userId);

    let avg = 60;

    if (activity?.length) {
      const s = activity.reduce((a, b) => a + b.total_score, 0);
      const t = activity.reduce((a, b) => a + b.total_marks, 0);
      if (t > 0) avg = (s / t) * 100;
    }

    let topicCount = 4;
    if (avg < 50) topicCount = 2;
    if (avg > 80) topicCount = 5;

    const todayTopics = pendingTopics.slice(0, topicCount);

    /* =================================================
       STEP 8: ENSURE CONTENT EXISTS
    ================================================= */
    await Promise.all(
      todayTopics.map(topic =>
        Promise.all([
          ensureTopicContent(req, selectedSubject, selectedChapter, topic),
          ensureTopicMCQs(req, selectedSubject, selectedChapter, topic),
          ensureTopicNumericals(req, selectedSubject, selectedChapter, topic)
        ])
      )
    );

    /* =================================================
       STEP 9: CREATE EXAM
    ================================================= */
    const { data: exam } = await req.supabase
      .from("exams")
      .insert({
        id: uuid(),
        user_id: userId,
        exam_name: `Daily Test - ${selectedSubject}`,
        subjects: [selectedSubject],
        duration: 30,
        total_marks: 30,
        difficulty: "medium",
        exam_details: {
          chapter: selectedChapter,
          topics: todayTopics
        },
        status: "CREATED"
      })
      .select()
      .single();

    /* =================================================
       STEP 10: SAVE PLAN
    ================================================= */
    await req.supabase.from("daily_plans").insert({
      id: uuid(),
      user_id: userId,
      plan_date: today,
      subject: selectedSubject,
      chapter: selectedChapter,
      topics: todayTopics,
      exam_id: exam.id
    });

    /* =================================================
       STEP 11: RESPONSE
    ================================================= */
    res.json({
      success: true,
      today_plan: {
        subject: selectedSubject,
        chapter: selectedChapter,
        topics: todayTopics,
        study_time: "30–40 mins",
        practice: "MCQs + Numericals",
        test_exam_id: exam.id,
        message:
          avg > 80
            ? "Great performance! Keep it up 🔥"
            : avg < 50
            ? "Focus on basics today"
            : "Keep improving!"
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Daily plan failed" });
  }
});

async function ensureTopicContent(req, subject, chapter, topic) {
  const { data } = await req.supabase
    .from("topic_content")
    .select("id")
    .eq("user_id", req.user.id)
    .eq("subject", subject)
    .eq("chapter", chapter)
    .eq("topic", topic)
    .single();

  if (!data) {
    const prompt = buildTopicLearningPrompt({
      board: req.profile.board,
      class_level: req.profile.class_level,
      subject,
      chapter,
      topic
    });

    const aiText = await callOpenAi(prompt);
    const content = JSON.parse(aiText);

    await req.supabase.from("topic_content").insert({
      id: uuid(),
      user_id: req.user.id,
      subject,
      chapter,
      topic,
      content
    });
  }
}

async function ensureTopicMCQs(req, subject, chapter, topic) {
  const { data } = await req.supabase
    .from("topic_mcqs")
    .select("id")
    .eq("user_id", req.user.id)
    .eq("subject", subject)
    .eq("chapter", chapter)
    .eq("topic", topic)
    .single();

  if (!data) {
    const prompt = buildTopicMcqPrompt({
      board: req.profile.board,
      class_level: req.profile.class_level,
      subject,
      chapter,
      topic
    });

    const aiText = await callOpenAi(prompt);
    const content = JSON.parse(aiText);

    await req.supabase.from("topic_mcqs").insert({
      id: uuid(),
      user_id: req.user.id,
      subject,
      chapter,
      topic,
      content
    });
  }
}

async function ensureTopicNumericals(req, subject, chapter, topic) {
  const { data } = await req.supabase
    .from("topic_numericals")
    .select("id")
    .eq("user_id", req.user.id)
    .eq("subject", subject)
    .eq("chapter", chapter)
    .eq("topic", topic)
    .single();

  if (!data) {
    const prompt = buildTopicNumericalPrompt({
      board: req.profile.board,
      class_level: req.profile.class_level,
      subject,
      chapter,
      topic
    });

    const aiText = await callOpenAi(prompt);
    const content = JSON.parse(aiText);

    await req.supabase.from("topic_numericals").insert({
      id: uuid(),
      user_id: req.user.id,
      subject,
      chapter,
      topic,
      content
    });
  }
}

app.post("/api/study/update-activity", protect, async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      subject,
      chapter,
      topic,
      score,
      total,
      activity_type
    } = req.body;

    /* =================================
       VALIDATION
    ================================= */
    if (!subject || score == null || total == null) {
      return res.status(400).json({
        error: "subject, score and total are required"
      });
    }

    const today = new Date().toISOString().split("T")[0];
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;

    /* =================================
       SAVE STUDY ACTIVITY
    ================================= */
    await req.supabase.from("study_activity").insert({
      id: uuid(),
      user_id: userId,
      subject,
      chapter: chapter || null,
      topic: topic || null,
      activity_type: activity_type || "EXAM",
      score,
      total,
      percentage,
      activity_date: today
    });

    /* =================================
       UPDATE STUDY STREAK
    ================================= */
    const { data: streak } = await req.supabase
      .from("study_streak")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (!streak) {
      // First time study
      await req.supabase.from("study_streak").insert({
        user_id: userId,
        current_streak: 1,
        last_study_date: today
      });
    } else {
      const lastDate = streak.last_study_date;

      const diffDays = Math.floor(
        (new Date(today) - new Date(lastDate)) /
          (1000 * 60 * 60 * 24)
      );

      if (diffDays === 0) {
        // Already counted today → do nothing
      }
      else if (diffDays === 1) {
        // Continue streak
        await req.supabase
          .from("study_streak")
          .update({
            current_streak: streak.current_streak + 1,
            last_study_date: today
          })
          .eq("user_id", userId);
      }
      else {
        // Streak broken → reset
        await req.supabase
          .from("study_streak")
          .update({
            current_streak: 1,
            last_study_date: today
          })
          .eq("user_id", userId);
      }
    }

    /* =================================
       RESPONSE
    ================================= */
    res.json({
      success: true,
      message: "Study activity recorded",
      data: {
        subject,
        chapter,
        topic,
        score,
        total,
        percentage,
        date: today
      }
    });

  } catch (err) {
    console.error("Study activity error:", err);
    res.status(500).json({
      error: "Failed to update study activity"
    });
  }
});



app.get("/api/debug-jobs", async (req, res) => {
  const waiting = await syllabusQueue.getWaiting();
  const active = await syllabusQueue.getActive();
  const completed = await syllabusQueue.getCompleted();

  res.json({
    waiting: waiting.length,
    active: active.length,
    completed: completed.length
  });
});





/* ================= SERVER ================= */

const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
