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
  VOICE = 'sol',          // preferred
  TWILIO_VALIDATE_SIGNATURE = 'true',
  LOG_LEVEL = 'info',
} = process.env;

const FALLBACK_VOICE = 'alloy';  // fallback if sol isn’t available

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

const SAMPLE_RATE_HZ = 8000;              // Twilio Media Streams are 8k μ-law
const MAX_CALL_SECONDS = 170;
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
const activeCallSessions = new Map();

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

/* ============================
 * Routes
 * ============================ */
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
      url: getPublicUrl(`/outbound-answer?callId=${callId}`),
      statusCallback: getPublicUrl(`/call-status?callId=${callId}`),
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
  const { callId } = request.query || {};
  const wsUrl = `${publicWsUrl()}/media-stream?callId=${encodeURIComponent(callId)}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

fastify.post('/call-status', async (request, reply) => {
  const { callId } = request.query || {};
  const { CallStatus, CallSid } = request.body || {};
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes((CallStatus || '').toLowerCase())) {
    activeCallSessions.delete(callId);
  }
  jlog('info', 'Call status update', { callId, CallStatus, CallSid });
  reply.send({ received: true });
});

/* ============================
 * Media Stream bridge
 * ============================ */
fastify.get('/media-stream', { websocket: true }, (connection, req) => {
  const { callId } = req.query || {};
  const lead = activeCallSessions.get(callId);
  jlog('info', 'Twilio stream connected', { callId, lead });

  const oaWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let streamSid = null;
  let callSoftEndTimer;

  function clearTimers() {
    if (callSoftEndTimer) clearTimeout(callSoftEndTimer);
  }

  function sendSessionUpdate(voiceChoice) {
  oaWs.send(JSON.stringify({
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      voice: voiceChoice,
-     input_audio_format:  { type: 'g711_ulaw', sample_rate_hz: SAMPLE_RATE_HZ },
-     output_audio_format: { type: 'g711_ulaw', sample_rate_hz: SAMPLE_RATE_HZ },
+     input_audio_format:  'g711_ulaw',
+     output_audio_format: 'g711_ulaw',
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
      instructions: `You are Kora from Boostly, an AI marketing assistant. Call ${lead?.name} from ${lead?.company}. Be friendly, casual, under 3 minutes.`,
    },
  }));
}


  oaWs.on('open', () => {
    jlog('info', 'Connected to OpenAI Realtime');
    sendSessionUpdate(VOICE);

    // opener
    oaWs.send(JSON.stringify({
      type: 'response.create',
      response: { modalities: ['audio','text'], instructions: `Hey ${lead?.name}! This is Kora from Boostly. You recently inquired about marketing services for ${lead?.company}. Got a quick minute to chat?` },
    }));

    callSoftEndTimer = setTimeout(() => {
      oaWs.send(JSON.stringify({
        type: 'response.create',
        response: { modalities: ['audio','text'], instructions: "I'll send you a quick follow-up by text. Thanks for your time!" },
      }));
    }, MAX_CALL_SECONDS * 1000);
  });

  oaWs.on('message', raw => {
    let event;
    try { event = JSON.parse(raw.toString()); }
    catch { return; }

    if (event.type === 'error') {
      jlog('error', 'OpenAI error', { detail: event.error });
      if (event.error?.param === 'session.voice' && VOICE === 'sol') {
        jlog('warn', 'Retrying with alloy voice');
        sendSessionUpdate(FALLBACK_VOICE);
      }
    }
    if (event.type === 'response.audio.delta' && event.delta && streamSid) {
      connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
    }
  });

  connection.on('message', twilioMessage => {
    const msg = JSON.parse(twilioMessage);
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
    } else if (msg.event === 'media') {
      oaWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
    } else if (msg.event === 'stop') {
      clearTimers(); oaWs.close();
    }
  });
});

/* ============================
 * Start server
 * ============================ */
fastify.listen({ port: Number(PORT), host: '0.0.0.0' }, (err, address) => {
  if (err) { jlog('error', 'Failed to start', { err }); process.exit(1); }
  jlog('info', 'Server listening', { address, model: OPENAI_REALTIME_MODEL });
});
