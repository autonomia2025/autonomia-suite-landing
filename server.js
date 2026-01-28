import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;

const sessions = new Map();
const wsClients = new Map();

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "";
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const openaiKey = process.env.OPENAI_API_KEY || "";
const openaiChatModel = process.env.OPENAI_MODEL_CHAT || "gpt-4o-mini";
const openaiAnalysisModel = process.env.OPENAI_MODEL_ANALYSIS || "gpt-4o-mini";
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

const gmailUser = process.env.GMAIL_USER || "";
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD || "";
const smtpReady = Boolean(gmailUser && gmailAppPassword);
const mailTransporter = smtpReady
  ? nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailAppPassword,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    })
  : null;

app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.static(__dirname));

const rateBuckets = new Map();
const RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 120 };

const rateLimit = (req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + RATE_LIMIT.windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT.windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > RATE_LIMIT.max) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }
  next();
};

const sanitize = (value) =>
  String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 200);

const sanitizeLong = (value, limit = 2000) =>
  String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, limit);

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const buildLeadText = (payload) => {
  const lines = [
    `Nombre: ${payload.name || "—"}`,
    `Email: ${payload.email || "—"}`,
    `Telefono: ${payload.phone || "—"}`,
    `Empresa: ${payload.company || "—"}`,
    `Industria: ${payload.industry || "—"}`,
    `Mensaje: ${payload.message || "—"}`,
    `Source: ${payload.source || "—"}`,
    `UTM Source: ${payload.utm_source || "—"}`,
    `UTM Medium: ${payload.utm_medium || "—"}`,
    `UTM Campaign: ${payload.utm_campaign || "—"}`,
  ];
  return lines.join("\n");
};

const buildAutoReplyText = () =>
  "Hola,\n\n" +
  "Gracias por contactarte con AutonomIA Suite.\n" +
  "Hemos recibido correctamente tu solicitud de demo.\n\n" +
  "Nuestro equipo revisara la informacion y se pondra en contacto contigo a la brevedad para coordinar una reunion 1:1, donde podremos mostrarte el sistema en funcionamiento y evaluar como se adapta a la operacion de tu clinica.\n\n" +
  "Que puedes esperar de la demo?\n" +
  "- Revision del flujo real de atencion y agenda\n" +
  "- Ejemplo practico de como se ordena la operacion diaria\n" +
  "- Espacio para resolver dudas tecnicas y operativas\n\n" +
  "La demo es sin compromiso y esta pensada para que puedas evaluar con claridad si este sistema hace sentido para tu organizacion.\n\n" +
  "Si necesitas agregar informacion o tienes alguna pregunta antes de la reunion, puedes responder directamente a este correo.\n\n" +
  "Un saludo,\n\n" +
  "Equipo AutonomIA Suite\n" +
  "Software profesional para operacion clinica";

const sendMailWithTimeout = (options, timeoutMs = 12000) =>
  Promise.race([
    mailTransporter.sendMail(options),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("SMTP timeout")), timeoutMs);
    }),
  ]);

const sanitizeForModel = (value) =>
  String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);

const createSession = () => {
  const id = crypto.randomUUID();
  const now = Date.now();
  const session = {
    id,
    createdAt: now,
    updatedAt: now,
    step: "greeting",
    captured: {},
    triage: {
      priority: "Baja",
      label: "Consulta",
      suggested_action: "Automatico",
    },
    timeline: [
      {
        type: "session",
        label: "Sesion iniciada",
        ts: now,
      },
    ],
    messages: [],
    assistantCount: 0,
  };
  sessions.set(id, session);
  return session;
};

const updateSupabase = async (session) => {
  if (!supabase) return;
  try {
    await supabase.from("sessions").upsert({
      session_id: session.id,
      step: session.step,
      captured: session.captured,
      triage: session.triage,
      timeline: session.timeline,
      updated_at: new Date(session.updatedAt).toISOString(),
    });
  } catch (error) {
    console.error("Supabase error", error.message);
  }
};

const emitEvent = (sessionId, event, data) => {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const payload = JSON.stringify({ event, data });
  clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
};

const addTimeline = (session, type, label) => {
  const event = { type, label, ts: Date.now() };
  session.timeline.push(event);
  emitEvent(session.id, "timeline.event", event);
};

