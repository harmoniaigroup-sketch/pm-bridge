/**
 * SessionManager — Manages WebSocket sessions to ElevenLabs agents.
 *
 * Each active conversation (doctor_id + patient_phone) gets its own
 * WebSocket connection. Sessions auto-close after TIMEOUT_MS of inactivity.
 *
 * CONVERSATION PERSISTENCE (B+C hybrid):
 * When a WebSocket closes (ElevenLabs timeout ~60s inactivity), we preserve
 * the conversation history in a separate store. On reconnect:
 *   B) Override first_message to "" so the agent doesn't re-greet
 *   C) Send a contextual_update with the conversation summary
 * This gives the LLM full context without touching the system prompt.
 *
 * Requires: "First message" override enabled in ElevenLabs agent Security tab.
 */

const WebSocket = require("ws");

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — after this, conversation resets completely
const HISTORY_MAX_TURNS = 10; // Max user+agent turn pairs to store
const HISTORY_MAX_CHARS = 2000; // Max chars for the contextual_update summary
const EL_WS_BASE = "wss://api.elevenlabs.io/v1/convai/conversation";

class SessionManager {
  constructor({ elevenLabsApiKey }) {
    this.apiKey = elevenLabsApiKey;

    // Active WebSocket sessions: Map<sessionKey, SessionObject>
    this.sessions = new Map();

    // Conversation history that persists beyond WebSocket closure:
    // Map<sessionKey, { turns: [{role, text}], lastActivity: number, timeout: NodeJS.Timeout }>
    this.historyStore = new Map();
  }

  _key(doctorId, patientPhone) {
    return `${doctorId}::${patientPhone}`;
  }

  /**
   * Send a user message to the ElevenLabs agent and return the agent's text response.
   * Creates a new WebSocket session if none exists for this doctor+patient pair.
   * If a previous conversation exists in historyStore, injects context on reconnect.
   */
  async sendMessage({ doctorId, agentId, patientPhone, text, dynamicVariables }) {
    const key = this._key(doctorId, patientPhone);
    let session = this.sessions.get(key);
    let isReconnect = false;

    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      // Check if we have prior conversation history (= this is a reconnect)
      isReconnect = this.historyStore.has(key);

      // Clean up stale WebSocket session if exists (preserves historyStore)
      if (session) this._cleanupSession(key);

      session = await this._createSession({
        key,
        agentId,
        patientPhone,
        dynamicVariables,
        isReconnect,
      });
    }

    // Reset inactivity timeout on the history store
    this._touchHistory(key);

    // Reset WebSocket-level timeout
    clearTimeout(session.wsTimeout);
    session.wsTimeout = setTimeout(() => this._cleanupSession(key), 5 * 60 * 1000);
    session.lastActivity = Date.now();

    // Record user message in history
    this._addToHistory(key, "user", text);

    // Send and wait for response
    const response = await this._sendAndWait(session, text);

    // Record agent response in history
    this._addToHistory(key, "agent", response);

