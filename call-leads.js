import fetch from 'node-fetch';

// Your deployed Render URL (you'll get this after deployment)
const API_URL = 'https://boostly-ai-sdr.onrender.com';

// Your leads
const leads = [
    { 
        phone: '+1234567890', 
        name: 'John', 
        company: 'Pizza Palace',
        email: 'john@pizzapalace.com'
    },
    // Add more leads here
];

async function callLead(lead) {
    try {
        const response = await fetch(`${API_URL}/make-call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: lead.phone,
                name: lead.name,
                company: lead.company,
                email: lead.email
            })
        });
        
        const result = await response.json();
        console.log(`Calling ${lead.name}:`, result.message);
        
    } catch (error) {
        console.error(`Failed to call ${lead.name}:`, error.message);
    }
}

// Call all leads with 10 second delay between calls
async function callAllLeads() {
    for (const lead of leads) {
        await callLead(lead);
        // Wait 10 seconds between calls
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
}

// Start calling
console.log('Starting calls to leads...');
callAllLeads();