import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import twilio from 'twilio';

// Load environment variables
dotenv.config();

// Check for required environment variables
const { OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('Missing required environment variables. Please check your .env file.');
    process.exit(1);
}

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const fastify = Fastify();
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);
await fastify.register(fastifyCors, {
    origin: true,
    credentials: true
});

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 10000;

// Store active calls
const activeCallSessions = new Map();

// Generate unique call ID
function generateCallId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Root route - health check
fastify.get('/', async (request, reply) => {
    return { message: 'Boostly AI SDR is running!' };
});

// Endpoint to trigger outbound calls
fastify.post('/make-call', async (request, reply) => {
    try {
        const { to, name, company, email } = request.body;
        
        if (!to || !name || !company) {
            return reply.status(400).send({ 
                error: 'Required: phone number (to), name, and company' 
            });
        }
        
        const callId = generateCallId();
        
        // Store lead data
        activeCallSessions.set(callId, {
            name,
            company,
            email: email || '',
            phoneNumber: to
        });
        
        // Make the call
        const call = await twilioClient.calls.create({
            from: TWILIO_PHONE_NUMBER,
            to: to,
            url: `https://${request.headers.host}/outbound-answer?callId=${callId}`,
            statusCallback: `https://${request.headers.host}/call-status?callId=${callId}`,
            timeout: 30
        });
        
        return { 
            success: true, 
            callSid: call.sid,
            message: `Calling ${name} at ${company}...`
        };
        
    } catch (error) {
        console.error('Error making call:', error);
        return reply.status(500).send({ error: 'Failed to initiate call: ' + error.message });
    }
});

// Handle outbound call when answered
fastify.all('/outbound-answer', async (request, reply) => {
    const callId = request.query.callId;
    
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream?callId=${callId}" />
                              </Connect>
                          </Response>`;
    
    reply.type('text/xml').send(twimlResponse);
});

// Handle call status updates
fastify.post('/call-status', async (request, reply) => {
    const { CallSid, CallStatus, To } = request.body;
    const callId = request.query.callId;
    const leadData = activeCallSessions.get(callId);
    
    console.log(`Call to ${leadData?.name} (${To}): ${CallStatus}`);
    
    if (CallStatus === 'completed') {
        setTimeout(() => {
            activeCallSessions.delete(callId);
        }, 60000);
    }
    
    return { received: true };
});

// WebSocket for media streaming
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        const callId = req.query.callId;
        const leadData = activeCallSessions.get(callId);
        
        console.log(`Call connected: ${leadData?.name} at ${leadData?.company}`);
        
        // Connect to OpenAI
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });
        
        let streamSid = null;
        
        // OpenAI connection opened
        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            
            // Send configuration
            const sessionConfig = {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: `You are Kora from Boostly. Say hello to ${leadData?.name} and tell them you're calling about their interest in marketing services for ${leadData?.company}. Be friendly and casual.`,
                    voice: VOICE,
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 200
                    }
                }
            };
            
            openAiWs.send(JSON.stringify(sessionConfig));
        });
        
        // Handle OpenAI messages
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                if (response.type === 'error') {
                    console.error('OpenAI error:', response.error);
                }
                
                // Send audio to caller
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioData = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(audioData));
                }
                
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });
        
        // Handle Twilio messages
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    streamSid = data.start.streamSid;
                    console.log('Stream started:', streamSid);
                } else if (data.event === 'media') {
                    // Send audio to OpenAI
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        const audioData = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openAiWs.send(JSON.stringify(audioData));
                    }
                }
            } catch (error) {
                console.error('Error processing Twilio message:', error);
            }
        });
        
        // Cleanup on disconnect
        connection.on('close', () => {
            console.log('Call disconnected');
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
        });
        
        openAiWs.on('close', () => {
            console.log('OpenAI disconnected');
        });
        
        openAiWs.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });
    });
});

// Start server
try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Boostly AI SDR running on port ${PORT}`);
} catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
}