    return response;
  }

  // ─── History Store ───────────────────────────────────────────────

  /**
   * Add a turn to the conversation history for this session key.
   */
  _addToHistory(key, role, text) {
    let history = this.historyStore.get(key);
    if (!history) {
      history = { turns: [], lastActivity: Date.now(), timeout: null };
      this.historyStore.set(key, history);
    }

    history.turns.push({ role, text: text.substring(0, 500) });
    history.lastActivity = Date.now();

    // Trim to max turns (keep most recent)
    while (history.turns.length > HISTORY_MAX_TURNS * 2) {
      history.turns.shift();
    }
  }

  /**
   * Reset the history expiration timer.
   */
  _touchHistory(key) {
    const history = this.historyStore.get(key);
    if (!history) return;

    clearTimeout(history.timeout);
    history.timeout = setTimeout(() => {
      console.log(`[History ${key}] Expired after 30min inactivity. Next message starts fresh.`);
      this.historyStore.delete(key);
    }, SESSION_TIMEOUT_MS);
    history.lastActivity = Date.now();
  }

  /**
   * Build a compact summary of the conversation history for contextual_update.
   */
  _buildContextSummary(key) {
    const history = this.historyStore.get(key);
    if (!history || history.turns.length === 0) return null;

    let summary = "CONTEXTO: Esta es una continuación de conversación. El paciente ya fue saludado. NO te presentes de nuevo. Historial previo:\n";

    for (const turn of history.turns) {
      const prefix = turn.role === "user" ? "Paciente" : "Agente";
      summary += `${prefix}: ${turn.text}\n`;
    }

    // Trim to max chars, keeping header + most recent turns
    if (summary.length > HISTORY_MAX_CHARS) {
      const header = summary.substring(0, 130);
      const recentTurns = summary.substring(summary.length - (HISTORY_MAX_CHARS - 130));
      summary = header + "...\n" + recentTurns;
    }

    return summary;
  }

  // ─── WebSocket Session Management ────────────────────────────────

  /**
   * Open a new WebSocket to ElevenLabs for this conversation.
   * If isReconnect=true, overrides first_message and injects context.
   */
  _createSession({ key, agentId, patientPhone, dynamicVariables, isReconnect }) {
    return new Promise((resolve, reject) => {
      const wsUrl = `${EL_WS_BASE}?agent_id=${agentId}`;
      const ws = new WebSocket(wsUrl, {
        headers: { "xi-api-key": this.apiKey },
      });

      const session = {
        ws,
        conversationId: null,
        lastActivity: Date.now(),
        wsTimeout: setTimeout(() => this._cleanupSession(key), 5 * 60 * 1000),
        pendingResolve: null,
        agentResponseBuffer: "",
        agentResponseTimer: null,
        connected: false,
        isReconnect,
      };

      ws.on("open", () => {
        console.log(`[Session ${key}] WebSocket opened (reconnect=${isReconnect})`);
      });

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Handle conversation initiation metadata
        if (msg.type === "conversation_initiation_metadata") {
          session.conversationId = msg.conversation_initiation_metadata_event?.conversation_id;
          session.connected = true;
          console.log(`[Session ${key}] Connected, convId=${session.conversationId}`);

          // Build initiation config
          const initConfig = {
            type: "conversation_initiation_client_data",
            conversation_initiation_client_data: {
              conversation_config_override: {
                conversation: { text_only: true },
              },
            },
          };

          // (B) If reconnecting, override first_message to suppress re-greeting
          if (isReconnect) {
            initConfig.conversation_initiation_client_data.conversation_config_override.agent = {
              first_message: "",
            };
            console.log(`[Session ${key}] Reconnect: suppressed first_message via override`);
          }

          if (dynamicVariables) {
            initConfig.conversation_initiation_client_data.dynamic_variables = dynamicVariables;
          }

          ws.send(JSON.stringify(initConfig));

          // (C) If reconnecting, send contextual_update with conversation history
          if (isReconnect) {
            const summary = this._buildContextSummary(key);
            if (summary) {
              const contextMsg = {
                type: "contextual_update",
                text: summary,
              };
              ws.send(JSON.stringify(contextMsg));
              console.log(`[Session ${key}] Reconnect: sent contextual_update (${summary.length} chars)`);
            }
          }

          this.sessions.set(key, session);
          resolve(session);
        }

        // Handle agent text response
        if (msg.type === "agent_response") {
          const text = msg.agent_response_event?.agent_response || msg.agent_response || "";
          if (text) {
            session.agentResponseBuffer += text;
            // Debounce: wait for agent to finish sending chunks
            clearTimeout(session.agentResponseTimer);
            session.agentResponseTimer = setTimeout(() => {
              if (session.pendingResolve) {
                session.pendingResolve(session.agentResponseBuffer);
                session.pendingResolve = null;
                session.agentResponseBuffer = "";
              }
            }, 1500);
          }
        }

        // Handle end of conversation
        if (msg.type === "conversation_end" || msg.type === "error") {
          console.log(`[Session ${key}] Conversation ended: ${msg.type}`);
          if (session.pendingResolve && session.agentResponseBuffer) {
            session.pendingResolve(session.agentResponseBuffer);
          } else if (session.pendingResolve) {
            session.pendingResolve("[Conversación finalizada]");
          }
          session.pendingResolve = null;
          session.agentResponseBuffer = "";
          this._cleanupSession(key);
        }
      });

      ws.on("error", (err) => {
        console.error(`[Session ${key}] WebSocket error:`, err.message);
        if (!session.connected) reject(err);
        this._cleanupSession(key);
      });

      ws.on("close", (code, reason) => {
        console.log(`[Session ${key}] WebSocket closed: ${code} ${reason}`);
        if (!session.connected) reject(new Error(`WS closed before connect: ${code}`));
        // Resolve any pending with what we have
        if (session.pendingResolve && session.agentResponseBuffer) {
          session.pendingResolve(session.agentResponseBuffer);
          session.pendingResolve = null;
        }
        // NOTE: historyStore is NOT deleted here — it persists for reconnects
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!session.connected) {
          reject(new Error("ElevenLabs WebSocket connection timeout (10s)"));
          ws.close();
        }
      }, 10000);
    });
  }

  /**
   * Send a user text message and wait for the agent's response.
   */
  _sendAndWait(session, text) {
    return new Promise((resolve, reject) => {
      session.pendingResolve = resolve;
      session.agentResponseBuffer = "";

      const userMsg = {
        type: "user_message",
        user_message: { text },
      };

      try {
        session.ws.send(JSON.stringify(userMsg));
      } catch (err) {
        reject(new Error(`Failed to send message: ${err.message}`));
      }

      // Hard timeout: if no response in 30s, return what we have or error
      setTimeout(() => {
        if (session.pendingResolve) {
          if (session.agentResponseBuffer) {
            session.pendingResolve(session.agentResponseBuffer);
          } else {
            session.pendingResolve("Lo siento, no pude procesar tu mensaje. ¿Podrías intentar de nuevo?");
          }
          session.pendingResolve = null;
          session.agentResponseBuffer = "";
        }
      }, 30000);
    });
  }

  /**
   * Close and remove a WebSocket session (but NOT the history store).
   */
  _cleanupSession(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    clearTimeout(session.wsTimeout);
    clearTimeout(session.agentResponseTimer);
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.close();
    }
    this.sessions.delete(key);
    console.log(`[Session ${key}] WebSocket cleaned up. Active: ${this.sessions.size}. Histories: ${this.historyStore.size}`);
  }

  /**
   * Get stats for health check.
   */
  stats() {
    return {
      activeSessions: this.sessions.size,
      conversationHistories: this.historyStore.size,
      sessions: Array.from(this.sessions.entries()).map(([key, s]) => ({
        key,
        conversationId: s.conversationId,
        lastActivity: new Date(s.lastActivity).toISOString(),
        wsState: s.ws.readyState,
        isReconnect: s.isReconnect,
      })),
      histories: Array.from(this.historyStore.entries()).map(([key, h]) => ({
        key,
        turns: h.turns.length,
        lastActivity: new Date(h.lastActivity).toISOString(),
      })),
    };
  }
}

module.exports = SessionManager;
