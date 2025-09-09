// server.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import twilio from 'twilio';

dotenv.config();

/* ============================
 * Env & constants
 * ============================ */
const {
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL = 'gpt-realtime-2025-08-28',
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_BASE_URL,
  PORT = 10000,
  VOICE = 'coral',                 // default voice
  TWILIO_VALIDATE_SIGNATURE = 'true',
  LOG_LEVEL = 'info',              // debug | info | warn | error
} = process.env;

const FALLBACK_VOICE = 'alloy';    // fallback if coral isn’t available

const REQUIRED = {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_BASE_URL,
};
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    msg: 'Missing required env vars',
    missing,
  }));
  process.exit(1);
}

const MAX_CALL_SECONDS = 170; // soft wrap-up < 3 minutes
const OPENAI_REALTIME_URL =
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;

/* ============================
 * Logger
 * ============================ */
const LEVELS = ['debug', 'info', 'warn', 'error'];
function shouldLog(level) { return LEVELS.indexOf(level) >= LEVELS.indexOf(LOG_LEVEL); }
function jlog(level, msg, extra = {}) {
  if (!shouldLog(level)) return;
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  if (extra.err instanceof Error) {
    line.err = { message: extra.err.message, stack: extra.err.stack };
  }
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

/* ============================
 * Fastify setup
 * ============================ */
const fastify = Fastify({ logger: false });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);
await fastify.register(fastifyCors, { origin: true });

/* ============================
 * Twilio client & helpers
 * ============================ */
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const activeCallSessions = new Map(); // callId -> { name, company, to, callSid }

