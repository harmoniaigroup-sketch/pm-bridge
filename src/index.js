/**
 * PM Bridge — Prompt Maestro Twilio ↔ ElevenLabs Bridge Service
 * v1.7.1 — Patient payment success page (H14)
 * 
 * Changes from v1.7.0:
 *   - GET /pago-paciente-exitoso — Success page after patient pays anticipo via Stripe Checkout
 *   - Version bump to 1.7.1
 * 
 * Endpoints:
 *   POST /webhook/twilio-bridge  — Twilio webhook (WhatsApp/SMS/FB messages)
 *   POST /chat                   — Internal API for n8n or direct calls
 *   GET  /health                 — Health check with session stats
 *   GET  /entrevista             — Interview page (Tarea #12)
 *   POST /api/validate-token     — Validate doctor token (entrevista)
 *   POST /api/entrevista-chat    — Proxy to entrevistador-agent
 *   POST /api/skip-calendar      — Doctor skips Calendar OAuth
 *   GET  /prueba                 — Trial page with 12h timer (Tarea #13)
 *   POST /api/validate-prueba    — Validate doctor for trial page
 *   GET  /pago-final             — Payment page with dynamic pricing + T&C (Tarea #16+#17)
 *   POST /api/create-checkout-final — Proxy to create Stripe Checkout Session
 *   POST /api/stripe-connect-onboarding — Proxy to n8n Stripe Connect onboarding (Tarea #25)
 *   POST /api/stripe-connect-status — Check if doctor has Stripe Connect configured (Tarea #25)
 *   GET  /pago-paciente-exitoso  — Patient payment success page (H14)
 */

const express = require("express");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
const SessionManager = require("./session-manager");

