const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');
require('dotenv').config();
 
const app = express();
app.use(express.json());
app.use(cors({
  origin: 'https://www.pathtopossibilities.co.uk', // your real Squarespace domain
  methods: ['POST'],
}));
 
// ---------------- CONFIG ----------------
// Use api.staging.justgiving.com while testing, api.justgiving.com once live
const JG_API_BASE = process.env.JUSTGIVING_API_BASE || 'https://api.staging.justgiving.com';
const JG_APP_ID = process.env.JUSTGIVING_APP_ID;
const JG_CHARITY_ID = process.env.JUSTGIVING_CHARITY_ID;
const JG_EVENT_ID = process.env.JUSTGIVING_EVENT_ID; // optional
const JG_CAMPAIGN_GUID = process.env.JUSTGIVING_CAMPAIGN_GUID; // optional
const FUNDRAISING_TARGET = "500"; // suggested GBP target, adjust as needed
 
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_CONVERSIONS_API_TOKEN;

console.log('META CONFIG:', {
  pixelId: META_PIXEL_ID ? 'SET' : 'MISSING',
  accessToken: META_ACCESS_TOKEN ? 'SET' : 'MISSING'
});

const KLAVIYO_PRIVATE_API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
 
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
 

 
// ---------------- STEP 1: create the unclaimed JustGiving page ----------------
async function createUnclaimedPage(lead) {
  const story = "I'm taking part in Hike for Change to help send " +
    "out-of-school children in Nigeria back into education. Every " +
    "step and every pound raised gets a child closer to the classroom. " +
    "Please support me!";
 
  const payload = {
    email: lead.email,
    firstName: lead.firstName,
    lastName: lead.lastName,
    charityId: Number(JG_CHARITY_ID),
    eventId: JG_EVENT_ID ? Number(JG_EVENT_ID) : null, // omit/null if no registered event
    campaignGuid: JG_CAMPAIGN_GUID || null,
    pageShortName: `${lead.firstName}-${lead.lastName}-hike-${Date.now()}`
      .toLowerCase().replace(/\s+/g, '-'),
    pageTitle: 'My Hike for Change Fundraising Page',
    // activityType + eventName are required whenever eventId is not set.
    // Confirmed against JustGiving's actual validation errors during testing.
    activityType: JG_EVENT_ID ? null : 'Treks',
    eventName: JG_EVENT_ID ? null : 'Hike for Change',
    targetAmount: FUNDRAISING_TARGET,
    charityOptIn: true,
    charityFunded: false,
    pageStory: story,
    currency: 'GBP',
    reference: `hikeforchange-${Date.now()}`,
  };
 
  // NOTE: confirmed with JustGiving developer support (Aug 2026) — this
  // endpoint takes NO authentication at creation time. Do not send an
  // Authorization header; it causes the request to fail. Authentication
  // happens later, when the supporter clicks their claim link.
//   const response = await axios.put(
//     `${JG_API_BASE}/${JG_APP_ID}/v1/fundraising/unclaimedpages`,
//     payload,
//     {
//       headers: { 'Content-Type': 'application/json' },
//     }
//   );
const response = await axios.put(
  `${JG_API_BASE}/${JG_APP_ID}/v1/fundraising/unclaimedpages`,
  payload,
  {
    headers: { 'Content-Type': 'application/json' },
  }
);

console.log('JUSTGIVING RESPONSE:', JSON.stringify(response.data, null, 2));
 
  // response.data includes: claimToken, pageGuid, signOnUrl, next.url (the claim link)
  return {
    claimUrl: response.data.signOnUrl,
    pageShortName: payload.pageShortName,
    pageGuid: response.data.pageGuid,
  };
}
 