function generateCallId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function getPublicUrl(pathAndQuery) {
  return `${PUBLIC_BASE_URL}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
}
function publicWsUrl() {
  return PUBLIC_BASE_URL.startsWith('https://')
    ? PUBLIC_BASE_URL.replace('https://', 'wss://')
    : PUBLIC_BASE_URL.replace('http://', 'ws://');
}
function isSigValidationOn() {
  return (TWILIO_VALIDATE_SIGNATURE || '').toString().toLowerCase() === 'true';
}
function validateTwilioSignature(request) {
  if (!isSigValidationOn()) return true;
  try {
    const signature = request.headers['x-twilio-signature'];
    if (!signature) return false;
    const fullUrl = `${PUBLIC_BASE_URL}${request.raw.url}`; // includes path & query
    const params = request.method === 'POST' ? (request.body || {}) : {};
    const ok = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, params);
    if (!ok) jlog('warn', 'Twilio signature validation failed', { fullUrl });
    return ok;
  } catch (err) {
    jlog('error', 'Twilio signature validation error', { err });
    return false;
  }
}

/* ============================
 * Routes
 * ============================ */
fastify.get('/', async (_req, reply) => {
  reply.send({ ok: true, msg: 'Boostly AI SDR is running' });
});

fastify.post('/make-call', async (request, reply) => {
  const { to, name, company } = request.body || {};
  if (!to || !name || !company) {
    return reply.status(400).send({ success: false, error: 'Required fields: to, name, company' });
  }
  try {
    const callId = generateCallId();
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      url: getPublicUrl(`/outbound-answer?callId=${encodeURIComponent(callId)}`),
      statusCallback: getPublicUrl(`/call-status?callId=${encodeURIComponent(callId)}`),
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });
    activeCallSessions.set(callId, { name, company, to, callSid: call.sid });
    jlog('info', 'Call created', { callSid: call.sid, callId });
    return reply.send({ success: true, callSid: call.sid, callId, message: `Calling ${name}...` });
  } catch (err) {
    jlog('error', 'Call creation failed', { err });
    return reply.status(500).send({ success: false, message: err.message });
  }
});

fastify.all('/outbound-answer', async (request, reply) => {
  if (!validateTwilioSignature(request)) {
    return reply.code(403).type('text/plain').send('Invalid Twilio signature');
  }
  const { callId } = request.query || {};
  // IMPORTANT: Twilio does NOT support query strings on <Stream url>. Use <Parameter>.
  // We’ll pass callId as a Parameter below and read it from start.customParameters. :contentReference[oaicite:1]{index=1}
  const wsUrl = `${publicWsUrl()}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callId" value="${callId || ''}"/>
    </Stream>
  </Connect>
</Response>`;

  jlog('debug', 'Responding TwiML for outbound-answer', { callId, wsUrl });
  reply.type('text/xml').send(twiml);
});

fastify.post('/call-status', async (request, reply) => {
  if (!validateTwilioSignature(request)) {
    return reply.code(403).type('text/plain').send('Invalid Twilio signature');
  }
  const { callId } = request.query || {};
  const { CallStatus, CallSid, To } = request.body || {};
  const status = (CallStatus || '').toLowerCase();
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
    activeCallSessions.delete(callId);
  }
  jlog('info', 'Call status update', { callId, CallStatus, CallSid, To });
  reply.send({ received: true });
});

/* ============================
 * Media Stream bridge (Twilio <-> OpenAI)
 * ============================ */
fastify.get('/media-stream', { websocket: true }, (connection) => {
  jlog('info', 'Twilio stream connected');

  const oaWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let streamSid = null;
  let callSoftEndTimer = null;
  let sessionReady = false;
  let callIdFromTwilio = null;
  const pendingAudio = []; // buffer OA deltas until Twilio streamSid exists
  let twilioMediaFramesIn = 0;
  let oaAudioFramesOut = 0;

  function clearTimers() {
    if (callSoftEndTimer) clearTimeout(callSoftEndTimer);
  }

  function sendSessionUpdate(voiceChoice, lead) {
    oaWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],   // required for audio responses
        voice: voiceChoice,               // if rejected -> retry with alloy
        input_audio_format: 'g711_ulaw',  // μ-law 8k
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        instructions: [
          `You are Kora from Boostly, an AI marketing assistant.`,
          `You're calling ${lead?.name || 'a lead'} from ${lead?.company || 'their restaurant'} who requested marketing help.`,
          `Be friendly, casual, concise. Confirm owner/manager; ask about current marketing & goals.`,
          `Keep under ~3 minutes; offer to schedule if they’re busy.`,
        ].join(' '),
      },
    }));
  }

  // ---------- OpenAI WS ----------
  oaWs.on('open', () => {
    jlog('info', 'Connected to OpenAI Realtime');
    // We’ll send the session.update once we know the lead from callId (after Twilio start)
  });

  oaWs.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch (err) {
      jlog('warn', 'Failed to parse OpenAI message', { err });
      return;
    }

    if (evt.type === 'session.updated') {
      if (!sessionReady) {
        sessionReady = true;
        jlog('info', 'OpenAI session updated — sending opener');
        const lead = activeCallSessions.get(callIdFromTwilio);
        const opener = `Hey ${lead?.name || 'there'}! This is Kora from Boostly. You recently inquired about marketing for ${lead?.company || 'your restaurant'}. Got a quick minute to chat?`;
        oaWs.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio', 'text'], instructions: opener },
        }));
        callSoftEndTimer = setTimeout(() => {
          oaWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities: ['audio', 'text'], instructions: "I'll text a quick follow-up. Thanks for your time!" },
          }));
        }, MAX_CALL_SECONDS * 1000);
      }
      return;
    }

    if (evt.type === 'error') {
      jlog('error', 'OpenAI error', { detail: evt.error });
      if (evt.error?.param === 'session.voice' && VOICE !== FALLBACK_VOICE) {
        jlog('warn', `Voice '${VOICE}' unavailable — retrying with '${FALLBACK_VOICE}'`);
        const lead = activeCallSessions.get(callIdFromTwilio);
        sendSessionUpdate(FALLBACK_VOICE, lead);
      }
      return;
    }

    if (evt.type === 'response.audio.delta' && evt.delta) {
      oaAudioFramesOut++;
      if (streamSid) {
        connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: evt.delta } }));
      } else {
        pendingAudio.push(evt.delta);
      }
      if (oaAudioFramesOut <= 3 || oaAudioFramesOut % 100 === 0) {
        jlog('debug', 'OA → Twilio audio frame', { oaAudioFramesOut, buffered: pendingAudio.length, hasStreamSid: !!streamSid });
      }
      return;
    }

    if (evt.type === 'response.created') jlog('debug', 'OpenAI response.created', { id: evt.response?.id });
    if (evt.type === 'response.output_text.delta') jlog('debug', 'OpenAI text delta', { len: evt.delta?.length });
    if (evt.type === 'response.output_text.done') jlog('debug', 'OpenAI text done');
  });

  oaWs.on('close', (code, reason) => {
    jlog('warn', 'OpenAI WS closed', { code, reason: reason?.toString?.() });
    clearTimers();
    try { connection.close(); } catch {}
  });

  oaWs.on('error', (err) => {
    jlog('error', 'OpenAI WS error', { err });
    try { connection.close(); } catch {}
  });

  // ---------- Twilio WS ----------
  connection.on('message', (twilioMessage) => {
    let raw, msg;
    try {
      raw = typeof twilioMessage === 'string' ? twilioMessage : twilioMessage.toString('utf8');
      msg = JSON.parse(raw);
    } catch (err) {
      jlog('error', 'Failed to parse Twilio WS message', { err, sample: raw ? raw.slice(0, 200) : '<no raw>' });
      return;
    }

    switch (msg.event) {
      case 'connected':
        jlog('info', 'Twilio WS event: connected');
        break;

      case 'start': {
        streamSid = msg.start.streamSid;
        // Pull our callId from customParameters
        callIdFromTwilio = msg.start?.customParameters?.callId || null;
        const lead = activeCallSessions.get(callIdFromTwilio);
        jlog('info', 'Twilio stream started', { streamSid, callIdFromTwilio, leadFound: !!lead });

        // Now that we know the lead, configure OpenAI session
        if (oaWs.readyState === WebSocket.OPEN) {
          sendSessionUpdate(VOICE, lead);
        }

        // flush buffered audio from OpenAI (if any arrived early)
        if (pendingAudio.length) {
          jlog('debug', `Flushing ${pendingAudio.length} buffered audio frames to Twilio`);
          for (const delta of pendingAudio) {
            connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: delta } }));
          }
          pendingAudio.length = 0;
        }
        break;
      }

      case 'media':
        twilioMediaFramesIn++;
        if (oaWs.readyState === WebSocket.OPEN) {
          oaWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
        }
        if (twilioMediaFramesIn <= 3 || twilioMediaFramesIn % 100 === 0) {
          jlog('debug', 'Twilio → OA media frame', { twilioMediaFramesIn });
        }
        break;

      case 'mark':
        jlog('debug', 'Twilio mark', { label: msg.mark?.name });
        break;

      case 'stop':
        jlog('info', 'Twilio stream stopped');
        clearTimers();
        try { oaWs.close(); } catch {}
        break;

      default:
        jlog('debug', 'Twilio WS event (other)', { event: msg.event });
        break;
    }
  });

  connection.on('close', () => {
    clearTimers();
    try { oaWs.close(); } catch {}
  });

  connection.on('error', (err) => {
    jlog('error', 'Twilio WS error', { err });
  });
});

/* ============================
 * Start server
 * ============================ */
fastify.listen({ port: Number(PORT), host: '0.0.0.0' }, (err, address) => {
  if (err) { jlog('error', 'Failed to start', { err }); process.exit(1); }
  jlog('info', 'Server listening', {
    address,
    model: OPENAI_REALTIME_MODEL,
    voice: VOICE,
    fallback: FALLBACK_VOICE,
    validateSignatures: isSigValidationOn(),
  });
});
