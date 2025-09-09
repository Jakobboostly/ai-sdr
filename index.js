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
  OPENAI_REALTIME_MODEL = 'gpt-realtime-2025-08-28', // <- your requested default
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_BASE_URL,
  PORT = 10000,
  VOICE = 'sol',
  TWILIO_VALIDATE_SIGNATURE = 'true', // <- default on
  LOG_LEVEL = 'info', // debug | info | warn | error
} = process.env;

const REQUIRED = {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_BASE_URL,
};
const missing = Object.entries(REQUIRED).filter(([,v]) => !v).map(([k]) => k);
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
const MAX_CALL_SECONDS = 170;             // soft wrap-up < 3 minutes
const OPENAI_REALTIME_URL =
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;

/* ============================
 * Lightweight JSON logger
 * ============================ */
const LEVELS = ['debug', 'info', 'warn', 'error'];
function shouldLog(level){ return LEVELS.indexOf(level) >= LEVELS.indexOf(LOG_LEVEL); }
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

fastify.setErrorHandler((error, request, reply) => {
  jlog('error', 'Unhandled route error', {
    method: request.method,
    url: request.url,
    err: error,
  });
  reply.status(error.statusCode || 500).send({
    success: false,
    message: 'Server error occurred',
    detail: error.message,
  });
});

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
  // Convert https://... -> wss://..., http://... -> ws://...
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

    // Twilio signs the full URL used for the webhook (including query string).
    const fullUrl = `${PUBLIC_BASE_URL}${request.raw.url}`;
    const params = request.method === 'POST' ? (request.body || {}) : {};
    const ok = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, params);

    if (!ok) {
      jlog('warn', 'Twilio signature validation failed', {
        fullUrl, method: request.method, headers: request.headers,
      });
    }
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
  reply.send({ message: 'Boostly AI SDR is running!' });
});

fastify.post('/make-call', async (request, reply) => {
  const { to, name, company } = request.body || {};
  if (!to || !name || !company) {
    return reply.status(400).send({ success: false, error: 'Required fields: to, name, company' });
  }

  try {
    const callId = generateCallId();
    const twimlUrl = getPublicUrl(`/outbound-answer?callId=${encodeURIComponent(callId)}`);
    const statusUrl = getPublicUrl(`/call-status?callId=${encodeURIComponent(callId)}`);

    jlog('info', 'Creating Twilio outbound call', { to, name, company, callId, twimlUrl, statusUrl });

    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      url: twimlUrl,
      statusCallback: statusUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      machineDetection: 'Enable', // optional AMD
    });

    activeCallSessions.set(callId, { name, company, to, callSid: call.sid });

    jlog('info', 'Twilio call created', { callSid: call.sid, callId });
    return reply.send({ success: true, callSid: call.sid, callId, message: `Calling ${name} at ${company}...` });
  } catch (err) {
    jlog('error', 'Failed to create Twilio call', { err });
    return reply.status(500).send({
      success: false,
      message: 'Failed to create outbound call',
      detail: err.message,
    });
  }
});