// ---------------- STEP 2: log to Google Sheet ----------------
async function logToSheet(lead, claimData) {
  const row = [
    `${lead.firstName} ${lead.lastName}`,  // A: Lead name
    lead.email,                                 // B: Email
    lead.phone || '',                           // C: Phone
    new Date().toISOString(),                   // D: Date lead captured
    claimData.claimUrl,                         // E: Claim link
    'Sent',                                      // F: Claim link sent status
    'No',                                         // G: Claimed? (Y/N)
    '',                                            // H: Date claimed
    0,                                              // I: Amount raised
    claimData.pageShortName,                        // J: Page short name
  ];
 
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Tracker!A:J',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}
 
// ---------------- STEP 3: fire Meta Conversions API event ----------------
function hashSHA256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
 
async function fireMetaEvent(eventName, lead, extraData = {}) {
  // Check that Meta credentials exist
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    console.warn(
      `META CONFIG MISSING - Skipping ${eventName} event`
    );
    return;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`,
      {
        data: [{
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          user_data: {
            em: [hashSHA256(lead.email)],
            ph: lead.phone
              ? [hashSHA256(lead.phone)]
              : undefined,
          },
          custom_data: extraData,
        }],
        access_token: META_ACCESS_TOKEN,
      }
    );

    console.log(`META SUCCESS: ${eventName}`, response.data);

  } catch (error) {
    console.error(
      `META ERROR: ${eventName}`,
      error.response?.data || error.message
    );

    // Don't stop the signup process if Meta fails
  }
}
 
// ---------------- STEP 4: send claim event to Klaviyo ----------------
async function sendClaimEmail(lead, claimUrl, pageShortName) {
  console.log('KLAVIYO: Starting...');

  if (!KLAVIYO_PRIVATE_API_KEY) {
    throw new Error('KLAVIYO_PRIVATE_API_KEY is not configured');
  }

  if (!lead.email) {
    throw new Error('Lead email is required for Klaviyo');
  }

  try {
    const response = await axios.post(
      'https://a.klaviyo.com/api/events',
      {
        data: {
          type: 'event',
          attributes: {
            metric: {
              data: {
                type: 'metric',
                attributes: {
                  name: 'ClaimLinkSent'
                }
              }
            },
            profile: {
              data: {
                type: 'profile',
                attributes: {
                  email: lead.email,
                  first_name: lead.firstName,
                  last_name: lead.lastName,
                  ...(lead.phone ? {
                    phone_number: lead.phone
                  } : {})
                }
              }
            },
            properties: {
              claim_url: claimUrl,
              page_short_name: pageShortName,
              page_title: 'My Hike for Change Fundraising Page',
              campaign: 'Hike for Change'
            },
            time: new Date().toISOString(),
            unique_id: `claim-link-${pageShortName}`
          }
        }
      },
      {
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_PRIVATE_API_KEY}`,
          'Content-Type': 'application/vnd.api+json',
          'Accept': 'application/json',
          'Revision': '2026-07-15'
        }
      }
    );

    console.log('KLAVIYO SUCCESS:', response.status);

  } catch (error) {
    console.error(
      'KLAVIYO ERROR:',
      error.response?.data || error.message
    );

    throw error;
  }
}
 
 
// Health check
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Hike for Change backend is running'
  });
});
// ---------------- MAIN SIGNUP ENDPOINT ----------------
// app.post('/api/signup', async (req, res) => {
//   try {
//     const lead = req.body; // { firstName, lastName, email, phone, consent }
 
//     if (!lead.consent) {
//       return res.status(400).json({ error: 'Consent required' });
//     }
 
//     const claimData = await createUnclaimedPage(lead);
//     await logToSheet(lead, claimData);
//     await fireMetaEvent('Lead', lead);
//     await fireMetaEvent('ClaimLinkSent', lead, { page: claimData.pageShortName });
//     await sendClaimEmail(lead, claimData.claimUrl);
 
//     res.status(200).json({ success: true, claimUrl: claimData.claimUrl });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({
//   error: 'Something went wrong',
//   details: err.message
// });
//   }
// });

app.post('/api/signup', async (req, res) => {
  try {
    const lead = req.body;

    if (!lead.consent) {
      return res.status(400).json({ error: 'Consent required' });
    }

    console.log('STEP 1: Creating JustGiving page...');
    const claimData = await createUnclaimedPage(lead);
    console.log('STEP 1 SUCCESS:', claimData);

    console.log('STEP 2: Logging to Google Sheet...');
    await logToSheet(lead, claimData);
    console.log('STEP 2 SUCCESS');

    console.log('STEP 3: Sending Meta Lead event...');
    await fireMetaEvent('Lead', lead);
    console.log('STEP 3 SUCCESS');

    console.log('STEP 4: Sending Meta ClaimLinkSent event...');
    await fireMetaEvent('ClaimLinkSent', lead, {
      page: claimData.pageShortName
    });
    console.log('STEP 4 SUCCESS');

    console.log('STEP 5: Sending claim event to Klaviyo...');

    await sendClaimEmail(
    lead,
    claimData.claimUrl,
    claimData.pageShortName
    );

console.log('STEP 5 SUCCESS');

    res.status(200).json({
      success: true,
      claimUrl: claimData.claimUrl
    });

  } catch (err) {
    console.error('SIGNUP ERROR:', err);
    console.error('STACK:', err.stack);

    res.status(500).json({
      error: 'Something went wrong',
      details: err.message
    });
  }
});
 
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