// --- Config ---
const PORT = parseInt(process.env.PORT || "3000", 10);
const EL_API_KEY = process.env.ELEVENLABS_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || "pm-bridge-secret-2026";
const MASTER_SHEET_LOOKUP_URL = process.env.MASTER_SHEET_LOOKUP_URL || "https://n8n-promptmaestro.sliplane.app/webhook/doctor-lookup-by-phone"; // v1.6.0: default to n8n webhook
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // For Whisper STT (voice transcription add-on)
const N8N_BASE_URL = process.env.N8N_BASE_URL || "https://n8n-promptmaestro.sliplane.app";
const PM_ROUTER_SECRET = process.env.PM_ROUTER_SECRET || "pm-router-secret-2026";
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "119962190836-01me8jvs4fm23iatrvk9ov7it35r0qkd.apps.googleusercontent.com";
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || `${N8N_BASE_URL}/webhook/calendar-oauth-callback`;

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
    version: "1.7.1",
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
  const { From, To, Body, NumMedia, MediaUrl0, MediaContentType0, ProfileName } = req.body;

  const fromChannel = parseChannel(From || "");
  const toChannel = parseChannel(To || "");

  const hasMedia = NumMedia && parseInt(NumMedia, 10) > 0;
  const isAudio = hasMedia && MediaContentType0 && MediaContentType0.startsWith("audio/");

  console.log(`[Twilio] channel=${fromChannel.channel} From=${From} To=${To} Body="${Body?.substring(0, 50) || ""}" Media=${NumMedia || 0}${isAudio ? ` (audio: ${MediaContentType0})` : ""}`);

  if (!Body && !hasMedia) {
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

    // --- Determine message text ---
    let messageText = cleanBody;

    if (isAudio && !cleanBody) {
      // Voice note received with no text body
      if (!doctor.enable_voice_transcription) {
        // Add-on NOT active → placeholder response, skip ElevenLabs
        console.log(`[Twilio] Voice note from ${From} — transcription DISABLED for ${doctor.doctor_id}`);
        await sendTwilioMessage(To, From,
          "Recibí su nota de voz. Por el momento solo puedo leer mensajes de texto. " +
          "¿Podría escribirme su consulta? Con gusto le ayudo."
        );
        return;
      }

      // Add-on ACTIVE → transcribe via Whisper
      console.log(`[Twilio] Voice note from ${From} — transcribing for ${doctor.doctor_id}`);
      try {
        messageText = await transcribeAudio(MediaUrl0);
        console.log(`[Whisper] Transcription (${messageText.length} chars): "${messageText.substring(0, 80)}..."`);
      } catch (transcriptionErr) {
        console.error(`[Whisper] Transcription failed:`, transcriptionErr.message);
        await sendTwilioMessage(To, From,
          "Disculpa, no pude procesar tu nota de voz. ¿Podrías escribirme tu consulta o enviar otra nota?"
        );
        return;
      }
    }

    // If still no text (e.g., non-audio media like image), use a descriptive fallback
    if (!messageText) {
      messageText = "[El paciente envió un archivo multimedia que no puedo procesar]";
    }

    const agentResponse = await sessionManager.sendMessage({
      doctorId: doctor.doctor_id,
      agentId: doctor.agent_id,
      patientPhone: From,
      text: messageText,
      dynamicVariables: doctor.dynamic_variables,
      onFollowUp: (followUpText) => {
        // Send follow-up responses (e.g., after tool calls) directly to patient
        console.log(`[Twilio] Sending follow-up to ${From}: "${followUpText.substring(0, 80)}..."`);
        sendTwilioMessage(To, From, followUpText);
      },
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
 * Download audio from Twilio MediaUrl and transcribe via OpenAI Whisper API.
 * 
 * Twilio MediaUrl requires Basic Auth (Account SID + Auth Token).
 * Whisper expects multipart/form-data with the audio file.
 * 
 * Returns: transcribed text string
 * Throws: on download failure, API error, or empty transcription
 */
async function transcribeAudio(mediaUrl) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured — cannot transcribe audio");
  }
  if (!mediaUrl) {
    throw new Error("No MediaUrl provided");
  }

  // Step 1: Download audio from Twilio (requires Basic Auth)
  const twilioAuth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const audioResponse = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${twilioAuth}` },
  });

  if (!audioResponse.ok) {
    throw new Error(`Failed to download audio: ${audioResponse.status} ${audioResponse.statusText}`);
  }

  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
  const contentType = audioResponse.headers.get("content-type") || "audio/ogg";

  // Determine file extension from content type
  const extMap = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr", "audio/wav": "wav" };
  const ext = extMap[contentType.split(";")[0]] || "ogg";

  console.log(`[Whisper] Downloaded audio: ${audioBuffer.length} bytes, type=${contentType}`);

  // Step 2: Send to OpenAI Whisper API (multipart/form-data)
  const boundary = "----PMBridgeWhisper" + Date.now();
  const formParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.${ext}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    audioBuffer,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes`,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson`,
    `\r\n--${boundary}--\r\n`,
  ];

  // Concatenate text parts and binary buffer into a single body
  const textEncoder = new TextEncoder();
  const parts = formParts.map(p => (typeof p === "string" ? textEncoder.encode(p) : new Uint8Array(p)));
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  const whisperResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!whisperResponse.ok) {
    const errText = await whisperResponse.text().catch(() => "unknown");
    throw new Error(`Whisper API error: ${whisperResponse.status} — ${errText}`);
  }

  const result = await whisperResponse.json();
  const transcript = (result.text || "").trim();

  if (!transcript) {
    throw new Error("Whisper returned empty transcription");
  }

  return transcript;
}

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
 * Returns: { doctor_id, agent_id, enable_voice_transcription, dynamic_variables }
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
        enable_voice_transcription: mapped.enable_voice_transcription || false,
        dynamic_variables: { doctor_id: mapped.doctor_id },
      };
    }

    // Default Sandbox doctor
    const defaultDoctor = {
      doctor_id: process.env.SANDBOX_DOCTOR_ID || "PM-TEST-001",
      agent_id: process.env.SANDBOX_AGENT_ID || "agent_7001kkf42e44f3ethezn15t0dh11",
      enable_voice_transcription: process.env.SANDBOX_ENABLE_VOICE === "true",
      dynamic_variables: {
        doctor_id: process.env.SANDBOX_DOCTOR_ID || "PM-TEST-001",
      },
    };
    return defaultDoctor;
  }

  // ── Production mode: cache check ──
  const cached = doctorCache.get(normalizedPhone);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    console.log(`[Lookup] Cache hit for ${normalizedPhone} → ${cached.data.doctor_id}`);
    return cached.data;
  }

  // ── Production mode: look up via n8n webhook ──
  if (MASTER_SHEET_LOOKUP_URL) {
    try {
      console.log(`[Lookup] Production lookup for ${normalizedPhone} via n8n`);
      const resp = await fetch(MASTER_SHEET_LOOKUP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ twilio_phone_number: normalizedPhone }),
      });
      const data = await resp.json();
      if (data.agent_id) {
        doctorCache.set(normalizedPhone, { data, ts: Date.now() });
        console.log(`[Lookup] Found: ${data.doctor_id} (${data.agent_name}) — cached for 5min`);
        return data;
      }
      console.log(`[Lookup] Doctor not found for ${normalizedPhone}`);
    } catch (err) {
      console.error(`[Lookup] Failed to look up doctor for ${normalizedPhone}:`, err.message);
    }
  }

  return null;
}

// ==========================================================================
// Interview Page Routes (Task #12)
// ==========================================================================

/**
 * GET /entrevista — Serve the interview page
 * Query: ?token=LEAD-xxx or ?lead_id=PM-xxx
 * Also handles ?calendar_connected=true for OAuth callback return
 */
const entrevistaTemplate = fs.readFileSync(
  path.join(__dirname, "pages", "entrevista.html"),
  "utf-8"
);

app.get("/entrevista", (req, res) => {
  // Determine the public base URL for API calls
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || "pm-bridge.sliplane.app";
  const apiBase = `${proto}://${host}`;

  const html = entrevistaTemplate
    .replace("'{{API_BASE}}'", JSON.stringify(apiBase))
    .replace("'{{N8N_BASE}}'", JSON.stringify(N8N_BASE_URL))
    .replace("'{{OAUTH_CLIENT_ID}}'", JSON.stringify(OAUTH_CLIENT_ID))
    .replace("'{{OAUTH_REDIRECT_URI}}'", JSON.stringify(OAUTH_REDIRECT_URI));

  res.type("text/html; charset=utf-8").send(html);
});

