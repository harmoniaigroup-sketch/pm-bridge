# PM Bridge — Prompt Maestro Twilio ↔ ElevenLabs Bridge

Microservicio que conecta Twilio (WhatsApp, SMS, FB Messenger) con agentes de ElevenLabs Conversational AI.

## Arquitectura

```
Paciente (WhatsApp / FB Messenger / SMS)
    ↓
Twilio (webhook POST)
    ↓
PM Bridge (este servicio)
  → Parses channel (whatsapp/messenger/sms)
  → Routes to correct doctor (by To number, or keyword in Sandbox)
  → Abre WebSocket a ElevenLabs en text-only mode
  → Envía mensaje del paciente
  → Recibe respuesta del agente (con RAG + Tools)
  → Responde vía Twilio REST API
    ↓
Paciente recibe respuesta
```

## Endpoints

| Endpoint | Método | Uso |
|---|---|---|
| `/webhook/twilio-bridge` | POST | Webhook de Twilio (WhatsApp/SMS/FB Messenger) |
| `/chat` | POST | API interna (llamada desde n8n o testing) |
| `/health` | GET | Health check con stats de sesiones activas |

## Multi-Doctor Routing

### Production mode
Each doctor has their own Twilio phone number. The bridge routes by the `To` field.

### Sandbox mode (testing)
All Sandbox messages arrive at `+14155238886`. Keyword-based routing:

- **Default** (no keyword): routes to `SANDBOX_DOCTOR_ID` / `SANDBOX_AGENT_ID`
- **Keyword prefix**: `sofia: hola` → routes to mapped doctor

Supported formats: `sofia: msg`, `sofia:msg`, `sofia msg` (if keyword in map), `s: msg`

Configure via env var:
```bash
SANDBOX_DOCTOR_MAP='{"sofia":{"doctor_id":"PM-E2E-001","agent_id":"agent_1901kkfaxnqzfpkv2d30j29szw3b"},"s":{"doctor_id":"PM-E2E-001","agent_id":"agent_1901kkfaxnqzfpkv2d30j29szw3b"}}'
```

## Channel Support

Detects channel from Twilio From/To prefixes:
- `whatsapp:+52...` → WhatsApp
- `messenger:...` → Facebook Messenger  
- `+52...` (no prefix) → SMS

All channels use the same ElevenLabs agent — bridge is channel-agnostic.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ELEVENLABS_API_KEY` | ✅ | ElevenLabs API key |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio Auth Token |
| `BRIDGE_AUTH_TOKEN` | No | Auth for `/chat` (default: `pm-bridge-secret-2026`) |
| `SANDBOX_DOCTOR_ID` | No | Default Sandbox doctor (default: `PM-TEST-001`) |
| `SANDBOX_AGENT_ID` | No | Default Sandbox agent ID |
| `SANDBOX_DOCTOR_MAP` | No | JSON keyword→doctor map for multi-doctor Sandbox |
| `MASTER_SHEET_LOOKUP_URL` | No | n8n webhook for production doctor lookup |

## Testing

```bash
# Default doctor (Valentina)
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Auth: pm-bridge-secret-2026" \
  -d '{"agent_id":"agent_7001kkf42e44f3ethezn15t0dh11","patient_phone":"+5213339657087","text":"Hola"}'

# Second doctor (Sofía) via /chat
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Auth: pm-bridge-secret-2026" \
  -d '{"doctor_id":"PM-E2E-001","agent_id":"agent_1901kkfaxnqzfpkv2d30j29szw3b","patient_phone":"+5213339657087","text":"Hola"}'
```
