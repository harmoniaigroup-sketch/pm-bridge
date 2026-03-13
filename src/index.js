/**
 * PM Bridge — Prompt Maestro Twilio ↔ ElevenLabs Bridge Service
 * 
 * Endpoints:
 *   POST /webhook/twilio-bridge  — Twilio webhook (WhatsApp/SMS/FB messages)
 *   POST /chat                   — Internal API for n8n or direct calls
 *   GET  /health                 — Health check with session stats
 */

const express = require("express");
const twilio = require("twilio");
const SessionManager = require("./session-manager");

// --- Config ---
const PORT = parseInt(process.env.PORT || "3000", 10);
const EL_API_KEY = process.env.ELEVENLABS_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || "pm-bridge-secret-2026";
const MASTER_SHEET_LOOKUP_URL = process.env.MASTER_SHEET_LOOKUP_URL; // n8n webhook URL to look up doctor by phone

if (!EL_API_KEY) {
  console.error("FATAL: ELEVENLABS_API_KEY environment variable is required");
  process.exit(1);
}

// --- Initialize ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio sends form-encoded

const sessionManager = new SessionManager({ elevenLabsApiKey: EL_API_KEY });
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// --- Doctor config cache (simple in-memory, refreshed per request for now) ---
// In production, this would be backed by Redis or a proper cache.
// For MVP, we'll accept a doctor_config in the request or look it up.
const doctorCache = new Map();

// --- Endpoints ---

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    ...sessionManager.stats(),
  });
});

/**
 * POST /chat — Internal API
 * Body: { doctor_id, agent_id, patient_phone, text, dynamic_variables? }
 * Returns: { response, conversation_id }
 * 
 * Used by n8n twilio-bridge workflow or for testing.
 */
