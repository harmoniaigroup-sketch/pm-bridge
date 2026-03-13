/**
 * SessionManager — Manages WebSocket sessions to ElevenLabs agents.
 * 
 * Each active conversation (doctor_id + patient_phone) gets its own
 * WebSocket connection. Sessions auto-close after TIMEOUT_MS of inactivity.
 */

const WebSocket = require("ws");

const TIMEOUT_MS = 30 * 60 * 1000; // 30 min inactivity timeout
const EL_WS_BASE = "wss://api.elevenlabs.io/v1/convai/conversation";

class SessionManager {
  constructor({ elevenLabsApiKey }) {
    this.apiKey = elevenLabsApiKey;
    // Map<sessionKey, { ws, conversationId, lastActivity, timeout, pendingResolve }>
    this.sessions = new Map();
  }

  _key(doctorId, patientPhone) {
    return `${doctorId}::${patientPhone}`;
  }

  /**
   * Send a user message to the ElevenLabs agent and return the agent's text response.
   * Creates a new WebSocket session if none exists for this doctor+patient pair.
   */
  async sendMessage({ doctorId, agentId, patientPhone, text, dynamicVariables }) {
    const key = this._key(doctorId, patientPhone);
    let session = this.sessions.get(key);

    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      // Clean up stale session if exists
      if (session) this._cleanup(key);
      session = await this._createSession({ key, agentId, patientPhone, dynamicVariables });
    }

    // Reset inactivity timeout
    clearTimeout(session.timeout);
    session.timeout = setTimeout(() => this._cleanup(key), TIMEOUT_MS);
    session.lastActivity = Date.now();

    return this._sendAndWait(session, text);
  }

  /**
   * Open a new WebSocket to ElevenLabs for this conversation.
   */
  _createSession({ key, agentId, patientPhone, dynamicVariables }) {
    return new Promise((resolve, reject) => {
      const wsUrl = `${EL_WS_BASE}?agent_id=${agentId}`;
      const ws = new WebSocket(wsUrl, {
        headers: { "xi-api-key": this.apiKey },
      });

      const session = {
        ws,
        conversationId: null,
        lastActivity: Date.now(),
        timeout: setTimeout(() => this._cleanup(key), TIMEOUT_MS),
        pendingResolve: null,
        agentResponseBuffer: "",
        agentResponseTimer: null,
        connected: false,
      };

      ws.on("open", () => {
        console.log(`[Session ${key}] WebSocket opened`);
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

          // Send initial config with text_only and dynamic variables
          const initConfig = {
            type: "conversation_initiation_client_data",
            conversation_initiation_client_data: {
              conversation_config_override: {
                conversation: { text_only: true },
              },
            },
          };

          if (dynamicVariables) {
            initConfig.conversation_initiation_client_data.dynamic_variables = dynamicVariables;
          }

          ws.send(JSON.stringify(initConfig));
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

        // Agent response can also come as transcript with role "agent"
        if (msg.type === "transcript" && msg.transcript_event?.role === "agent") {
          // Some EL versions send full transcript events
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
          this._cleanup(key);
        }
      });

      ws.on("error", (err) => {
        console.error(`[Session ${key}] WebSocket error:`, err.message);
        if (!session.connected) reject(err);
        this._cleanup(key);
      });

      ws.on("close", (code, reason) => {
        console.log(`[Session ${key}] WebSocket closed: ${code} ${reason}`);
        if (!session.connected) reject(new Error(`WS closed before connect: ${code}`));
        // Resolve any pending with what we have
        if (session.pendingResolve && session.agentResponseBuffer) {
          session.pendingResolve(session.agentResponseBuffer);
          session.pendingResolve = null;
        }
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
   * Close and remove a session.
   */
  _cleanup(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    clearTimeout(session.timeout);
    clearTimeout(session.agentResponseTimer);
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.close();
    }
    this.sessions.delete(key);
    console.log(`[Session ${key}] Cleaned up. Active sessions: ${this.sessions.size}`);
  }

  /**
   * Get stats for health check.
   */
  stats() {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([key, s]) => ({
        key,
        conversationId: s.conversationId,
        lastActivity: new Date(s.lastActivity).toISOString(),
        wsState: s.ws.readyState,
      })),
    };
  }
}

module.exports = SessionManager;