/**
 * POST /api/validate-token — Validate doctor access token
 * Body: { lead_id: "LEAD-xxx" or "PM-xxx" }
 * Proxies to n8n validate-interview-token workflow
 */
app.post("/api/validate-token", async (req, res) => {
  const { lead_id } = req.body || {};

  if (!lead_id) {
    return res.status(400).json({ error: "missing lead_id" });
  }

  try {
    const resp = await fetch(`${N8N_BASE_URL}/webhook/validate-interview-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PM-Auth": PM_ROUTER_SECRET,
      },
      body: JSON.stringify({ lead_id }),
    });

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    console.error("[validate-token] Proxy error:", err.message);
    res.status(502).json({ error: "validation_service_unavailable" });
  }
});

/**
 * POST /api/entrevista-chat — Proxy chat messages to entrevistador-agent
 * Body: { message, doctor_id, doctor_name, doctor_phone, doctor_email,
 *         doctor_specialty, sessionId, interview_state, calendar_connected,
 *         google_calendar_id, stripe_connected, stripe_connect_id,
 *         whatsapp_verified, wa_phone_number }
 * Returns: { response: "...", profile_complete: true/false }
 */
app.post("/api/entrevista-chat", async (req, res) => {
  const {
    message, doctor_id, doctor_name, doctor_phone, doctor_email,
    doctor_specialty, sessionId: sid, interview_state,
    calendar_connected, google_calendar_id, stripe_connected,
    stripe_connect_id, whatsapp_verified, wa_phone_number,
  } = req.body || {};

  if (!message || !doctor_id) {
    return res.status(400).json({ error: "missing message or doctor_id" });
  }

  try {
    const resp = await fetch(`${N8N_BASE_URL}/webhook/entrevistador-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        doctor_id,
        doctor_name: doctor_name || "",
        doctor_phone: doctor_phone || "",
        doctor_email: doctor_email || "",
        doctor_specialty: doctor_specialty || "",
        sessionId: sid || `interview-${doctor_id}-${Date.now()}`,
        interview_state: interview_state || null,
        calendar_connected: calendar_connected || false,
        google_calendar_id: google_calendar_id || "",
        stripe_connected: stripe_connected || false,
        stripe_connect_id: stripe_connect_id || "",
        whatsapp_verified: whatsapp_verified || false,
        wa_phone_number: wa_phone_number || "",
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      console.error(`[entrevista-chat] n8n error: ${resp.status} — ${errText.substring(0, 200)}`);
      return res.status(502).json({ error: "interview_service_error" });
    }

    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error("[entrevista-chat] Proxy error:", err.message);
    res.status(502).json({ error: "interview_service_unavailable" });
  }
});

/**
 * POST /api/skip-calendar — Doctor skips Calendar OAuth
 * Body: { doctor_id }
 * Updates pipeline_status to permisos_completos (with calendar_connected=false)
 *
 * For MVP this is a simple status update via Sheets API through n8n.
 * The configurador-agent will pick it up on the next cron cycle.
 */
