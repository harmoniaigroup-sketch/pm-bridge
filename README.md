# PM Bridge — Prompt Maestro Twilio ↔ ElevenLabs Bridge

Microservicio que conecta Twilio (WhatsApp, SMS, FB Messenger) con agentes de ElevenLabs Conversational AI.

## Arquitectura

```
Paciente (WhatsApp)
    ↓
Twilio (webhook POST)
    ↓
PM Bridge (este servicio)
  → Abre WebSocket a ElevenLabs en text-only mode
  → Envía mensaje del paciente
  → Recibe respuesta del agente (con RAG + Tools)
  → Responde a Twilio con TwiML
    ↓
Paciente recibe respuesta
```

## Endpoints

| Endpoint | Método | Uso |
|---|---|---|
| `/webhook/twilio-bridge` | POST | Webhook de Twilio (WhatsApp/SMS) |
| `/chat` | POST | API interna (llamada desde n8n o testing) |
| `/health` | GET | Health check con stats de sesiones activas |

## Session Management

- Cada conversación (doctor_id + patient_phone) tiene su propio WebSocket
- Sessions se cierran automáticamente después de 30 min de inactividad
- Multi-turno: el WebSocket se reutiliza entre mensajes del mismo paciente

## Deploy en Sliplane

1. Push este repo a GitHub
2. En Sliplane → New Service → seleccionar el repo
3. Configurar environment variables (ver `.env.example`)
4. Deploy

## Variables de entorno

Ver `.env.example` para la lista completa.

## Testing local

```bash
npm install
cp .env.example .env
# Editar .env con tus credenciales
npm run dev
```

Test con curl:
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Auth: pm-bridge-secret-2026" \
  -d '{"agent_id":"agent_7001kkf42e44f3ethezn15t0dh11","patient_phone":"+5213339657087","text":"Hola, quiero agendar una cita"}'
```
