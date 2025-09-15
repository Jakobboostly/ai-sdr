// setup-calendar-auth.js
import { google } from 'googleapis';
import http from 'http';
import url from 'url';
import open from 'open';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 8080;

// OAuth2 client setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,    
  process.env.GOOGLE_CLIENT_SECRET, 
  `http://localhost:${PORT}/auth/callback`
);

// Scopes needed for calendar access
const scopes = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
];

// Generate auth URL
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
  prompt: 'consent' // Forces consent screen to ensure refresh token
});

console.log('\n📋 Starting authorization process...');
console.log('Browser should open automatically.');
console.log('\nIf it doesn\'t, manually visit this URL:');
console.log(authUrl);
console.log('\n');

// Start local server to receive callback
const server = http.createServer(async (req, res) => {
  const queryObject = url.parse(req.url, true).query;
  
  if (queryObject.code) {
    console.log('✅ Authorization code received!');
    
    try {
      // Exchange code for tokens
      const { tokens } = await oauth2Client.getToken(queryObject.code);
      
      console.log('\n' + '='.repeat(60));
      console.log('🎉 SUCCESS! Add this to your .env file:');
      console.log('='.repeat(60) + '\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\n' + '='.repeat(60) + '\n');
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head>
            <title>Authorization Success</title>
          </head>
          <body style="font-family: Arial; padding: 50px; text-align: center; background: #f0f0f0;">
            <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h1 style="color: #22c55e;">✅ Success!</h1>
              <p>Authorization complete for Jakob's calendar.</p>
              <p style="color: #666;">Check your terminal for the refresh token.</p>
              <p style="margin-top: 30px; color: #999;">You can close this window.</p>
            </div>
          </body>
        </html>
      `);
      
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 2000);
      
    } catch (error) {
      console.error('❌ Error exchanging code for tokens:', error);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h1>Error - check terminal for details</h1>');
      server.close();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Local server ready on http://localhost:${PORT}`);
  console.log('Opening browser...\n');
  
  // Open browser automatically
  open(authUrl).catch(() => {
    console.log('Could not open browser automatically.');
    console.log('Please visit the URL above manually.');
  });
});