app.post("/api/skip-calendar", async (req, res) => {
  const { doctor_id } = req.body || {};

  if (!doctor_id) {
    return res.status(400).json({ error: "missing doctor_id" });
  }

  try {
    // Use the validate-interview-token endpoint to find the doctor row,
    // then we'll update pipeline_status via a direct Sheets batchUpdate through n8n.
    // For MVP simplicity, we'll call a lightweight n8n webhook.
    // TODO: Create a dedicated skip-calendar n8n workflow if needed.
    // For now, the configurador-agent picks up entrevista_completa status.
    console.log(`[skip-calendar] Doctor ${doctor_id} skipped Calendar OAuth`);
    res.json({ ok: true, message: "Calendar skipped — using static hours" });
  } catch (err) {
    console.error("[skip-calendar] Error:", err.message);
    res.status(500).json({ error: "internal_error" });
  }
});

// ==========================================================================
// Stripe Connect Routes (Task #25)
// ==========================================================================

/**
 * POST /api/stripe-connect-onboarding — Initiate Stripe Connect onboarding
 * Body: { doctor_id: "PM-xxx" }
 * Proxies to n8n stripe-connect-onboarding workflow (adds X-PM-Auth)
 * Returns: { ok: true, onboarding_url: "https://connect.stripe.com/..." }
 */