fastify.all('/outbound-answer', async (request, reply) => {
  if (!validateTwilioSignature(request)) {
    return reply.code(403).type('text/plain').send('Invalid Twilio signature');
  }

  const { callId } = request.query || {};
  if (!callId) {
    jlog('warn', 'Missing callId on outbound-answer');
  }
  const wsUrl = `${publicWsUrl()}/media-stream?callId=${encodeURIComponent(callId || '')}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
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
  const { CallStatus, CallSid, To, From, Timestamp } = request.body || {};
  const lead = activeCallSessions.get(callId);

  jlog('info', 'Call status update', {
    callId, CallStatus, CallSid, To, From, Timestamp, leadName: lead?.name, leadCompany: lead?.company,
  });

  const status = (CallStatus || '').toLowerCase();
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
    activeCallSessions.delete(callId);
    jlog('debug', 'Cleaned session on terminal status', { callId, status });
  }
  reply.send({ received: true });
});

/* ============================
 * Media Stream bridge (Twilio <-> OpenAI)
 * ============================ */
fastify.get('/media-stream', { websocket: true }, (connection, req) => {
  jlog('info', 'Twilio MediaStream connected');
  const { callId } = req.query || {};
  const lead = activeCallSessions.get(callId);
  jlog('debug', 'Lead context', { callId, lead });

  // Connect to OpenAI Realtime
  const oaWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let streamSid = null;
  let callSoftEndTimer = null;
  let silenceTimer = null;
  let heartbeat = null;

  function clearAllTimers() {
    if (callSoftEndTimer) clearTimeout(callSoftEndTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (heartbeat) clearInterval(heartbeat);
  }

  function scheduleSilenceCommit() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (oaWs.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        jlog('debug', 'Committed input audio buffer due to silence');
      }
    }, 600); // pairs nicely with server_vad
  }

  async function softEndCall() {
    try {
      if (oaWs.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({
          type: 'response.create',
          response: {
            instructions:
              "I'm going to let you run—I'll text over a quick summary and a link to pick a time that works. Thanks for the chat!",
          },
        }));
        jlog('info', 'Sent soft wrap-up message to caller');
      }
    } catch (err) {
      jlog('warn', 'Failed to send wrap-up message', { err });
    }
    try {
      const sid = lead?.callSid;
      if (sid) {
        await twilioClient.calls(sid).update({ status: 'completed' });
        jlog('info', 'Requested Twilio to complete call', { callSid: sid });
      }
    } catch (err) {
      jlog('warn', 'Failed to complete call via Twilio', { err });
    }
  }

  /* ===== OpenAI WS ===== */
  oaWs.on('open', () => {
    jlog('info', 'Connected to OpenAI Realtime');

    heartbeat = setInterval(() => {
      try { oaWs.ping(); } catch {}
    }, 15000);

    const opener = `Hey ${lead?.name || 'there'}! This is Kora from Boostly. You recently inquired about marketing services for ${lead?.company || 'your restaurant'}. Got a quick minute to chat?`;

    // Configure session
    oaWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: [
          `You are Kora from Boostly, an AI marketing assistant.`,
          `You're calling ${lead?.name || 'a lead'} from ${lead?.company || 'their restaurant'} who filled out a form about restaurant marketing services.`,
          `Be friendly, casual, and concise. Confirm if they are the owner or manager.`,
          `Ask about their current marketing (channels, budget, goals) and pain points.`,
          `Keep the call under ~3 minutes; if they’re busy, offer to schedule a follow-up.`,
        ].join(' '),
        audio: {
          input:  { format: 'g711_ulaw', sample_rate_hz: SAMPLE_RATE_HZ },
          output: { format: 'g711_ulaw', sample_rate_hz: SAMPLE_RATE_HZ, voice: VOICE },
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    }));

    // Initial greeting
    oaWs.send(JSON.stringify({ type: 'response.create', response: { instructions: opener } }));
    callSoftEndTimer = setTimeout(softEndCall, MAX_CALL_SECONDS * 1000);
  });

  oaWs.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); }
    catch (err) { jlog('warn', 'Failed to parse OpenAI message', { err }); return; }

    if (event.type === 'session.updated') jlog('debug', 'OpenAI session.updated');
    if (event.type === 'error') jlog('error', 'OpenAI error', { detail: event.error });

    // Stream audio back to Twilio
    if (event.type === 'response.audio.delta' && event.delta && streamSid) {
      connection.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: event.delta },
      }));
    }

    if (event.type === 'response.audio_transcript.done') {
      jlog('debug', 'AI said', { transcript: event.transcript });
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      jlog('debug', 'Caller said', { transcript: event.transcript });
    }
  });

  oaWs.on('close', (code, reason) => {
    jlog('warn', 'OpenAI WS closed', { code, reason: reason?.toString?.() });
    clearAllTimers();
    try { connection.close(); } catch {}
  });

  oaWs.on('error', (err) => {
    jlog('error', 'OpenAI WS error', { err });
    try { connection.close(); } catch {}
  });

  /* ===== Twilio WS ===== */
  connection.on('message', (twilioMessage) => {
    let msg;
    try { msg = JSON.parse(twilioMessage); }
    catch (err) { jlog('warn', 'Failed to parse Twilio WS message', { err }); return; }

    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid;
        jlog('info', 'Twilio stream started', { streamSid });
        break;
      case 'media':
        if (oaWs.readyState === WebSocket.OPEN) {
          oaWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload, // base64 μ-law 8k
          }));
          scheduleSilenceCommit();
        }
        break;
      case 'mark':
        // optional: markers if you need them
        break;
      case 'stop':
        jlog('info', 'Twilio stream stopped');
        clearAllTimers();
        try { oaWs.close(); } catch {}
        break;
      default:
        jlog('debug', 'Twilio WS event', { event: msg.event });
        break;
    }
  });

  connection.on('close', (code, reason) => {
    jlog('warn', 'Twilio WS closed', { code, reason: reason?.toString?.() });
    clearAllTimers();
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
  if (err) {
    jlog('error', 'Fastify failed to start', { err });
    process.exit(1);
  }
  jlog('info', 'Server listening', { address, model: OPENAI_REALTIME_MODEL, validateSignatures: isSigValidationOn() });
});
