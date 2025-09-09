import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import twilio from 'twilio';

dotenv.config();

// Environment variables
const {
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL = 'gpt-realtime-2025-08-28',
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_BASE_URL = 'https://ai-sdr-7v9s.onrender.com',
  PORT = 10000,
  VOICE = 'sol',
} = process.env;

// Check required vars
if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const fastify = Fastify({ logger: false });

await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);
await fastify.register(fastifyCors, { origin: true });

const activeCallSessions = new Map();

function generateCallId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Routes
fastify.get('/', async (req, reply) => {
  reply.send({ ok: true, msg: 'Boostly AI SDR is running' });
});

fastify.post('/make-call', async (request, reply) => {
  const { to, name, company } = request.body || {};
  if (!to || !name || !company) {
    return reply.status(400).send({ error: 'Required: to, name, company' });
  }
  
  try {
    const callId = generateCallId();
    activeCallSessions.set(callId, { name, company, to });
    
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      url: `${PUBLIC_BASE_URL}/outbound-answer?callId=${callId}`,
      statusCallback: `${PUBLIC_BASE_URL}/call-status?callId=${callId}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });
    
    console.log(`Call created: ${call.sid} for ${name}`);
    return reply.send({ success: true, callSid: call.sid, callId, message: `Calling ${name}...` });
  } catch (err) {
    console.error('Call creation failed:', err);
    return reply.status(500).send({ error: err.message });
  }
});

fastify.all('/outbound-answer', async (request, reply) => {
  const { callId } = request.query;
  console.log('Outbound answer for callId:', callId);
  
  const wsUrl = `wss://ai-sdr-7v9s.onrender.com/media-stream?callId=${callId}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`;
  
  reply.type('text/xml').send(twiml);
});

fastify.post('/call-status', async (request, reply) => {
  const { CallStatus, CallSid } = request.body || {};
  const { callId } = request.query;
  console.log(`Call status: ${CallStatus} for ${CallSid}`);
  
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    activeCallSessions.delete(callId);
  }
  
  reply.send({ received: true });
});

// WebSocket handler - FIXED
fastify.get('/media-stream', { websocket: true }, (connection, req) => {
  const { callId } = req.query || {};
  const lead = activeCallSessions.get(callId);
  
  console.log('=== TWILIO WEBSOCKET CONNECTED ===');
  console.log('CallId:', callId);
  console.log('Lead:', lead);
  
  // Connect to OpenAI
  const openAiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const oaWs = new WebSocket(openAiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });
  
  let streamSid = null;
  const pendingAudio = [];
  
  // OpenAI connection
  oaWs.on('open', () => {
    console.log('Connected to OpenAI');
    
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        voice: VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        instructions: `You are Kora from Boostly. You're calling ${lead?.name || 'a potential client'} from ${lead?.company || 'their restaurant'}. Start by saying: "Hey ${lead?.name || 'there'}! This is Kora from Boostly. You recently inquired about marketing services for ${lead?.company || 'your restaurant'}. Got a quick minute to chat?" Be friendly and casual.`,
      },
    };
    
    oaWs.send(JSON.stringify(sessionUpdate));
  });
  
  oaWs.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      
      if (event.type === 'session.updated') {
        console.log('Session updated, sending greeting');
        oaWs.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio', 'text'] }
        }));
      }
      
      if (event.type === 'error') {
        console.error('OpenAI error:', event.error);
      }
      
      if (event.type === 'response.audio.delta' && event.delta) {
        if (streamSid) {
          // FIXED: Use connection.socket.send()
          connection.socket.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: event.delta }
          }));
        } else {
          pendingAudio.push(event.delta);
          if (pendingAudio.length === 1 || pendingAudio.length % 10 === 0) {
            console.log(`Buffering: ${pendingAudio.length} frames`);
          }
        }
      }
      
      if (event.type === 'response.done') {
        console.log('AI finished');
      }
    } catch (err) {
      console.error('OpenAI parse error:', err);
    }
  });
  
  // FIXED: Handle Twilio messages on connection.socket
  connection.socket.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      
      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid;
        console.log('✅ GOT STREAM START! streamSid:', streamSid);
        
        // Flush buffered audio
        if (pendingAudio.length > 0) {
          console.log(`Sending ${pendingAudio.length} buffered frames`);
          pendingAudio.forEach(delta => {
            connection.socket.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: delta }
            }));
          });
          pendingAudio.length = 0;
        }
      } else if (msg.event === 'media') {
        if (oaWs.readyState === WebSocket.OPEN) {
          oaWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
          }));
        }
      } else if (msg.event === 'stop') {
        console.log('Stream stopped');
        oaWs.close();
      }
    } catch (err) {
      console.error('Twilio message error:', err);
    }
  });
  
  // Cleanup
  connection.socket.on('close', () => {
    console.log('Twilio closed');
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
  
  oaWs.on('close', () => {
    console.log('OpenAI closed');
  });
  
  oaWs.on('error', (err) => {
    console.error('OpenAI error:', err);
  });
});

// Start server
fastify.listen({ port: Number(PORT), host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
  console.log(`Server running on port ${PORT}`);
  console.log(`Model: ${OPENAI_REALTIME_MODEL}`);
  console.log(`Voice: ${VOICE}`);
});