app.post("/chat", async (req, res) => {
  // Auth check
  const authHeader = req.headers["x-bridge-auth"] || req.headers["authorization"];
  if (authHeader !== BRIDGE_AUTH_TOKEN && authHeader !== `Bearer ${BRIDGE_AUTH_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { doctor_id, agent_id, patient_phone, text, dynamic_variables } = req.body;

  if (!agent_id || !patient_phone || !text) {
    return res.status(400).json({ error: "Missing required fields: agent_id, patient_phone, text" });
  }

  try {
    const response = await sessionManager.sendMessage({
      doctorId: doctor_id || "unknown",
      agentId: agent_id,
      patientPhone: patient_phone,
      text,
      dynamicVariables: dynamic_variables,
    });

    res.json({ response, doctor_id, patient_phone });
  } catch (err) {
    console.error(`[/chat] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhook/twilio-bridge — Twilio incoming message webhook
 * 
 * Twilio sends form-encoded: From, To, Body, NumMedia, MediaUrl0, etc.
 * We look up the doctor by the To number, send the message to ElevenLabs,
 * and respond to Twilio with the agent's text response.
 */
app.post("/webhook/twilio-bridge", async (req, res) => {
  const { From, To, Body, NumMedia, MediaUrl0, ProfileName } = req.body;

  const fromChannel = parseChannel(From || "");
  const toChannel = parseChannel(To || "");

  console.log(`[Twilio] channel=${fromChannel.channel} From=${From} To=${To} Body="${Body?.substring(0, 50)}..." Media=${NumMedia || 0}`);

  if (!Body && (!NumMedia || NumMedia === "0")) {
    return res.type("text/xml").send("<Response></Response>");
  }

  // Respond 200 OK immediately — Twilio needs this fast to avoid retries
  res.type("text/xml").send("<Response></Response>");

  // Process asynchronously: look up doctor, call ElevenLabs, send reply via REST API
  try {
    // Parse keyword for Sandbox routing (e.g., "sofia: hola" → keyword="sofia", cleanBody="hola")
    const { keyword, cleanBody } = parseSandboxKeyword(Body);
    if (keyword) {
      console.log(`[Twilio] Sandbox keyword detected: "${keyword}" → routing to mapped doctor`);
    }

    const doctor = await lookupDoctor(To, keyword);

    if (!doctor) {
      console.error(`[Twilio] No doctor found for number: ${To} (keyword: ${keyword})`);
      await sendTwilioMessage(To, From, "Lo siento, este número no está configurado. Por favor contacta a tu doctor directamente.");
      return;
    }

    const messageText = cleanBody || "[Audio message — transcription not yet implemented]";

    const agentResponse = await sessionManager.sendMessage({
      doctorId: doctor.doctor_id,
      agentId: doctor.agent_id,
      patientPhone: From,
      text: messageText,
      dynamicVariables: doctor.dynamic_variables,
    });

    // Send response via Twilio REST API (not TwiML)
    await sendTwilioMessage(To, From, agentResponse);

    console.log(`[Twilio] Responded to ${From} via ${doctor.doctor_id} (${fromChannel.channel}): "${agentResponse.substring(0, 80)}..."`);
  } catch (err) {
    console.error(`[Twilio] Error processing message:`, err.message);
    await sendTwilioMessage(To, From, "Disculpa, estoy experimentando problemas técnicos. Por favor intenta de nuevo en unos minutos.").catch(() => {});
  }
});

/**
 * Send a message via Twilio REST API (async, independent of webhook response).
 */
async function sendTwilioMessage(from, to, body) {
  if (!twilioClient) {
    console.error("[Twilio] Cannot send message: Twilio client not initialized");
    return;
  }
  try {
    const msg = await twilioClient.messages.create({ from, to, body });
    console.log(`[Twilio REST] Sent to ${to} (sid=${msg.sid})`);
  } catch (err) {
    console.error(`[Twilio REST] Failed to send to ${to}:`, err.message);
  }
}

/**
 * Sandbox keyword routing map.
 * 
 * In Sandbox mode, all messages arrive at the same Twilio number (+14155238886).
 * To test multiple doctors, patients prefix their message with a keyword.
 * 
 * Format: SANDBOX_DOCTOR_MAP env var is a JSON string:
 *   { "sofia": { "doctor_id": "PM-E2E-001", "agent_id": "agent_..." }, ... }
 * 
 * If no keyword matches, falls back to SANDBOX_DOCTOR_ID / SANDBOX_AGENT_ID.
 * 
 * TEMPORARY: Remove when each doctor has their own Twilio number (production).
 */
const SANDBOX_NUMBER = "14155238886";
let sandboxDoctorMap = {};
try {
  sandboxDoctorMap = JSON.parse(process.env.SANDBOX_DOCTOR_MAP || "{}");
} catch (e) {
  console.warn("[Config] Failed to parse SANDBOX_DOCTOR_MAP, using empty map");
}

/**
 * Parse keyword prefix from message body for Sandbox routing.
 * Supports formats: "sofia: mensaje", "sofia mensaje", "s: mensaje", "s mensaje"
 * Returns { keyword, cleanBody } or { keyword: null, cleanBody: originalBody }
 */
function parseSandboxKeyword(body) {
  if (!body) return { keyword: null, cleanBody: body };

  const trimmed = body.trim();
  // Match: keyword (optionally followed by : or space) then the actual message
  const match = trimmed.match(/^(\w+)\s*:\s*(.+)$/is);
  if (match) {
    return { keyword: match[1].toLowerCase(), cleanBody: match[2].trim() };
  }

  // Also check for keyword as standalone first word (no colon)
  const words = trimmed.split(/\s+/);
  if (words.length > 1) {
    const firstWord = words[0].toLowerCase();
    if (sandboxDoctorMap[firstWord]) {
      return { keyword: firstWord, cleanBody: words.slice(1).join(" ") };
    }
  }

  return { keyword: null, cleanBody: body };
}

/**
 * Normalize the channel type from Twilio's From/To fields.
 * Twilio prefixes: "whatsapp:+52...", "messenger:...", plain "+52..." = SMS
 * Returns: { channel: "whatsapp"|"messenger"|"sms", phone: "+52..." }
 */
function parseChannel(twilioAddress) {
  if (twilioAddress.startsWith("whatsapp:")) {
    return { channel: "whatsapp", phone: twilioAddress.replace("whatsapp:", "") };
  }
  if (twilioAddress.startsWith("messenger:")) {
    return { channel: "messenger", phone: twilioAddress.replace("messenger:", "") };
  }
  return { channel: "sms", phone: twilioAddress };
}

/**
 * Look up doctor config by Twilio phone number (+ optional keyword for Sandbox).
 * 
 * Strategy: 
 * 1. Sandbox mode: use keyword routing map or default doctor
 * 2. Production mode: check in-memory cache, then n8n webhook → Master Sheet
 * 3. Cache result for 5 minutes
 * 
 * Returns: { doctor_id, agent_id, dynamic_variables }
 */
async function lookupDoctor(toNumber, keyword) {
  // Normalize phone number (remove channel prefix)
  const { phone } = parseChannel(toNumber);
  const normalizedPhone = phone.replace("+", "");

  // ── Sandbox mode ──
  if (normalizedPhone === SANDBOX_NUMBER) {
    // Check keyword routing map first
    if (keyword && sandboxDoctorMap[keyword]) {
      const mapped = sandboxDoctorMap[keyword];
      console.log(`[Lookup] Sandbox keyword "${keyword}" → doctor ${mapped.doctor_id}`);
      return {
        doctor_id: mapped.doctor_id,
        agent_id: mapped.agent_id,
        dynamic_variables: { doctor_id: mapped.doctor_id },
      };
    }

    // Default Sandbox doctor
    const defaultDoctor = {
      doctor_id: process.env.SANDBOX_DOCTOR_ID || "PM-TEST-001",
      agent_id: process.env.SANDBOX_AGENT_ID || "agent_7001kkf42e44f3ethezn15t0dh11",
      dynamic_variables: {
        doctor_id: process.env.SANDBOX_DOCTOR_ID || "PM-TEST-001",
      },
    };
    return defaultDoctor;
  }

  // ── Production mode: cache check ──
  const cached = doctorCache.get(normalizedPhone);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return cached.data;
  }

  // ── Production mode: look up via n8n webhook ──
  if (MASTER_SHEET_LOOKUP_URL) {
    try {
      const resp = await fetch(MASTER_SHEET_LOOKUP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ twilio_phone_number: normalizedPhone }),
      });
      const data = await resp.json();
      if (data.agent_id) {
        doctorCache.set(normalizedPhone, { data, ts: Date.now() });
        return data;
      }
    } catch (err) {
      console.error(`[Lookup] Failed to look up doctor for ${normalizedPhone}:`, err.message);
    }
  }

  return null;
}

// --- Start server ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`PM Bridge running on port ${PORT}`);
  console.log(`  Twilio webhook: POST /webhook/twilio-bridge`);
  console.log(`  Chat API:       POST /chat`);
  console.log(`  Health:         GET  /health`);
  console.log(`  Sandbox doctor: ${process.env.SANDBOX_DOCTOR_ID || "PM-TEST-001"}`);
  console.log(`  Sandbox agent:  ${process.env.SANDBOX_AGENT_ID || "agent_7001kkf42e44f3ethezn15t0dh11"}`);
  const mapKeys = Object.keys(sandboxDoctorMap);
  if (mapKeys.length > 0) {
    console.log(`  Sandbox keyword routing:`);
    for (const [kw, cfg] of Object.entries(sandboxDoctorMap)) {
      console.log(`    "${kw}" → ${cfg.doctor_id} (${cfg.agent_id})`);
    }
  } else {
    console.log(`  Sandbox keyword routing: none (all messages → default doctor)`);
  }
});