const fallbackTriage = (text) => {
  const normalized = text.toLowerCase();
  const high = ["urgente", "dolor", "fuerte", "hoy", "ahora", "necesito", "fractura"];
  const medium = ["precio", "valores", "costo", "horario", "disponibilidad", "consulta", "cotizacion"];
  if (high.some((word) => normalized.includes(word))) {
    return { priority: "Alta", label: "Potencial cita", suggested_action: "Derivar a equipo" };
  }
  if (medium.some((word) => normalized.includes(word))) {
    return { priority: "Media", label: "Potencial cita", suggested_action: "Derivar a equipo" };
  }
  return { priority: "Baja", label: "Consulta", suggested_action: "Automatico" };
};

const withTimeout = async (promise, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await promise(controller.signal);
    clearTimeout(timeout);
    return result;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
};

const getChatReply = async ({ session, message }) => {
  if (session.step === "done") {
    return "La clinica continuara el proceso por su canal habitual. Si desea seguir revisando el flujo, puede recuperar el control operativo en una demo.";
  }
  if (!openai) {
    return "Gracias. Puede contarme el motivo de su consulta?";
  }
  const history = session.messages.slice(-8).map((msg) => ({
    role: msg.role === "patient" ? "user" : "assistant",
    content: msg.text,
  }));
  const systemPrompt =
    "Eres la recepcion digital de una clinica en Chile. Responde con tono profesional, sobrio y clinico. " +
    "Haz preguntas breves y claras. No menciones tecnologia. No prometas agendamiento real. " +
    "Si falta un dato (motivo, nombre, ciudad, preferencia horaria), pide solo uno a la vez.";

  const userPrompt = message
    ? sanitizeForModel(message)
    : "Inicia la conversacion con un saludo profesional y pregunta el motivo de la consulta.";

  const response = await withTimeout(
    (signal) =>
      openai.chat.completions.create(
        {
          model: openaiChatModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 180,
        },
        { signal }
      ),
    8000
  );

  return response.choices?.[0]?.message?.content?.trim() || "Puede contarme un poco mas?";
};

const getAnalysis = async ({ session, message }) => {
  if (!openai) {
    return null;
  }

  const systemPrompt =
    "Analiza la conversacion clinica y devuelve JSON estricto. " +
    "Extrae: name, reason, city, preferred_time. " +
    "Clasifica: type (Consulta|Potencial cita), priority (Alta|Media|Baja), suggested_action (Automatico|Derivar a equipo). " +
    "No inventes datos. Si no existe, usa null.";

  const context = {
    last_message: sanitizeForModel(message),
    captured: session.captured,
  };

  const response = await withTimeout(
    (signal) =>
      openai.chat.completions.create(
        {
          model: openaiAnalysisModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(context) },
          ],
          temperature: 0,
          max_tokens: 220,
          response_format: { type: "json_object" },
        },
        { signal }
      ),
    8000
  );

  const content = response.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
};

const nextReply = async (session, message) => {
  const input = sanitize(message);
  session.updatedAt = Date.now();

  if (session.step === "done") {
    return await getChatReply({ session, message: "" });
  }

  if (session.step === "greeting") {
    session.step = "reason";
    addTimeline(session, "system", "Saludo enviado");
    return await getChatReply({ session, message: "" });
  }

  if (input) {
    addTimeline(session, "patient", "Mensaje recibido");
  }

  const analysis = input ? await getAnalysis({ session, message: input }) : null;
  if (analysis) {
    const updates = {};
    if (analysis.name) {
      session.captured.name = analysis.name;
      updates.name = analysis.name;
      addTimeline(session, "patient", "Nombre detectado");
    }
    if (analysis.reason) {
      session.captured.reason = analysis.reason;
      updates.reason = analysis.reason;
      addTimeline(session, "patient", "Motivo detectado");
    }
    if (analysis.city) {
      session.captured.city = analysis.city;
      updates.city = analysis.city;
      addTimeline(session, "patient", "Ciudad detectada");
    }
    if (analysis.preferred_time) {
      session.captured.preferred_time = analysis.preferred_time;
      updates.preferred_time = analysis.preferred_time;
      addTimeline(session, "patient", "Preferencia registrada");
    }
    if (Object.keys(updates).length) {
      emitEvent(session.id, "patient.updated", updates);
    }

    const triage = {
      priority: analysis.priority || session.triage.priority,
      label: analysis.type || session.triage.label,
      suggested_action: analysis.suggested_action || session.triage.suggested_action,
    };
    session.triage = triage;
    emitEvent(session.id, "triage.updated", triage);
  } else if (input) {
    session.triage = fallbackTriage(input);
    emitEvent(session.id, "triage.updated", session.triage);
  }

  const hasAll =
    session.captured.name &&
    session.captured.reason &&
    session.captured.city &&
    session.captured.preferred_time;

  if (hasAll) {
    session.step = "done";
    addTimeline(session, "system", "Datos completos");
    return "Gracias. La clinica continuara el proceso por su canal habitual. Si desea seguir revisando el flujo, puede recuperar el control operativo en una demo.";
  }

  const reply = await getChatReply({ session, message: input });
  return reply || "Podria contarme un poco mas?";
};