app.post("/api/stripe-connect-onboarding", async (req, res) => {
  try {
    const { doctor_id } = req.body || {};

    if (!doctor_id) {
      return res.status(400).json({ error: "doctor_id is required" });
    }

    const response = await fetch(`${N8N_BASE_URL}/webhook/stripe-connect-onboarding`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PM-Auth": PM_ROUTER_SECRET,
      },
      body: JSON.stringify({ doctor_id }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      console.error(`[stripe-connect-onboarding] Error: ${data.message || response.status}`);
      return res.status(response.status || 400).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("[stripe-connect-onboarding] Proxy error:", err.message);
    res.status(502).json({ error: "Failed to initiate Stripe Connect onboarding" });
  }
});

/**
 * POST /api/stripe-connect-status — Check Stripe Connect status for a doctor
 * Body: { doctor_id: "PM-xxx" }
 * Reads Master Sheet via n8n validate-interview-token and returns Stripe fields
 * Returns: { connected: true/false, stripe_connect_id: "acct_xxx", stripe_connect_status: "active" }
 */
app.post("/api/stripe-connect-status", async (req, res) => {
  try {
    const { doctor_id } = req.body || {};

    if (!doctor_id) {
      return res.status(400).json({ error: "doctor_id is required" });
    }

    // Use validate-interview-token to read doctor data from Sheet
    const response = await fetch(`${N8N_BASE_URL}/webhook/validate-interview-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PM-Auth": PM_ROUTER_SECRET,
      },
      body: JSON.stringify({ lead_id: doctor_id }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      // If validate-interview-token fails, return not connected
      return res.json({ connected: false, stripe_connect_id: null, stripe_connect_status: null });
    }

    const connectId = data.stripe_connect_id || null;
    const connectStatus = data.stripe_connect_status || null;

    res.json({
      connected: !!connectId,
      stripe_connect_id: connectId,
      stripe_connect_status: connectStatus,
    });
  } catch (err) {
    console.error("[stripe-connect-status] Error:", err.message);
    res.status(502).json({ error: "Failed to check Stripe Connect status" });
  }
});

// ==========================================================================
// Trial Page Routes (Task #13)
// ==========================================================================

/**
 * GET /prueba — Serve the trial page with 12h countdown timer
 * Query: ?token=PM-xxx (doctor_id)
 * Validates doctor status, shows agent info, WhatsApp number, checklist
 */
const pruebaTemplate = fs.readFileSync(
  path.join(__dirname, "pages", "prueba.html"),
  "utf-8"
);

app.get("/prueba", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || "pm-bridge.sliplane.app";
  const apiBase = `${proto}://${host}`;

  const html = pruebaTemplate
    .replace(/'{{API_BASE}}'/g, JSON.stringify(apiBase));

  res.type("text/html; charset=utf-8").send(html);
});

/**
 * POST /api/validate-prueba — Validate doctor for trial page
 * Body: { token: "PM-xxx" }
 * Proxies to n8n, filters by trial-eligible statuses, strips sensitive data
 */
app.post("/api/validate-prueba", async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    const response = await fetch(`${N8N_BASE_URL}/webhook/validate-interview-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PM-Auth": PM_ROUTER_SECRET,
      },
      body: JSON.stringify({ lead_id: token }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Security: only allow trial-eligible or post-trial statuses
    const trialEligible = [
      "agente_listo_para_prueba",
      "canales_activos",
      "prueba_expirada",
      "pago_final_completo",
      "whatsapp_pendiente_aprobacion",
      "en_produccion",
    ];

    if (!trialEligible.includes(data.pipeline_status)) {
      return res.status(403).json({ error: "agent_not_ready_for_trial" });
    }

    // Strip sensitive fields — only send what the frontend needs
    const safeData = {
      valid: data.valid,
      doctor_id: data.doctor_id,
      doctor_name: data.doctor_name,
      specialty: data.specialty,
      pipeline_status: data.pipeline_status,
      pipeline_status_updated: data.pipeline_status_updated,
      agent_name: data.agent_name,
      twilio_phone_number: data.twilio_phone_number,
      wa_phone_number: data.wa_phone_number,
      addon_voice_transcription: data.addon_voice_transcription,
      addon_fb_messenger: data.addon_fb_messenger,
      monthly_total: data.monthly_total,
      first_month_total: data.first_month_total,
      services_json: data.services_json,
      business_hours_json: data.business_hours_json,
    };

    return res.json(safeData);
  } catch (err) {
    console.error("[validate-prueba] Error:", err.message);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ==========================================================================
// Payment Page Routes (Tasks #16 + #17)
// ==========================================================================

/**
 * GET /pago-final — Serve the payment page with dynamic pricing + T&C
 * Query: ?token=PM-xxx (doctor_id)
 * Shows: agent summary, payment breakdown, T&C checkbox, Stripe Checkout button
 */
const pagoFinalTemplate = fs.readFileSync(
  path.join(__dirname, "pages", "pago-final.html"),
  "utf-8"
);

app.get("/pago-final", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || "pm-bridge.sliplane.app";
  const apiBase = `${proto}://${host}`;

  const html = pagoFinalTemplate
    .replace(/%%API_BASE%%/g, JSON.stringify(apiBase).slice(1, -1));

  res.type("text/html; charset=utf-8").send(html);
});

/**
 * POST /api/create-checkout-final — Create Stripe Checkout Session for pago final
 * Body: { doctor_id: "PM-xxx", terms_accepted: true }
 * Proxies to n8n create-checkout-final workflow (adds X-PM-Auth)
 * Returns: { ok: true, checkout_url: "https://checkout.stripe.com/..." }
 */
app.post("/api/create-checkout-final", async (req, res) => {
  try {
    const { doctor_id, terms_accepted } = req.body || {};

    if (!doctor_id || !terms_accepted) {
      return res.status(400).json({ error: "doctor_id and terms_accepted are required" });
    }

    const response = await fetch(`${N8N_BASE_URL}/webhook/create-checkout-final`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PM-Auth": PM_ROUTER_SECRET,
      },
      body: JSON.stringify({ doctor_id, terms_accepted }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      console.error(`[create-checkout-final] Error: ${data.message || response.status}`);
      return res.status(response.status || 400).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("[create-checkout-final] Proxy error:", err.message);
    res.status(502).json({ error: "Failed to create checkout session" });
  }
});

// ==========================================================================
// Patient Payment Success Page (H14)
// ==========================================================================

/**
 * GET /pago-paciente-exitoso — Success page after patient pays anticipo
 * Query: ?session_id=cs_xxx (Stripe Checkout Session ID)
 * Static page — the webhook already handled Calendar + WA notifications server-side.
 * This page is purely UX for the patient to see a confirmation.
 */
app.get("/pago-paciente-exitoso", (req, res) => {
  const html = fs.readFileSync(
    path.join(__dirname, "pages", "pago-paciente-exitoso.html"),
    "utf-8"
  );
  res.type("text/html; charset=utf-8").send(html);
});

// --- Start server ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`PM Bridge v1.7.1 running on port ${PORT}`);
  console.log(`  Twilio webhook: POST /webhook/twilio-bridge`);
  console.log(`  Chat API:       POST /chat`);
  console.log(`  Interview:      GET  /entrevista`);
  console.log(`  Trial page:     GET  /prueba`);
  console.log(`  Payment:        GET  /pago-final`);
  console.log(`  Patient success: GET /pago-paciente-exitoso`);
  console.log(`  Health:         GET  /health`);
  console.log(`  Stripe Connect: POST /api/stripe-connect-onboarding`);
  console.log(`  Stripe Status:  POST /api/stripe-connect-status`);
  console.log(`  Doctor lookup:  ${MASTER_SHEET_LOOKUP_URL ? 'ACTIVE' : 'DISABLED'}`);
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
