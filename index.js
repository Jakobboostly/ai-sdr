import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import twilio from 'twilio';

dotenv.config();

const { OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('Missing required environment variables');
    process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, { origin: true });

const PORT = process.env.PORT || 5050;
const activeCallSessions = new Map();

function generateCallId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Boostly AI SDR is running!' });
});

fastify.post('/make-call', async (request, reply) => {
    const { to, name, company } = request.body;
    
    if (!to || !name || !company) {
        return reply.status(400).send({ error: 'Required: phone, name, company' });
    }
    
    try {
        const callId = generateCallId();
        activeCallSessions.set(callId, { name, company });
        
        const call = await twilioClient.calls.create({
            from: TWILIO_PHONE_NUMBER,
            to: to,
            url: `https://${request.headers.host}/outbound-answer?callId=${callId}`,
            timeout: 30
        });
        
        reply.send({ success: true, callSid: call.sid, message: `Calling ${name}...` });
    } catch (error) {
        console.error('Error:', error);
        reply.status(500).send({ error: error.message });
    }
});

fastify.all('/outbound-answer', async (request, reply) => {
    const callId = request.query.callId;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
                  <Response>
                      <Connect>
                          <Stream url="wss://${request.headers.host}/media-stream?callId=${callId}" />
                      </Connect>
                  </Response>`;
    reply.type('text/xml').send(twiml);
});

// SIMPLIFIED WEBSOCKET HANDLER
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('=== NEW CALL CONNECTED ===');
        const callId = req.query.callId;
        const leadData = activeCallSessions.get(callId);
        
        let streamSid = null;
        
        // Connect to OpenAI
        console.log('Connecting to OpenAI...');
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });
        
        openAiWs.on('open', () => {
            console.log('✓ Connected to OpenAI');
            
            // Simple session config
            const config = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: 'You are Kora. Say hello to ' + leadData?.name + ' and ask how you can help them today. Keep it very brief.',
                    voice: 'alloy',
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    turn_detection: { type: 'server_vad' }
                }
            };
            
            console.log('Sending config to OpenAI...');
            openAiWs.send(JSON.stringify(config));
        });
        
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                console.log('OpenAI says:', response.type);
                
                if (response.type === 'error') {
                    console.error('❌ OPENAI ERROR:', response.error);
                }
                
                if (response.type === 'session.created') {
                    console.log('✓ Session created successfully');
                }
                
                if (response.type === 'response.audio.delta' && response.delta) {
                    // Send audio to phone
                    const msg = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(msg));
                }
            } catch (error) {
                console.error('Parse error:', error);
            }
        });
        
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    streamSid = data.start.streamSid;
                    console.log('✓ Call started');
                } else if (data.event === 'media' && openAiWs.readyState === WebSocket.OPEN) {
                    // Send caller audio to OpenAI
                    openAiWs.send(JSON.stringify({
                        type: 'input_audio_buffer.append',
                        audio: data.media.payload
                    }));
                }
            } catch (error) {
                console.error('Twilio error:', error);
            }
        });
        
        connection.on('close', () => {
            console.log('Call ended');
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        });
        
        openAiWs.on('error', (error) => {
            console.error('❌ WebSocket Error:', error.message);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server running on port ${PORT}`);
});