app.post("/api/sessions", rateLimit, async (req, res) => {
  const session = createSession();
  await updateSupabase(session);
  res.json({ session_id: session.id });
});

app.post("/api/chat", rateLimit, async (req, res) => {
  const sessionId = sanitize(req.body.session_id);
  const message = sanitize(req.body.message || "");
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  if (message) {
    session.messages.push({ role: "patient", text: message, ts: Date.now() });
  }
  let reply = "Podria contarme un poco mas?";
  try {
    reply = await nextReply(session, message);
  } catch (error) {
    reply = "Podria contarme un poco mas?";
  }
  session.messages.push({ role: "system", text: reply, ts: Date.now() });
  session.assistantCount += 1;
  if (session.assistantCount >= 10 && session.step !== "done") {
    session.step = "done";
    addTimeline(session, "system", "Cierre de conversacion");
  }
  await updateSupabase(session);
  res.json({
    reply,
    state: {
      step: session.step,
      captured: session.captured,
    },
  });
});

app.post("/api/lead", rateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const honeypot = sanitizeLong(body.website, 200);
    if (honeypot) {
      return res.json({ success: true });
    }

    const name = sanitize(body.name || body.nombre);
    const email = sanitize(body.email);
    const phone = sanitizeLong(body.phone || body.whatsapp, 200);
    const company = sanitizeLong(body.company || body.clinica, 200);
    const industry = sanitizeLong(body.industry, 120);
    const message = sanitizeLong(body.message || body.comentarios, 2000);
    const source = sanitizeLong(body.source, 120);
    const utm_source = sanitizeLong(body.utm_source, 200);
    const utm_medium = sanitizeLong(body.utm_medium, 200);
    const utm_campaign = sanitizeLong(body.utm_campaign, 200);

    if (!name || name.length < 2) {
      return res.status(400).json({ success: false, error: "Nombre es requerido" });
    }

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "Email valido es requerido" });
    }

    if (!smtpReady || !mailTransporter) {
      return res.status(500).json({ success: false, error: "SMTP no configurado" });
    }

    const leadPayload = {
      name,
      email,
      phone,
      company,
      industry,
      message,
      source,
      utm_source,
      utm_medium,
      utm_campaign,
    };

    const internalSubject = "Nuevo lead – AutonomIA Suite";
    const autoReplySubject = "Confirmacion de solicitud de demo – AutonomIA Suite";

    const internalText = buildLeadText(leadPayload);
    const autoReplyText = buildAutoReplyText();

    await Promise.all([
      sendMailWithTimeout({
        from: `AutonomIA Suite <${gmailUser}>`,
        to: "jtmenesesg@gmail.com",
        subject: internalSubject,
        text: internalText,
        replyTo: email,
      }),
      sendMailWithTimeout({
        from: `AutonomIA Suite <${gmailUser}>`,
        to: email,
        subject: autoReplySubject,
        text: autoReplyText,
      }),
    ]);

    return res.json({ success: true });
  } catch (error) {
    console.error("Lead email error", error);
    return res.status(500).json({ success: false, error: "No fue posible enviar" });
  }
});

app.get("/api/sessions/:id", rateLimit, (req, res) => {
  const sessionId = sanitize(req.params.id);
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json({
    session_id: session.id,
    state: {
      step: session.step,
      captured: session.captured,
    },
    triage: session.triage,
    timeline: session.timeline,
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    const sessionId = sanitize(url.searchParams.get("session_id") || "");
    ws.sessionId = sessionId;
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  const sessionId = ws.sessionId;
  if (!sessionId) {
    ws.close();
    return;
  }
  if (!wsClients.has(sessionId)) {
    wsClients.set(sessionId, new Set());
  }
  wsClients.get(sessionId).add(ws);
  ws.on("close", () => {
    const set = wsClients.get(sessionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) wsClients.delete(sessionId);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  sessions.forEach((session, id) => {
    if (now - session.updatedAt > 30 * 60 * 1000) {
      sessions.delete(id);
      wsClients.delete(id);
    }
  });
}, 5 * 60 * 1000);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
