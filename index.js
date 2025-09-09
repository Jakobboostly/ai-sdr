import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import twilio from 'twilio';

// Load environment variables
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

const VOICE = 'alloy';
const PORT = process.env.PORT || 10000;

const activeCallSessions = new Map();

function generateCallId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Root route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Boostly AI SDR is running!' });
});

// Make call endpoint
fastify.post('/make-call', async (request, reply) => {
    const { to, name, company } = request.body;
    
    if (!to || !name || !company) {
        return reply.status(400).send({ error: 'Required fields missing' });
    }
    
    try {
        const callId = generateCallId();
        activeCallSessions.set(callId, { name, company });
        
        const call = await twilioClient.calls.create({
            from: TWILIO_PHONE_NUMBER,
            to: to,
            url: `https://${request.headers.host}/outbound-answer?callId=${callId}`,
            statusCallback: `https://${request.headers.host}/call-status?callId=${callId}`
        });
        
        reply.send({ success: true, callSid: call.sid, message: `Calling ${name}...` });
    } catch (error) {
        console.error('Call error:', error);
        reply.status(500).send({ error: error.message });
    }
});

// Answer handler
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

// Status callback
fastify.post('/call-status', async (request, reply) => {
    const callId = request.query.callId;
    const leadData = activeCallSessions.get(callId);
    console.log(`Call to ${leadData?.name} (${request.body.To}): ${request.body.CallStatus}`);
    reply.send({ received: true });
});

// WebSocket handler - USING EXACT OPENAI DOCUMENTATION FORMAT
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected to Twilio stream');
        const callId = req.query.callId;
        const leadData = activeCallSessions.get(callId);
        console.log(`Call data: ${leadData?.name} at ${leadData?.company}`);
        
        // Connect to OpenAI using EXACT format from their docs
        const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
        const ws = new WebSocket(url, {
            headers: {
                Authorization: "Bearer " + OPENAI_API_KEY,
            }
        });
        
        let streamSid = null;

        // OpenAI WebSocket opened
        ws.on('open', function open() {
            console.log('Connected to OpenAI Realtime server');
            
            // Send session configuration (as shown in OpenAI docs)
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    type: 'realtime',
                    instructions: `You are Kora from Boostly, an AI marketing assistant. You're calling ${leadData?.name} from ${leadData?.company} who filled out a form about restaurant marketing services. 
                    
Start immediately by saying: "Hey ${leadData?.name}! This is Kora from Boostly. You recently inquired about marketing services for ${leadData?.company}. Got a quick minute to chat?"

Be friendly, casual, and conversational. Ask them about their current marketing and if they're the owner.`,
                    voice: VOICE,
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500
                    }
                }
            }));
            
            // Trigger initial response
            setTimeout(() => {
                ws.send(JSON.stringify({
                    type: 'response.create'
                }));
                console.log('Triggered AI to speak');
            }, 500);
        });

        // Listen for messages from OpenAI (as shown in docs)
        ws.on('message', function incoming(message) {
            try {
                const event = JSON.parse(message.toString());
                
                // Log event types for debugging
                if (event.type === 'session.created' || event.type === 'session.updated') {
                    console.log('Session event:', event.type);
                }
                
                if (event.type === 'error') {
                    console.error('OpenAI Error:', event.error);
                }
                
                if (event.type === 'response.created') {
                    console.log('AI is preparing to speak');
                }
                
                if (event.type === 'response.done') {
                    console.log('AI finished speaking');
                }
                
                // Handle audio data from OpenAI
                if (event.type === 'response.audio.delta' && event.delta) {
                    // Send audio to Twilio
                    const audioMessage = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { 
                            payload: event.delta 
                        }
                    };
                    connection.send(JSON.stringify(audioMessage));
                }
                
                // Log transcripts for debugging
                if (event.type === 'response.audio_transcript.done') {
                    console.log('AI said:', event.transcript);
                }
                
                if (event.type === 'conversation.item.input_audio_transcription.completed') {
                    console.log('Caller said:', event.transcript);
                }
                
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (twilioMessage) => {
            try {
                const data = JSON.parse(twilioMessage);
                
                if (data.event === 'start') {
                    streamSid = data.start.streamSid;
                    console.log('Twilio stream started:', streamSid);
                    
                } else if (data.event === 'media') {
                    // Send audio to OpenAI
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        }));
                    }
                    
                } else if (data.event === 'stop') {
                    console.log('Twilio stream stopped');
                }
                
            } catch (error) {
                console.error('Error processing Twilio message:', error);
            }
        });

        // Handle Twilio disconnect
        connection.on('close', () => {
            console.log('Twilio disconnected');
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });

        // Handle OpenAI disconnect
        ws.on('close', () => {
            console.log('OpenAI disconnected');
        });

        // Handle errors
        ws.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });
    });
});

// Start server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server listening on port ${PORT}`);
});
