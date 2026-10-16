// Memory Companion - MCP server (v2)
// An Alexa+ add-on for dementia care. Conversation only, no hardware.
//
// Tools:
//   log_patient_message  - any patient question/statement, with warm-response guidance
//   check_dose_status    - READ-ONLY: "did I take my pills?"
//   confirm_dose         - writes ONE entry per dose window; extra requests become a caregiver alert
//   check_meal_status    - READ-ONLY: "did I eat?"
//   confirm_meal         - writes one entry per meal per day
//   get_caregiver_report - READ-ONLY: weekly plain-language summary and alerts
//
// Every tool takes an optional `time` (ISO string like 2026-10-12T09:05:00)
// so you can jump around in time during a demo.

const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const DATA_FILE = path.join(__dirname, "memory-companion-data.json");

// Edit this to match the patient's real routine. Used for missed-dose detection.
const SCHEDULE = [
  { medication: "morning pill", window: "morning", dueHour: 10 },
  { medication: "evening pill", window: "evening", dueHour: 20 },
];

// ---------- storage ----------
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      messages: d.messages || [],
      doses: d.doses || [],
      meals: d.meals || [],
      alerts: d.alerts || [],
    };
  } catch {
    return { messages: [], doses: [], meals: [], alerts: [] };
  }
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ---------- helpers ----------
function normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}
function toDate(time) {
  if (!time) return new Date();
  const d = new Date(time);
  return isNaN(d.getTime()) ? new Date() : d;
}
function localDay(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function clock(d) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function reply(text) {
  return { content: [{ type: "text", text }] };
}

// Adds an alert unless the same dedupeKey was already raised.
function addAlert(data, alert) {
  if (alert.dedupeKey && data.alerts.some((a) => a.dedupeKey === alert.dedupeKey)) return false;
  data.alerts.push(alert);
  return true;
}

// Safety rules appended to every patient-facing guidance.
const SAFE_RULES =
  "Rules: speak in short, warm, simple sentences. Never say 'you already asked'. " +
  "Never argue with or harshly correct the patient. Do not give medical advice or " +
  "change any medication; for anything medical, say you will let their caregiver know.";

// ---------- per-category guidance ----------
const GUIDANCE = {
  repeated_question:
    "Answer the question with the same warmth and patience as the first time. " +
    "Do not mention it was asked before. Add one comforting detail if it fits.",
  time_place:
    "Give the day, time or place calmly and simply, and add one anchoring detail " +
    "(for example the weather, or what usually happens at this time of day). " +
    "If they insist it is a different year or place, do not argue: acknowledge " +
    "their feeling, then gently offer the current facts.",
  identity:
    "Respond warmly and reassure them that the person with them is someone who " +
    "cares about them. If the patient asks who YOU are, say you are Alexa, " +
    "here to help. Never say 'don't you remember?' or correct them sharply.",
  loved_one:
    "Do not bluntly state facts that could cause fresh grief, and do not make up " +
    "false promises. Validate the feeling ('You miss her, don't you?'), then " +
    "invite a memory ('Tell me about her') or gently redirect to a comforting " +
    "activity. Let the caregiver know about repeated distress on this topic.",
  meal_hydration:
    "The patient is asking about food or drink. Use check_meal_status to answer, " +
    "and use confirm_meal when they clearly say they have eaten or drunk. " +
    "Gently offer a snack or a glass of water if nothing is logged.",
  going_home:
    "'I want to go home' often means feeling unsafe, lonely, or searching for " +
    "comfort, even when they are already at home. Do not say 'you are home' " +
    "bluntly. Acknowledge the feeling, ask about home ('What do you miss most?'), " +
    "and offer a calming activity or music. Do not encourage them to leave.",
  medication:
    "For pill questions, do NOT use this tool. Use check_dose_status to answer " +
    "'did I take it?', and confirm_dose only when they clearly confirm taking it.",
  distress:
    "The patient sounds upset. Slow down, use a calm and soft tone, validate " +
    "the feeling, and offer comfort or a familiar song. Let the caregiver know.",
  urgent_help:
    "This may be an emergency (pain, fall, fear for safety). Tell the patient " +
    "help is being contacted, encourage them to stay where they are, and tell " +
    "them to call their caregiver or emergency services right away.",
  other:
    "Answer kindly and simply. If unsure, offer to let the caregiver know.",
};

const CATEGORIES = Object.keys(GUIDANCE);

const server = new McpServer({ name: "memory-companion", version: "2.0.0" });

// ============================================================
// TOOL 1: log_patient_message
// ============================================================
server.registerTool(
  "log_patient_message",
  {
    title: "Log a patient message",
    description:
      "Call this whenever the patient asks a question or says something about " +
      "time, place, people, a loved one, wanting to go home, feeling upset, or " +
      "needing help. Pick the best category. Returns guidance on how to respond " +
      "kindly. Do NOT use for pill questions (use check_dose_status) or meal " +
      "questions (use check_meal_status).",
    inputSchema: {
      message: z.string().describe("What the patient just said or asked"),
      category: z.enum(CATEGORIES).describe("Best-fit category for the message"),
      distress: z
        .enum(["calm", "anxious", "agitated"])
        .default("calm")
        .describe("How the patient sounds"),
      time: z.string().optional().describe("Optional ISO time, for demos"),
    },
  },
  async ({ message, category, distress, time }) => {
    const data = loadData();
    const now = toDate(time);
    const day = localDay(now);
    const key = normalize(message);

    const sameBefore = data.messages.filter((m) => m.key === key);
    const sameToday = sameBefore.filter((m) => localDay(new Date(m.at)) === day);
    const categoryToday = data.messages.filter(
      (m) => m.category === category && localDay(new Date(m.at)) === day
    ).length + 1;

    data.messages.push({ key, message, category, distress, at: now.toISOString() });

    // ----- caregiver alerts -----
    const alerts = [];
    const raise = (type, severity, note, dedupeKey) => {
      const a = { type, severity, note, at: now.toISOString(), dedupeKey };
      if (addAlert(data, a)) alerts.push(a);
    };

    if (category === "urgent_help") {
      raise("urgent_help", "urgent", `Patient may need urgent help: "${message}"`, `urgent|${now.toISOString()}`);
    }
    if (distress === "agitated") {
      raise("agitation", "high", `Patient sounded agitated at ${clock(now)}: "${message}"`, `agit|${day}|${key}`);
    }
    if (category === "going_home" && categoryToday >= 2) {
      const evening = now.getHours() >= 17 || now.getHours() < 6;
      raise(
        "wandering_intent",
        "high",
        `Patient said they want to go home ${categoryToday} times today` +
          (evening ? " (evening, a common restless period)" : "") + ".",
        `home|${day}`
      );
    }
    if (category === "loved_one" && categoryToday >= 3) {
      raise("emotional_loop", "medium", `Patient asked about a loved one ${categoryToday} times today.`, `loved|${day}`);
    }
    if (sameToday.length + 1 >= 5) {
      raise(
        "high_repetition",
        "medium",
        `The same question was asked ${sameToday.length + 1} times today: "${message}". ` +
          "Unusually high repetition can reflect stress or discomfort.",
        `rep|${day}|${key}`
      );
    }
    if (distress === "anxious" && sameToday.length + 1 >= 3) {
      raise("anxious_repeat", "medium", `Anxious repeated question (${sameToday.length + 1}x today): "${message}"`, `anx|${day}|${key}`);
    }

    // ----- build response for Alexa+ -----
    let text = `Category: ${category}. Distress: ${distress}.\n`;
    if (sameBefore.length === 0) {
      text += "First time this message has been logged.\n";
    } else {
      text += `This was said ${sameBefore.length} time(s) before (${sameToday.length} today). ` +
        "Respond as if it is the first time; do NOT mention the repetition.\n";
    }
    text += `Guidance: ${GUIDANCE[category]}\n${SAFE_RULES}`;
    if (alerts.length) {
      text += `\nCaregiver alert(s) recorded: ${alerts.map((a) => a.type).join(", ")}. ` +
        "You may say you will let their caregiver know, if it fits naturally.";
    }

    saveData(data);
    return reply(text);
  }
);

// ============================================================
// TOOL 2: check_dose_status (READ-ONLY)
// ============================================================
server.registerTool(
  "check_dose_status",
  {
    title: "Check whether a dose was taken",
    description:
      "READ-ONLY. Use when the patient asks 'did I take my pills?' or similar. " +
      "Never creates a log entry, so asking repeatedly is always safe.",
    inputSchema: {
      medication: z.string().describe("e.g. 'morning pill'"),
      window: z.string().describe("Dose window, e.g. 'morning' or 'evening'"),
      time: z.string().optional().describe("Optional ISO time, for demos"),
    },
  },
  async ({ medication, window, time }) => {
    const data = loadData();
    const now = toDate(time);
    const key = `${localDay(now)}|${normalize(medication)}|${normalize(window)}`;
    const entry = data.doses.find((d) => d.key === key);

    if (entry) {
      return reply(
        `Yes. The ${medication} was logged as taken at ${clock(new Date(entry.at))} today. ` +
          "Reassure the patient warmly that they are all set and do not need another. " +
          "Do not mention how many times they have asked.\n" + SAFE_RULES
      );
    }
    return reply(
      `No dose of the ${medication} is logged for this window yet. Do NOT tell the patient ` +
        "they forgot, and do not tell them to take it. Gently ask whether they have taken it. " +
        "Only call confirm_dose if they clearly say yes. If they are unsure, say you will " +
        "check with their caregiver.\n" + SAFE_RULES
    );
  }
);

// ============================================================
// TOOL 3: confirm_dose (writes ONCE per window)
// ============================================================
server.registerTool(
  "confirm_dose",
  {
    title: "Record that a dose was taken",
    description:
      "Call ONLY when the patient clearly confirms they have just taken a dose. " +
      "Writes one entry per dose window. If a dose is already logged, it does " +
      "NOT log again and instead raises a safety alert for the caregiver.",
    inputSchema: {
      medication: z.string().describe("e.g. 'morning pill'"),
      window: z.string().describe("Dose window, e.g. 'morning'"),
      time: z.string().optional().describe("Optional ISO time, for demos"),
    },
  },
  async ({ medication, window, time }) => {
    const data = loadData();
    const now = toDate(time);
    const key = `${localDay(now)}|${normalize(medication)}|${normalize(window)}`;
    const existing = data.doses.find((d) => d.key === key);

    if (!existing) {
      data.doses.push({ key, medication, window, at: now.toISOString() });
      saveData(data);
      return reply(
        `Dose logged at ${clock(now)}. Tell the patient warmly that it is recorded and they are all set.\n` +
          SAFE_RULES
      );
    }

    // Already logged: do NOT add a second entry. Raise a safety alert instead.
    addAlert(data, {
      type: "possible_extra_dose",
      severity: "urgent",
      note:
        `Patient asked to confirm another ${medication} dose at ${clock(now)}, but one was ` +
        `already logged at ${clock(new Date(existing.at))}. Please check in.`,
      at: now.toISOString(),
      dedupeKey: `redose|${key}|${now.toISOString()}`,
    });
    saveData(data);
    return reply(
      `A dose of the ${medication} was ALREADY logged at ${clock(new Date(existing.at))} for this window. ` +
        "No new entry was created. Gently tell the patient their records show they already took it, " +
        "that they do not need to take it again, and that you are letting their caregiver know. " +
        "Do NOT suggest taking more. Do not give medical advice.\n" + SAFE_RULES
    );
  }
);

// ============================================================
// TOOL 4: check_meal_status (READ-ONLY)
// ============================================================
const MEALS = ["breakfast", "lunch", "dinner", "snack", "drink"];

server.registerTool(
  "check_meal_status",
  {
    title: "Check whether a meal or drink was logged",
    description:
      "READ-ONLY. Use when the patient asks 'did I eat?' or 'have I had water?'. " +
      "Never creates a log entry.",
    inputSchema: {
      meal: z.enum(MEALS).describe("Which meal or drink"),
      time: z.string().optional().describe("Optional ISO time, for demos"),
    },
  },
  async ({ meal, time }) => {
    const data = loadData();
    const now = toDate(time);
    const day = localDay(now);
    const entries = data.meals.filter((m) => m.meal === meal && localDay(new Date(m.at)) === day);

    if (entries.length) {
      const last = clock(new Date(entries[entries.length - 1].at));
      return reply(
        `Yes, ${meal} was logged today (last at ${last}). Reassure the patient warmly. ` +
          (meal === "drink" ? "Gently encourage another glass of water if it has been a while. " : "") +
          "Do not mention how often they have asked.\n" + SAFE_RULES
      );
    }
    return reply(
      `No ${meal} is logged yet today. Do not say they forgot. Gently offer to help them ` +
        `have ${meal === "drink" ? "something to drink" : meal}, and call confirm_meal only ` +
        "once they say they have had it.\n" + SAFE_RULES
    );
  }
);

// ============================================================
// TOOL 5: confirm_meal
// ============================================================
server.registerTool(
  "confirm_meal",
  {
    title: "Record a meal or drink",
    description:
      "Call when the patient clearly says they have just eaten or drunk something. " +
      "Breakfast, lunch and dinner are logged once per day; snacks and drinks can repeat.",
    inputSchema: {
      meal: z.enum(MEALS).describe("Which meal or drink"),
      time: z.string().optional().describe("Optional ISO time, for demos"),
    },
  },
  async ({ meal, time }) => {
    const data = loadData();
    const now = toDate(time);
    const day = localDay(now);
    const once = ["breakfast", "lunch", "dinner"].includes(meal);
    const existing = data.meals.find((m) => m.meal === meal && localDay(new Date(m.at)) === day);

    if (once && existing) {
      return reply(
        `${meal} was already logged at ${clock(new Date(existing.at))}. No new entry created. ` +
          "Reassure the patient that they have already eaten.\n" + SAFE_RULES
      );
    }
    data.meals.push({ meal, at: now.toISOString() });
    saveData(data);
    return reply(`${meal} logged at ${clock(now)}. Tell the patient warmly that it is noted.\n` + SAFE_RULES);
  }
);

// ============================================================
// TOOL 6: get_caregiver_report (READ-ONLY)
// ============================================================
function repeatEvents(messages) {
  // A "repeat" = an identical message that was already logged earlier the same day.
  const seen = {};
  let count = 0;
  for (const m of [...messages].sort((a, b) => a.at.localeCompare(b.at))) {
    const k = `${localDay(new Date(m.at))}|${m.key}`;
    if (seen[k]) count++;
    seen[k] = true;
  }
  return count;
}

server.registerTool(
  "get_caregiver_report",
  {
    title: "Weekly caregiver report",
    description:
      "READ-ONLY. Returns a plain-language summary for the caregiver: repetition " +
      "patterns and trend, safety alerts, dose and meal gaps. Use when the " +
      "caregiver asks how the week went.",
    inputSchema: {
      days: z.number().int().min(1).max(30).default(7).describe("How many days to cover"),
      now: z.string().optional().describe("Optional ISO time to treat as 'now', for demos"),
    },
  },
  async ({ days, now: nowArg }) => {
    const data = loadData();
    const end = toDate(nowArg);
    const ms = days * 24 * 60 * 60 * 1000;
    const start = new Date(end.getTime() - ms);
    const prevStart = new Date(start.getTime() - ms);

    const inRange = (iso, a, b) => {
      const t = new Date(iso).getTime();
      return t >= a.getTime() && t <= b.getTime();
    };

    const msgs = data.messages.filter((m) => inRange(m.at, start, end));
    const prevMsgs = data.messages.filter((m) => inRange(m.at, prevStart, new Date(start.getTime() - 1)));

    const lines = [];
    lines.push(`CAREGIVER REPORT: ${localDay(start)} to ${localDay(end)} (${days} days)`);
    lines.push("");

    // --- conversation patterns ---
    lines.push(`Conversations logged: ${msgs.length}`);
    const byCat = {};
    msgs.forEach((m) => (byCat[m.category] = (byCat[m.category] || 0) + 1));
    Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .forEach(([c, n]) => lines.push(`  - ${c.replace(/_/g, " ")}: ${n}`));

    const counts = {};
    msgs.forEach((m) => {
      counts[m.key] = counts[m.key] || { text: m.message, n: 0 };
      counts[m.key].n++;
    });
    const top = Object.values(counts).filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
    if (top.length) {
      lines.push("Most repeated questions:");
      top.forEach((c) => lines.push(`  - "${c.text}" (${c.n} times)`));
    }

    const rNow = repeatEvents(msgs);
    const rPrev = repeatEvents(prevMsgs);
    if (prevMsgs.length > 0 || rNow > 0) {
      let trend;
      if (rPrev === 0 && rNow === 0) trend = "No repeated questions this period.";
      else if (rPrev === 0) trend = `${rNow} repeated questions this period, compared with none in the previous period.`;
      else {
        const pct = Math.round(((rNow - rPrev) / rPrev) * 100);
        trend =
          pct > 0
            ? `Repeated questions are up about ${pct}% (${rPrev} before, ${rNow} now).`
            : pct < 0
            ? `Repeated questions are down about ${Math.abs(pct)}% (${rPrev} before, ${rNow} now).`
            : `Repeated questions are steady (${rNow}).`;
      }
      lines.push(`Trend: ${trend}`);
    }
    lines.push("");

    // --- alerts ---
    const alerts = data.alerts.filter((a) => inRange(a.at, start, end));
    const order = { urgent: 0, high: 1, medium: 2 };
    alerts.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    lines.push(`Alerts: ${alerts.length}`);
    alerts.forEach((a) => lines.push(`  - [${a.severity.toUpperCase()}] ${a.note}`));
    lines.push("");

    // --- medication ---
    const doses = data.doses.filter((d) => inRange(d.at, start, end));
    lines.push(`Doses logged: ${doses.length}`);

    const allTimes = [
      ...data.messages.map((m) => m.at),
      ...data.doses.map((d) => d.at),
      ...data.meals.map((m) => m.at),
    ].sort();
    const firstDay = allTimes.length ? localDay(new Date(allTimes[0])) : null;

    const missed = [];
    if (firstDay) {
      for (let i = 0; i < days; i++) {
        const dayDate = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
        const dk = localDay(dayDate);
        if (dk < firstDay) continue;
        for (const s of SCHEDULE) {
          const due = new Date(dayDate);
          due.setHours(s.dueHour, 0, 0, 0);
          if (due.getTime() > end.getTime()) continue;
          const key = `${dk}|${normalize(s.medication)}|${normalize(s.window)}`;
          if (!data.doses.some((d) => d.key === key)) missed.push(`${s.medication} on ${dk}`);
        }
      }
    }
    if (missed.length) {
      lines.push("Possible missed doses (no confirmation logged):");
      missed.forEach((m) => lines.push(`  - ${m}`));
    } else {
      lines.push("No missed doses detected.");
    }
    lines.push("");

    // --- meals ---
    const lowMeals = [];
    if (firstDay) {
      for (let i = 1; i < days; i++) {
        const dk = localDay(new Date(end.getTime() - i * 24 * 60 * 60 * 1000));
        if (dk < firstDay) continue;
        const n = new Set(
          data.meals
            .filter((m) => localDay(new Date(m.at)) === dk && ["breakfast", "lunch", "dinner"].includes(m.meal))
            .map((m) => m.meal)
        ).size;
        if (n < 3) lowMeals.push(`${dk}: ${n} of 3 main meals logged`);
      }
    }
    if (lowMeals.length) {
      lines.push("Days with fewer than 3 meals logged:");
      lowMeals.forEach((m) => lines.push(`  - ${m}`));
    } else {
      lines.push("No meal gaps detected on completed days.");
    }
    lines.push("");

    lines.push(
      "Note: this report shows patterns from conversations. It is not a diagnosis. " +
        "If repetition, distress or missed doses are increasing, consider sharing this " +
        "report with the patient's doctor."
    );
    return reply(lines.join("\n"));
  }
);

// ---------- start ----------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP over stdio uses stdout for messages, so log to stderr instead.
  console.error("Memory Companion MCP server v2 is running");
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});